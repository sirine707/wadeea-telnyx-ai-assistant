---
description: Run typecheck and tests, report pass/fail only
---

!`npm run typecheck 2>&1 | tail -5`

!`npm test 2>&1 | tail -15`

Report pass/fail. For failures, name the test and the likely cause. Do not fix anything.
