import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readCallbackCorpusBytes } from "../deploy/runtime/vendor/codex/callback-corpus.mjs";
import { callbackCorpus } from "../deploy/runtime/vendor/codex/callback-v2-corpus/index.mjs";

const vendor = new URL("../deploy/runtime/vendor/codex/", import.meta.url);
const sourceDigest =
	"504715ca9b68f99329077d2c29159e444669ef26392735bd074c2c55b007fa8a";

test("corpus modules reproduce the complete pinned native input", () => {
	const bytes = readCallbackCorpusBytes();
	assert.equal(bytes.length, 835430);
	assert.equal(createHash("sha256").update(bytes).digest("hex"), sourceDigest);
	const corpus = JSON.parse(bytes);
	assert.equal(corpus.cases.length, 174);
	assert.equal(new Set(corpus.cases.map(({ id }) => id)).size, 174);
	assert.equal(corpus.framingCases.length, 3);
	assert.equal(corpus.jcsVectors.length, 34);
	assert.equal(corpus.fakeDataOnly, true);
});

test("every pinned schema case retains its structural outcome", () => {
	const require = createRequire(
		new URL("../packages/contracts/package.json", import.meta.url),
	);
	const Ajv2020 = require("ajv/dist/2020.js");
	const schema = JSON.parse(
		readFileSync(new URL("callback-v2.schema.json", vendor), "utf8"),
	);
	const ajv = new Ajv2020({ strict: true, strictRequired: false });
	ajv.addFormat(
		"uuid",
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
	);
	const validate = ajv.compile(schema);
	for (const entry of JSON.parse(readCallbackCorpusBytes()).cases) {
		assert.equal(validate(entry.frame), entry.schemaValid, entry.id);
	}
});

test("a corpus change is rejected before it can reach a pinned consumer", () => {
	const originalId = callbackCorpus.cases[0].id;
	try {
		callbackCorpus.cases[0].id = "changed-corpus-fixture";
		assert.throws(readCallbackCorpusBytes, /CORPUS_DIGEST_MISMATCH/);
	} finally {
		callbackCorpus.cases[0].id = originalId;
	}
	assert.equal(readCallbackCorpusBytes().length, 835430);
});

test("the native preparation CLI emits the same pinned bytes", () => {
	const bytes = execFileSync(process.execPath, [
		fileURLToPath(new URL("callback-corpus.mjs", vendor)),
	]);
	assert.deepEqual(bytes, readCallbackCorpusBytes());
});
