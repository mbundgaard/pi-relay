# pi-relay

One-to-one async Pi-to-Pi relay implemented as a Pi extension.

The extension does **not** start ngrok automatically. Loading it only registers commands.

## Load

From this repo:

```bash
pi --extension ./src/index.ts
```

## Agent tools

The extension gives the agent tools so you can ask it naturally, e.g. “start relay”, “set my relay URL to …”, “send this to the other Pi”.

Available tools:

```text
relay_prepare
relay_start
relay_set_url
relay_show_details
relay_accept
relay_send
relay_status
relay_disconnect
```

For the simple flow, just ask: “start the relay”. The agent should use `relay_prepare`. It starts the local relay, auto-detects an already-running ngrok tunnel if possible, and gives you the exact line to paste into the other Pi session. It does not start ngrok itself.

Slash commands with the same names except `relay_prepare` are also registered for manual use, but they are optional.

## Handshake

On host A:

```text
/relay_start
```

In a separate shell:

```bash
ngrok http 8787
```

Back in Pi:

```text
/relay_set_url https://a.ngrok-free.app
/relay_show_details
```

Copy the printed `/relay_accept ... 123456` line to host B.

On host B:

```text
/relay_start
```

In a separate shell:

```bash
ngrok http 8787
```

Back in Pi:

```text
/relay_set_url https://b.ngrok-free.app
/relay_accept pi-relay://... 123456
```

B stores A and sends B's return contact card to A. A verifies the 6-digit pairing code and stores B.

Then either side can run:

```text
/relay_send Please inspect your repo and report back.
```

## State

State is stored in `~/.pi-relay/`:

```text
config.json
peer.json
messages.jsonl
```
