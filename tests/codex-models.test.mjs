import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
	buildCodexModelCatalog,
	upstreamCatalogUrl,
} from "../deploy/runtime/codex-models.mjs";

const additions = JSON.parse(
	await readFile(
		new URL("../deploy/runtime/codex-models-additions.json", import.meta.url),
		"utf8",
	),
);
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

test("reviewed additions are exactly the DeepSeek entries with low/high/max reasoning (#2978)", () => {
	assert.deepEqual(Object.keys(additions), ["models"]);
	assert.deepEqual(
		additions.models.map((entry) => entry.slug),
		["deepseek-flash", "deepseek-v4-pro"],
	);
	for (const entry of additions.models) {
		assert.deepEqual(
			entry.supported_reasoning_levels.map((level) => level.effort),
			["low", "high", "max"],
		);
		assert.equal(entry.default_reasoning_level, "high");
		assert.equal(entry.visibility, "list");
	}
});

test("pins the built-in catalog and the generated result by digest only (#2978)", () => {
	assert.deepEqual(Object.keys(pins).sort(), ["sha256", "upstreamSha256"]);
	for (const value of Object.values(pins))
		assert.match(value, /^sha256:[a-f0-9]{64}$/);
	assert.equal(
		upstreamCatalogUrl(release.provenance.upstreamCommit),
		`https://raw.githubusercontent.com/openai/codex/${release.provenance.upstreamCommit}/codex-rs/models-manager/models.json`,
	);
});

test("keeps built-in entries first and unchanged, then appends the additions (#2978)", () => {
	const upstream = [
		{ slug: "built-in-b", priority: 2, nested: { keep: [1, 2] } },
		{ slug: "built-in-a", priority: 1 },
	];
	const added = [{ slug: "added", priority: 9 }];
	assert.equal(
		buildCodexModelCatalog(catalog(upstream), catalog(added)).toString("utf8"),
		`${JSON.stringify({ models: [...upstream, ...added] })}\n`,
	);
});

for (const [name, upstream, added] of [
	["an addition overriding a built-in model", [{ slug: "a" }], [{ slug: "a" }]],
	["duplicate additions", [{ slug: "a" }], [{ slug: "b" }, { slug: "b" }]],
	["an empty addition list", [{ slug: "a" }], []],
	["an entry without a slug", [{ slug: "a" }], [{ name: "b" }]],
	["an invalid slug", [{ slug: "a" }], [{ slug: "../b" }]],
	["a non-object entry", [{ slug: "a" }], ["b"]],
])
	test(`rejects ${name} (#2978)`, () => {
		assert.throws(
			() => buildCodexModelCatalog(catalog(upstream), catalog(added)),
			/Codex model catalog is invalid/,
		);
	});

test("rejects catalogs with fields other than models (#2978)", () => {
	assert.throws(
		() =>
			buildCodexModelCatalog(
				Buffer.from(JSON.stringify({ models: [{ slug: "a" }], extra: 1 })),
				catalog([{ slug: "b" }]),
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
