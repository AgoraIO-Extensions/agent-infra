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

const claims = {
	agentId: binding.agentId,
	conversationId: binding.conversationId,
	executionId: binding.executionId,
	sessionGeneration: binding.sessionGeneration,
} as const;

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
			verifyExecutionGrant: async () => claims,
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
			verifyExecutionGrant: async () => claims,
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

	it("rejects a valid grant whose verified claims belong to another execution", async () => {
		const readInput = vi.fn(async () => new ReadableStream<Uint8Array>());
		const writeResult = vi.fn(async () => projection);
		const bridge = createBrowserFileGrantBridgeV1({
			binding,
			client: { readInput, writeResult },
			verifyExecutionGrant: async () => ({
				...claims,
				executionId: "other-execution",
			}),
		});
		await expect(
			bridge.readInput({
				binding,
				executionGrant: grant,
				fileId: "input-1",
				idempotencyKey: "read-cross-execution",
			}),
		).rejects.toThrow("BROWSER_FILE_GRANT_BINDING_CONFLICT");
		expect(readInput).not.toHaveBeenCalled();
	});

	it.each([
		["agentId", { agentId: "other-agent" }],
		["conversationId", { conversationId: "other-conversation" }],
		["sessionGeneration", { sessionGeneration: 4 }],
	])("rejects verified claims with a different %s", async (_field, change) => {
		const readInput = vi.fn(async () => new ReadableStream<Uint8Array>());
		const writeResult = vi.fn(async () => projection);
		const bridge = createBrowserFileGrantBridgeV1({
			binding,
			client: { readInput, writeResult },
			verifyExecutionGrant: async () => ({ ...claims, ...change }),
		});
		await expect(
			bridge.readInput({
				binding,
				executionGrant: grant,
				fileId: "input-1",
				idempotencyKey: `read-${String(_field)}`,
			}),
		).rejects.toThrow("BROWSER_FILE_GRANT_BINDING_CONFLICT");
		expect(readInput).not.toHaveBeenCalled();
	});

	it("fails closed when grant verification fails", async () => {
		const readInput = vi.fn(async () => new ReadableStream<Uint8Array>());
		const writeResult = vi.fn(async () => projection);
		const bridge = createBrowserFileGrantBridgeV1({
			binding,
			client: { readInput, writeResult },
			verifyExecutionGrant: async () => {
				throw new Error("grant invalid");
			},
		});
		await expect(
			bridge.writeResult({
				binding,
				executionGrant: grant,
				descriptor,
				body: new ReadableStream<Uint8Array>(),
				idempotencyKey: "result-invalid-grant",
			}),
		).rejects.toThrow("grant invalid");
		expect(writeResult).not.toHaveBeenCalled();
	});
});
