import type {
	FileAccessGrantV1,
	FileDescriptorV1,
} from "@agent-infra/contracts/files";
import { describe, expect, it, vi } from "vitest";
import { createBrowserFileGrantBridgeV1 } from "./browser-file-bridge.js";

const binding = {
	agentId: "agent-1",
	conversationId: "conversation-1",
	executionId: "execution-1",
	sessionGeneration: 3,
} as const;

const grant = {
	schemaVersion: 1,
	format: "compact-jws",
	token: "opaque-file-grant",
} as FileAccessGrantV1;

const descriptor: FileDescriptorV1 = {
	name: "screenshot.png",
	mediaType: "image/png",
	sizeBytes: 3,
	sha256: "a".repeat(64),
};

const projection = {
	schemaVersion: 1,
	fileId: "file-1",
	kind: "result",
	descriptor,
	status: "available",
	createdAt: "2026-10-06T00:00:00Z",
	expiresAt: "2026-10-06T01:00:00Z",
} as const;

describe("Browser File Grant bridge", () => {
	it("delegates exact execution-bound reads and result writes", async () => {
		const readInput = vi.fn(async () => new ReadableStream<Uint8Array>());
		const writeResult = vi.fn(async () => projection);
		const bridge = createBrowserFileGrantBridgeV1({
			binding,
			client: { readInput, writeResult },
		});

		await bridge.readInput({
			binding,
			executionGrant: grant,
			fileId: "input-1",
			idempotencyKey: "read-1",
		});
		const body = new ReadableStream<Uint8Array>();
		await expect(
			bridge.writeResult({
				binding,
				executionGrant: grant,
				descriptor,
				body,
				idempotencyKey: "result-1",
			}),
		).resolves.toEqual(projection);
		expect(readInput).toHaveBeenCalledWith(grant, "input-1", "read-1");
		expect(writeResult).toHaveBeenCalledWith(
			grant,
			descriptor,
			body,
			"result-1",
			undefined,
		);
	});

	it("rejects cross-execution or stale-session bindings before file access", async () => {
		const readInput = vi.fn(async () => new ReadableStream<Uint8Array>());
		const writeResult = vi.fn(async () => projection);
		const bridge = createBrowserFileGrantBridgeV1({
			binding,
			client: { readInput, writeResult },
		});

		await expect(
			bridge.readInput({
				binding: { ...binding, executionId: "other-execution" },
				executionGrant: grant,
				fileId: "input-1",
				idempotencyKey: "read-2",
			}),
		).rejects.toThrow("BROWSER_FILE_BINDING_CONFLICT");
		await expect(
			bridge.writeResult({
				binding: { ...binding, sessionGeneration: 4 },
				executionGrant: grant,
				descriptor,
				body: new ReadableStream<Uint8Array>(),
				idempotencyKey: "result-2",
			}),
		).rejects.toThrow("BROWSER_FILE_BINDING_CONFLICT");
		expect(readInput).not.toHaveBeenCalled();
		expect(writeResult).not.toHaveBeenCalled();
	});
});
