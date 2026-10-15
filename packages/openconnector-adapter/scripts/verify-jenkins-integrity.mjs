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

// v9 delegates unchanged build/read behavior to the immutable v8 implementation.
const { jenkinsV9ExecutorDigest } = await import(
	"../src/providers/jenkins/versions/jenkins-v9-integrity.ts"
);
const v9Source = await readFile(
	new URL("../src/providers/jenkins/versions/jenkins-v9.ts", import.meta.url),
);
assert.equal(
	`sha256:${createHash("sha256").update(v9Source).update(source).update("saxes@6.0.0").digest("hex")}`,
	jenkinsV9ExecutorDigest,
);
