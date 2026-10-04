import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SHA = /^[0-9a-f]{40,64}$/i;
const MAX_METADATA_BYTES = 256 * 1024;
const MAX_CHUNKS = 3;

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
		"--literal-pathspecs",
		...args,
	];
}

async function git(repoPath: string, args: string[]): Promise<string> {
	try {
		const result = await execFileAsync("git", gitArgs(...args), {
			cwd: repoPath,
			env: {
				...process.env,
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_CONFIG_SYSTEM: "/dev/null",
				GIT_ATTR_NOSYSTEM: "1",
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

function parseHunks(
	patch: string,
	file: { oldPath: string | null; newPath: string | null },
): DiffHunk[] {
	const sections = patch.split(/^diff --git /m).slice(1);
	const section = sections.find(
		(item) =>
			item.includes(`a/${file.oldPath ?? file.newPath}`) ||
			item.includes(`b/${file.newPath ?? file.oldPath}`),
	);
	if (!section) return [];
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
	for (const line of lines) {
		const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
		if (header) {
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
			continue;
		}
		if (
			!current ||
			line === "\\ No newline at end of file" ||
			line.startsWith("---") ||
			line.startsWith("+++")
		)
			continue;
		if (line.startsWith("+")) {
			current.lines.push({
				side: "new",
				line: newLine++,
				contentSha256: digest(line.slice(1)),
			});
		} else if (line.startsWith("-")) {
			current.lines.push({
				side: "old",
				line: oldLine++,
				contentSha256: digest(line.slice(1)),
			});
		} else if (line.startsWith(" ")) {
			oldLine++;
			newLine++;
		}
	}
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

export async function buildGitInventory(
	repositoryPath: string,
	baseSha: string,
	headSha: string,
): Promise<GitInventory> {
	assertSha(baseSha, "baseSha");
	assertSha(headSha, "headSha");
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
			"--unified=0",
			"--full-index",
			"--no-ext-diff",
			"--no-textconv",
			"--find-renames=50%",
			`${mergeBaseSha}..${headSha}`,
			"--",
		]),
	);
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
	return inventory;
}

function parseRequestDiff(body: string): string {
	try {
		const parsed = JSON.parse(body) as { diff?: unknown };
		if (typeof parsed.diff !== "string") throw new Error("missing diff");
		return parsed.diff;
	} catch {
		throw new CoverageError(
			"unsupported-transport",
			"request is not the approved JSON transport",
		);
	}
}

function matchDiff(
	inventory: GitInventory,
	diff: string,
): { fileIds: string[]; hunkIds: string[] } {
	const matched: string[] = [];
	const matchedHunks: string[] = [];
	for (const file of inventory.files) {
		const pathNeedle = [file.oldPath, file.newPath]
			.filter(Boolean)
			.map((path) => `a/${path}|b/${path}`)
			.join("|");
		if (!pathNeedle) continue;
		const firstPathNeedle = pathNeedle.split("|")[0];
		if (!firstPathNeedle || !diff.includes(firstPathNeedle)) continue;
		const requestHunks = parseHunks(diff, {
			oldPath: file.oldPath,
			newPath: file.newPath,
		});
		if (
			requestHunks.length !== file.hunks.length ||
			requestHunks.some((hunk, index) => hunk.id !== file.hunks[index]?.id)
		)
			throw new CoverageError(
				"review-coverage-incomplete",
				"hunk content or position mismatch",
			);
		matchedHunks.push(...file.hunks.map((hunk) => hunk.id));
		matched.push(file.id);
	}
	if (matched.length !== inventory.files.length)
		throw new CoverageError(
			"review-coverage-incomplete",
			"request omitted an authoritative file",
		);
	return { fileIds: matched, hunkIds: matchedHunks };
}

export type ChunkTransport = (
	body: string,
	headers: Record<string, string>,
) => Promise<{ status: number; body: string }>;

export interface RecordingProxyOptions {
	inventory: GitInventory;
	upstreamBaseUrl: string;
	transportHeaders?: Record<string, string>;
	maxRequestBytes?: number;
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

export async function startRecordingProxy(
	options: RecordingProxyOptions,
): Promise<{
	server: ReturnType<typeof createServer>;
	port: number;
	close: () => Promise<void>;
}> {
	const upstream = new URL(options.upstreamBaseUrl);
	if (!/^https?:$/.test(upstream.protocol))
		throw new CoverageError(
			"invalid-recorder-config",
			"upstream must be HTTP(S)",
		);
	const maxRequestBytes = options.maxRequestBytes ?? 32 * 1024 * 1024;
	const recorder = new JobLocalRecorder({
		inventory: options.inventory,
		maxRetries: 1,
		transport: async (forwardedBody, headers) => {
			const path = headers["x-review-forward-path"] ?? "/";
			delete headers["x-review-forward-path"];
			if (!path.startsWith("/") || path.startsWith("//"))
				throw new CoverageError(
					"unsupported-transport",
					"request path must be relative",
				);
			const target = new URL(path, upstream);
			const upstreamResponse = await fetch(target, {
				method: "POST",
				headers,
				body: forwardedBody,
			});
			return {
				status: upstreamResponse.status,
				body: await upstreamResponse.text(),
			};
		},
	});
	const server = createServer(
		async (request: IncomingMessage, response: ServerResponse) => {
			try {
				if (request.method !== "POST")
					throw new CoverageError(
						"unsupported-transport",
						"only POST is supported",
					);
				const chunkId = request.headers["x-review-chunk-id"];
				if (typeof chunkId !== "string")
					throw new CoverageError("invalid-chunk", "missing x-review-chunk-id");
				const body = await readRequestBody(request, maxRequestBytes);
				const headers = requestHeaders(request, options.transportHeaders ?? {});
				const requestPath = request.url ?? "/";
				if (!requestPath.startsWith("/") || requestPath.startsWith("//"))
					throw new CoverageError(
						"unsupported-transport",
						"request path must be relative",
					);
				headers["x-review-forward-path"] = requestPath;
				const result = await recorder.record({
					chunkId,
					body,
					headers,
				});
				const output = JSON.stringify(result.response);
				response.writeHead(result.responseStatus, {
					"content-type": "application/json",
					"content-length": Buffer.byteLength(output),
				});
				response.end(output);
			} catch (error) {
				const code =
					error instanceof CoverageError ? error.code : "review-run-failed";
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
		close: () =>
			new Promise((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			),
	};
}

export async function recordChunk(
	inventory: GitInventory,
	request: ChunkRequest,
	transport: ChunkTransport,
): Promise<ChunkResult> {
	if (!/^chunk-[a-z0-9-]+$/.test(request.chunkId))
		throw new CoverageError("invalid-chunk", "chunk id is invalid");
	const diff = parseRequestDiff(request.body);
	const matched = matchDiff(inventory, diff);
	const response = await transport(request.body, { ...request.headers });
	if (response.status < 200 || response.status >= 300)
		throw new CoverageError(
			"review-output-invalid",
			`upstream status ${response.status}`,
		);
	let parsed: unknown;
	try {
		parsed = JSON.parse(response.body);
	} catch {
		throw new CoverageError("review-output-invalid", "response is not JSON");
	}
	const review = (parsed as { review?: unknown })?.review;
	if (
		!review ||
		typeof review !== "object" ||
		!Array.isArray(
			(review as { key_issues_to_review?: unknown }).key_issues_to_review,
		)
	)
		throw new CoverageError(
			"review-output-invalid",
			"official review schema is invalid",
		);
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
	const persistedChunks = metadata.chunks.map(
		({ response: _response, ...chunk }) => chunk,
	);
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
	>,
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
			chunk.callStatus !== "succeeded" ||
			chunk.responseStatus < 200 ||
			chunk.responseStatus >= 300 ||
			!Number.isSafeInteger(chunk.attempts) ||
			chunk.attempts < 1
		)
			throw new CoverageError(
				"review-output-invalid",
				"chunk summary contains unknown or duplicate IDs",
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
}

export class JobLocalRecorder {
	private readonly results = new Map<string, ChunkResult>();
	private readonly requestDigests = new Map<string, string>();
	private readonly failures = new Map<string, FailedChunk>();
	private readonly maxChunks: number;
	private readonly maxRetries: number;
	constructor(private readonly options: JobLocalRecorderOptions) {
		this.maxChunks = options.maxChunks ?? MAX_CHUNKS;
		this.maxRetries = options.maxRetries ?? 1;
		if (
			this.maxChunks < 1 ||
			this.maxChunks > MAX_CHUNKS ||
			this.maxRetries < 0
		)
			throw new CoverageError("invalid-recorder-config");
	}
	async record(request: ChunkRequest): Promise<ChunkResult> {
		const requestSha256 = digest(request.body);
		const priorDigest = this.requestDigests.get(request.chunkId);
		if (priorDigest && priorDigest !== requestSha256)
			throw new CoverageError(
				"review-coverage-incomplete",
				"logical chunk body changed",
			);
		const prior = this.results.get(request.chunkId);
		if (prior) return prior;
		const isNew = !priorDigest;
		if (isNew && this.requestDigests.size >= this.maxChunks)
			throw new CoverageError(
				"review-coverage-incomplete",
				"logical chunk limit exceeded",
			);
		let lastError: unknown;
		for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
			try {
				const result = await recordChunk(
					this.options.inventory,
					request,
					this.options.transport,
				);
				const completed = { ...result, attempts: attempt + 1 };
				this.requestDigests.set(request.chunkId, requestSha256);
				this.results.set(request.chunkId, completed);
				this.failures.delete(request.chunkId);
				return completed;
			} catch (error) {
				lastError = error;
				if (
					error instanceof CoverageError &&
					error.code !== "git-failed" &&
					error.code !== "review-output-invalid"
				)
					throw error;
			}
		}
		const reasonCode =
			lastError instanceof CoverageError ? lastError.code : "review-run-failed";
		this.requestDigests.set(request.chunkId, requestSha256);
		this.failures.set(request.chunkId, {
			chunkId: request.chunkId,
			attempts: this.maxRetries + 1,
			reasonCode,
		});
		throw new CoverageError(reasonCode);
	}
	failedChunks(): FailedChunk[] {
		return [...this.failures.values()];
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
