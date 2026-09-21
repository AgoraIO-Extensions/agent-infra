#!/usr/bin/env python3
"""Apply the recorded WIP patches only to an explicit clean exact upstream checkout."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from vendor_inputs import read_input

parser = argparse.ArgumentParser()
parser.add_argument("--source-checkout", type=Path, required=True)
parser.add_argument("--verify-existing", action="store_true")
args = parser.parse_args()
vendor = Path(__file__).resolve().parent
source = args.source_checkout.resolve()
manifest = json.loads(read_input(vendor / "build-input-v1.json"))

def git(*arguments, data=None):
    return subprocess.check_output(["git", "-C", str(source), *arguments], input=data)

def digest(raw):
    return "sha256:" + hashlib.sha256(raw).hexdigest()

if git("rev-parse", "HEAD").decode().strip() != manifest["upstream"]["commit"]:
    raise SystemExit("Unexpected upstream source revision")
patches = []
for patch in manifest["patches"]:
    raw = read_input(vendor / patch["path"])
    if digest(raw) != patch["sha256"]:
        raise SystemExit("Patch digest mismatch")
    patches.append(raw)
status = git("status", "--porcelain", "--untracked-files=all").decode().splitlines()
if any(line.startswith(("??", "!!")) for line in status):
    raise SystemExit("Untracked files are not allowed in the upstream checkout")
if not args.verify_existing:
    for raw in patches:
        git("apply", "--check", "-", data=raw)
        git("apply", "-", data=raw)
for entry in manifest["sourceFiles"]:
    if digest((source / entry["path"]).read_bytes()) != entry["sha256"]:
        raise SystemExit("Patched source digest mismatch: " + entry["path"])
print(json.dumps({"status": "source-bytes-verified", "files": len(manifest["sourceFiles"]), "nativeAcceptance": False}))
