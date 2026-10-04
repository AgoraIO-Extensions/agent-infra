import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";

const execFileAsync = promisify(execFile);
const SHA = /^[0-9a-f]{40,64}$/i;
const MAX_METADATA_BYTES = 256 * 1024;
const MAX_CHUNKS = 3;
const MAX_RETRIES = 3;

export type DiffStatus =
	| "added"
	| "copied"
	| "deleted"
	| "modified"
	| "renamed"
	| "type-changed";
export type DiffSide = "old" | "new";

export interface DiffLine {
	side: DiffSide;
	line: number;
	contentSha256: string;
	noNewline: boolean;
}

export interface DiffHunk {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	lines: DiffLine[];
	id: string;
}

export interface DiffFile {
	oldPath: string | null;
	newPath: string | null;
	status: DiffStatus;
	oldMode: string | null;
	newMode: string | null;
	oldBlob: string | null;
	newBlob: string | null;
	hunks: DiffHunk[];
	id: string;
}

export interface GitInventory {
	repositoryPath: string;
	baseSha: string;
	headSha: string;
	mergeBaseSha: string;
	files: DiffFile[];
	digest: string;
}

export interface BuildProvenance {
	baseImageDigest: string;
	buildWorkflow: string;
	buildCommit: string;
	patchSha256: string;
	builderIdentity: string;
	imageDigest: string;
}

export interface RecorderIdentity {
	reviewer: "pr-agent";
	runtimeKind: "official" | "derived";
	sourceCommit?: string;
	patchSha256?: string;
	buildProvenance?: BuildProvenance;
	repositoryId: number;
	repositoryName: string;
	pullRequest: number;
	baseSha: string;
	headSha: string;
	mergeBaseSha: string;
	workflowRunId: number;
	runAttempt: number;
	analysisJobId: string;
	provider: string;
	imageDigest: string;
	recorderVersion: string;
	templateVersion: string;
	transportVersion: string;
	tokenCap: number;
	diffSha256: string;
	diffBytes: number;
}

export interface ChunkRequest {
	chunkId: string;
	body: string;
	headers: Record<string, string>;
}

export interface ChunkResult {
	chunkId: string;
	requestSha256: string;
	matchedFileIds: string[];
	matchedHunkIds: string[];
	responseSha256: string;
	attempts: number;
	callStatus: "succeeded";
	responseStatus: number;
	response?: unknown;
	parsedResult?: ParsedResultSummary;
}

export interface ParsedResultSummary {
	schema: "pr-agent-review";
	findingCount: number;
	digest: string;
}

export interface FailedChunk {
	chunkId: string;
	attempts: number;
	reasonCode: string;
}

export interface CoverageMetadata extends RecorderIdentity {
	version: 1;
	inventory: GitInventory;
	plannedChunkIds: string[];
	chunks: ChunkResult[];
	failedChunks: FailedChunk[];
	mergedOutputSha256: string;
	successfulResponseSha256: string[];
}

export class CoverageError extends Error {
	readonly code: string;
	constructor(code: string, message = code) {
		super(message);
		this.name = "CoverageError";
		this.code = code;
	}
}

function digest(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
	return JSON.stringify(value);
}

function normalizedFinding(value: unknown): string {
	if (!value || typeof value !== "object")
		return String(value).trim().toLowerCase();
	const finding = value as Record<string, unknown>;
	return [finding.relevant_file, finding.issue_header, finding.issue_content]
		.map((part) =>
			String(part ?? "")
				.replace(/\s+/g, " ")
				.trim()
				.toLowerCase(),
		)
		.join("\u0000");
}

function mergeFindingUnion(values: unknown[]): unknown[] {
	const merged: unknown[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		if (!Array.isArray(value)) continue;
		for (const finding of value) {
			const key = normalizedFinding(finding);
			if (seen.has(key)) continue;
			seen.add(key);
			merged.push(finding);
		}
	}
	return merged;
}

function parseJson(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
}

function assertSha(value: string, name: string): void {
	if (!SHA.test(value))
		throw new CoverageError("invalid-identity", `${name} is not a git SHA`);
}

function assertSafeGitPath(path: string): void {
	if (
		!path ||
		path.startsWith("/") ||
		path.includes("\0") ||
		path.split("/").some((part) => part === "..")
	)
		throw new CoverageError("invalid-diff", "unsafe git path");
}

function gitArgs(...args: string[]): string[] {
	return [
		"-c",
		"core.attributesfile=/dev/null",
		"-c",
		"core.hooksPath=/dev/null",
		"-c",
		"diff.external=",
		"-c",
		"diff.renames=true",
		"-c",
		"core.quotePath=false",
		"-c",
		"color.ui=false",
		"-c",
		"diff.algorithm=myers",
		"--literal-pathspecs",
		...args,
	];
}

async function git(repoPath: string, args: string[]): Promise<string> {
	try {
		const result = await execFileAsync("git", gitArgs(...args), {
			cwd: repoPath,
			env: {
				...Object.fromEntries(
					Object.entries(process.env).filter(
						([key]) => !key.startsWith("GIT_"),
					),
				),
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_CONFIG_SYSTEM: "/dev/null",
				GIT_ATTR_NOSYSTEM: "1",
				GIT_NO_REPLACE_OBJECTS: "1",
				GIT_TERMINAL_PROMPT: "0",
			},
			encoding: "buffer" as BufferEncoding,
			maxBuffer: 32 * 1024 * 1024,
		});
		const bytes = Buffer.isBuffer(result.stdout)
			? result.stdout
			: Buffer.from(String(result.stdout));
		try {
			return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch {
			throw new CoverageError(
				"unsupported-input",
				"git output is not valid UTF-8",
			);
		}
	} catch (error) {
		throw new CoverageError(
			"git-failed",
			error instanceof Error ? error.message : "git command failed",
		);
	}
}

function parseRaw(raw: string): Array<{
	oldMode: string;
	newMode: string;
	oldBlob: string;
	newBlob: string;
	status: string;
	oldPath: string;
	newPath: string;
}> {
	const tokens = raw.split("\0");
	const entries: Array<{
		oldMode: string;
		newMode: string;
		oldBlob: string;
		newBlob: string;
		status: string;
		oldPath: string;
		newPath: string;
	}> = [];
	for (let i = 0; i < tokens.length && tokens[i]; ) {
		const header = tokens[i++];
		if (header === undefined)
			throw new CoverageError("invalid-diff", "missing raw git diff record");
		const match = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) ([A-Z][0-9]*)$/.exec(
			header,
		);
		if (!match)
			throw new CoverageError("invalid-diff", "invalid raw git diff record");
		const firstPath = tokens[i++];
		if (firstPath === undefined)
			throw new CoverageError("invalid-diff", "missing git path");
		const [, oldMode, newMode, oldBlob, newBlob, statusToken] = match;
		if (!oldMode || !newMode || !oldBlob || !newBlob || !statusToken)
			throw new CoverageError("invalid-diff", "incomplete raw git diff record");
		const status = statusToken[0];
		if (!status)
			throw new CoverageError("invalid-diff", "missing raw git status");
		assertSafeGitPath(firstPath);
		const secondPath =
			status === "R" || status === "C" ? tokens[i++] : firstPath;
		if (secondPath === undefined)
			throw new CoverageError("invalid-diff", "missing rename path");
		assertSafeGitPath(secondPath);
		if (oldMode === "160000" || newMode === "160000")
			throw new CoverageError(
				"unsupported-input",
				"submodule diff is not reliably reconstructable",
			);
		const statusMap: Record<string, DiffStatus> = {
			A: "added",
			C: "copied",
			D: "deleted",
			M: "modified",
			R: "renamed",
			T: "type-changed",
		};
		const mapped = statusMap[status];
		if (!mapped)
			throw new CoverageError(
				"unsupported-diff",
				`unsupported status ${status}`,
			);
		entries.push({
			oldMode,
			newMode,
			oldBlob,
			newBlob,
			status: mapped,
			oldPath: firstPath,
			newPath: secondPath,
		});
	}
	return entries;
}

function patchSections(patch: string): string[] {
	return patch
		.split(/^(?=diff --git )/m)
		.map((section) => section.replace(/\r?\n$/, ""))
		.filter((section) => section.startsWith("diff --git "));
}

function sectionForFile(
	patch: string,
	file: { oldPath: string | null; newPath: string | null },
): string | undefined {
	const oldPath = file.oldPath ?? file.newPath;
	const newPath = file.newPath ?? file.oldPath;
	if (!oldPath || !newPath) return undefined;
	const expected = `diff --git a/${oldPath} b/${newPath}`;
	return patchSections(patch).find(
		(section) => section.split(/\r?\n/, 1)[0] === expected,
	);
}

function parseHunksFromSection(section: string): DiffHunk[] {
	if (/^Binary files /m.test(section) || /^GIT binary patch/m.test(section))
		throw new CoverageError(
			"unsupported-input",
			"binary diff is not reliably reconstructable",
		);
	const lines = section.split(/\r?\n/);
	const hunks: DiffHunk[] = [];
	let current: DiffHunk | undefined;
	let oldLine = 0;
	let newLine = 0;
	let oldSeen = 0;
	let newSeen = 0;
	for (const line of lines) {
		const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
		if (header) {
			if (
				current &&
				(oldSeen !== current.oldLines || newSeen !== current.newLines)
			)
				throw new CoverageError("invalid-diff", "hunk line count mismatch");
			current = {
				oldStart: Number(header[1]),
				oldLines: Number(header[2] ?? 1),
				newStart: Number(header[3]),
				newLines: Number(header[4] ?? 1),
				lines: [],
				id: "",
			};
			hunks.push(current);
			oldLine = current.oldStart;
			newLine = current.newStart;
			oldSeen = 0;
			newSeen = 0;
			continue;
		}
		if (line === "\\ No newline at end of file") {
			const previous = current?.lines.at(-1);
			if (previous) previous.noNewline = true;
			continue;
		}
		if (!current) continue;
		if (line.startsWith("+")) {
			current.lines.push({
				side: "new",
				line: newLine++,
				contentSha256: digest(line.slice(1)),
				noNewline: false,
			});
			newSeen += 1;
		} else if (line.startsWith("-")) {
			current.lines.push({
				side: "old",
				line: oldLine++,
				contentSha256: digest(line.slice(1)),
				noNewline: false,
			});
			oldSeen += 1;
		} else if (line.startsWith(" ")) {
			oldLine++;
			newLine++;
			oldSeen += 1;
			newSeen += 1;
		} else {
			throw new CoverageError("invalid-diff", "unexpected hunk line");
		}
	}
	if (current && (oldSeen !== current.oldLines || newSeen !== current.newLines))
		throw new CoverageError("invalid-diff", "hunk line count mismatch");
	return hunks.map((hunk) => ({
		...hunk,
		id: digest(
			canonical({
				oldStart: hunk.oldStart,
				oldLines: hunk.oldLines,
				newStart: hunk.newStart,
				newLines: hunk.newLines,
				lines: hunk.lines,
			}),
		),
	}));
}

function parseHunks(
	patch: string,
	file: { oldPath: string | null; newPath: string | null },
): DiffHunk[] {
	const section = sectionForFile(patch, file);
	if (!section)
		throw new CoverageError(
			"unsupported-input",
			"Git patch path cannot be matched unambiguously",
		);
	return parseHunksFromSection(section);
}

function assertFileMetadata(
	section: string,
	file:
		| DiffFile
		| Pick<
				DiffFile,
				| "oldPath"
				| "newPath"
				| "status"
				| "oldMode"
				| "newMode"
				| "oldBlob"
				| "newBlob"
		  >,
): void {
	const lines = section.split(/\r?\n/);
	const has = (value: string) => lines.includes(value);
	const oldPath = file.oldPath;
	const newPath = file.newPath;
	const requiresPathHeaders =
		file.status === "added" ||
		file.status === "deleted" ||
		file.status === "renamed" ||
		file.status === "copied" ||
		lines.some((line) => line.startsWith("@@ "));
	if (
		requiresPathHeaders &&
		oldPath &&
		!has(`rename from ${oldPath}`) &&
		!has(`--- a/${oldPath}`) &&
		!has("--- /dev/null")
	)
		throw new CoverageError(
			"review-coverage-incomplete",
			"old path metadata mismatch",
		);
	if (
		requiresPathHeaders &&
		newPath &&
		!has(`rename to ${newPath}`) &&
		!has(`+++ b/${newPath}`) &&
		!has("+++ /dev/null")
	)
		throw new CoverageError(
			"review-coverage-incomplete",
			"new path metadata mismatch",
		);
	if (file.status === "renamed" || file.status === "copied") {
		const from = file.status === "copied" ? "copy from" : "rename from";
		const to = file.status === "copied" ? "copy to" : "rename to";
		if (!has(`${from} ${oldPath}`) || !has(`${to} ${newPath}`))
			throw new CoverageError(
				"review-coverage-incomplete",
				"rename metadata is incomplete",
			);
	}
	if (
		file.status === "added" &&
		!lines.some((line) => line.startsWith("new file mode "))
	)
		throw new CoverageError(
			"review-coverage-incomplete",
			"add metadata is incomplete",
		);
	if (
		file.status === "deleted" &&
		!lines.some((line) => line.startsWith("deleted file mode "))
	)
		throw new CoverageError(
			"review-coverage-incomplete",
			"delete metadata is incomplete",
		);
	if (
		(file.status === "modified" || file.status === "type-changed") &&
		file.oldMode &&
		file.newMode &&
		file.oldMode !== file.newMode
	) {
		if (!has(`old mode ${file.oldMode}`) || !has(`new mode ${file.newMode}`))
			throw new CoverageError(
				"review-coverage-incomplete",
				"mode metadata is incomplete",
			);
	}
	if (file.oldBlob && file.newBlob && file.oldBlob !== file.newBlob) {
		const indexLine = lines.find((line) => line.startsWith("index "));
		if (!indexLine?.includes(file.oldBlob) || !indexLine.includes(file.newBlob))
			throw new CoverageError(
				"review-coverage-incomplete",
				"blob metadata is incomplete",
			);
	}
}

export async function buildGitInventory(
	repositoryPath: string,
	baseSha: string,
	headSha: string,
): Promise<GitInventory> {
	const result = await observeGitInventory(repositoryPath, baseSha, headSha);
	if (!result.inventory) throw new CoverageError(result.reasonCode);
	return result.inventory;
}

// Only unsupported diff representation is advisory. Git/object/identity errors
// still escape; the merge-base is independently established before observation.
export async function observeGitInventory(
	repositoryPath: string,
	baseSha: string,
	headSha: string,
): Promise<
	{ mergeBaseSha: string } & (
		| { inventory: GitInventory; reasonCode?: never }
		| { inventory?: never; reasonCode: string }
	)
> {
	assertSha(baseSha, "baseSha");
	assertSha(headSha, "headSha");
	if (![40, 64].includes(baseSha.length) || headSha.length !== baseSha.length)
		throw new CoverageError(
			"invalid-identity",
			"Git object formats must match",
		);
	const directory = await mkdtemp(join(tmpdir(), "review-coverage-git-"));
	try {
		// Resolve Git's metadata pointer outside the source repository. This command
		// does not load its config; only its immutable object store is reused below.
		let gitDirectory: string;
		try {
			gitDirectory = await git(directory, [
				"rev-parse",
				"--resolve-git-dir",
				resolve(repositoryPath, ".git"),
			]);
		} catch {
			gitDirectory = await git(directory, [
				"rev-parse",
				"--resolve-git-dir",
				resolve(repositoryPath),
			]);
		}
		gitDirectory = gitDirectory.replace(/\r?\n$/, "");
		let commonDirectory = gitDirectory;
		try {
			const relative = await readFile(join(gitDirectory, "commondir"), "utf8");
			commonDirectory = resolve(gitDirectory, relative.replace(/\r?\n$/, ""));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (/[\r\n]/.test(commonDirectory))
			throw new CoverageError(
				"unsupported-input",
				"Git object path contains a line break",
			);
		await git(directory, [
			"init",
			"--bare",
			"--template=",
			`--object-format=${baseSha.length === 40 ? "sha1" : "sha256"}`,
			"--quiet",
		]);
		await writeFile(
			join(directory, "objects/info/alternates"),
			`${join(commonDirectory, "objects")}\n`,
		);
		const inventory = await buildIsolatedGitInventory(
			directory,
			baseSha,
			headSha,
		);
		return inventory.inventory
			? { ...inventory, inventory: { ...inventory.inventory, repositoryPath } }
			: inventory;
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

async function buildIsolatedGitInventory(
	repositoryPath: string,
	baseSha: string,
	headSha: string,
): Promise<
	{ mergeBaseSha: string } & (
		| { inventory: GitInventory; reasonCode?: never }
		| { inventory?: never; reasonCode: string }
	)
> {
	const mergeBases = String(
		await git(repositoryPath, ["merge-base", "--all", baseSha, headSha]),
	)
		.trim()
		.split(/\s+/)
		.filter(Boolean);
	if (mergeBases.length !== 1)
		throw new CoverageError(
			"ambiguous-merge-base",
			"merge-base must be unique",
		);
	const mergeBaseSha = mergeBases.at(0);
	if (!mergeBaseSha)
		throw new CoverageError("ambiguous-merge-base", "merge-base is missing");
	const raw = String(
		await git(repositoryPath, [
			"diff",
			"--ignore-submodules=none",
			"--raw",
			"-z",
			"--full-index",
			"--no-abbrev",
			"--no-ext-diff",
			"--no-textconv",
			"--find-renames=50%",
			`${mergeBaseSha}..${headSha}`,
			"--",
		]),
	);
	const patch = String(
		await git(repositoryPath, [
			"diff",
			"--ignore-submodules=none",
			"--no-color",
			"--src-prefix=a/",
			"--dst-prefix=b/",
			"--unified=0",
			"--full-index",
			"--no-abbrev",
			"--no-ext-diff",
			"--no-textconv",
			"--find-renames=50%",
			`${mergeBaseSha}..${headSha}`,
			"--",
		]),
	);
	try {
		const files = parseRaw(raw).map((entry) => {
			const oldPath = entry.status === "added" ? null : entry.oldPath;
			const newPath = entry.status === "deleted" ? null : entry.newPath;
			const hunks = parseHunks(patch, { oldPath, newPath });
			const fileValue = {
				oldPath,
				newPath,
				status: entry.status as DiffStatus,
				oldMode: entry.oldMode,
				newMode: entry.newMode,
				oldBlob: entry.oldBlob,
				newBlob: entry.newBlob,
				hunks,
			};
			return { ...fileValue, id: digest(canonical(fileValue)) };
		});
		const inventory = {
			repositoryPath,
			baseSha,
			headSha,
			mergeBaseSha,
			files,
			digest: "",
		};
		inventory.digest = digest(
			canonical({ baseSha, headSha, mergeBaseSha, files }),
		);
		return { mergeBaseSha, inventory };
	} catch (error) {
		if (error instanceof CoverageError && error.code === "unsupported-input") {
			return { mergeBaseSha, reasonCode: error.code };
		}
		throw error;
	}
}

function textValues(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.flatMap(textValues);
	if (!value || typeof value !== "object") return [];
	const record = value as Record<string, unknown>;
	const preferred = [
		"text",
		"input_text",
		"content",
		"input",
		"messages",
		"prompt",
	];
	return preferred.flatMap((key) =>
		key in record ? textValues(record[key]) : [],
	);
}

function extractUnifiedDiff(text: string): string {
	const sections = text
		.split(/^(?=diff --git )/m)
		.map((section) => section.replace(/\r?\n$/, ""))
		.filter((section) => section.startsWith("diff --git "));
	if (sections.length === 0)
		throw new CoverageError(
			"unsupported-transport",
			"request has no unified diff",
		);
	return sections.join("\n");
}

function convertPrAgentDiff(text: string): string {
	const blocks = text
		.split("======")
		.filter((block) => /^\s*## File:/m.test(block));
	const block = blocks.at(-1);
	if (!block)
		throw new CoverageError(
			"unsupported-transport",
			"request has no PR-Agent diff block",
		);
	const fileMatches = [...block.matchAll(/^## File: '([^']+)'\s*$/gm)];
	if (fileMatches.length === 0)
		throw new CoverageError(
			"unsupported-transport",
			"request has no PR-Agent files",
		);
	const sections: string[] = [];
	for (let index = 0; index < fileMatches.length; index += 1) {
		const fileMatch = fileMatches[index];
		const path = fileMatch?.[1];
		if (!path)
			throw new CoverageError("unsupported-transport", "file path is missing");
		if (path.includes("\0") || path.includes("'"))
			throw new CoverageError(
				"unsupported-transport",
				"PR-Agent path quoting is unsupported",
			);
		const start = (fileMatch?.index ?? 0) + fileMatch[0].length;
		const end = fileMatches[index + 1]?.index ?? block.length;
		const fileBlock = block.slice(start, end);
		const hunks = [
			...fileBlock.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*$/gm),
		];
		if (hunks.length === 0)
			throw new CoverageError(
				"unsupported-transport",
				"PR-Agent file has no hunk",
			);
		const output = [
			`diff --git a/${path} b/${path}`,
			`--- a/${path}`,
			`+++ b/${path}`,
		];
		for (let hunkIndex = 0; hunkIndex < hunks.length; hunkIndex += 1) {
			const hunk = hunks[hunkIndex];
			if (!hunk)
				throw new CoverageError(
					"unsupported-transport",
					"hunk header is missing",
				);
			const hunkStart = hunk.index ?? 0;
			const hunkEnd = hunks[hunkIndex + 1]?.index ?? fileBlock.length;
			const hunkBlock = fileBlock.slice(hunkStart, hunkEnd);
			const header = hunk[0];
			if (!header)
				throw new CoverageError(
					"unsupported-transport",
					"hunk header is missing",
				);
			output.push(header);
			const newStart = hunkBlock.indexOf("__new hunk__");
			const oldStart = hunkBlock.indexOf("__old hunk__");
			if (newStart < 0 && oldStart < 0)
				throw new CoverageError(
					"unsupported-transport",
					"PR-Agent hunk body is missing",
				);
			const parseLines = (
				value: string,
				numbered: boolean,
			): Array<{
				number: number | undefined;
				marker: " " | "+" | "-";
				content: string;
			}> =>
				value
					.split(/\r?\n/)
					.slice(1)
					.filter((line) => line.length > 0)
					.map((line) => {
						if (numbered) {
							const match = /^(\d+) (.*)$/.exec(line);
							if (!match)
								throw new CoverageError(
									"unsupported-transport",
									"PR-Agent line number is invalid",
								);
							const number = Number(match[1]);
							if (!Number.isSafeInteger(number) || number < 1)
								throw new CoverageError(
									"unsupported-transport",
									"PR-Agent line number is invalid",
								);
							const content = match[2] ?? "";
							const marker = content.startsWith("+") ? "+" : " ";
							return {
								number,
								marker,
								content:
									content.startsWith("+") || content.startsWith(" ")
										? content.slice(1)
										: content,
							};
						}
						if (!line.startsWith(" ") && !line.startsWith("-"))
							throw new CoverageError(
								"unsupported-transport",
								"PR-Agent old hunk marker is invalid",
							);
						return {
							number: undefined,
							marker: line.startsWith("-") ? "-" : " ",
							content: line.slice(1),
						};
					});
			const newEnd = oldStart >= 0 ? oldStart : hunkBlock.length;
			const newLines =
				newStart >= 0
					? parseLines(hunkBlock.slice(newStart, newEnd), true)
					: [];
			const oldLines =
				oldStart >= 0 ? parseLines(hunkBlock.slice(oldStart), false) : [];
			const expectedNewStart = Number(hunk[3]);
			if (
				!Number.isSafeInteger(expectedNewStart) ||
				newLines.some((line, index) => line.number !== expectedNewStart + index)
			)
				throw new CoverageError(
					"unsupported-transport",
					"PR-Agent line numbers are not contiguous",
				);
			if (newLines.some((line) => line.marker === "-"))
				throw new CoverageError(
					"unsupported-transport",
					"PR-Agent new hunk has removal marker",
				);
			const mergedLines: string[] = [];
			let newIndex = 0;
			let oldIndex = 0;
			while (newIndex < newLines.length || oldIndex < oldLines.length) {
				const nextNew = newLines[newIndex];
				const nextOld = oldLines[oldIndex];
				if (
					nextNew?.marker === " " &&
					nextOld?.marker === " " &&
					nextNew.content === nextOld.content
				) {
					mergedLines.push(` ${nextNew.content}`);
					newIndex += 1;
					oldIndex += 1;
				} else if (nextOld?.marker === "-") {
					mergedLines.push(`-${nextOld.content}`);
					oldIndex += 1;
				} else if (nextNew?.marker === "+") {
					mergedLines.push(`+${nextNew.content}`);
					newIndex += 1;
				} else {
					throw new CoverageError(
						"unsupported-transport",
						"PR-Agent hunk sides do not align",
					);
				}
			}
			output.push(...mergedLines);
		}
		sections.push(output.join("\n"));
	}
	return sections.join("\n");
}

function parseRequestDiff(
	body: string,
	strictResponses = false,
): { diff: string; native: boolean } {
	const parsed = parseJson(body);
	if (!parsed || typeof parsed !== "object")
		throw new CoverageError("unsupported-transport", "request is not JSON");
	const record = parsed as Record<string, unknown>;
	if (
		strictResponses &&
		(!Array.isArray(record.input) ||
			record.input.length === 0 ||
			"diff" in record)
	)
		throw new CoverageError(
			"unsupported-transport",
			"production recorder requires Responses input",
		);
	if (typeof record.diff === "string") {
		if (
			record.diff.includes("## File:") &&
			record.diff.includes("__new hunk__")
		)
			return { diff: convertPrAgentDiff(record.diff), native: true };
		return { diff: extractUnifiedDiff(record.diff), native: false };
	}
	const texts = textValues(record.input ?? record.messages ?? record.prompt);
	if (texts.length === 0)
		throw new CoverageError(
			"unsupported-transport",
			"request has no Responses input",
		);
	const combined = texts.join("\n");
	return {
		diff:
			combined.includes("## File:") && combined.includes("__new hunk__")
				? convertPrAgentDiff(combined)
				: (() => {
						throw new CoverageError(
							"unsupported-transport",
							"Responses input is not the fixed PR-Agent diff format",
						);
					})(),
		native: true,
	};
}

function matchDiff(
	inventory: GitInventory,
	diff: string,
	native = false,
): { fileIds: string[]; hunkIds: string[] } {
	const matched: string[] = [];
	const matchedHunks: string[] = [];
	const sections = patchSections(diff);
	const expectedSections = new Map(
		inventory.files.map((file) => [
			`diff --git a/${file.oldPath ?? file.newPath} b/${file.newPath ?? file.oldPath}`,
			file,
		]),
	);
	const seenFiles = new Set<string>();
	if (sections.length === 0)
		throw new CoverageError(
			"review-coverage-incomplete",
			"request has no diff sections",
		);
	for (const section of sections) {
		const header = section.split(/\r?\n/, 1)[0] ?? "";
		const file = expectedSections.get(header);
		if (!file)
			throw new CoverageError(
				"review-coverage-incomplete",
				"request contains unknown file",
			);
		if (seenFiles.has(file.id))
			throw new CoverageError(
				"review-coverage-incomplete",
				"request repeats a file section",
			);
		seenFiles.add(file.id);
		if (!native) assertFileMetadata(section, file);
		else if (
			(file.status === "modified" && file.oldMode !== file.newMode) ||
			file.status === "renamed" ||
			file.status === "copied" ||
			file.status === "type-changed"
		)
			throw new CoverageError(
				"review-coverage-incomplete",
				"PR-Agent native format omits required file metadata",
			);
		const requestHunks = parseHunksFromSection(section);
		const expectedChanged = file.hunks.flatMap((hunk) =>
			hunk.lines.map((line) => ({
				side: line.side,
				line: line.line,
				contentSha256: line.contentSha256,
				noNewline: line.noNewline,
			})),
		);
		const requestedChanged = requestHunks.flatMap((hunk) =>
			hunk.lines
				.filter((line) => line.side !== undefined)
				.map((line) => ({
					side: line.side,
					line: line.line,
					contentSha256: line.contentSha256,
					noNewline: line.noNewline,
				})),
		);
		const sortLines = (lines: typeof expectedChanged) =>
			lines.toSorted((left, right) =>
				JSON.stringify(left).localeCompare(JSON.stringify(right)),
			);
		if (
			canonical(sortLines(requestedChanged)) !==
			canonical(sortLines(expectedChanged))
		)
			throw new CoverageError(
				"review-coverage-incomplete",
				"hunk changed lines or positions mismatch",
			);
		matchedHunks.push(...file.hunks.map((hunk) => hunk.id));
		matched.push(file.id);
	}
	if (matched.length === 0)
		throw new CoverageError(
			"review-coverage-incomplete",
			"request omitted an authoritative file",
		);
	return { fileIds: matched, hunkIds: matchedHunks };
}

export type ChunkTransport = (
	body: string,
	headers: Record<string, string>,
) => Promise<{
	status: number;
	body: string;
	headers?: Record<string, string>;
}>;

function boundedText(value: unknown, maxBytes: number): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		Buffer.byteLength(value, "utf8") <= maxBytes
	);
}

function parseReviewText(text: string): {
	review: { key_issues_to_review: unknown[] };
} {
	let value: unknown = parseJson(text);
	if (value === undefined) {
		try {
			value = parseYaml(text);
		} catch {
			throw new CoverageError(
				"review-output-invalid",
				"review content is not JSON/YAML",
			);
		}
	}
	if (
		!value ||
		typeof value !== "object" ||
		Object.keys(value).length !== 1 ||
		!("review" in value) ||
		!value.review ||
		typeof value.review !== "object" ||
		!Array.isArray(
			(value.review as { key_issues_to_review?: unknown }).key_issues_to_review,
		)
	)
		throw new CoverageError(
			"review-output-invalid",
			"official review schema is invalid",
		);
	const findings = (value.review as { key_issues_to_review: unknown[] })
		.key_issues_to_review;
	if (findings.length > 10)
		throw new CoverageError(
			"review-output-invalid",
			"official review findings exceed the bounded schema",
		);
	for (const finding of findings) {
		const item =
			finding && typeof finding === "object"
				? (finding as Record<string, unknown>)
				: undefined;
		if (
			!item ||
			!boundedText(item.relevant_file, 1024) ||
			!boundedText(item.issue_header, 200) ||
			!boundedText(item.issue_content, 4000) ||
			!Number.isSafeInteger(item.start_line) ||
			!Number.isSafeInteger(item.end_line) ||
			(item.start_line as number) < 1 ||
			(item.end_line as number) < (item.start_line as number)
		)
			throw new CoverageError(
				"review-output-invalid",
				"official review finding is invalid",
			);
	}
	return value as { review: { key_issues_to_review: unknown[] } };
}

function summarizeParsedResult(parsed: unknown): ParsedResultSummary {
	const review = parsed as {
		review: { key_issues_to_review: unknown[] };
	};
	return {
		schema: "pr-agent-review",
		findingCount: review.review.key_issues_to_review.length,
		digest: digest(canonical(parsed)),
	};
}

function extractResponseText(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.flatMap(extractResponseText);
	if (!value || typeof value !== "object") return [];
	const record = value as Record<string, unknown>;
	const chunks: string[] = [];
	if (typeof record.text === "string") chunks.push(record.text);
	if (typeof record.content === "string") chunks.push(record.content);
	if (record.content && typeof record.content === "object")
		chunks.push(...extractResponseText(record.content));
	if (record.output) chunks.push(...extractResponseText(record.output));
	if (record.message) chunks.push(...extractResponseText(record.message));
	if (record.delta) chunks.push(...extractResponseText(record.delta));
	if (record.choices) chunks.push(...extractResponseText(record.choices));
	return chunks;
}

function extractResponsesOutput(value: unknown): string[] {
	if (!value || typeof value !== "object") return [];
	const output = (value as Record<string, unknown>).output;
	if (!Array.isArray(output)) return [];
	const texts: string[] = [];
	for (const item of output) {
		if (!item || typeof item !== "object") continue;
		if ((item as Record<string, unknown>).type !== "message") continue;
		const content = (item as Record<string, unknown>).content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (
				part &&
				typeof part === "object" &&
				(part as Record<string, unknown>).type === "output_text" &&
				typeof (part as Record<string, unknown>).text === "string"
			)
				texts.push((part as Record<string, string>).text as string);
		}
	}
	return texts;
}

function parseOfficialResponse(body: string, strictResponses = false): unknown {
	const trimmed = body.trim();
	if (!trimmed)
		throw new CoverageError("review-output-invalid", "empty response");
	if (trimmed.split(/\r?\n/).some((line) => line.startsWith("data:"))) {
		let completed = false;
		const deltaParts: string[] = [];
		const completedParts: string[] = [];
		for (const line of trimmed.split(/\r?\n/)) {
			if (!line.startsWith("data:")) continue;
			const data = line.slice(5).trim();
			if (data === "[DONE]") {
				continue;
			}
			const event = parseJson(data);
			if (!event)
				throw new CoverageError(
					"review-output-invalid",
					"stream data is not JSON",
				);
			const type =
				typeof event === "object" && event
					? (event as { type?: unknown }).type
					: undefined;
			if (
				type === "response.failed" ||
				type === "response.incomplete" ||
				type === "response.cancelled"
			)
				throw new CoverageError(
					"review-output-invalid",
					"stream ended without a completed response",
				);
			if (type === "response.completed" || type === "response.done") {
				const terminal =
					typeof event === "object" && event
						? ((event as { response?: unknown }).response ?? event)
						: event;
				const status =
					typeof terminal === "object" && terminal
						? (terminal as { status?: unknown }).status
						: undefined;
				if (status !== "completed")
					throw new CoverageError(
						"review-output-invalid",
						"stream ended without a completed response",
					);
				if (strictResponses) {
					if (
						!terminal ||
						typeof terminal !== "object" ||
						(terminal as Record<string, unknown>).object !== "response" ||
						extractResponsesOutput(terminal).length === 0
					)
						throw new CoverageError(
							"review-output-invalid",
							"completed Responses envelope has no output text",
						);
					completedParts.push(...extractResponsesOutput(terminal));
				} else completedParts.push(...extractResponseText(terminal));
				completed = true;
			} else if (type === "response.output_text.delta") {
				const delta =
					typeof event === "object" && event
						? (event as { delta?: unknown }).delta
						: undefined;
				if (typeof delta === "string") deltaParts.push(delta);
			} else if (
				type === "response.output_text.done" &&
				deltaParts.length === 0
			) {
				const text =
					typeof event === "object" && event
						? (event as { text?: unknown }).text
						: undefined;
				if (typeof text === "string") deltaParts.push(text);
			}
		}
		if (!completed)
			throw new CoverageError(
				"review-output-invalid",
				"stream did not complete",
			);
		if (
			strictResponses &&
			deltaParts.length > 0 &&
			deltaParts.join("") !== completedParts.join("")
		)
			throw new CoverageError(
				"review-output-invalid",
				"streamed text differs from completed response",
			);
		const text = (deltaParts.length > 0 ? deltaParts : completedParts).join("");
		return parseReviewText(text);
	}
	const value = parseJson(trimmed);
	if (!value)
		throw new CoverageError("review-output-invalid", "response is not JSON");
	const record = value as Record<string, unknown>;
	if (
		strictResponses &&
		(record.object !== "response" ||
			record.status !== "completed" ||
			!Array.isArray(record.output))
	)
		throw new CoverageError(
			"review-output-invalid",
			"production recorder requires a completed Responses envelope",
		);
	const status = record.status;
	const finishReason = (
		record.choices as Array<Record<string, unknown>> | undefined
	)?.[0]?.finish_reason;
	if (status !== "completed" && finishReason !== "stop")
		throw new CoverageError(
			"review-output-invalid",
			"response did not complete",
		);
	const text = (
		strictResponses ? extractResponsesOutput(value) : extractResponseText(value)
	).join("");
	if (!text)
		throw new CoverageError(
			"review-output-invalid",
			"Responses output is empty",
		);
	return parseReviewText(text);
}

export interface RecordingProxyOptions {
	inventory?: GitInventory;
	observationOnly?: boolean;
	upstreamBaseUrl: string;
	transportHeaders?: Record<string, string>;
	maxRequestBytes?: number;
	maxResponseBytes?: number;
	upstreamTimeoutMs?: number;
}

async function readRequestBody(
	request: IncomingMessage,
	maxBytes: number,
): Promise<string> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += bytes.byteLength;
		if (size > maxBytes)
			throw new CoverageError(
				"review-input-incomplete",
				"request exceeds bounded input",
			);
		chunks.push(bytes);
	}
	return Buffer.concat(chunks).toString("utf8");
}

async function readResponseBody(
	response: Response,
	maxBytes: number,
): Promise<Uint8Array> {
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isSafeInteger(declaredLength) && declaredLength > maxBytes)
		throw new CoverageError(
			"review-output-invalid",
			"response exceeds bounded output",
		);
	const reader = response.body?.getReader();
	if (!reader) {
		if (declaredLength !== 0)
			throw new CoverageError(
				"review-output-invalid",
				"response exceeds bounded output",
			);
		return new Uint8Array();
	}
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;
		size += value.byteLength;
		if (size > maxBytes) {
			await reader.cancel();
			throw new CoverageError(
				"review-output-invalid",
				"response exceeds bounded output",
			);
		}
		chunks.push(value);
	}
	const result = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result;
}

function requestHeaders(
	request: IncomingMessage,
	extra: Record<string, string>,
): Record<string, string> {
	const headers: Record<string, string> = { ...extra };
	for (const [key, value] of Object.entries(request.headers)) {
		if (typeof value === "string" && key !== "host" && key !== "content-length")
			headers[key] = value;
	}
	return headers;
}

function relativeUpstreamUrl(path: string, upstream: URL): URL {
	if (
		!path.startsWith("/") ||
		path.startsWith("//") ||
		path.includes("\\") ||
		[...path].some((character) => {
			const code = character.charCodeAt(0);
			return code < 0x20 || code === 0x7f;
		})
	)
		throw new CoverageError(
			"unsupported-transport",
			"request path must be relative",
		);
	const target = new URL(path, upstream);
	if (target.origin !== upstream.origin)
		throw new CoverageError(
			"unsupported-transport",
			"request path escaped upstream",
		);
	return target;
}

export async function startRecordingProxy(
	options: RecordingProxyOptions,
): Promise<{
	server: ReturnType<typeof createServer>;
	port: number;
	results: () => ChunkResult[];
	failedChunks: () => FailedChunk[];
	observationFailure: () => string | undefined;
	transportFailure: () => string | undefined;
	close: () => Promise<void>;
}> {
	const upstream = new URL(options.upstreamBaseUrl);
	if (!/^https?:$/.test(upstream.protocol))
		throw new CoverageError(
			"invalid-recorder-config",
			"upstream must be HTTP(S)",
		);
	const maxRequestBytes = options.maxRequestBytes ?? 32 * 1024 * 1024;
	const maxResponseBytes = options.maxResponseBytes ?? 32 * 1024 * 1024;
	const upstreamTimeoutMs = options.upstreamTimeoutMs ?? 120_000;
	if (
		!Number.isSafeInteger(maxRequestBytes) ||
		maxRequestBytes < 1 ||
		!Number.isSafeInteger(maxResponseBytes) ||
		maxResponseBytes < 1 ||
		!Number.isSafeInteger(upstreamTimeoutMs) ||
		upstreamTimeoutMs < 1
	)
		throw new CoverageError("invalid-recorder-config");
	const activeRequests = new Set<AbortController>();
	let closing = false;
	if (!options.inventory && !options.observationOnly)
		throw new CoverageError("invalid-recorder-config");
	let observationFailure: string | undefined;
	let transportFailure: string | undefined;
	const observedResults = new Map<string, ChunkResult>();
	const observedAttempts = new Map<
		string,
		{ digest: string; attempts: number }
	>();
	const transport: ChunkTransport = async (forwardedBody, headers) => {
		if (closing)
			throw new CoverageError("review-run-failed", "recorder is closing");
		const chunkId = headers["x-review-chunk-id"];
		if (typeof chunkId !== "string")
			throw new CoverageError(
				"invalid-chunk",
				"forwarded chunk identity is missing",
			);
		const path = headers["x-review-forward-path"] ?? "/";
		delete headers["x-review-forward-path"];
		delete headers["x-review-chunk-id"];
		const target = relativeUpstreamUrl(path, upstream);
		const controller = new AbortController();
		activeRequests.add(controller);
		const timeout = setTimeout(() => controller.abort(), upstreamTimeoutMs);
		try {
			const upstreamResponse = await fetch(target, {
				method: "POST",
				headers,
				body: forwardedBody,
				redirect: "error",
				signal: controller.signal,
			});
			const rawBody = await readResponseBody(
				upstreamResponse,
				maxResponseBytes,
			);
			const body = new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
			const responseHeaders: Record<string, string> = {};
			upstreamResponse.headers.forEach((value, key) => {
				responseHeaders[key] = value;
			});
			const result = {
				status: upstreamResponse.status,
				body,
				headers: responseHeaders,
			};
			rawResponses.set(`${chunkId}:${digest(forwardedBody)}`, {
				status: result.status,
				body: rawBody,
				headers: responseHeaders,
			});
			return result;
		} finally {
			clearTimeout(timeout);
			activeRequests.delete(controller);
		}
	};
	const recorder = options.inventory
		? new JobLocalRecorder({
				inventory: options.inventory,
				maxRetries: 1,
				requireResponses: true,
				transport,
			})
		: undefined;

	const rawResponses = new Map<
		string,
		{ status: number; body: Uint8Array; headers: Record<string, string> }
	>();
	const server = createServer(
		async (request: IncomingMessage, response: ServerResponse) => {
			try {
				if (closing)
					throw new CoverageError("review-run-failed", "recorder is closing");
				if (request.method !== "POST")
					throw new CoverageError(
						"unsupported-transport",
						"only POST is supported",
					);
				const body = await readRequestBody(request, maxRequestBytes);
				const suppliedChunkId = request.headers["x-review-chunk-id"];
				if (
					suppliedChunkId !== undefined &&
					(typeof suppliedChunkId !== "string" ||
						!/^chunk-[a-z0-9-]+$/.test(suppliedChunkId))
				)
					throw new CoverageError(
						"invalid-chunk",
						"x-review-chunk-id is invalid",
					);
				const chunkId =
					typeof suppliedChunkId === "string"
						? suppliedChunkId
						: `chunk-${digest(body).slice(0, 32)}`;
				const headers = requestHeaders(request, options.transportHeaders ?? {});
				const requestPath = request.url ?? "/";
				relativeUpstreamUrl(requestPath, upstream);
				headers["x-review-chunk-id"] = chunkId;
				headers["x-review-forward-path"] = requestPath;
				const chunkRequest = { chunkId, body, headers };
				if (options.observationOnly) {
					const bodyDigest = digest(body);
					const prior = observedAttempts.get(chunkId);
					if (prior && prior.digest !== bodyDigest)
						throw new CoverageError("review-coverage-incomplete");
					const attempts = prior?.attempts ?? 0;
					if (
						(attempts === 0 && observedAttempts.size >= MAX_CHUNKS) ||
						attempts >= 2
					)
						throw new CoverageError("review-coverage-incomplete");
					observedAttempts.set(chunkId, {
						digest: bodyDigest,
						attempts: attempts + 1,
					});
					// Exactly one actual upstream call. Observation never retries a model
					// request or substitutes an error for an independently valid response.
					const upstreamResult = await transport(body, { ...headers });
					try {
						if (!options.inventory)
							throw new CoverageError("review-coverage-incomplete");
						const result = await recordChunk(
							options.inventory,
							chunkRequest,
							async () => upstreamResult,
							true,
						);
						// A late earlier attempt must not overwrite the latest dispatched
						// response or undercount calls after concurrent native retries.
						if (observedAttempts.get(chunkId)?.attempts === attempts + 1)
							observedResults.set(chunkId, {
								...result,
								attempts: attempts + 1,
							});
					} catch (error) {
						observationFailure =
							error instanceof CoverageError
								? error.code
								: "review-output-invalid";
					}
				} else {
					await recorder?.record(chunkRequest);
				}
				const rawKey = `${chunkId}:${digest(body)}`;
				const raw = rawResponses.get(rawKey);
				if (!raw)
					throw new CoverageError(
						"review-output-invalid",
						"raw upstream response was not captured",
					);
				const responseHeaders = { ...raw.headers };
				delete responseHeaders.connection;
				delete responseHeaders["transfer-encoding"];
				delete responseHeaders["keep-alive"];
				delete responseHeaders.upgrade;
				// fetch transparently decodes content-encoding; replay the decoded bytes
				// without advertising the stale encoding to the Analysis client.
				delete responseHeaders["content-encoding"];
				responseHeaders["content-length"] = String(raw.body.byteLength);
				response.writeHead(raw.status, responseHeaders);
				response.end(Buffer.from(raw.body));
			} catch (error) {
				const code =
					error instanceof CoverageError ? error.code : "review-run-failed";
				if (options.observationOnly) transportFailure = code;
				response.writeHead(502, { "content-type": "application/json" });
				response.end(JSON.stringify({ error: code }));
			}
		},
	);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	if (!address || typeof address === "string")
		throw new CoverageError(
			"invalid-recorder-config",
			"proxy did not bind a TCP port",
		);
	return {
		server,
		port: address.port,
		results: () =>
			options.observationOnly
				? [...observedResults.values()]
				: (recorder?.results() ?? []),
		failedChunks: () =>
			options.observationOnly ? [] : (recorder?.failedChunks() ?? []),
		observationFailure: () => observationFailure,
		transportFailure: () => transportFailure,
		close: () =>
			new Promise((resolve, reject) => {
				closing = true;
				for (const controller of activeRequests) controller.abort();
				server.closeAllConnections?.();
				server.close((error) => (error ? reject(error) : resolve()));
			}),
	};
}

export async function recordChunk(
	inventory: GitInventory,
	request: ChunkRequest,
	transport: ChunkTransport,
	requireResponses = false,
): Promise<ChunkResult> {
	if (!/^chunk-[a-z0-9-]+$/.test(request.chunkId))
		throw new CoverageError("invalid-chunk", "chunk id is invalid");
	const parsedRequest = parseRequestDiff(request.body, requireResponses);
	const matched = matchDiff(
		inventory,
		parsedRequest.diff,
		parsedRequest.native,
	);
	const response = await transport(request.body, { ...request.headers });
	if (response.status < 200 || response.status >= 300)
		throw new CoverageError(
			"review-output-invalid",
			`upstream status ${response.status}`,
		);
	const parsed = parseOfficialResponse(response.body, requireResponses);
	return {
		chunkId: request.chunkId,
		requestSha256: digest(request.body),
		matchedFileIds: matched.fileIds,
		matchedHunkIds: matched.hunkIds,
		responseSha256: digest(response.body),
		attempts: 1,
		callStatus: "succeeded",
		responseStatus: response.status,
		response: parsed,
		parsedResult: summarizeParsedResult(parsed),
	};
}

function validateRuntimeIdentity(
	identity: Pick<
		RecorderIdentity,
		| "reviewer"
		| "runtimeKind"
		| "sourceCommit"
		| "patchSha256"
		| "buildProvenance"
		| "imageDigest"
		| "provider"
		| "tokenCap"
	>,
): void {
	if (identity.reviewer !== "pr-agent")
		throw new CoverageError("provider-mismatch", "unsupported reviewer");
	if (identity.tokenCap !== 300000)
		throw new CoverageError(
			"review-output-invalid",
			"token cap must remain 300000",
		);
	if (!/^sha256:[0-9a-f]{64}$/i.test(identity.imageDigest))
		throw new CoverageError("review-output-invalid", "image digest is invalid");
	if (identity.runtimeKind === "derived") {
		if (identity.provider !== "plain-diff-derived")
			throw new CoverageError(
				"provider-mismatch",
				"derived runtime provider mismatch",
			);
		if (
			!identity.sourceCommit ||
			!identity.patchSha256 ||
			!identity.buildProvenance
		)
			throw new CoverageError(
				"review-output-invalid",
				"derived runtime provenance is incomplete",
			);
		assertSha(identity.sourceCommit, "sourceCommit");
		if (!/^[0-9a-f]{64}$/i.test(identity.patchSha256))
			throw new CoverageError(
				"review-output-invalid",
				"patchSha256 is invalid",
			);
		if (
			identity.buildProvenance.imageDigest !== identity.imageDigest ||
			identity.buildProvenance.patchSha256 !== identity.patchSha256 ||
			identity.buildProvenance.buildCommit !== identity.sourceCommit
		)
			throw new CoverageError(
				"review-output-invalid",
				"derived provenance does not match runtime identity",
			);
	} else if (
		identity.provider === "plain-diff-derived" ||
		identity.sourceCommit ||
		identity.patchSha256 ||
		identity.buildProvenance
	) {
		throw new CoverageError(
			"review-output-invalid",
			"derived identity cannot be attached to official runtime",
		);
	}
}

export function serializeMetadata(metadata: CoverageMetadata): string {
	validateRuntimeIdentity(metadata);
	if (
		!/^[0-9a-f]{64}$/i.test(metadata.diffSha256) ||
		!Number.isSafeInteger(metadata.diffBytes) ||
		metadata.diffBytes < 1
	)
		throw new CoverageError(
			"review-output-invalid",
			"diff scope fingerprint is invalid",
		);
	if (
		metadata.version !== 1 ||
		metadata.chunks.length > MAX_CHUNKS ||
		metadata.plannedChunkIds.length > MAX_CHUNKS ||
		new Set(metadata.plannedChunkIds).size !==
			metadata.plannedChunkIds.length ||
		metadata.plannedChunkIds.length !==
			metadata.chunks.length + metadata.failedChunks.length ||
		!/^[0-9a-f]{64}$/i.test(metadata.mergedOutputSha256)
	)
		throw new CoverageError(
			"review-output-invalid",
			"metadata contract is invalid",
		);
	if (metadata.chunks.some((chunk) => chunk.matchedFileIds.length === 0))
		throw new CoverageError(
			"review-coverage-incomplete",
			"chunk has no complete coverage",
		);
	const chunkIds = metadata.chunks.map((chunk) => chunk.chunkId);
	if (
		new Set(chunkIds).size !== chunkIds.length ||
		metadata.chunks.some(
			(chunk) =>
				!/^[0-9a-f]{64}$/i.test(chunk.requestSha256) ||
				!/^[0-9a-f]{64}$/i.test(chunk.responseSha256) ||
				!/^chunk-[a-z0-9-]+$/.test(chunk.chunkId),
		) ||
		metadata.failedChunks.some(
			(chunk) =>
				!/^chunk-[a-z0-9-]+$/.test(chunk.chunkId) ||
				!Number.isSafeInteger(chunk.attempts) ||
				chunk.attempts < 1 ||
				!chunk.reasonCode,
		) ||
		metadata.successfulResponseSha256.some(
			(hash) => !/^[0-9a-f]{64}$/i.test(hash),
		)
	)
		throw new CoverageError(
			"review-output-invalid",
			"chunk summary contains invalid digests",
		);
	const persistedChunks = metadata.chunks.map((chunk) => {
		if (chunk.response === undefined)
			throw new CoverageError(
				"review-output-invalid",
				"chunk parsed result is missing",
			);
		const parsedResult = summarizeParsedResult(chunk.response);
		return {
			...chunk,
			response: undefined,
			parsedResult,
		};
	});
	const persisted = {
		...metadata,
		chunks: persistedChunks,
		inventory: { ...metadata.inventory, repositoryPath: undefined },
	};
	const text = `${canonical(persisted)}\n`;
	if (Buffer.byteLength(text, "utf8") > MAX_METADATA_BYTES)
		throw new CoverageError(
			"metadata-too-large",
			"coverage metadata exceeds 256 KiB",
		);
	return text;
}

function inventoryDigest(
	inventory: Pick<
		GitInventory,
		"baseSha" | "headSha" | "mergeBaseSha" | "files"
	>,
): string {
	return digest(
		canonical({
			baseSha: inventory.baseSha,
			headSha: inventory.headSha,
			mergeBaseSha: inventory.mergeBaseSha,
			files: inventory.files,
		}),
	);
}

export function verifyShadowMetadata(
	metadataText: string,
	expected: Pick<
		RecorderIdentity,
		| "repositoryId"
		| "repositoryName"
		| "pullRequest"
		| "baseSha"
		| "headSha"
		| "mergeBaseSha"
		| "workflowRunId"
		| "runAttempt"
		| "analysisJobId"
		| "provider"
		| "imageDigest"
		| "reviewer"
		| "runtimeKind"
		| "recorderVersion"
		| "templateVersion"
		| "transportVersion"
		| "tokenCap"
		| "diffSha256"
		| "diffBytes"
	> &
		Partial<
			Pick<RecorderIdentity, "sourceCommit" | "patchSha256" | "buildProvenance">
		> & {
			mergedOutputSha256: string;
			successfulResponseSha256: string[];
		},
	inventory: GitInventory,
): CoverageMetadata {
	if (Buffer.byteLength(metadataText, "utf8") > MAX_METADATA_BYTES)
		throw new CoverageError("metadata-too-large");
	let metadata: CoverageMetadata;
	try {
		metadata = JSON.parse(metadataText) as CoverageMetadata;
	} catch {
		throw new CoverageError("review-output-invalid", "metadata is not JSON");
	}
	validateRuntimeIdentity(metadata);
	for (const key of [
		"repositoryId",
		"repositoryName",
		"pullRequest",
		"workflowRunId",
		"runAttempt",
		"analysisJobId",
		"provider",
		"imageDigest",
		"reviewer",
		"runtimeKind",
		"recorderVersion",
		"templateVersion",
		"transportVersion",
		"tokenCap",
		"diffSha256",
		"diffBytes",
	] as const)
		if (metadata[key] !== expected[key])
			throw new CoverageError(
				"review-output-invalid",
				`identity mismatch: ${key}`,
			);
	for (const key of ["baseSha", "headSha", "mergeBaseSha"] as const)
		if (metadata[key] !== expected[key])
			throw new CoverageError(
				"review-output-invalid",
				`identity mismatch: ${key}`,
			);
	if (
		metadata.inventory.digest !== inventory.digest ||
		metadata.inventory.digest !== inventoryDigest(metadata.inventory) ||
		metadata.inventory.files.length !== inventory.files.length
	)
		throw new CoverageError("review-output-invalid", "inventory mismatch");
	if (
		!/^[0-9a-f]{64}$/i.test(metadata.diffSha256) ||
		!Number.isSafeInteger(metadata.diffBytes) ||
		metadata.diffBytes < 1 ||
		metadata.diffSha256 !== expected.diffSha256 ||
		metadata.diffBytes !== expected.diffBytes
	)
		throw new CoverageError(
			"review-output-invalid",
			"diff scope fingerprint mismatch",
		);
	if (
		expected.runtimeKind === "derived" &&
		(!expected.sourceCommit ||
			!expected.patchSha256 ||
			!expected.buildProvenance)
	)
		throw new CoverageError(
			"review-output-invalid",
			"derived expected provenance is incomplete",
		);
	for (const key of [
		"sourceCommit",
		"patchSha256",
		"buildProvenance",
	] as const) {
		if (
			key in expected &&
			canonical(metadata[key]) !== canonical(expected[key])
		)
			throw new CoverageError(
				"review-output-invalid",
				`identity mismatch: ${key}`,
			);
	}
	if (metadata.mergedOutputSha256 !== expected.mergedOutputSha256)
		throw new CoverageError(
			"review-output-invalid",
			"merged output digest mismatch",
		);
	if (
		canonical(metadata.successfulResponseSha256) !==
		canonical(expected.successfulResponseSha256)
	)
		throw new CoverageError(
			"review-output-invalid",
			"response digest set mismatch",
		);
	const fileIds = new Set(inventory.files.map((file) => file.id));
	const covered = new Set(
		metadata.chunks.flatMap((chunk) => chunk.matchedFileIds),
	);
	const hunkIds = new Set(
		inventory.files.flatMap((file) => file.hunks.map((hunk) => hunk.id)),
	);
	const coveredHunks = new Set(
		metadata.chunks.flatMap((chunk) => chunk.matchedHunkIds),
	);
	if (
		metadata.plannedChunkIds.length !==
			metadata.chunks.length + metadata.failedChunks.length ||
		new Set(metadata.plannedChunkIds).size !==
			metadata.plannedChunkIds.length ||
		metadata.failedChunks.length > 0 ||
		metadata.plannedChunkIds.some(
			(id) => !metadata.chunks.some((chunk) => chunk.chunkId === id),
		) ||
		metadata.chunks.length === 0 ||
		metadata.chunks.length > MAX_CHUNKS ||
		[...fileIds].some((id) => !covered.has(id)) ||
		[...hunkIds].some((id) => !coveredHunks.has(id))
	)
		throw new CoverageError(
			"review-coverage-incomplete",
			"not every authoritative file/hunk was covered",
		);
	const knownFileIds = new Set(inventory.files.map((file) => file.id));
	const knownHunkIds = new Set(
		inventory.files.flatMap((file) => file.hunks.map((hunk) => hunk.id)),
	);
	for (const chunk of metadata.chunks) {
		if (
			!/^chunk-[a-z0-9-]+$/.test(chunk.chunkId) ||
			new Set(chunk.matchedFileIds).size !== chunk.matchedFileIds.length ||
			new Set(chunk.matchedHunkIds).size !== chunk.matchedHunkIds.length ||
			chunk.matchedFileIds.some((id) => !knownFileIds.has(id)) ||
			chunk.matchedHunkIds.some((id) => !knownHunkIds.has(id)) ||
			!/^[0-9a-f]{64}$/i.test(chunk.responseSha256) ||
			!/^[0-9a-f]{64}$/i.test(chunk.requestSha256) ||
			chunk.callStatus !== "succeeded" ||
			chunk.responseStatus < 200 ||
			chunk.responseStatus >= 300 ||
			chunk.parsedResult?.schema !== "pr-agent-review" ||
			!Number.isSafeInteger(chunk.parsedResult?.findingCount) ||
			(chunk.parsedResult?.findingCount ?? -1) < 0 ||
			!/^[0-9a-f]{64}$/i.test(chunk.parsedResult?.digest ?? "") ||
			!Number.isSafeInteger(chunk.attempts) ||
			chunk.attempts < 1
		)
			throw new CoverageError(
				"review-output-invalid",
				"chunk summary contains unknown or duplicate IDs",
			);
	}
	for (const chunk of metadata.failedChunks) {
		if (
			!/^chunk-[a-z0-9-]+$/.test(chunk.chunkId) ||
			!Number.isSafeInteger(chunk.attempts) ||
			chunk.attempts < 1 ||
			!chunk.reasonCode
		)
			throw new CoverageError(
				"review-output-invalid",
				"failed chunk summary is invalid",
			);
	}
	if (
		metadata.successfulResponseSha256.length !== metadata.chunks.length ||
		metadata.successfulResponseSha256.some(
			(hash) => !metadata.chunks.some((chunk) => chunk.responseSha256 === hash),
		)
	)
		throw new CoverageError(
			"review-output-invalid",
			"response summary set does not match chunks",
		);
	return metadata;
}

export interface JobLocalRecorderOptions {
	inventory: GitInventory;
	transport: ChunkTransport;
	maxChunks?: number;
	maxRetries?: number;
	requireResponses?: boolean;
}

export class JobLocalRecorder {
	private readonly completedResults = new Map<string, ChunkResult>();
	private readonly requestDigests = new Map<string, string>();
	private readonly failures = new Map<string, FailedChunk>();
	private readonly attempts = new Map<string, number>();
	private readonly inFlight = new Map<string, Promise<ChunkResult>>();
	private readonly maxChunks: number;
	private readonly maxRetries: number;
	private terminalFailure: CoverageError | undefined;
	constructor(private readonly options: JobLocalRecorderOptions) {
		this.maxChunks = options.maxChunks ?? MAX_CHUNKS;
		this.maxRetries = options.maxRetries ?? 1;
		if (
			!Number.isSafeInteger(this.maxChunks) ||
			this.maxChunks < 1 ||
			this.maxChunks > MAX_CHUNKS ||
			!Number.isSafeInteger(this.maxRetries) ||
			this.maxRetries < 0 ||
			this.maxRetries > MAX_RETRIES
		)
			throw new CoverageError("invalid-recorder-config");
	}
	async record(request: ChunkRequest): Promise<ChunkResult> {
		if (this.terminalFailure) throw this.terminalFailure;
		const requestSha256 = digest(request.body);
		const priorDigest = this.requestDigests.get(request.chunkId);
		if (priorDigest && priorDigest !== requestSha256)
			throw new CoverageError(
				"review-coverage-incomplete",
				"logical chunk body changed",
			);
		const prior = this.completedResults.get(request.chunkId);
		if (prior) return prior;
		const active = this.inFlight.get(request.chunkId);
		if (active) return active;
		const failed = this.failures.get(request.chunkId);
		if (failed)
			throw new CoverageError(
				failed.reasonCode,
				"logical chunk retry budget exhausted",
			);
		const isNew = !priorDigest;
		if (isNew && this.requestDigests.size >= this.maxChunks) {
			this.terminalFailure = new CoverageError(
				"review-coverage-incomplete",
				"logical chunk limit exceeded",
			);
			throw this.terminalFailure;
		}
		// Reserve synchronously before the first await. This is the logical chunk budget.
		this.requestDigests.set(request.chunkId, requestSha256);
		const work = (async () => {
			let lastError: unknown;
			for (;;) {
				const attempt = (this.attempts.get(request.chunkId) ?? 0) + 1;
				this.attempts.set(request.chunkId, attempt);
				try {
					const result = await recordChunk(
						this.options.inventory,
						request,
						this.options.transport,
						this.options.requireResponses,
					);
					const completed = { ...result, attempts: attempt };
					this.completedResults.set(request.chunkId, completed);
					this.failures.delete(request.chunkId);
					return completed;
				} catch (error) {
					lastError = error;
					const retryable =
						!(error instanceof CoverageError) ||
						error.code === "git-failed" ||
						error.code === "review-output-invalid";
					if (!retryable || attempt > this.maxRetries) break;
				}
			}
			const reasonCode =
				lastError instanceof CoverageError
					? lastError.code
					: "review-run-failed";
			const failedChunk = {
				chunkId: request.chunkId,
				attempts: this.attempts.get(request.chunkId) ?? 1,
				reasonCode,
			};
			this.failures.set(request.chunkId, failedChunk);
			throw new CoverageError(reasonCode);
		})();
		this.inFlight.set(request.chunkId, work);
		try {
			return await work;
		} finally {
			this.inFlight.delete(request.chunkId);
		}
	}
	failedChunks(): FailedChunk[] {
		if (this.terminalFailure) throw this.terminalFailure;
		return [...this.failures.values()];
	}
	results(): ChunkResult[] {
		if (this.terminalFailure) throw this.terminalFailure;
		return [...this.completedResults.values()];
	}
}

export function buildCoverageMetadata(
	identity: RecorderIdentity,
	inventory: GitInventory,
	chunks: ChunkResult[],
	mergedOutput: unknown,
	plannedChunkIds = chunks.map((chunk) => chunk.chunkId),
	failedChunks: FailedChunk[] = [],
): CoverageMetadata {
	if (
		chunks.length + failedChunks.length === 0 ||
		chunks.length + failedChunks.length > MAX_CHUNKS ||
		plannedChunkIds.length > MAX_CHUNKS ||
		new Set(plannedChunkIds).size !== plannedChunkIds.length ||
		plannedChunkIds.length !== chunks.length + failedChunks.length
	)
		throw new CoverageError(
			"review-coverage-incomplete",
			"invalid chunk count",
		);
	const merged = parseReviewText(
		typeof mergedOutput === "string"
			? mergedOutput
			: JSON.stringify(mergedOutput),
	);
	const mergedIssues = merged.review.key_issues_to_review;
	const chunkIssues = chunks.flatMap((chunk) =>
		chunk.response === undefined
			? []
			: parseReviewText(
					typeof chunk.response === "string"
						? chunk.response
						: JSON.stringify(chunk.response),
				).review.key_issues_to_review,
	);
	const expectedMergedIssues = mergeFindingUnion([chunkIssues]);
	if (canonical(mergedIssues) !== canonical(expectedMergedIssues))
		throw new CoverageError(
			"review-output-invalid",
			"merged output does not match chunk responses",
		);
	return {
		version: 1,
		...identity,
		inventory,
		plannedChunkIds,
		chunks,
		failedChunks,
		mergedOutputSha256: digest(canonical(mergedOutput)),
		successfulResponseSha256: chunks.map((chunk) => chunk.responseSha256),
	};
}

export const limits = {
	maxChunks: MAX_CHUNKS,
	maxMetadataBytes: MAX_METADATA_BYTES,
} as const;

// The preparation step owns a private directory outside native container mounts.
// Exclusive creation prevents replacing any prior observation; readers run only
// after this writer has closed the file.
export async function writeShadowMetadataFile(
	path: string,
	text: string,
): Promise<void> {
	const bytes = Buffer.from(text, "utf8");
	if (!bytes.length || bytes.length > MAX_METADATA_BYTES)
		throw new CoverageError("review-output-invalid");
	const file = await open(path, "wx", 0o600);
	try {
		await file.writeFile(bytes);
	} catch (error) {
		await rm(path, { force: true });
		throw error;
	} finally {
		await file.close();
	}
}

export async function readShadowMetadataFile(path: string): Promise<string> {
	const file = await open(
		path,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const before = await file.stat();
		if (!before.isFile() || before.size < 1 || before.size > MAX_METADATA_BYTES)
			throw new CoverageError("review-output-invalid");
		const bytes = Buffer.alloc(MAX_METADATA_BYTES + 1);
		let size = 0;
		while (size < bytes.length) {
			const read = await file.read(bytes, size, bytes.length - size, null);
			if (!read.bytesRead) break;
			size += read.bytesRead;
		}
		const after = await file.stat();
		if (
			size !== before.size ||
			size !== after.size ||
			size > MAX_METADATA_BYTES ||
			before.mtimeMs !== after.mtimeMs ||
			before.ctimeMs !== after.ctimeMs
		)
			throw new CoverageError("review-output-invalid");
		return new TextDecoder("utf-8", { fatal: true }).decode(
			bytes.subarray(0, size),
		);
	} finally {
		await file.close();
	}
}
