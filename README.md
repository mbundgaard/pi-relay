# pi-relay

One-to-one async Pi-to-Pi relay implemented as a Pi extension.

The extension does **not** start ngrok automatically. Loading it only registers commands.

## Load

From this repo:

```bash
pi --extension ./src/index.ts
```

## Commands

```text
/relay_start [port]
/relay_set_url <ngrok-url>
/relay_show_details [ngrok-url]
/relay_accept <pi-relay-card> <6-digit-code>
/relay_send <message>
/relay_status
/relay_disconnect
```

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
