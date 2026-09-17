import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { jenkinsExecutorDigest } from "../src/jenkins-integrity.ts";

const source = await readFile(new URL("../src/jenkins.ts", import.meta.url));
assert.equal(
	`sha256:${createHash("sha256").update(source).digest("hex")}`,
	jenkinsExecutorDigest,
);
