---
description: Check and toggle the bookings_enabled KV flag
---

!`telnyx-edge storage kv key get d6bfa576-5a6e-4d5d-a92a-e259f43a7c71 flag/bookings_enabled`

State whether bookings are enabled. Print (do not run) the commands to flip it:

```
# Enable:
telnyx-edge storage kv key put d6bfa576-5a6e-4d5d-a92a-e259f43a7c71 flag/bookings_enabled "true"

# Disable:
telnyx-edge storage kv key put d6bfa576-5a6e-4d5d-a92a-e259f43a7c71 flag/bookings_enabled "false"
```
