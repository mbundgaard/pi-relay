# pi-relay

One-to-one async Pi-to-Pi relay implemented as a Pi extension.

Loading the extension only registers tools. When you ask the agent to start the relay, it starts the local relay and opens a free Cloudflare quick tunnel automatically.

## Load

From this repo:

```bash
pi --extension ./src/index.ts
```

## Simple use

Ask the agent:

```text
start relay
```

It should call `relay_start` and return exactly one line like:

```text
/relay_accept pi-relay://... 123456
```

Paste that line into the remote Pi session. That is the pairing prompt.

On the remote side, ask its agent to start relay too if needed, then paste the line. The remote side sends its return contact card back automatically.

Then either side can ask its agent to send something to the other Pi.

## Agent tools

```text
relay_start
relay_prepare
relay_accept
relay_send
relay_status
relay_disconnect
relay_set_url
relay_show_details
```

Slash commands with similar names are also registered for manual use, but normal use should be through agent tools.

## State

State is stored in `~/.pi-relay/`:

```text
config.json
peer.json
messages.jsonl
```
