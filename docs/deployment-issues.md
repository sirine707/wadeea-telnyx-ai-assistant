# Deployment Issues — wadeea-dynamic-variables

Function ID: `4374037b-49bf-400c-8862-c60711869e2d`
Invoke URL (target): `https://wadeea-dynamic-variables-4374037b-4.telnyxcompute.com`

## Summary

The Edge Function cannot be deployed. Every `telnyx-edge ship` attempt ends in
`build_failed`. The CLI reports the failure as a Telnyx-side issue, not a code
issue. No build logs are returned.

## Attempts

### Attempt 1 — full implementation (telnyx dep, 8 files)
- **What shipped:** `index.ts` + `lib/` + `test/` + `package.json` (with `telnyx` dep) + `tsconfig.json`
- **Result:** `build_failed` — "temporary problem on our side, not your code"
- **Build logs:** none returned (`ship status --logs` empty)
- **Runtime logs:** none (function never started)

### Attempt 2 — same, after reset
- **Action:** `telnyx-edge reset-func --yes` then re-ship
- **Result:** `build_failed` — same message

### Attempt 3 — fixed import paths, after reset
- **Change:** import paths `../../lib/...` → `./lib/...` (relative to deployed root)
- **Result:** `build_failed` — same message

### Attempt 4 — minimal scaffold (3 files, no deps)
- **What shipped:** bare `index.ts` (`node:http` + `/health` only), `package.json` (no deps), `func.toml`
- **Archive size:** 881 bytes
- **Result:** `build_failed` — same message
- **Build logs:** none returned

## CLI commands and output (Attempt 4)

```
$ telnyx-edge ship --timeout 5m
...
✓ Collected 3 files for shipping
✓ Created shipping archive (881 bytes)
✓ Func 'wadeea-dynamic-variables' uploaded successfully!
👀 Monitoring build and deployment status...
⚠️ Func shipping status monitoring timed out after 5m0s

$ telnyx-edge ship status wadeea-dynamic-variables --logs
❌ The build failed due to a temporary problem on our side, not your code. Please try shipping again.

$ telnyx-edge logs wadeea-dynamic-variables --since 30m --json
{ "data": [] }
```

## Environment

- CLI: `telnyx-edge v0.5.3` (v0.5.4 available)
- Auth: OAuth 2.0, admin scope
- OS: macOS (Apple silicon)
- Node: v25.1.0

## What this rules out

- **Our code** — the minimal scaffold from Telnyx's own quickstart docs also fails.
- **Dependencies** — Attempt 4 has zero npm dependencies.
- **Import paths** — ruled out by Attempt 4 (no imports beyond `node:http`).

## Open questions (not answerable from docs)

1. Is the account's Edge Compute build infrastructure provisioned? (Promo code
   `TELNYXFDE2026` applied? Account in good standing?)
2. Is there a region/availability issue on Telnyx's side at this time?
3. Does the account need a billing profile or specific Edge Compute enablement
   beyond running `new-func`?

## Next steps

1. Check the Telnyx Portal (Mission Control) for any account-level alerts or
   Edge Compute configuration issues.
2. Try shipping from the Portal UI if a deploy option exists there.
3. Contact Stephen (stephenm@telnyx.com) — the assignment says "No question is
   too small."
4. Retry later — the error explicitly says "temporary."
