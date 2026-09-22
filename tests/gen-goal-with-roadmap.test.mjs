import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const skillPath = join(
	process.cwd(),
	".agents",
	"skills",
	"gen-goal-with-roadmap",
	"SKILL.md",
);

test("gen-goal-with-roadmap is explicit-only and read-only", async () => {
	const source = await readFile(skillPath, "utf8");
	assert.match(source, /name: gen-goal-with-roadmap/);
	assert.match(source, /disable-model-invocation: true/);
	assert.match(source, /Generation has no side effects/);
	assert.match(source, /at most three candidates/);
	assert.match(source, /exactly one Coordinator Goal instruction/);
});

test("generated project skill contains the coordination contract", async () => {
	const source = await readFile(skillPath, "utf8");
	for (const phrase of [
		"Snapshot",
		"Frontier",
		"Lane",
		"ownership ledger",
		"exact head SHA",
		"Ready to implement",
		"Implemented",
		"Integrated",
		"Accepted",
		"independent Verifier",
		"Terminal proof",
	]) {
		assert.ok(source.includes(phrase), phrase);
	}
});

test("project skill has no personal notification or machine binding", async () => {
	const source = await readFile(skillPath, "utf8");
	for (const forbidden of [
		"wecom",
		"luxuhui",
		"/Users/",
		"CODEX_HOME",
		"corp_secret",
	]) {
		assert.doesNotMatch(source, new RegExp(forbidden, "i"), forbidden);
	}
});
