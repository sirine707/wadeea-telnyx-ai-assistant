---
description: Pre-ship checks: typecheck, test, bundle load, report GO or NO-GO
---

Function dir: $ARGUMENTS.

!`npm run typecheck 2>&1 | tail -3`

!`npm test 2>&1 | tail -3`

Run `cd $ARGUMENTS && npx tsc --noEmit`, then bundle src/index.ts with esbuild (--bundle --platform=node --format=cjs to /tmp) and load it with `node -e "require('/tmp/bundle.js')"` and list its exports. Output GO or NO-GO. Never run telnyx-edge ship.
