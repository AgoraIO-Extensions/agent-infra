#!/usr/bin/env python3
"""Apply the recorded WIP patches only to an explicit clean exact upstream checkout."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument("--source-checkout", type=Path, required=True)
parser.add_argument("--verify-existing", action="store_true")
args = parser.parse_args()
vendor = Path(__file__).resolve().parent
source = args.source_checkout.resolve()
manifest = json.loads((vendor / "build-input-v1.json").read_text())

def git(*arguments):
    return subprocess.check_output(["git", "-C", str(source), *arguments])

def digest(raw):
    return "sha256:" + hashlib.sha256(raw).hexdigest()

if git("rev-parse", "HEAD").decode().strip() != manifest["upstream"]["commit"]:
    raise SystemExit("Unexpected upstream source revision")
for patch in manifest["patches"]:
    if digest((vendor / patch["path"]).read_bytes()) != patch["sha256"]:
        raise SystemExit("Patch digest mismatch")
if not args.verify_existing:
    if git("status", "--porcelain"):
        raise SystemExit("An explicit clean upstream checkout is required")
    paths = [str(vendor / patch["path"]) for patch in manifest["patches"]]
    for path in paths:
        git("apply", "--check", path)
        git("apply", path)
for entry in manifest["sourceFiles"]:
    if digest((source / entry["path"]).read_bytes()) != entry["sha256"]:
        raise SystemExit("Patched source digest mismatch: " + entry["path"])
print(json.dumps({"status": "source-bytes-verified", "files": len(manifest["sourceFiles"]), "nativeAcceptance": False}))
