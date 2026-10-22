import { createHash } from "node:crypto";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createRuntimeFileBridgeV1,
	type RuntimeFileInputV1,
} from "./runtime-file-bridge.js";
import {
	materializeSandboxAttachmentsV1,
	SANDBOX_ATTACHMENT_MAX_BYTES_V1,
	SANDBOX_ATTACHMENT_MAX_COUNT_V1,
	sandboxAttachmentManifestV1,
	sandboxAttachmentNameV1,
	sandboxAttachmentPromptTextV1,
	sandboxAttachmentRefV1,
} from "./sandbox-attachments.js";
import { SANDBOX_FILE_INSTRUCTIONS_V1 } from "./sandbox-file-instructions.js";

const directories: string[] = [];

afterEach(async () => {
	for (const directory of directories.splice(0)) {
		await chmod(directory, 0o700).catch(() => {});
		await rm(directory, { recursive: true, force: true });
	}
});

async function workspaceRoot() {
	const directory = await mkdtemp(join(tmpdir(), "agent-infra-attachments-"));
	directories.push(directory);
	const workspace = join(directory, "workspace");
	await mkdir(workspace, { mode: 0o700 });
	return { directory, workspace };
}

class InvalidAttachment extends Error {
	readonly code = "RUNTIME_TEST_UNAVAILABLE";
}

function invalid(): never {
	throw new InvalidAttachment("RUNTIME_TEST_UNAVAILABLE");
}

const png = Buffer.from(
	"89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
		"1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
	"hex",
);
const pdf = Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<<>>\nendobj\n");
const csv = Buffer.from("name,value\nalpha,1\nbeta,2\n");
const txt = Buffer.from("plain notes\n");

const sha256 = (bytes: Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");

interface Fixture {
	readonly name: string;
	readonly mediaType: string;
	readonly bytes: Uint8Array;
}

const fixtures: Record<string, Fixture> = {
	"file-pdf": { name: "report.pdf", mediaType: "application/pdf", bytes: pdf },
	"file-csv": { name: "table.csv", mediaType: "text/csv", bytes: csv },
	"file-txt": { name: "notes.txt", mediaType: "text/plain", bytes: txt },
	"file-png": { name: "chart.png", mediaType: "image/png", bytes: png },
};

function source(
	fileId: string,
	fixture: Fixture,
	overrides: Partial<RuntimeFileInputV1["descriptor"]> = {},
	onCancel?: () => void,
): RuntimeFileInputV1 {
	return {
		fileId,
		descriptor: {
			name: fixture.name,
			mediaType: fixture.mediaType,
			sizeBytes: fixture.bytes.byteLength,
			sha256: sha256(fixture.bytes),
			...overrides,
		},
		body: new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(fixture.bytes));
				controller.close();
			},
			cancel() {
				onCancel?.();
			},
		}),
	};
}

function reader(cancelled?: string[]) {
	return vi.fn(async (fileId: string) => {
		const fixture = fixtures[fileId];
		if (!fixture) throw new Error("RUNTIME_FILE_INPUT_NOT_AUTHORIZED");
		return source(fileId, fixture, {}, () => cancelled?.push(fileId));
	});
}

describe("sandbox attachment names, refs and manifest (#3225)", () => {
	it("derives <ref> from the fileId SHA-256 and cleans <name>", () => {
		expect(sandboxAttachmentRefV1("file-1")).toBe(
			createHash("sha256").update("file-1").digest("hex").slice(0, 16),
		);
		expect(sandboxAttachmentRefV1("file-1")).toMatch(/^[a-f0-9]{16}$/);
		expect(sandboxAttachmentNameV1("../../etc/passwd", "text/plain")).toBe(
			"passwd",
		);
		expect(sandboxAttachmentNameV1("dir\\evil.txt", "text/plain")).toBe(
			"evil.txt",
		);
		expect(sandboxAttachmentNameV1("..hidden.pdf", "application/pdf")).toBe(
			"hidden.pdf",
		);
		expect(
			sandboxAttachmentNameV1("a\u0000b\u001fc\u007f.txt", "text/plain"),
		).toBe("abc.txt");
		expect(sandboxAttachmentNameV1("...", "application/pdf")).toBe(
			"attachment.pdf",
		);
		expect(sandboxAttachmentNameV1("", "image/png")).toBe("attachment.png");
		expect(sandboxAttachmentNameV1("\u0001", "application/x-custom+zip")).toBe(
			"attachment.xcustomzip",
		);
		const long = sandboxAttachmentNameV1(`${"报".repeat(200)}.pdf`, "x/y");
		expect(Buffer.byteLength(long)).toBeLessThanOrEqual(255);
		expect(long.endsWith(".pdf")).toBe(true);
		expect(long).not.toContain("\uFFFD");
		expect(
			Buffer.byteLength(sandboxAttachmentNameV1("\uD800x".repeat(200), "x/y")),
		).toBeLessThanOrEqual(255);
	});

	it("lists each attachment on one line without fileIds or Host paths", () => {
		const manifest = sandboxAttachmentManifestV1([
			{
				name: 'say "hi".txt',
				mediaType: "text/plain",
				sizeBytes: 12,
				workspacePath: '.agent-infra/attachments/0123456789abcdef/say "hi".txt',
			},
		]);
		expect(manifest.split("\n")).toEqual([
			"Attachments (saved in your workspace; paths are relative to your workspace root):",
			'- name: "say \\"hi\\".txt", media type: text/plain, size: 12 bytes, path: ".agent-infra/attachments/0123456789abcdef/say \\"hi\\".txt"',
		]);
		// 平台指令描述的正是这一清单。
		expect(SANDBOX_FILE_INSTRUCTIONS_V1).toContain(
			"lists each attachment after the user's message with its name, media type, size and path relative to your workspace root",
		);
	});

	it("appends the manifest after the user message and sends only the manifest without text", () => {
		const attachment = {
			name: "a.txt",
			mediaType: "text/plain",
			sizeBytes: 1,
			workspacePath: ".agent-infra/attachments/0123456789abcdef/a.txt",
			path: "/host/never-listed",
		};
		const withText = sandboxAttachmentPromptTextV1("hello", [attachment]);
		expect(withText.startsWith("hello\n\nAttachments")).toBe(true);
		expect(withText).not.toContain("/host/never-listed");
		expect(sandboxAttachmentPromptTextV1("", [attachment])).toMatch(
			/^Attachments/,
		);
		expect(sandboxAttachmentPromptTextV1("hello", [])).toBe("hello");
	});
});

describe("materializeSandboxAttachmentsV1 (#3225)", () => {
	it("materializes PDF, CSV, TXT and PNG read-only with the admitted SHA-256", async () => {
		const { workspace } = await workspaceRoot();
		const read = reader();
		const attachments = await materializeSandboxAttachmentsV1({
			workspace,
			fileIds: ["file-pdf", "file-csv", "file-txt", "file-png"],
			read,
			invalid,
			imageBytes: true,
		});
		expect(read.mock.calls.map(([fileId]) => fileId)).toEqual([
			"file-pdf",
			"file-csv",
			"file-txt",
			"file-png",
		]);
		for (const [index, fileId] of [
			"file-pdf",
			"file-csv",
			"file-txt",
			"file-png",
		].entries()) {
			const fixture = fixtures[fileId];
			const attachment = attachments[index];
			if (!fixture || !attachment) throw new Error("missing attachment");
			expect(attachment).toMatchObject({
				name: fixture.name,
				mediaType: fixture.mediaType,
				sizeBytes: fixture.bytes.byteLength,
				workspacePath: `.agent-infra/attachments/${sandboxAttachmentRefV1(fileId)}/${fixture.name}`,
			});
			const onDisk = await readFile(join(workspace, attachment.workspacePath));
			expect(sha256(onDisk)).toBe(sha256(fixture.bytes));
			expect(
				(await stat(join(workspace, attachment.workspacePath))).mode & 0o777,
			).toBe(0o400);
		}
		// 只有原生图片类型携带字节，其余只落盘。
		expect(Buffer.from(attachments[3]?.imageBytes ?? [])).toEqual(png);
		expect(attachments.slice(0, 3).some((entry) => entry.imageBytes)).toBe(
			false,
		);
		// 平台目录中不残留临时文件。
		for (const attachment of attachments)
			expect(
				await readdir(join(workspace, attachment.workspacePath, "..")),
			).toEqual([attachment.name]);
	});

	it("reuses an unchanged copy and restores a rewritten or deleted one", async () => {
		const { workspace } = await workspaceRoot();
		const target = join(
			workspace,
			".agent-infra/attachments",
			sandboxAttachmentRefV1("file-pdf"),
			"report.pdf",
		);
		await materializeSandboxAttachmentsV1({
			workspace,
			fileIds: ["file-pdf"],
			read: reader(),
			invalid,
		});
		const first = await lstat(target);

		// 内容一致：同一路径、同一文件，不重复写入，上游流被释放。
		const cancelled: string[] = [];
		const reused = await materializeSandboxAttachmentsV1({
			workspace,
			fileIds: ["file-pdf"],
			read: reader(cancelled),
			invalid,
		});
		expect(reused[0]?.path).toBe(await realpath(target));
		expect((await lstat(target)).ino).toBe(first.ino);
		expect(cancelled).toEqual(["file-pdf"]);

		// Agent 改写了副本：恢复为原内容。
		await chmod(target, 0o600);
		await writeFile(target, "tampered");
		await materializeSandboxAttachmentsV1({
			workspace,
			fileIds: ["file-pdf"],
			read: reader(),
			invalid,
		});
		expect(await readFile(target)).toEqual(pdf);
		expect((await stat(target)).mode & 0o777).toBe(0o400);

		// Agent 删除了副本：恢复。
		await rm(target);
		await materializeSandboxAttachmentsV1({
			workspace,
			fileIds: ["file-pdf"],
			read: reader(),
			invalid,
		});
		expect(await readFile(target)).toEqual(pdf);
	});

	it.each([
		[".agent-infra"],
		[".agent-infra/attachments"],
		[`.agent-infra/attachments/${sandboxAttachmentRefV1("file-txt")}`],
		[
			`.agent-infra/attachments/${sandboxAttachmentRefV1("file-txt")}/notes.txt`,
		],
	])(
		"rejects a planted symbolic link at %s without touching the outside",
		async (link) => {
			const { directory, workspace } = await workspaceRoot();
			const outside = join(directory, "outside");
			await mkdir(outside, { mode: 0o700 });
			await writeFile(join(outside, "notes.txt"), "outside");
			const parent = join(workspace, link, "..");
			await mkdir(parent, { recursive: true, mode: 0o700 });
			await symlink(
				link.endsWith("notes.txt") ? join(outside, "notes.txt") : outside,
				join(workspace, link),
			);
			const cancelled: string[] = [];
			await expect(
				materializeSandboxAttachmentsV1({
					workspace,
					fileIds: ["file-txt"],
					read: reader(cancelled),
					invalid,
				}),
			).rejects.toBeInstanceOf(InvalidAttachment);
			expect(cancelled).toEqual(["file-txt"]);
			expect(await readdir(outside)).toEqual(["notes.txt"]);
			expect(await readFile(join(outside, "notes.txt"), "utf8")).toBe(
				"outside",
			);
		},
	);

	it("rejects oversized or mismatched attachments before anything is written", async () => {
		const { workspace } = await workspaceRoot();
		const cancelled: string[] = [];
		const fixture = fixtures["file-txt"];
		if (!fixture) throw new Error("missing fixture");
		await expect(
			materializeSandboxAttachmentsV1({
				workspace,
				fileIds: ["file-txt"],
				read: async (fileId) =>
					source(
						fileId,
						fixture,
						{ sizeBytes: SANDBOX_ATTACHMENT_MAX_BYTES_V1 + 1 },
						() => cancelled.push("oversized"),
					),
				invalid,
			}),
		).rejects.toBeInstanceOf(InvalidAttachment);
		expect(cancelled).toEqual(["oversized"]);
		await expect(readdir(join(workspace, ".agent-infra"))).rejects.toThrow();

		await expect(
			materializeSandboxAttachmentsV1({
				workspace,
				fileIds: ["file-txt"],
				read: async (fileId) =>
					source(fileId, fixture, { sha256: "a".repeat(64) }),
				invalid,
			}),
		).rejects.toBeInstanceOf(InvalidAttachment);
		const ref = join(
			workspace,
			".agent-infra/attachments",
			sandboxAttachmentRefV1("file-txt"),
		);
		// 校验失败的临时文件被删除，目标不存在。
		expect(await readdir(ref)).toEqual([]);
	});

	it("rejects more than 32 attachments before any read", async () => {
		const { workspace } = await workspaceRoot();
		const read = reader();
		await expect(
			materializeSandboxAttachmentsV1({
				workspace,
				fileIds: Array.from(
					{ length: SANDBOX_ATTACHMENT_MAX_COUNT_V1 + 1 },
					(_, index) => `file-${index}`,
				),
				read,
				invalid,
			}),
		).rejects.toBeInstanceOf(InvalidAttachment);
		expect(read).not.toHaveBeenCalled();
	});

	it("cannot read a fileId outside the request Grant", async () => {
		const { workspace } = await workspaceRoot();
		const authority = vi.fn(async (context: { fileId: string }) => {
			const fixture = fixtures[context.fileId];
			if (!fixture) throw new Error("unused");
			return source(context.fileId, fixture);
		});
		const bridge = createRuntimeFileBridgeV1({
			binding: {
				actorId: "actor-a",
				channelId: "web",
				agentId: "agent-a",
				conversationId: "conversation-a",
				executionId: "execution-a",
				sessionGeneration: 1,
				grantId: "grant-a",
				expiresAt: Date.now() + 60_000,
				inputFileIds: ["file-txt"],
			},
			readInput: authority,
			writeResult: async () => {
				throw new Error("unused");
			},
			isRevoked: () => false,
			isCurrent: () => true,
		});
		// 另一会话或另一执行的附件不在本次 Grant 中：在对象访问前拒绝，不落盘。
		await expect(
			materializeSandboxAttachmentsV1({
				workspace,
				fileIds: ["file-pdf"],
				read: (fileId) => bridge.readInput(fileId),
				invalid,
			}),
		).rejects.toThrow("RUNTIME_FILE_INPUT_NOT_AUTHORIZED");
		expect(authority).not.toHaveBeenCalled();
		await expect(readdir(join(workspace, ".agent-infra"))).rejects.toThrow();
	});
});
