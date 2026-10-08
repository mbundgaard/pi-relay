# Known issues

## Repeated errors when a saved peer tunnel expires

**Status:** open; release blocker.

Symptom: `getaddrinfo ENOTFOUND <old-host>.trycloudflare.com` appears repeatedly.
Cloudflare Quick Tunnel addresses are temporary, but the saved peer can retain
an old address. Automatic reply delivery runs from `agent_settled`; a failed
send leaves the pending reply in place and throws out of the hook. Later
settled events can attempt the same delivery again.

Recovery: use `/relay_disconnect`, then start and pair the two relays again
with a fresh link. Disconnect forgets the peer; it does not stop the local
tunnel or revoke the local bearer token.

Required fix and regression coverage:

- Catch automatic reply delivery failures at the event boundary.
- Report a concise actionable failure without repeated unhandled errors.
- Define bounded retry/manual recovery behavior and pending-reply ownership.
- Never send a stale pending reply to a newly paired, unrelated peer.
- Test DNS failures, timeouts, non-2xx responses, disconnect, and re-pairing.
- Avoid blind retries when delivery may have succeeded but acknowledgment
  was lost; there is currently no message-ID deduplication.

## Prototype limitations

- One active relay per state directory; default loopback port is 8787.
- Quick Tunnel availability depends on Cloudflare and network access.
- Assistant responses appear as notifications at the remote side, not new
  agent turns.
- Pending reply tracking is a single slot, not a durable multi-message queue.
- Pairing and delivery security need hardening before broader distribution;
  see [../SECURITY.md](../SECURITY.md).
