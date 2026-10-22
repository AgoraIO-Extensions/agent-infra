import { z } from "zod";

/**
 * #3226：会话 Sandbox 工作区内文件的规范化相对路径（工程 Spec §15.4.4）。
 *
 * 以 `/` 分隔的非空段，不含 `.`/`..` 段、NUL 与反斜杠，不以 `/` 开头或结尾。
 * Runtime 的回答内 `sandbox:` 引用、结果文件意图与 `result.file` V2 共用这一形状。
 */
const workspaceReferenceSegment = String.raw`(?!\.\.?(?:/|$))[^/\\\u0000]+`;
const workspaceReferencePattern = new RegExp(
	`^${workspaceReferenceSegment}(?:/${workspaceReferenceSegment})*$`,
	"u",
);

export const SANDBOX_WORKSPACE_REFERENCE_MAX_LENGTH_V1 = 1024;

export const SandboxWorkspaceReferenceV1Schema = z
	.string()
	.min(1)
	.max(SANDBOX_WORKSPACE_REFERENCE_MAX_LENGTH_V1)
	.regex(workspaceReferencePattern);
export type SandboxWorkspaceReferenceV1 = z.infer<
	typeof SandboxWorkspaceReferenceV1Schema
>;

/** 回答内文件引用使用的专用 URL scheme。 */
export const SANDBOX_REFERENCE_SCHEME_V1 = "sandbox:";

export type SandboxReferenceUrlV1 =
	| { readonly kind: "none" }
	| { readonly kind: "invalid" }
	| { readonly kind: "reference"; readonly workspaceReference: string };

/**
 * 把 Markdown 链接或图片的 URL 解析为工作区引用。
 *
 * - 不以 `sandbox:` 开头：不是引用（`none`）。
 * - 先百分号解码；含 NUL、反斜杠，`..` 越过工作区根目录，或规范化后为空、超长：无效引用。
 * - 开头的 `/` 也表示工作区根目录；空段与 `.` 段在规范化时去掉。
 *
 * 结果只是词法规范化的路径；文件是否位于工作区内、是否为普通文件，仍由调用方按实际
 * 文件系统核对。
 */
export function parseSandboxReferenceUrlV1(url: string): SandboxReferenceUrlV1 {
	if (!url.startsWith(SANDBOX_REFERENCE_SCHEME_V1)) return { kind: "none" };
	let decoded: string;
	try {
		decoded = decodeURIComponent(url.slice(SANDBOX_REFERENCE_SCHEME_V1.length));
	} catch {
		return { kind: "invalid" };
	}
	if (decoded.includes("\0") || decoded.includes("\\"))
		return { kind: "invalid" };
	const segments: string[] = [];
	for (const segment of decoded.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			if (segments.length === 0) return { kind: "invalid" };
			segments.pop();
			continue;
		}
		segments.push(segment);
	}
	const workspaceReference = segments.join("/");
	if (!SandboxWorkspaceReferenceV1Schema.safeParse(workspaceReference).success)
		return { kind: "invalid" };
	return { kind: "reference", workspaceReference };
}
