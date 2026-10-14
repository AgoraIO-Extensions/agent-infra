import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = new URL(
	"../deploy/runtime/codex-model-profiles.mjs",
	import.meta.url,
);

// 假 codex：按场景应答 initialize 与分页的 model/list，并检查收到的环境。
async function fakeCodex(scenario) {
	const directory = await mkdtemp(join(tmpdir(), "fake-codex-"));
	const path = join(directory, "codex");
	await writeFile(
		path,
		`#!${process.execPath}
const scenario = ${JSON.stringify(scenario)};
// 生成脚本不得把部署环境中的变量传给 Codex，也不得沿用真实 HOME。
if (process.env.PRIVATE_DEPLOYMENT_TOKEN || process.env.HOME === ${JSON.stringify(process.env.HOME)} || process.env.CODEX_HOME !== process.env.HOME) process.exit(3);
if (scenario === "exit-immediately") process.exit(0);
if (scenario === "stdin-closed") {
	// 读端已关闭但进程仍在运行，Platform 侧收到应答后再写入会得到 EPIPE。
	require("node:fs").closeSync(0);
	setTimeout(() => process.stdout.write(JSON.stringify({ id: 1, result: {} }) + "\\n"), 100);
	setTimeout(() => {}, 10000);
} else {
	const pages = {
		first: { data: [{ model: "model-a", supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }] }], nextCursor: "page-2" },
		second: { data: [{ model: "model-b", supportedReasoningEfforts: [{ reasoningEffort: "low" }] }], nextCursor: null },
	};
	let buffer = "";
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk) => {
		buffer += chunk;
		for (let end = buffer.indexOf("\\n"); end >= 0; end = buffer.indexOf("\\n")) {
			const frame = JSON.parse(buffer.slice(0, end));
			buffer = buffer.slice(end + 1);
			if (frame.id === undefined) continue;
			let result;
			if (frame.method === "initialize") result = {};
			else if (scenario === "error") {
				process.stdout.write(JSON.stringify({ id: frame.id, error: { code: -1, message: "private upstream detail" } }) + "\\n");
				continue;
			} else if (scenario === "loop") result = { ...pages.first };
			else if (scenario === "duplicate") result = frame.params.cursor ? { data: pages.first.data, nextCursor: null } : pages.first;
			else result = frame.params.cursor === "page-2" ? pages.second : pages.first;
			process.stdout.write(JSON.stringify({ id: frame.id, result }) + "\\n");
		}
	});
}
`,
	);
	await chmod(path, 0o755);
	return { directory, path };
}

// 脚本使用私有 TMPDIR 运行，结束后检查没有遗留临时 HOME。
async function run(codex) {
	const temporary = await mkdtemp(join(tmpdir(), "profiles-tmp-"));
	try {
		const result = spawnSync(process.execPath, [script.pathname], {
			env: {
				...process.env,
				TMPDIR: temporary,
				CODEX_BIN: codex,
				PRIVATE_DEPLOYMENT_TOKEN: "sentinel",
			},
			encoding: "utf8",
			timeout: 20_000,
		});
		return { ...result, leftovers: await readdir(temporary) };
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
}

test("collects every model/list page as codexModelProfiles (#2382)", async () => {
	const fake = await fakeCodex("ok");
	try {
		const result = await run(fake.path);
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(JSON.parse(result.stdout), [
			{ model: "model-a", reasoningLevels: ["medium", "high"] },
			{ model: "model-b", reasoningLevels: ["low"] },
		]);
		assert.deepEqual(result.leftovers, []);
	} finally {
		await rm(fake.directory, { recursive: true, force: true });
	}
});

for (const [scenario, code] of [
	["error", "CODEX_MODEL_PROFILES_INVALID_RESPONSE"],
	["loop", "CODEX_MODEL_PROFILES_INVALID_RESPONSE"],
	["duplicate", "CODEX_MODEL_PROFILES_INVALID_RESPONSE"],
	// Codex 启动后立即退出，或关闭 stdin 读端后管道写入得到 EPIPE：只输出固定错误码，
	// 不能以未处理的 error 事件和堆栈退出，也不能遗留临时 HOME。
	["exit-immediately", "CODEX_MODEL_PROFILES_UNAVAILABLE"],
	["stdin-closed", "CODEX_MODEL_PROFILES_UNAVAILABLE"],
])
	test(`fails closed with a fixed code on ${scenario} (#2382)`, async () => {
		const fake = await fakeCodex(scenario);
		try {
			const result = await run(fake.path);
			assert.equal(result.status, 1);
			assert.equal(result.stdout, "");
			assert.equal(result.stderr.trim(), code);
			assert.doesNotMatch(
				result.stderr,
				/private upstream detail|EPIPE|\n\s+at /,
			);
			assert.deepEqual(result.leftovers, []);
		} finally {
			await rm(fake.directory, { recursive: true, force: true });
		}
	});

test("reports an unavailable Codex binary without output (#2382)", async () => {
	const result = await run("/nonexistent/codex");
	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.equal(result.stderr.trim(), "CODEX_MODEL_PROFILES_UNAVAILABLE");
	assert.deepEqual(result.leftovers, []);
});
