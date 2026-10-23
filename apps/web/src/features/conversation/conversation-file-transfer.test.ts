import { beforeEach, describe, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({
	createFileUpload: vi.fn(),
	issueFileAccess: vi.fn(),
	uploadFileContent: vi.fn(),
	completeFileUpload: vi.fn(),
}));

vi.mock("../../pilot/generated/sdk.gen.js", () => api);

import { TEXT_SUBTYPE_DECLARATIONS_V1 } from "@agent-infra/file-content/text";
import {
	ConversationFileTransferError,
	describeConversationFile,
	uploadConversationFile,
} from "./conversation-file-transfer.js";

const png = Uint8Array.from(
	"89504e470d0a1a0a0000000d49484452"
		.match(/../g)
		?.map((byte) => Number.parseInt(byte, 16)) ?? [],
);
const limitsFor = (mediaTypes: string[]) => ({
	schemaVersion: 1 as const,
	revision: "limits-1",
	expiresAt: "2099-01-01T00:00:00Z",
	mediaTypes,
	maxBytes: 1024,
});

describe("describeConversationFile (#3257)", () => {
	test("declares every whitelisted text subtype the FileLimits allow", async () => {
		for (const mediaType of TEXT_SUBTYPE_DECLARATIONS_V1)
			await expect(
				describeConversationFile(
					new File(["a,b\n1,2\n"], "table", { type: mediaType }),
					limitsFor([mediaType]),
				),
			).resolves.toMatchObject({ mediaType, sizeBytes: 8 });
	});

	test("rejects a CSV when FileLimits only allow text/plain", async () => {
		await expect(
			describeConversationFile(
				new File(["a,b\n1,2\n"], "table.csv", { type: "text/csv" }),
				limitsFor(["text/plain"]),
			),
		).rejects.toMatchObject({ expired: false, reason: undefined });
	});

	test("rejects text declarations whose content is not UTF-8 text", async () => {
		for (const bytes of [
			png,
			// GBK 编码的 CSV。
			Uint8Array.from([0xc3, 0xfb, 0xb3, 0xc6, 0x2c, 0x31, 0x0a]),
		]) {
			const failure = await describeConversationFile(
				new File([bytes], "table.csv", { type: "text/csv" }),
				limitsFor(["text/csv"]),
			).catch((error) => error);
			expect(failure).toBeInstanceOf(ConversationFileTransferError);
			expect(failure).toMatchObject({ expired: false, reason: "content" });
		}
	});

	test("leaves byte-identified binary formats to the server check", async () => {
		await expect(
			describeConversationFile(
				new File([png], "photo.png", { type: "image/png" }),
				limitsFor(["image/png"]),
			),
		).resolves.toMatchObject({ mediaType: "image/png" });
	});
});

describe("uploadConversationFile", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		api.createFileUpload.mockResolvedValue({
			response: { status: 201 },
			data: { fileId: "file-1" },
		});
		api.issueFileAccess.mockResolvedValue({
			response: { status: 200 },
			data: {
				accessId: "access-1",
				grant: { token: "grant-1" },
			},
		});
		api.uploadFileContent.mockResolvedValue({ response: { status: 204 } });
		api.completeFileUpload.mockResolvedValue({
			response: { status: 200 },
			data: { fileId: "file-1", status: "available" },
		});
	});

	test("sends the declared media type with the byte upload", async () => {
		const descriptor = {
			name: "notes.txt",
			mediaType: "text/plain",
			sizeBytes: 5,
			sha256: "a".repeat(64),
		} as const;
		const result = await uploadConversationFile({
			client: {} as never,
			conversationId: "conversation-1",
			file: new File(["hello"], descriptor.name, {
				type: descriptor.mediaType,
			}),
			descriptor,
			idempotencyKey: "web-file-1",
		});

		expect(result).toMatchObject({ fileId: "file-1", status: "available" });
		expect(api.uploadFileContent).toHaveBeenCalledWith(
			expect.objectContaining({
				headers: expect.objectContaining({
					"Content-Type": descriptor.mediaType,
					"Content-Length": descriptor.sizeBytes,
				}),
			}),
		);
	});
});
