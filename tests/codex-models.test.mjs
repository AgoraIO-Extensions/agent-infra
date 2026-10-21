import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

import {
	buildCodexModelCatalog,
	upstreamCatalogUrl,
} from "../deploy/runtime/codex-models.mjs";

const pins = JSON.parse(
	await readFile(
		new URL("../packages/agent-runtime/src/codex-models.json", import.meta.url),
		"utf8",
	),
);
const release = JSON.parse(
	await readFile(
		new URL(
			"../packages/agent-runtime/src/codex-release.json",
			import.meta.url,
		),
		"utf8",
	),
);
const catalog = (models) => Buffer.from(JSON.stringify({ models }));

test("pins the built-in catalog and the generated result by digest only (#2978)", () => {
	assert.deepEqual(Object.keys(pins).sort(), ["sha256", "upstreamSha256"]);
	for (const value of Object.values(pins))
		assert.match(value, /^sha256:[a-f0-9]{64}$/);
	assert.equal(
		upstreamCatalogUrl(release.provenance.upstreamCommit),
		`https://raw.githubusercontent.com/openai/codex/${release.provenance.upstreamCommit}/codex-rs/models-manager/models.json`,
	);
});

test("the platform no longer ships appended model entries (ADR-0029)", async () => {
	await assert.rejects(
		access(
			new URL("../deploy/runtime/codex-models-additions.json", import.meta.url),
		),
	);
});

test("keeps built-in entries in order and unchanged (ADR-0029)", () => {
	const upstream = [
		{ slug: "built-in-b", priority: 2, nested: { keep: [1, 2] } },
		{ slug: "built-in-a", priority: 1 },
	];
	assert.equal(
		buildCodexModelCatalog(catalog(upstream)).toString("utf8"),
		`${JSON.stringify({ models: upstream })}\n`,
	);
});

for (const [name, upstream] of [
	["duplicate entries", [{ slug: "a" }, { slug: "a" }]],
	["an empty list", []],
	["an entry without a slug", [{ name: "b" }]],
	["an invalid slug", [{ slug: "../b" }]],
	["a non-object entry", ["b"]],
])
	test(`rejects ${name} (#2978)`, () => {
		assert.throws(
			() => buildCodexModelCatalog(catalog(upstream)),
			/Codex model catalog is invalid/,
		);
	});

test("rejects a catalog with extra top-level keys (#2978)", () => {
	assert.throws(
		() =>
			buildCodexModelCatalog(
				Buffer.from(JSON.stringify({ models: [{ slug: "a" }], extra: 1 })),
			),
		/Codex model catalog is invalid/,
	);
});

test("rejects a mutable upstream reference (#2978)", () => {
	for (const reference of ["main", "rust-v0.153.0", "a".repeat(39), "../x"])
		assert.throws(
			() => upstreamCatalogUrl(reference),
			/Codex upstream commit is invalid/,
		);
});
