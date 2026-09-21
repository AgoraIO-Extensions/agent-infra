#!/usr/bin/env python3
"""Freeze callback/coverage bytes and embed the private read-only native probe.

Only writes this vendor manifest and the explicitly supplied isolated source.
Does not fetch, build, install, update the release pin, or operate a cluster.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from vendor_inputs import read_input

UPSTREAM = "41e22fee981a63b3698df7ed36bad393cda24715"
arguments = argparse.ArgumentParser()
arguments.add_argument("--source-checkout", required=True, type=Path)
args = arguments.parse_args()
source = args.source_checkout.resolve()
revision = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
if revision != UPSTREAM:
    raise SystemExit("Unexpected upstream source revision")
vendor = Path(__file__).resolve().parent
def digest(name):
    return "sha256:" + hashlib.sha256(read_input(vendor / name)).hexdigest()
manifest = {
    "schemaVersion": 1,
    "transport": "anonymous-unix-stream-fd3",
    "callbackSchemaSha256": digest("callback-v2.schema.json"),
    "coverageSha256": digest("coverage-v1.json"),
    "callbackCorpusSha256": digest("callback-v2-corpus.json"),
}
encoded = json.dumps(manifest, separators=(",", ":"))
(vendor / "native-barrier-v1.json").write_text(json.dumps(manifest, indent=2) + "\n")
(source / "codex-rs/core/src/native_operation_barrier_manifest.json").write_text(encoded + "\n")
print(json.dumps(manifest))
