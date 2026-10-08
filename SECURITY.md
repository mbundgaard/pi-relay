# Security

pi-relay is a prototype that allows a paired remote Pi to submit work to the
local Pi session. Pair only with a trusted peer, and review the local agent's
tool permissions before exposing a relay.

## Current boundaries

- Loading the extension does not start a listener or tunnel.
- Startup binds HTTP to loopback and exposes it using a Cloudflare Quick Tunnel.
- `/info` is public and includes the host name.
- `/message` requires the local bearer token. Contact-card acceptance also
  checks the pending six-digit pairing code and its 30-minute expiry.
- The relay link contains the bearer token. Share it only with the intended
  peer, never in public issues, logs, or screenshots.
- State is stored under `~/.pi-relay/` (or `PI_RELAY_STATE_DIR`). Config and peer
  files contain plaintext secrets; protect that directory with OS permissions.
- The message log contains message text. It omits structured card tokens and
  pairing codes, but does not redact secrets embedded in arbitrary text.

## Limitations

The local bearer token persists across restarts. Forgetting a peer does not
revoke that token or stop the tunnel. Pairing-code expiry does not expire an
already shared bearer token. Message replay protection, message-ID
deduplication, request rate limiting, and a durable delivery queue are not
implemented. Remote work is injected as user input; this is a trust boundary,
not a sandbox.

To stop exposure, close the owning Pi session and verify its listener/tunnel
has ended. If a token is compromised, stop the relay before rotating local
state and re-pairing; do not assume `/relay_disconnect` revokes access.

## Reporting

Do not put secrets or exploitable security details in a public issue. Contact
the repository owner privately through an available verified channel. A
dedicated private reporting channel should be established before public release.
