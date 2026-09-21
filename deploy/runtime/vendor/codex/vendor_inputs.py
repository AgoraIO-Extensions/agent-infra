"""Read frozen vendor bytes from an original file or verified ordered parts."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import subprocess

FORMAT = "agent-infra-vendor-parts-v1"
MAX_PART_BYTES = 64 * 1024
MAX_INPUT_BYTES = 8 * 1024 * 1024
MAX_PARTS = 256
CORPUS_PATCH = "callback-corpus-patch-v1"


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def sha256(raw):
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def file_bytes(path, limit):
    require(not path.is_symlink() and path.is_file(), "Missing regular vendor input")
    with path.open("rb") as stream:
        raw = stream.read(limit + 1)
    require(len(raw) <= limit, "Vendor input exceeds size limit")
    return raw


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "Duplicate vendor parts metadata key")
        result[key] = value
    return result


def metadata(value, keys, limit):
    require(isinstance(value, dict) and set(value) == keys,
            "Invalid vendor parts metadata")
    require(type(value["byteLength"]) is int and 0 < value["byteLength"] <= limit,
            "Invalid vendor input byte length")
    require(isinstance(value["sha256"], str)
            and re.fullmatch(r"sha256:[a-f0-9]{64}", value["sha256"]),
            "Invalid vendor input SHA-256")


def part_path(root, name):
    require(isinstance(name, str) and re.fullmatch(r"[A-Za-z0-9_.\-/]+", name),
            "Invalid vendor part path")
    relative = PurePosixPath(name)
    require(not relative.is_absolute() and relative.as_posix() == name
            and all(part not in (".", "..") for part in name.split("/")),
            "Vendor part path escapes its manifest directory")
    path = root
    for component in relative.parts:
        path = path / component
        require(not path.is_symlink(), "Symlink vendor part path is not allowed")
    require(path.resolve().is_relative_to(root.resolve()),
            "Vendor part path escapes its manifest directory")
    return path


def corpus_patch_bytes(path):
    """Reproduce the one frozen new-file hunk without storing its corpus twice."""
    require(path.name == "0003-protected-connection-client.patch"
            and path.parent.name == "patches", "Invalid callback corpus patch location")
    corpus = read_input(path.parent.parent / "callback-v2-corpus.json")
    require(corpus.endswith(b"\n"), "Callback corpus must end with a newline")
    lines = corpus.splitlines(keepends=True)
    target = "codex-rs/rmcp-client/src/native_connection/callback-v2-corpus.json"
    header = (f"diff --git a/{target} b/{target}\nnew file mode 100644\n"
              f"--- /dev/null\n+++ b/{target}\n@@ -0,0 +1,{len(lines)} @@\n").encode()
    return header + b"".join(b"+" + line for line in lines)


def read_input(path):
    """Return original bytes; fragments never change the original input digest."""
    path = Path(path)
    if path.exists() or path.is_symlink():
        return file_bytes(path, MAX_INPUT_BYTES)
    if path.name == "callback-v2-corpus.json":
        loader = path.with_name("callback-corpus.mjs")
        require(not loader.is_symlink() and loader.is_file(), "Missing callback corpus loader")
        try:
            version = subprocess.check_output(["node", "--version"], timeout=10).decode().strip()
            require(re.fullmatch(r"v24\.[0-9]+\.[0-9]+", version),
                    "Node.js 24 is required to reconstruct callback corpus")
            raw = subprocess.check_output(["node", str(loader.resolve())], timeout=30)
        except (OSError, subprocess.SubprocessError, UnicodeError) as error:
            raise RuntimeError("Node.js 24 callback corpus reconstruction failed") from error
        require(len(raw) <= MAX_INPUT_BYTES, "Callback corpus exceeds input size limit")
        return raw
    index = path.with_name(path.name + ".parts.json")
    try:
        manifest = json.loads(file_bytes(index, MAX_PART_BYTES),
                              object_pairs_hook=unique_object)
    except (UnicodeError, ValueError) as error:
        raise RuntimeError("Invalid vendor parts JSON") from error
    metadata(manifest, {"format", "byteLength", "sha256", "parts"}, MAX_INPUT_BYTES)
    require(manifest["format"] == FORMAT, "Unsupported vendor parts format")
    parts = manifest["parts"]
    require(isinstance(parts, list) and 0 < len(parts) <= MAX_PARTS,
            "Invalid vendor parts inventory")
    names = set()
    chunks = []
    length = 0
    for part in parts:
        generated = isinstance(part, dict) and "generated" in part
        metadata(part, {"generated" if generated else "path", "byteLength", "sha256"},
                 MAX_INPUT_BYTES if generated else MAX_PART_BYTES)
        if generated:
            require(part["generated"] == CORPUS_PATCH, "Unknown generated vendor part")
            name = "generated:" + CORPUS_PATCH
        else:
            target = part_path(index.parent, part["path"])
            name = part["path"]
        require(name not in names, "Duplicate vendor part path")
        names.add(name)
        length += part["byteLength"]
        require(length <= manifest["byteLength"], "Vendor parts exceed original length")
        raw = corpus_patch_bytes(path) if generated else file_bytes(target, part["byteLength"])
        require(len(raw) == part["byteLength"] and sha256(raw) == part["sha256"],
                "Vendor part bytes do not match metadata")
        chunks.append(raw)
    raw = b"".join(chunks)
    require(len(raw) == manifest["byteLength"] and sha256(raw) == manifest["sha256"],
            "Reassembled vendor input does not match original bytes")
    return raw
