// 标准 Codex 模板的模型目录：固定 Codex 提交中的内置目录 `codex-rs/models-manager/models.json`，
// 不含平台追加条目（ADR-0029）。未内置的模型由 Codex 使用默认回退元数据；能否使用由保存时的
// 真实请求判定。
//
// `install-codex.mjs` 在镜像构建时调用 `buildCodexModelCatalog`，校验两个摘要后把结果写入
// `/opt/codex/share/models.json`；Runtime 以 `model_catalog_json` 加载它，使固定 Codex 只用
// 进程内目录、不向模型端点请求 `/models`。升级 Codex 后，在仓库根目录运行本脚本（需要访问
// GitHub），用输出替换 `packages/agent-runtime/src/codex-models.json`：
//
//   node --use-env-proxy deploy/runtime/codex-models.mjs \
//     > packages/agent-runtime/src/codex-models.json
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";

export const upstreamCatalogPath = "codex-rs/models-manager/models.json";
const slugPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function sha256(bytes) {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function catalogModels(bytes) {
	const value = JSON.parse(Buffer.from(bytes).toString("utf8"));
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).join(",") !== "models" ||
		!Array.isArray(value.models) ||
		value.models.length === 0 ||
		!value.models.every(
			(entry) =>
				entry !== null &&
				typeof entry === "object" &&
				!Array.isArray(entry) &&
				typeof entry.slug === "string" &&
				slugPattern.test(entry.slug),
		)
	)
		throw new Error("Codex model catalog is invalid");
	return value.models;
}

// 内置条目原样保留，顺序不变；重名拒绝。
export function buildCodexModelCatalog(upstreamBytes) {
	const models = catalogModels(upstreamBytes);
	if (new Set(models.map((entry) => entry.slug)).size !== models.length)
		throw new Error("Codex model catalog is invalid");
	return Buffer.from(`${JSON.stringify({ models })}\n`);
}

export function upstreamCatalogUrl(upstreamCommit) {
	if (!/^[a-f0-9]{40}$/.test(upstreamCommit))
		throw new Error("Codex upstream commit is invalid");
	return `https://raw.githubusercontent.com/openai/codex/${upstreamCommit}/${upstreamCatalogPath}`;
}

if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
	const release = JSON.parse(
		await readFile(
			new URL(
				"../../packages/agent-runtime/src/codex-release.json",
				import.meta.url,
			),
			"utf8",
		),
	);
	const response = await fetch(
		upstreamCatalogUrl(release.provenance.upstreamCommit),
		{ signal: AbortSignal.timeout(300_000) },
	);
	if (!response.ok) throw new Error("Codex model catalog is unavailable");
	const upstream = Buffer.from(await response.arrayBuffer());
	const catalog = buildCodexModelCatalog(upstream);
	process.stdout.write(
		`${JSON.stringify({ upstreamSha256: sha256(upstream), sha256: sha256(catalog) }, null, "\t")}\n`,
	);
}
