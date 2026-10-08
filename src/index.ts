import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { randomBytes, randomInt } from "node:crypto";
import { bin as tunnelBinary, install as installTunnelBinary } from "cloudflared";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile, appendFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const VERSION = 1;
const DEFAULT_PORT = 8787;
const STATE_DIR = process.env.PI_RELAY_STATE_DIR ?? path.join(os.homedir(), ".pi-relay");
const CONFIG_PATH = path.join(STATE_DIR, "config.json");
const PEER_PATH = path.join(STATE_DIR, "peer.json");
const MESSAGES_PATH = path.join(STATE_DIR, "messages.jsonl");
const MAX_BODY_BYTES = 256 * 1024;
let tunnelProcess: ChildProcess | undefined;

type MessageType = "user_message" | "assistant_message" | "contact_card" | "ack" | "error";

type ContactCard = {
	kind: "pi-relay-contact";
	version: 1;
	name: string;
	url: string;
	token: string;
	createdAt: string;
	expiresAt?: string;
	capabilities: string[];
};

type RelayMessage = {
	id: string;
	type: MessageType;
	from?: string;
	text?: string;
	sentAt: string;
	pairingCode?: string;
	card?: ContactCard;
};

type Config = {
	name: string;
	port: number;
	url?: string;
	token: string;
	pendingInvite?: { pairingCode: string; createdAt: string; expiresAt: string };
};

type Peer = ContactCard;

let server: Server | undefined;
let currentContext: ExtensionContext | ExtensionCommandContext | undefined;
let pendingReplyTo: { messageId: string; startedAt: number } | undefined;
let lastSentAssistantFor: string | undefined;

const nowIso = () => new Date().toISOString();
const msgId = () => `msg_${randomBytes(12).toString("hex")}`;
const token = () => `rly_${randomBytes(24).toString("base64url")}`;
const sixDigits = () => String(randomInt(100000, 1000000));

async function ensureStateDir() {
	await mkdir(STATE_DIR, { recursive: true });
}

async function readJson<T>(file: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(file, "utf8")) as T;
	} catch (err: any) {
		if (err?.code === "ENOENT") return undefined;
		throw err;
	}
}

async function writeJson(file: string, value: unknown) {
	await ensureStateDir();
	await writeFile(file, `${JSON.stringify(value, null, "\t")}\n`, "utf8");
}

async function getConfig(): Promise<Config> {
	await ensureStateDir();
	const existing = await readJson<Config>(CONFIG_PATH);
	if (existing) return existing;
	const cfg: Config = {
		name: os.hostname(),
		port: DEFAULT_PORT,
		token: token(),
	};
	await writeJson(CONFIG_PATH, cfg);
	return cfg;
}

async function saveConfig(cfg: Config) {
	await writeJson(CONFIG_PATH, cfg);
}

async function getPeer(): Promise<Peer | undefined> {
	return readJson<Peer>(PEER_PATH);
}

async function savePeer(peer: Peer) {
	await writeJson(PEER_PATH, peer);
}

function decodeCard(input: string): ContactCard {
	const trimmed = input.trim();
	if (trimmed.startsWith("https://")) {
		const url = new URL(trimmed);
		const secret = url.hash.slice(1);
		if (!/^rly_[A-Za-z0-9_-]{32}$/.test(secret)) throw new Error("Invalid relay link secret");
		url.hash = "";
		return { kind: "pi-relay-contact", version: 1, name: url.hostname, url: url.origin,
			token: secret, createdAt: nowIso(), capabilities: ["one-to-one", "async-messages"] };
	}
	if (!trimmed.startsWith("pi-relay://")) throw new Error("contact card must start with pi-relay://");
	const json = Buffer.from(trimmed.slice("pi-relay://".length), "base64url").toString("utf8");
	const card = JSON.parse(json) as ContactCard;
	if (card.kind !== "pi-relay-contact" || card.version !== 1 || !card.url || !card.token) {
		throw new Error("invalid pi-relay contact card");
	}
	return card;
}

async function makeLocalCard(): Promise<ContactCard> {
	const cfg = await getConfig();
	if (!cfg.url) throw new Error("No public URL configured. Start the relay first.");
	return {
		kind: "pi-relay-contact",
		version: 1,
		name: cfg.name,
		url: cfg.url.replace(/\/$/, ""),
		token: cfg.token,
		createdAt: nowIso(),
		expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
		capabilities: ["one-to-one", "async-messages"],
	};
}

async function appendMessage(direction: "in" | "out", message: RelayMessage) {
	await ensureStateDir();
	const { card, pairingCode: _code, ...metadata } = message;
	const safe = { direction, receivedAt: nowIso(), ...metadata,
		...(card ? { card: { name: card.name, url: card.url } } : {}) };
	await appendFile(MESSAGES_PATH, `${JSON.stringify(safe)}\n`, "utf8");
}

async function readBody(req: IncomingMessage): Promise<any> {
	let size = 0;
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buf.length;
		if (size > MAX_BODY_BYTES) throw Object.assign(new Error("request body too large"), { statusCode: 413 });
		chunks.push(buf);
	}
	if (chunks.length === 0) return {};
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}

function bearer(req: IncomingMessage): string | undefined {
	const auth = req.headers.authorization;
	if (!auth?.startsWith("Bearer ")) return undefined;
	return auth.slice("Bearer ".length).trim();
}

async function handleInboundMessage(message: RelayMessage, logged = false) {
	if (!logged) await appendMessage("in", message);
	const ctx = currentContext;

	if (message.type === "contact_card") {
		const cfg = await getConfig();
		if (!message.card) throw new Error("contact_card message missing card");
		if (!cfg.pendingInvite || message.pairingCode !== cfg.pendingInvite.pairingCode) {
			throw new Error("pairing code did not match pending invite");
		}
		await savePeer(message.card);
		delete cfg.pendingInvite;
		await saveConfig(cfg);
		ctx?.ui.notify(`pi-relay paired with ${message.card.name}`, "info");
		return;
	}

	if (message.type === "user_message") {
		pendingReplyTo = { messageId: message.id, startedAt: Date.now() };
		const text = message.text?.trim();
		if (!text) return;
		ctx?.ui.notify(`pi-relay message from ${message.from ?? "peer"}`, "info");
		// Queue as user input in this Pi session. If the agent is busy, follow up after it settles.
		try {
			if (ctx && "isIdle" in ctx && !ctx.isIdle()) {
				piApi?.sendUserMessage(`Message from remote Pi:\n\n${text}`, { deliverAs: "followUp" });
			} else {
				piApi?.sendUserMessage(`Message from remote Pi:\n\n${text}`);
			}
		} catch (err: any) {
			ctx?.ui.notify(`pi-relay could not inject message: ${err?.message ?? err}`, "error");
		}
		return;
	}

	if (message.type === "assistant_message") {
		ctx?.ui.notify(`pi-relay assistant reply from ${message.from ?? "peer"}: ${message.text?.slice(0, 160) ?? ""}`, "info");
	}
}

async function startServer(port?: number) {
	const cfg = await getConfig();
	const listenPort = port ?? cfg.port ?? DEFAULT_PORT;
	if (server) return { alreadyRunning: true, port: listenPort };

	server = createServer(async (req, res) => {
		try {
			const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
			if (req.method === "GET" && url.pathname === "/info") {
				const c = await getConfig();
				sendJson(res, 200, { kind: "pi-relay", version: VERSION, name: c.name, status: "ready" });
				return;
			}

			if (req.method === "POST" && url.pathname === "/message") {
				const c = await getConfig();
				if (bearer(req) !== c.token) {
					sendJson(res, 401, { ok: false, error: "unauthorized" });
					return;
				}
				const body = (await readBody(req)) as RelayMessage;
				if (body.type === "contact_card" && (!c.pendingInvite ||
					body.pairingCode !== c.pendingInvite.pairingCode ||
					Date.parse(c.pendingInvite.expiresAt) <= Date.now())) {
					sendJson(res, 403, { ok: false, error: "Invalid or expired pairing code" });
					return;
				}
				if (!body?.id || !body?.type || !body?.sentAt) {
					sendJson(res, 400, { ok: false, error: "invalid message" });
					return;
				}
				if (body.type === "contact_card") {
					await handleInboundMessage(body);
					sendJson(res, 200, { ok: true, id: body.id, status: "accepted" });
					return;
				}
				await appendMessage("in", body);
				sendJson(res, 200, { ok: true, id: body.id, status: "accepted" });
				void handleInboundMessage(body, true).catch((err: any) =>
					currentContext?.ui.notify(`pi-relay inbound error: ${err?.message ?? err}`, "error"),
				);
				return;
			}

			sendJson(res, 404, { ok: false, error: "not found" });
		} catch (err: any) {
			sendJson(res, err?.statusCode ?? 500, { ok: false, error: err?.message ?? "server error" });
		}
	});

	try {
		await new Promise<void>((resolve, reject) => {
			server!.once("error", reject);
			server!.listen(listenPort, "127.0.0.1", () => {
				server!.off("error", reject);
				resolve();
			});
		});
	} catch (error) {
		server = undefined;
		throw error;
	}
	cfg.port = listenPort;
	await saveConfig(cfg);
	return { alreadyRunning: false, port: listenPort };
}

async function stopServer() {
	if (!server) return;
	const s = server;
	server = undefined;
	await new Promise<void>((resolve) => s.close(() => resolve()));
}

async function postMessage(peer: Peer, message: RelayMessage) {
	const endpoint = new URL("/message", peer.url.replace(/\/$/, ""));
	const body = JSON.stringify(message);
	const requester = endpoint.protocol === "http:" ? httpRequest : httpsRequest;
	await new Promise<void>((resolve, reject) => {
		const req = requester(endpoint, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"content-length": Buffer.byteLength(body),
				authorization: `Bearer ${peer.token}`,
			},
		}, (res) => {
			let data = "";
			res.setEncoding("utf8");
			res.on("data", (d) => (data += d));
			res.on("end", () => {
				if ((res.statusCode ?? 500) >= 200 && (res.statusCode ?? 500) < 300) resolve();
				else reject(new Error(`HTTP ${res.statusCode}: ${data}`));
			});
		});
		req.setTimeout(20000, () => req.destroy(new Error("Peer request timed out")));
		req.on("error", reject);
		req.write(body);
		req.end();
	});
	await appendMessage("out", message);
}

function extractTextFromLastAssistant(ctx: ExtensionContext, afterMs: number): string | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message") continue;
		const msg: any = entry.message;
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		if (typeof msg.timestamp === "number" && msg.timestamp < afterMs) return undefined;
		const text = msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n").trim();
		if (text) return text;
	}
	return undefined;
}

let piApi: ExtensionAPI | undefined;

function toolText(text: string, details: unknown = undefined) {
	return { content: [{ type: "text" as const, text }], details };
}

async function setPublicUrl(url: string) {
	const normalized = url.trim().replace(/\/$/, "");
	if (!/^https?:\/\//.test(normalized)) throw new Error("URL must start with http:// or https://");
	const cfg = await getConfig();
	cfg.url = normalized;
	await saveConfig(cfg);
	return normalized;
}

async function createInvite(maybeUrl?: string) {
	if (maybeUrl?.trim()) await setPublicUrl(maybeUrl);
	const cfg = await getConfig();
	const pairingCode = sixDigits();
	cfg.pendingInvite = {
		pairingCode,
		createdAt: nowIso(),
		expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
	};
	await saveConfig(cfg);
	const card = await makeLocalCard();
	const acceptLine = `relay_accept ${card.url}#${card.token} ${pairingCode}`;
	return { acceptLine, pairingCode, card };
}

async function acceptPeer(cardText: string, pairingCode: string) {
	const peer = decodeCard(cardText);
	if (!/^\d{6}$/.test(pairingCode)) throw new Error("Expected six-digit pairing code");
	await ensureRelay();
	const localCard = await makeLocalCard();
	await postMessage(peer, {
		id: msgId(),
		type: "contact_card",
		from: localCard.name,
		pairingCode,
		card: localCard,
		sentAt: nowIso(),
	});
	await savePeer(peer);
	return peer;
}

async function sendToPeer(text: string) {
	const peer = await getPeer();
	if (!peer) throw new Error("No pi-relay peer configured. Accept a contact card first.");
	const cfg = await getConfig();
	const message = { id: msgId(), type: "user_message" as const, from: cfg.name, text, sentAt: nowIso() };
	await postMessage(peer, message);
	return { peer, message };
}

async function startCloudflareTunnel(port: number): Promise<string> {
	if (tunnelProcess) {
		const cfg = await getConfig();
		if (cfg.url) return cfg.url;
	}

	if (!existsSync(tunnelBinary)) await installTunnelBinary(tunnelBinary);
	return new Promise((resolve, reject) => {
		const proc = spawn(tunnelBinary, ["tunnel", "--url", `http://127.0.0.1:${port}`], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		tunnelProcess = proc;
		let settled = false;
		let output = "";
		const timeout = setTimeout(() => {
			if (!settled) {
				settled = true;
				proc.kill();
				reject(new Error("Timed out waiting for Cloudflare tunnel URL"));
			}
		}, 30_000);

		const onData = (chunk: Buffer) => {
			const text = chunk.toString("utf8");
			output = (output + text).slice(-16384);
			const match = output.match(/https:\/\/[^\s|]+\.trycloudflare\.com/);
			if (match && output.includes("Registered tunnel connection") && !settled) {
				settled = true;
				clearTimeout(timeout);
				resolve(match[0].replace(/\/$/, ""));
			}
		};

		proc.stdout.on("data", onData);
		proc.stderr.on("data", onData);
		proc.on("error", (err) => {
			if (tunnelProcess === proc) tunnelProcess = undefined;
			if (!settled) {
				settled = true;
				clearTimeout(timeout);
				reject(err);
			}
		});
		proc.on("exit", (code) => {
			if (tunnelProcess === proc) tunnelProcess = undefined;
			if (!settled) {
				settled = true;
				clearTimeout(timeout);
				reject(new Error(`Cloudflare tunnel exited (${code}): ${output.slice(-1000)}`));
			}
		});
	});
}

let starting: Promise<string> | undefined;
async function ensureRelay(): Promise<string> {
	if (starting) return starting;
	starting = (async () => {
		const started = await startServer();
		const url = await startCloudflareTunnel(started.port);
		let reachable = false;
		for (let attempt = 0; attempt < 30; attempt++) {
			try {
				const response = await fetch(`${url}/info`, { signal: AbortSignal.timeout(5000) });
				const info = await response.json() as { kind?: string };
				if (response.ok && info.kind === "pi-relay") { reachable = true; break; }
			} catch { /* DNS and routing may take time to propagate. */ }
			await new Promise(resolve => setTimeout(resolve, 1000));
		}
		if (!reachable) {
			tunnelProcess?.kill();
			tunnelProcess = undefined;
			throw new Error("Relay tunnel did not become reachable; retry relay_start.");
		}
		await setPublicUrl(url);
		return url;
	})();
	try { return await starting; } finally { starting = undefined; }
}

async function prepareRelay(url?: string) {
	if (url) await startServer();
	const publicUrl = url ? await setPublicUrl(url) : await ensureRelay();
	const invite = await createInvite(publicUrl);
	return {
		ready: true,
		text: invite.acceptLine,
		invite,
	};
}

async function getStatusText() {
	const cfg = await getConfig();
	const peer = await getPeer();
	return [
		`server: ${server ? `running on 127.0.0.1:${cfg.port}` : "stopped"}`,
		`public URL: ${cfg.url ?? "not set"}`,
		`peer: ${peer ? `${peer.name} <${peer.url}>` : "none"}`,
		`pending invite: ${cfg.pendingInvite ? cfg.pendingInvite.pairingCode : "none"}`,
	].join("\n");
}

export default function relayExtension(pi: ExtensionAPI) {
	piApi = pi;

	pi.on("session_start", async (_event, ctx) => {
		currentContext = ctx;
	});

	pi.on("session_shutdown", async () => {
		if (tunnelProcess) {
			try {
				tunnelProcess.kill();
			} catch {
				// ignore shutdown cleanup failures
			}
			tunnelProcess = undefined;
		}
		await stopServer();
		currentContext = undefined;
	});

	pi.on("agent_settled", async (_event, ctx) => {
		currentContext = ctx;
		if (!pendingReplyTo || pendingReplyTo.messageId === lastSentAssistantFor) return;
		const peer = await getPeer();
		if (!peer) return;
		const text = extractTextFromLastAssistant(ctx, pendingReplyTo.startedAt);
		if (!text) return;
		const cfg = await getConfig();
		const reply: RelayMessage = {
			id: msgId(),
			type: "assistant_message",
			from: cfg.name,
			text,
			sentAt: nowIso(),
		};
		await postMessage(peer, reply);
		lastSentAssistantFor = pendingReplyTo.messageId;
		pendingReplyTo = undefined;
		ctx.ui.notify("pi-relay sent assistant reply", "info");
	});

	pi.registerTool({
		name: "relay_prepare",
		label: "Relay Prepare",
		description: "Start the relay end-to-end: open the local relay, start a free public tunnel automatically, and return exactly one pasteable relay_accept line for the remote Pi.",
		parameters: Type.Object({
			url: Type.Optional(Type.String({ description: "Optional public tunnel URL if already known" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			currentContext = ctx;
			const result = await prepareRelay(params.url);
			return toolText(result.text, result);
		},
	});

	pi.registerTool({
		name: "relay_start",
		label: "Relay Start",
		description: "Start the relay end-to-end: open the local relay, start a free public tunnel automatically, and return exactly one pasteable relay_accept line for the remote Pi.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			currentContext = ctx;
			const result = await prepareRelay();
			return toolText(result.text, result);
		},
	});

	pi.registerTool({
		name: "relay_set_url",
		label: "Relay Set URL",
		description: "Set this relay's public tunnel URL manually.",
		parameters: Type.Object({
			url: Type.String({ description: "Public URL, for example https://abc123.trycloudflare.com" }),
		}),
		async execute(_toolCallId, params) {
			const url = await setPublicUrl(params.url);
			return toolText(`pi-relay public URL set to ${url}`, { url });
		},
	});

	pi.registerTool({
		name: "relay_show_details",
		label: "Relay Show Details",
		description: "Create a contact card and 6-digit pairing code for the other Pi. Returns a copy/paste accept line.",
		parameters: Type.Object({
			url: Type.Optional(Type.String({ description: "Optional public URL to set first" })),
		}),
		async execute(_toolCallId, params) {
			const invite = await createInvite(params.url);
			return toolText(invite.acceptLine, invite);
		},
	});

	pi.registerTool({
		name: "relay_accept",
		label: "Relay Accept",
		description: "Accept a relay link and six-digit code. Automatically start this side, open its tunnel, and send return contact info. No separate relay_start is needed.",
		parameters: Type.Object({
			card: Type.String({ description: "Relay link (https://host#secret), or legacy pi-relay:// card. Automatically starts this side before pairing." }),
			pairingCode: Type.String({ description: "6-digit pairing code from the other Pi" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			currentContext = ctx;
			const peer = await acceptPeer(params.card, params.pairingCode);
			return toolText(`Accepted ${peer.name} and sent return contact card`, { peerName: peer.name, peerUrl: peer.url });
		},
	});

	pi.registerTool({
		name: "relay_send",
		label: "Relay Send",
		description: "Send a text message to the paired Pi relay.",
		parameters: Type.Object({
			message: Type.String({ description: "Message to send" }),
		}),
		async execute(_toolCallId, params) {
			const { peer, message } = await sendToPeer(params.message);
			return toolText(`Sent to ${peer.name}`, { peerName: peer.name, messageId: message.id });
		},
	});

	pi.registerTool({
		name: "relay_status",
		label: "Relay Status",
		description: "Show pi-relay server, URL, peer, and pending invite status.",
		parameters: Type.Object({}),
		async execute() {
			return toolText(await getStatusText());
		},
	});

	pi.registerTool({
		name: "relay_disconnect",
		label: "Relay Disconnect",
		description: "Forget the current pi-relay peer.",
		parameters: Type.Object({}),
		async execute() {
			if (existsSync(PEER_PATH)) await rm(PEER_PATH);
			return toolText("pi-relay peer removed");
		},
	});

	pi.registerCommand("relay_start", {
		description: "Start the relay end-to-end and show its pairing line",
		handler: async (args, ctx) => {
			currentContext = ctx;
			const result = await prepareRelay();
			ctx.ui.notify(result.text, "info");
		},
	});

	pi.registerCommand("relay_set_url", {
		description: "Set this relay's public tunnel URL",
		handler: async (args, ctx) => {
			const url = args.trim().replace(/\/$/, "");
			if (!/^https?:\/\//.test(url)) {
				ctx.ui.notify("Usage: /relay_set_url <https://your-public-url>", "error");
				return;
			}
			const cfg = await getConfig();
			cfg.url = url;
			await saveConfig(cfg);
			ctx.ui.notify(`pi-relay public URL set to ${url}`, "info");
		},
	});

	pi.registerCommand("relay_show_details", {
		description: "Show copy/paste pairing command for another Pi",
		handler: async (args, ctx) => {
			const invite = await createInvite(args.trim() || undefined);
			ctx.ui.notify(invite.acceptLine, "info");
		},
	});

	pi.registerCommand("relay_accept", {
		description: "Accept a pi-relay contact card and send this side's return card",
		handler: async (args, ctx) => {
			currentContext = ctx;
			const [cardArg, pairingCode] = args.trim().split(/\s+/, 2);
			if (!cardArg || !pairingCode) {
				ctx.ui.notify("Usage: /relay_accept <relay-link> <6-digit-code>", "error");
				return;
			}
			const peer = await acceptPeer(cardArg, pairingCode);
			ctx.ui.notify(`Accepted ${peer.name} and sent return contact card`, "info");
		},
	});

	pi.registerCommand("relay_send", {
		description: "Send a message to the paired Pi",
		handler: async (args, ctx) => {
			const text = args.trim();
			if (!text) {
				ctx.ui.notify("Usage: /relay_send <message>", "error");
				return;
			}
			const peer = await getPeer();
			if (!peer) {
				ctx.ui.notify("No pi-relay peer configured. Use /relay_accept first.", "error");
				return;
			}
			const cfg = await getConfig();
			await postMessage(peer, { id: msgId(), type: "user_message", from: cfg.name, text, sentAt: nowIso() });
			ctx.ui.notify(`Sent to ${peer.name}`, "info");
		},
	});

	pi.registerCommand("relay_status", {
		description: "Show pi-relay status",
		handler: async (_args, ctx) => {
			const cfg = await getConfig();
			const peer = await getPeer();
			ctx.ui.notify(
				[
					`server: ${server ? `running on 127.0.0.1:${cfg.port}` : "stopped"}`,
					`public URL: ${cfg.url ?? "not set"}`,
					`peer: ${peer ? `${peer.name} <${peer.url}>` : "none"}`,
					`pending invite: ${cfg.pendingInvite ? cfg.pendingInvite.pairingCode : "none"}`,
				].join("\n"),
				"info",
			);
		},
	});

	pi.registerCommand("relay_disconnect", {
		description: "Forget the current pi-relay peer",
		handler: async (_args, ctx) => {
			if (existsSync(PEER_PATH)) await rm(PEER_PATH);
			ctx.ui.notify("pi-relay peer removed", "info");
		},
	});
}
