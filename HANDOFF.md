# pi-relay handoff (historical design)

Superseded by `README.md` and the extension implementation. The current transport uses account-free quick tunnels, not ngrok. Both `relay_start` and `relay_accept` handle startup automatically. The pairing prompt is a compact relay link plus a code; no standalone Pi RPC process is used.

## Goal

Build `pi-relay`: a small one-to-one async bridge that lets one Pi agent talk to another Pi agent over the internet.

This is not a multi-room chat system and should not expose raw Pi RPC directly. It is a peer link between exactly two relays:

```text
local Pi <-> local pi-relay <-> internet <-> remote pi-relay <-> remote Pi
```

## Desired UX

Each side runs its own local `pi-relay` and exposes it temporarily with ngrok or similar.

### Commands/tools to provide

Minimum command set:

```text
relay_start
relay_show_details
relay_accept <contact-card>
relay_send "message"
relay_status
relay_disconnect
```

Optional later:

```text
relay_watch
relay_messages
relay_revoke
```

### Handshake

On Agent A:

```text
relay_show_details
```

It outputs a single copy/paste line:

```text
relay_accept pi-relay://<base64url-json-contact-card>
```

Agent B pastes that line. B stores A as its only peer, then sends B's own return card back to A through A's `/message` endpoint.

A receives the return card and stores B.

After that, either side can run:

```text
relay_send "Please inspect your repo and report back."
```

No peer name should be required because the system is one-to-one.

## Contact card format

Use a base64url encoded JSON object behind a `pi-relay://` URL.

Example decoded card:

```json
{
  "kind": "pi-relay-contact",
  "version": 1,
  "name": "martin-pc",
  "url": "https://abc123.ngrok-free.app",
  "token": "rly_...",
  "createdAt": "2026-10-08T09:50:00Z",
  "expiresAt": "2026-10-09T09:50:00Z",
  "capabilities": ["one-to-one", "async-messages"]
}
```

Security preference: tokens should be invite/peer scoped, not a single global permanent token. First version may use one token, but keep the storage/API shaped so per-peer tokens are easy.

## HTTP API

Keep it minimal.

### `GET /info`

Returns relay info without secrets:

```json
{
  "kind": "pi-relay",
  "version": 1,
  "name": "martin-pc",
  "status": "ready"
}
```

### `POST /message`

Authenticated with:

```text
Authorization: Bearer <token>
```

Body:

```json
{
  "id": "msg_...",
  "type": "user_message",
  "from": "remote-agent",
  "text": "Please inspect X",
  "sentAt": "2026-10-08T09:51:00Z"
}
```

Message types to support initially:

```text
user_message
assistant_message
contact_card
ack
error
```

The receiving relay should append the message to a local inbox log, acknowledge quickly, and process asynchronously.

Response:

```json
{
  "ok": true,
  "id": "msg_...",
  "status": "accepted"
}
```

## Async behavior

Communication must be async.

`POST /message` must not wait for Pi to complete a response. It should only persist/queue the inbound message and return.

The relay then forwards the message into the local Pi process. When Pi eventually produces an answer, `pi-relay` sends an `assistant_message` back to the configured peer's `/message` endpoint.

## Pi integration

Best implementation: use Pi RPC mode for a long-lived local Pi process:

```bash
pi --mode rpc --session-id pi-relay
```

Reasons:

- keeps context over many turns
- allows async prompt injection
- emits structured events
- can detect `agent_settled`
- avoids restarting Pi for every message

For first prototype, `pi --print` is simpler but not ideal because it is not conversational/contextual. Prefer RPC unless time is very short.

RPC prompt command shape:

```json
{"id":"msg_123","type":"prompt","message":"Message from remote Pi:\n\n..."}
```

Relay should collect assistant text from RPC events and, when the run settles, send it back as an `assistant_message`.

## State files

Suggested local state directory:

```text
~/.pi-relay/
```

Files:

```text
config.json        local name, port, ngrok/public URL if known
peer.json          the one accepted peer/contact
messages.jsonl     durable inbound/outbound message log
relay.log          operational log
```

On Windows this can also be under `%APPDATA%\pi-relay`, but cross-platform `~/.pi-relay` is fine for prototype.

## Server binding

Bind local HTTP server to loopback only:

```text
127.0.0.1:8787
```

ngrok exposes that local port.

Do not bind to `0.0.0.0` by default.

## ngrok assumptions

User likely wants free ngrok.

Expected flow:

```bash
pi-relay start
ngrok http 8787
pi-relay set-url https://abc123.ngrok-free.app
pi-relay show-details
```

Later improvement: auto-detect ngrok API at `http://127.0.0.1:4040/api/tunnels`.

## Non-goals

Do not implement initially:

- group chats
- multiple peers
- conversation IDs
- raw public Pi RPC exposure
- unauthenticated endpoints
- browser UI
- central server

## Security notes

- Never put private keys/passwords in contact cards.
- Contact card includes a bearer token, so treat it as secret.
- Prefer expiring tokens.
- Log message metadata and errors, but avoid accidentally logging tokens.
- Add request body size limit.
- Consider replay protection later via message IDs and `sentAt` tolerance.

## Suggested implementation stack

Simplest: Node.js, no framework or Express.

Files:

```text
package.json
src/cli.js
src/server.js
src/state.js
src/pi-rpc.js
src/contact-card.js
```

Package commands:

```json
{
  "bin": {
    "pi-relay": "./src/cli.js"
  },
  "type": "module"
}
```

## First milestone

1. `pi-relay start` starts HTTP server on `127.0.0.1:8787`.
2. `pi-relay show-details --url <ngrok-url>` prints one-line `relay_accept pi-relay://...`.
3. `pi-relay accept <card>` stores peer.
4. `pi-relay send "hello"` posts to peer `/message`.
5. Incoming `/message` appends to `messages.jsonl` and prints/logs it.

## Second milestone

Wire incoming messages into local Pi RPC and send assistant replies back automatically.

## Important terminology

Use `peer`, `link`, `message`, `inbox`, `outbox`.

Avoid `conversation` in user-facing API/docs because the user explicitly wants one-to-one, not conversation resources.
