import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.argv.includes("--worker")) {
  const tools = new Map<string, any>();
  const events = new Map<string, any>();
  const ctx = { ui: { notify() {} }, isIdle: () => true };
  const { default: extension } = await import("../src/index.ts");
  extension({
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand() {},
    on: (name: string, handler: any) => events.set(name, handler),
    sendUserMessage: (text: string) => process.send?.({ inbound: text }),
  } as any);
  process.on("message", async (request: any) => {
    try {
      if (request.tool === "shutdown") {
        await events.get("session_shutdown")();
        process.send?.({ id: request.id, result: "closed" });
        process.disconnect();
        return;
      }
      const result = await tools.get(request.tool).execute("test", request.params ?? {}, undefined, undefined, ctx);
      process.send?.({ id: request.id, result });
    } catch (error: any) {
      process.send?.({ id: request.id, error: error.message });
    }
  });
} else {
  const dirs: string[] = [];
  const clients: any[] = [];
  try {
    for (const port of [18787, 18788]) {
      const dir = await mkdtemp(join(tmpdir(), "pi-relay-test-"));
      dirs.push(dir);
      await writeFile(join(dir, "config.json"), JSON.stringify({ name: `test-${port}`, port, token: `rly_${"a".repeat(31)}${port === 18787 ? "b" : "c"}` }));
      const proc = fork(fileURLToPath(import.meta.url), ["--worker"], {
        execArgv: ["--import", "tsx"], env: { ...process.env, PI_RELAY_STATE_DIR: dir }, silent: true,
      });
      proc.stderr?.pipe(process.stderr);
      let counter = 0;
      const waiting = new Map<number, any>();
      const inbound: string[] = [];
      proc.on("message", (message: any) => {
        if (message.inbound) inbound.push(message.inbound);
        const task = waiting.get(message.id);
        if (task) { clearTimeout(task.timer); waiting.delete(message.id); message.error ? task.reject(new Error(message.error)) : task.resolve(message.result); }
      });
      const call = (tool: string, params = {}) => new Promise<any>((resolve, reject) => {
        const id = ++counter;
        const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`${tool} timed out`)); }, 180_000);
        waiting.set(id, { resolve, reject, timer });
        proc.send({ id, tool, params });
      });
      clients.push({ proc, call, inbound });
    }
    const [a, b] = clients;
    const invite = await a.call("relay_start");
    const line = invite.content[0].text;
    assert.match(line, /^relay_accept https:\/\/[^\s]+#rly_[\w-]+ \d{6}$/);
    assert.ok(line.length < 180, "compact prompt");
    const [, card, pairingCode] = line.split(" ");
    const publicUrl = new URL(card).origin;
    const info = await fetch(`${publicUrl}/info`, { signal: AbortSignal.timeout(20000) });
    assert.equal(info.status, 200);
    const unauthorized = await fetch(`${publicUrl}/message`, { method: "POST", body: "{}" });
    assert.equal(unauthorized.status, 401);
    await assert.rejects(b.call("relay_accept", { card, pairingCode: "000000" }), /403/);
    await b.call("relay_accept", { card, pairingCode });
    await a.call("relay_send", { message: "hello B" });
    await b.call("relay_send", { message: "hello A" });
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.ok(a.inbound.some((text: string) => text.includes("hello A")));
    assert.ok(b.inbound.some((text: string) => text.includes("hello B")));
    const repeated = await a.call("relay_start");
    assert.equal(new URL(repeated.content[0].text.split(" ")[1]).origin, publicUrl);
    console.log("PASS: compact invite, public reachability, auth rejection, pairing-code rejection, automatic remote startup, bidirectional delivery, repeated startup");
  } finally {
    for (const client of clients) {
      try { await client.call("shutdown"); } finally { client.proc.kill(); }
    }
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  }
}
