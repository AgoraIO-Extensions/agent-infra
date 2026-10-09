import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { jenkinsExecutorDigest } from "../src/jenkins-integrity.ts";
import { implementationUrl } from "./source-layout.mjs";

const source = await readFile(implementationUrl("src/jenkins.ts"));
assert.equal(
	`sha256:${createHash("sha256").update(source).digest("hex")}`,
	jenkinsExecutorDigest,
);
