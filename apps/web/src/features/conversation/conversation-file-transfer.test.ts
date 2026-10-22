import { beforeEach, describe, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({
	createFileUpload: vi.fn(),
	issueFileAccess: vi.fn(),
	uploadFileContent: vi.fn(),
	completeFileUpload: vi.fn(),
}));

vi.mock("../../pilot/generated/sdk.gen.js", () => api);

import { uploadConversationFile } from "./conversation-file-transfer.js";

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
