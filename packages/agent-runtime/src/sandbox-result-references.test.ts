import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileDescriptorV1 } from "@agent-infra/contracts/files";
import type { RuntimeOperationFactV2 } from "@agent-infra/contracts/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createRuntimeFileResultReceiptV1,
	type RuntimeFileBridgePortV1,
	type RuntimeFileResultReceiptV1,
	RuntimeFileResultUnconfirmedError,
} from "./runtime-file-bridge.js";
import {
	parseSandboxReferencesV1,
	parseSandboxResourceLinkV1,
	planSandboxResultsV1,
	publishSandboxResultsV1,
	readSandboxResultFileV1,
	SANDBOX_RESULT_TOOL_ID_V1,
	type SandboxResultPlanV1,
	sandboxResultAnswerText,
	settleSandboxResultsWithoutBridgeV1,
} from "./sandbox-result-references.js";

// 1×1 PNG 与最小 PDF 头；媒体类型只按文件头魔数识别。
const png = Buffer.from(
	"89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
		"1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
	"hex",
);
const pdf = Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<<>>\nendobj\n");
const sha256 = (bytes: Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");

const binding = {
	actorId: "actor-a",
	channelId: "web",
	agentId: "agent-a",
	conversationId: "conversation-a",
	executionId: "execution-a",
	sessionGeneration: 1,
	grantId: "grant-a",
	expiresAt: Date.now() + 60_000,
	inputFileIds: [],
};

function receiptFor(
	descriptor: FileDescriptorV1,
	fileId: string,
	workspaceReference: string | null,
): RuntimeFileResultReceiptV1 {
	return createRuntimeFileResultReceiptV1(
		binding,
		{
			schemaVersion: 1,
			fileId,
			kind: "result",
			descriptor,
			status: "available",
			createdAt: new Date().toISOString(),
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
		},
		{ workspaceReference },
	);
}

function memoryLedger(initial: SandboxResultPlanV1) {
	let plan = structuredClone(initial);
	const facts: RuntimeOperationFactV2[] = [];
	const receipts: RuntimeFileResultReceiptV1[] = [];
	return {
		facts,
		receipts,
		plan: () => plan,
		ledger: {
			read: () => plan,
			commit: async (change: {
				plan: SandboxResultPlanV1;
				facts: readonly RuntimeOperationFactV2[];
				receipt?: RuntimeFileResultReceiptV1;
			}) => {
				plan = structuredClone(change.plan);
				facts.push(...change.facts);
				if (change.receipt) receipts.push(change.receipt);
			},
		},
	};
}

function fakeBridge(
	write: RuntimeFileBridgePortV1["writeResult"],
): RuntimeFileBridgePortV1 {
	return {
		readInput: async () => {
			throw new Error("unused");
		},
		writeResult: write,
		revalidate: () => {},
	};
}

async function collect(body: ReadableStream<Uint8Array>) {
	const chunks: Uint8Array[] = [];
	for await (const chunk of body) chunks.push(chunk);
	return Buffer.concat(chunks);
}

describe("sandbox: reference parsing (#3226)", () => {
	it("finds links, images and reference definitions in document order", () => {
		const answer = [
			"Here is the [report](sandbox:out/report.pdf) and a chart:",
			"",
			"![Chart](sandbox:/out/chart.png)",
			"",
			"See also [the data][data] and <sandbox:out/raw%20data.csv>.",
			"",
			"[data]: sandbox:out/./tables/../data.csv",
		].join("\n");
		expect(parseSandboxReferencesV1(answer)).toEqual([
			{ kind: "reference", workspaceReference: "out/report.pdf" },
			{ kind: "reference", workspaceReference: "out/chart.png" },
			{ kind: "reference", workspaceReference: "out/data.csv" },
			{ kind: "reference", workspaceReference: "out/raw data.csv" },
		]);
	});

	it("ignores code blocks, inline code, ordinary relative links, bare paths and HTML", () => {
		const answer = [
			"```markdown",
			"[not delivered](sandbox:out/in-code.png)",
			"```",
			"",
			"Inline `[x](sandbox:out/inline.png)` code and sandbox:out/bare.png text.",
			"",
			"Source: [app.ts](src/app.ts) and ![img](out/image.png).",
			"",
			'<a href="sandbox:out/html.png">html</a>',
			"",
			"    [indented](sandbox:out/indented.png)",
		].join("\n");
		expect(parseSandboxReferencesV1(answer)).toEqual([]);
	});

	it("rejects traversal beyond the workspace root, NUL and backslashes", () => {
		expect(
			parseSandboxReferencesV1(
				[
					"[a](sandbox:../secret.txt)",
					"[b](sandbox:out/../../secret.txt)",
					"[c](sandbox:out/%00.png)",
					"[d](sandbox:out%5Cwin.png)",
					"[e](sandbox:%E0%A4%A)",
					"[f](sandbox:/)",
				].join("\n\n"),
			).map((item) => item.kind),
		).toEqual([
			"invalid",
			"invalid",
			"invalid",
			"invalid",
			"invalid",
			"invalid",
		]);
	});

	it("deduplicates by normalized path, keeps first occurrence and counts the excess as one failure", () => {
		const text = [
			"[a](sandbox:out/a.png) [a again](sandbox:/out//a.png)",
			...Array.from(
				{ length: 11 },
				(_, index) => `[f${index}](sandbox:f${index}.txt)`,
			),
		].join("\n\n");
		const { plan } = planSandboxResultsV1({ text });
		expect(plan?.entries).toHaveLength(10);
		expect(plan?.entries.map((entry) => entry.workspaceReference)).toEqual([
			"out/a.png",
			...Array.from({ length: 9 }, (_, index) => `f${index}.txt`),
		]);
		expect(plan?.overflow?.phase).toBe("pending");
		expect(
			planSandboxResultsV1({ text: "no references" }).plan,
		).toBeUndefined();
	});

	it("maps only empty-authority file: resource links inside the workspace", () => {
		const root = "/srv/conversation/workspace";
		expect(
			parseSandboxResourceLinkV1(`file://${root}/out/a%20b.png`, root),
		).toEqual({ kind: "reference", workspaceReference: "out/a b.png" });
		expect(parseSandboxResourceLinkV1(`file:${root}/out/c.png`, root)).toEqual({
			kind: "reference",
			workspaceReference: "out/c.png",
		});
		for (const uri of [
			`file://host${root}/out/a.png`,
			"file:///etc/passwd",
			`file://${root}/../escape.txt`,
			`file://${root}`,
			`file://${root}/out/a.png?x=1`,
		])
			expect(parseSandboxResourceLinkV1(uri, root)).toEqual({
				kind: "invalid",
			});
		expect(
			parseSandboxResourceLinkV1("https://example.com/a.png", root),
		).toBeUndefined();
	});

	it("joins only text events as the final answer", () => {
		expect(
			sandboxResultAnswerText([
				{ type: "text", payload: { delta: "[a](sandbox:" } },
				{ type: "tool", payload: { name: "Read" } },
				{ type: "text", payload: { delta: "a.png)" } },
			]),
		).toBe("[a](sandbox:a.png)");
	});
});

describe("sandbox: file validation (#3226)", () => {
	let workspace: string;
	let outside: string;
	beforeEach(async () => {
		workspace = await mkdtemp(join(tmpdir(), "sandbox-ref-workspace-"));
		outside = await mkdtemp(join(tmpdir(), "sandbox-ref-outside-"));
		await mkdir(join(workspace, "out"));
		await writeFile(join(workspace, "out", "chart.png"), png);
		await writeFile(join(workspace, "out", "report.pdf"), pdf);
		await writeFile(join(outside, "secret.png"), png);
	});
	afterEach(async () => {
		await rm(workspace, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	});

	it("reads a regular file once and identifies its type from the bytes", async () => {
		await expect(
			readSandboxResultFileV1(workspace, "out/chart.png"),
		).resolves.toMatchObject({
			descriptor: {
				name: "chart.png",
				mediaType: "image/png",
				sizeBytes: png.byteLength,
				sha256: sha256(png),
			},
		});
		await expect(
			readSandboxResultFileV1(workspace, "out/report.pdf"),
		).resolves.toMatchObject({ descriptor: { mediaType: "application/pdf" } });
	});

	it("rejects symlinks, escaping parents, directories, oversize and unverifiable content", async () => {
		await symlink(
			join(outside, "secret.png"),
			join(workspace, "out", "link.png"),
		);
		await symlink(outside, join(workspace, "escape"));
		// 指回工作区内的链接目录也不是合法的父目录。
		await symlink(join(workspace, "out"), join(workspace, "alias"));
		await writeFile(
			join(workspace, "out", "blob.bin"),
			Buffer.from([0, 1, 2, 255]),
		);
		for (const reference of [
			"out/link.png",
			"escape/secret.png",
			"alias/chart.png",
			"out",
			"out/missing.png",
			"out/blob.bin",
		])
			await expect(
				readSandboxResultFileV1(workspace, reference),
			).resolves.toBeUndefined();
		await expect(
			readSandboxResultFileV1(workspace, "out/chart.png", png.byteLength - 1),
		).resolves.toBeUndefined();
	});
});

describe("sandbox: result publication (#3226)", () => {
	let workspace: string;
	beforeEach(async () => {
		workspace = await mkdtemp(join(tmpdir(), "sandbox-publish-"));
		await mkdir(join(workspace, "out"));
		await writeFile(join(workspace, "out", "chart.png"), png);
		await writeFile(join(workspace, "out", "report.pdf"), pdf);
	});
	afterEach(async () => {
		await rm(workspace, { recursive: true, force: true });
	});

	it("records intent, started and completed facts and publishes with the workspace reference", async () => {
		const { plan } = planSandboxResultsV1({
			text: "![c](sandbox:out/chart.png) [r](sandbox:out/report.pdf)",
		});
		if (!plan) throw new Error("missing plan");
		const memory = memoryLedger(plan);
		const uploads: { descriptor: FileDescriptorV1; bytes: Buffer }[] = [];
		const writeResult = vi.fn(
			async (
				descriptor: FileDescriptorV1,
				body: ReadableStream<Uint8Array>,
				options?: { workspaceReference: string | null },
			) => {
				uploads.push({ descriptor, bytes: await collect(body) });
				return receiptFor(
					descriptor,
					`file-${uploads.length}`,
					options?.workspaceReference ?? null,
				);
			},
		);
		await publishSandboxResultsV1({
			ledger: memory.ledger,
			bridge: fakeBridge(writeResult),
			workspaceRoot: workspace,
		});
		expect(writeResult.mock.calls.map((call) => call[2])).toEqual([
			{ workspaceReference: "out/chart.png" },
			{ workspaceReference: "out/report.pdf" },
		]);
		expect(uploads.map((upload) => upload.descriptor.mediaType)).toEqual([
			"image/png",
			"application/pdf",
		]);
		expect(uploads[0]?.bytes.equals(png)).toBe(true);
		expect(uploads[0]?.descriptor.sha256).toBe(sha256(png));
		expect(memory.facts.map((fact) => [fact.operationRef, fact.phase])).toEqual(
			[
				[plan.entries[0]?.operationRef, "intent"],
				[plan.entries[0]?.operationRef, "started"],
				[plan.entries[0]?.operationRef, "completed"],
				[plan.entries[1]?.operationRef, "intent"],
				[plan.entries[1]?.operationRef, "started"],
				[plan.entries[1]?.operationRef, "completed"],
			],
		);
		expect(
			memory.facts.every(
				(fact) =>
					fact.kind === "tool" && fact.toolId === SANDBOX_RESULT_TOOL_ID_V1,
			),
		).toBe(true);
		expect(
			memory.facts
				.filter((fact) => fact.phase === "completed")
				.map((fact) => (fact.kind === "tool" ? fact.resultRef : undefined)),
		).toEqual(["file-1", "file-2"]);
		// 事实不含路径与文件内容。
		expect(JSON.stringify(memory.facts)).not.toMatch(/chart|report|out\//);
		expect(memory.receipts).toHaveLength(2);
		expect(memory.plan().settled).toBe(true);
	});

	it("fails rejected, missing and over-limit references without calling writeResult", async () => {
		const text = [
			"[escape](sandbox:../x.png)",
			"[missing](sandbox:out/missing.png)",
			...Array.from(
				{ length: 10 },
				(_, index) => `[f${index}](sandbox:f${index}.png)`,
			),
		].join("\n\n");
		const { plan } = planSandboxResultsV1({ text });
		if (!plan) throw new Error("missing plan");
		const memory = memoryLedger(plan);
		const writeResult = vi.fn();
		await publishSandboxResultsV1({
			ledger: memory.ledger,
			bridge: fakeBridge(writeResult),
			workspaceRoot: workspace,
		});
		expect(writeResult).not.toHaveBeenCalled();
		const terminal = memory.facts.filter((fact) => fact.phase !== "intent");
		expect(terminal).toHaveLength(11);
		expect(
			terminal.every(
				(fact) =>
					fact.phase === "failed" && fact.failureCode === "request_rejected",
			),
		).toBe(true);
		expect(
			memory.facts.filter(
				(fact) => fact.operationRef === plan.overflow?.operationRef,
			),
		).toHaveLength(2);
	});

	it("keeps unconfirmed results unknown and maps definite failures to failed", async () => {
		const { plan } = planSandboxResultsV1({
			text: "[c](sandbox:out/chart.png) [r](sandbox:out/report.pdf)",
		});
		if (!plan) throw new Error("missing plan");
		const memory = memoryLedger(plan);
		let calls = 0;
		await publishSandboxResultsV1({
			ledger: memory.ledger,
			bridge: fakeBridge(async () => {
				calls += 1;
				if (calls === 1) throw new RuntimeFileResultUnconfirmedError();
				throw new Error("RUNTIME_FILE_EXCHANGE_UNAVAILABLE");
			}),
			workspaceRoot: workspace,
		});
		expect(
			memory.facts
				.filter((fact) => fact.phase !== "intent" && fact.phase !== "started")
				.map((fact) => [fact.phase, fact.failureCode]),
		).toEqual([
			["unknown", "recovery_unconfirmed"],
			["failed", "request_rejected"],
		]);
		expect(memory.plan().entries.map((entry) => entry.phase)).toEqual([
			"unknown",
			"failed",
		]);
	});

	it("resumes without republishing: started stays unknown and changed content fails", async () => {
		const { plan } = planSandboxResultsV1({
			text: "[c](sandbox:out/chart.png) [r](sandbox:out/report.pdf)",
		});
		if (!plan?.entries[0] || !plan.entries[1]) throw new Error("missing plan");
		// 第一项已开始写入（结论未知），第二项已保存 intent 后文件被改写。
		plan.entries[0].phase = "started";
		plan.entries[0].descriptor = {
			name: "chart.png",
			mediaType: "image/png",
			sizeBytes: png.byteLength,
			sha256: sha256(png),
		};
		plan.entries[0].startedAt = new Date().toISOString();
		plan.entries[1].phase = "intent";
		plan.entries[1].descriptor = {
			name: "report.pdf",
			mediaType: "application/pdf",
			sizeBytes: pdf.byteLength,
			sha256: sha256(pdf),
		};
		await writeFile(join(workspace, "out", "report.pdf"), `${pdf}changed`);
		const memory = memoryLedger(plan);
		const writeResult = vi.fn();
		await publishSandboxResultsV1({
			ledger: memory.ledger,
			bridge: fakeBridge(writeResult),
			workspaceRoot: workspace,
		});
		expect(writeResult).not.toHaveBeenCalled();
		expect(memory.facts.map((fact) => [fact.phase, fact.failureCode])).toEqual([
			["unknown", "recovery_unconfirmed"],
			["failed", "request_rejected"],
		]);
	});

	it("settles without a bridge: nothing is sent and a confirmed file event completes a started entry", async () => {
		const { plan } = planSandboxResultsV1({
			text: "[c](sandbox:out/chart.png) [r](sandbox:out/report.pdf) [x](sandbox:x.png)",
		});
		if (!plan?.entries[0] || !plan.entries[1]) throw new Error("missing plan");
		plan.entries[0].phase = "started";
		plan.entries[1].phase = "intent";
		const settled = settleSandboxResultsWithoutBridgeV1(plan, (entry) =>
			entry.operationRef === plan.entries[0]?.operationRef
				? "file-1"
				: undefined,
		);
		expect(settled.facts.map((fact) => [fact.phase, fact.failureCode])).toEqual(
			[
				["completed", undefined],
				["failed", "dependency_unavailable"],
				["intent", undefined],
				["failed", "dependency_unavailable"],
			],
		);
		expect(settled.plan.settled).toBe(true);
		const memory = memoryLedger(
			planSandboxResultsV1({ text: "[c](sandbox:out/chart.png)" })
				.plan as SandboxResultPlanV1,
		);
		await publishSandboxResultsV1({
			ledger: memory.ledger,
			bridge: undefined,
			workspaceRoot: workspace,
		});
		expect(memory.facts.map((fact) => fact.phase)).toEqual([
			"intent",
			"failed",
		]);
	});

	it("publishes ACP image blocks with a null workspace reference", async () => {
		const { plan, images } = planSandboxResultsV1({
			blocks: [
				{ type: "image", data: png.toString("base64") },
				{ type: "image", data: png.toString("base64") },
				{ type: "image", data: "not base64!" },
			],
		});
		if (!plan) throw new Error("missing plan");
		expect(plan.entries).toHaveLength(2);
		const memory = memoryLedger(plan);
		const writeResult = vi.fn(
			async (
				descriptor: FileDescriptorV1,
				_body: ReadableStream<Uint8Array>,
				options?: { workspaceReference: string | null },
			) =>
				receiptFor(
					descriptor,
					"file-image",
					options?.workspaceReference ?? null,
				),
		);
		await publishSandboxResultsV1({
			ledger: memory.ledger,
			bridge: fakeBridge(writeResult),
			workspaceRoot: workspace,
			images,
		});
		expect(writeResult).toHaveBeenCalledOnce();
		expect(writeResult.mock.calls[0]?.[0]).toMatchObject({
			mediaType: "image/png",
			sha256: sha256(png),
		});
		expect(writeResult.mock.calls[0]?.[2]).toEqual({
			workspaceReference: null,
		});
		expect(memory.plan().entries.map((entry) => entry.phase)).toEqual([
			"completed",
			"failed",
		]);
	});
});
