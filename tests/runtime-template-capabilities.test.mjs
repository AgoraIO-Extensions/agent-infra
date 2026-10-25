import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// #3375：标准模板的 Registry capability 声明来自镜像 manifest label，Worker 再与 Driver
// probe 取交集。补充指令只能在对应 Driver 通过 Conformance 后开启，目前只有 Codex。
const supplementTemplates = new Set(["codex"]);

/** Effective `io.agora.agent.runtime.manifest` label of each Dockerfile stage. */
function stageManifests(dockerfile) {
	const stages = new Map();
	let current;
	for (const line of dockerfile.split("\n")) {
		const from = /^FROM\s+(\S+)(?:\s+AS\s+(\S+))?\s*$/i.exec(line);
		if (from) {
			const parent = stages.get(from[1]);
			current = { manifest: parent?.manifest };
			if (from[2]) stages.set(from[2], current);
			continue;
		}
		const label = /^LABEL io\.agora\.agent\.runtime\.manifest='(.+)'\s*$/.exec(
			line,
		);
		if (label && current) current.manifest = JSON.parse(label[1]);
	}
	return new Map(
		[...stages].map(([name, stage]) => [name, stage.manifest]),
	);
}

test("standard templates declare supplementary instructions only after Driver conformance", async () => {
	const manifests = stageManifests(
		await readFile("apps/agent-runtime-host/Dockerfile", "utf8"),
	);
	const runtime = manifests.get("runtime");
	assert.ok(runtime, "runtime stage must declare the shared manifest");
	assert.equal(runtime.capabilities.supplementaryInstruction, false);
	for (const template of ["codex", "claude", "opencode", "pi", "runner"]) {
		const manifest = manifests.get(template);
		assert.ok(manifest, `${template} must inherit or declare a manifest`);
		const expected = supplementTemplates.has(template);
		assert.equal(
			manifest.capabilities.supplementaryInstruction,
			expected,
			`${template} supplementaryInstruction must be ${expected}`,
		);
		// 模板之间只允许补充指令声明不同，其余 manifest 字段保持同一份。
		assert.deepEqual(
			{
				...manifest,
				capabilities: {
					...manifest.capabilities,
					supplementaryInstruction: false,
				},
			},
			runtime,
		);
	}
});
