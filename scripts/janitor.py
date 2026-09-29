#!/usr/bin/env python3
"""Snapshot-bucket janitor (ADR 0003, ops runbook rule #1).

The account's actor-runtime bucket holds ~5 objects and the platform never
prunes it; every SQLDB write and actor activation ships a generation object.
This prunes superseded `gen-*` objects (keeping each entity's fence + newest
generation) so writes never hit `TooManyObjects`.

Usage:
  python3 scripts/janitor.py            # one pass
  python3 scripts/janitor.py --loop     # every 120s until Ctrl-C

Requires TELNYX_API_KEY in the environment (source .env) and boto3.
"""
import os
import re
import sys
import time
from collections import defaultdict

import boto3

BUCKET = "edge-compute-actor-runtime-7f7183c2-9578-41c3-ad58-b89a89f9bb45"
ENDPOINT = "https://us-east-1.telnyxcloudstorage.com"


def prune(s3) -> int:
    objs = s3.list_objects_v2(Bucket=BUCKET).get("Contents", [])
    # Group generations per entity prefix so multiple actors/DBs coexist safely.
    by_entity: dict[str, list[tuple[int, str]]] = defaultdict(list)
    for o in objs:
        m = re.search(r"^snapshots/(.+)/gen-(\d+)-", o["Key"])
        if m:
            by_entity[m.group(1)].append((int(m.group(2)), o["Key"]))
    pruned = 0
    for entity, gens in by_entity.items():
        newest = max(g for g, _ in gens)
        for g, key in gens:
            if g < newest:
                s3.delete_object(Bucket=BUCKET, Key=key)
                pruned += 1
    return pruned


def main() -> None:
    key = os.environ.get("TELNYX_API_KEY")
    if not key:
        sys.exit("TELNYX_API_KEY not set — run: set -a && source .env && set +a")
    s3 = boto3.client(
        "s3", endpoint_url=ENDPOINT,
        aws_access_key_id=key, aws_secret_access_key=key, region_name="us-east-1",
    )
    loop = "--loop" in sys.argv
    while True:
        n = prune(s3)
        if n:
            print(time.strftime("%H:%M:%S"), f"pruned {n} superseded generation(s)")
        if not loop:
            break
        time.sleep(120)


if __name__ == "__main__":
    main()
