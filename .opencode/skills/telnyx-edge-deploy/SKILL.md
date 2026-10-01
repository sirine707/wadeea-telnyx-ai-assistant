---
name: telnyx-edge-deploy
description: Use before running telnyx-edge ship on any Wadeea function.
---
## Rules
- `rm -rf .telnyx` before every ship; a stale bundle can be reused silently.
- Keep module scope inert (no env or secrets at import); build dependencies lazily.
- Actor functions: redeploy rarely and batch changes; hosts launch once at provisioning.
- Run `scripts/janitor.py --loop` during writes; the actor-runtime bucket caps at ~5 objects (`TooManyObjects`).
- Gate: typecheck, tests, esbuild bundle loads in bare Node with the expected exports.
- After ship: verify with a real tool call. A build failure with a clean local bundle: retry once.
