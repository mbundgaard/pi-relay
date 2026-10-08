# pi-relay

A one-to-one async link between two Pi agents.

## Install on both hosts

```sh
pi install git:github.com/mbundgaard/pi-relay
```

For a local checkout: `npm install`, then `pi install .`.
Use `/reload` in an already-running Pi session after installing or updating.

## Use

Tell your agent **start relay**. It returns just:

```text
relay_accept https://<host>#<secret> <code>
```

Paste that line into the other agent. Its `relay_accept` tool starts its own relay, opens its tunnel, and returns its contact information automatically. No separate startup, ports, accounts, or URLs to configure.

Then ask either agent to send a message to the other.

The link contains a secret: share it only with the intended peer. Pairing codes expire after 30 minutes.

## Behavior

- Loading the extension starts no network listeners or processes.
- Startup automatically downloads the tunnel binary if missing and opens an account-free Cloudflare Quick Tunnel.
- Startup waits for public reachability before returning the pairing line.
- No ngrok dependency, authentication, or port-4040 discovery remains.
- Shutdown closes the local listener and the tunnel process owned by this extension.
- `relay_start`, `relay_accept`, `relay_send`, `relay_status`, and `relay_disconnect` are agent tools. Legacy helper tools and slash commands remain available.
- State lives in `~/.pi-relay/`. The current prototype supports one active relay per state directory. Tests use `PI_RELAY_STATE_DIR` for isolation.
- Tunnel URLs are temporary; start and pair again after restarting Pi.
- Inbound requests trigger Pi work; assistant replies are returned as notifications rather than triggering an endless reply loop.

## Checks

```sh
npm run check
npm run test:live
```

The live test launches two isolated relays with real public tunnels and verifies compact invites, reachability, authentication, rejected pairing codes, automatic remote startup, bidirectional message delivery, and repeated startup. It requires internet access and cleans up its processes and temporary state.
