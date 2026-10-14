// 从标准 Codex 模板镜像内的固定 Codex 读取 `model/list`，输出部署配置所需的
// `codexModelProfiles`（#2382）。在镜像内离线运行：不联网、不读取凭证，使用
// 临时空 HOME；只向 stdout 输出 JSON，失败时只输出固定的错误码。
//
//   docker run --rm -i --network none --entrypoint node \
//     <registry>/agent-runtime-host@sha256:<digest> --input-type=module - \
//     < deploy/runtime/codex-model-profiles.mjs
//
// 结果与 Runtime readiness 使用同一份 `model/list`（含隐藏模型、分页）。
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const codex = process.env.CODEX_BIN || "/opt/codex/bin/codex";
const pageSize = 100;
const maximumPages = 8;
const timeoutMs = 30_000;
const modelPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const reasoningPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function fail(code) {
	process.stderr.write(`${code}\n`);
	process.exit(1);
}

const home = mkdtempSync(join(tmpdir(), "codex-model-profiles-"));
const child = spawn(codex, ["app-server"], {
	// 只传 PATH：不继承部署环境中的任何凭证或代理配置。
	env: { HOME: home, CODEX_HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin" },
	stdio: ["pipe", "pipe", "ignore"],
});
const cleanup = () => {
	child.kill();
	rmSync(home, { recursive: true, force: true });
};
const timer = setTimeout(() => {
	cleanup();
	fail("CODEX_MODEL_PROFILES_TIMEOUT");
}, timeoutMs);
child.on("error", () => {
	cleanup();
	fail("CODEX_MODEL_PROFILES_UNAVAILABLE");
});

let buffer = "";
let nextId = 0;
const waiting = new Map();
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
	buffer += chunk;
	for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
		const line = buffer.slice(0, end);
		buffer = buffer.slice(end + 1);
		let frame;
		try {
			frame = JSON.parse(line);
		} catch {
			continue;
		}
		const resolve = waiting.get(frame?.id);
		if (resolve) {
			waiting.delete(frame.id);
			resolve(frame);
		}
	}
});
child.on("exit", () => {
	for (const resolve of waiting.values()) resolve({ error: {} });
	waiting.clear();
});

function request(method, params) {
	const id = ++nextId;
	return new Promise((resolve) => {
		waiting.set(id, resolve);
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
	});
}

const initialized = await request("initialize", {
	clientInfo: { name: "agent-infra-model-profiles", version: "1" },
	capabilities: { experimentalApi: true },
});
if (initialized.error) {
	cleanup();
	fail("CODEX_MODEL_PROFILES_UNAVAILABLE");
}
child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized" })}\n`);

const profiles = [];
const models = new Set();
const cursors = new Set();
let cursor;
for (let page = 0; ; page += 1) {
	if (page >= maximumPages) {
		cleanup();
		fail("CODEX_MODEL_PROFILES_TOO_MANY_PAGES");
	}
	const response = await request("model/list", {
		includeHidden: true,
		limit: pageSize,
		...(cursor ? { cursor } : {}),
	});
	const data = response.result?.data;
	if (response.error || !Array.isArray(data)) {
		cleanup();
		fail("CODEX_MODEL_PROFILES_INVALID_RESPONSE");
	}
	for (const entry of data) {
		const efforts = entry?.supportedReasoningEfforts;
		if (
			typeof entry?.model !== "string" ||
			!modelPattern.test(entry.model) ||
			models.has(entry.model) ||
			!Array.isArray(efforts)
		) {
			cleanup();
			fail("CODEX_MODEL_PROFILES_INVALID_RESPONSE");
		}
		const levels = efforts.map((effort) => effort?.reasoningEffort);
		if (
			levels.length === 0 ||
			levels.length > 32 ||
			levels.some((level) => typeof level !== "string" || !reasoningPattern.test(level)) ||
			new Set(levels).size !== levels.length
		) {
			cleanup();
			fail("CODEX_MODEL_PROFILES_INVALID_RESPONSE");
		}
		models.add(entry.model);
		profiles.push({ model: entry.model, reasoningLevels: levels });
	}
	cursor = response.result.nextCursor;
	if (!cursor) break;
	if (typeof cursor !== "string" || cursors.has(cursor)) {
		cleanup();
		fail("CODEX_MODEL_PROFILES_INVALID_RESPONSE");
	}
	cursors.add(cursor);
}
clearTimeout(timer);
cleanup();
if (profiles.length === 0) fail("CODEX_MODEL_PROFILES_EMPTY");
process.stdout.write(`${JSON.stringify(profiles, null, 2)}\n`);
