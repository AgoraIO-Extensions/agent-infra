import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileDescriptorV1 } from "@agent-infra/contracts/files";
import { describe, expect, it, vi } from "vitest";
import {
	ingressVerifiedRuntimeHost,
	runtimeGrantFixture,
} from "./grant-fixture.test-support.js";
import { FakeRuntimeDriver, FileRuntimeStore, RuntimeHost } from "./index.js";
import {
	assertRuntimeFileBridgeContextMatchesV1,
	assertRuntimeFileBridgeContextV1,
	createRuntimeFileBridgeV1,
	type RuntimeFileBridgeBindingV1,
	type RuntimeFileBridgeContextV1,
} from "./runtime-file-bridge.js";

const binding: RuntimeFileBridgeBindingV1 = Object.freeze({
	actorId: "actor-1",
	channelId: "web",
	agentId: "agent-1",
	conversationId: "conversation-1",
	executionId: "execution-1",
	sessionGeneration: 3,
	grantId: "grant-1",
	expiresAt: 20_000,
	inputFileIds: Object.freeze(["input-1"]),
});

const descriptor = {
	name: "input.txt",
	mediaType: "text/plain",
	sizeBytes: 3,
	sha256: "a".repeat(64),
} as const;

const projection = {
	schemaVersion: 1,
	fileId: "result-1",
	kind: "result",
	descriptor,
	status: "available",
	createdAt: "2026-10-10T00:00:00Z",
	expiresAt: "2026-10-10T01:00:00Z",
} as const;

function bridge(
	options: Partial<Parameters<typeof createRuntimeFileBridgeV1>[0]> = {},
) {
	return createRuntimeFileBridgeV1({
		binding,
		now: () => 10_000,
		isRevoked: () => false,
		isCurrent: () => true,
		readInput: async (context) => ({
			fileId: context.fileId,
			descriptor,
			body: new ReadableStream<Uint8Array>(),
		}),
		writeResult: async () => projection,
		...options,
	});
}

describe("RuntimeHost execution file bridge", () => {
	it("passes a frozen, exact read or result-write context to injected authority", async () => {
		const readInput = vi.fn(async (context: RuntimeFileBridgeContextV1) => ({
			fileId: context.fileId,
			descriptor,
			body: new ReadableStream<Uint8Array>(),
		}));
		const writeResult = vi.fn(
			async (
				..._args: [
					FileDescriptorV1,
					ReadableStream<Uint8Array>,
					RuntimeFileBridgeContextV1,
				]
			) => projection,
		);
		const port = bridge({ readInput, writeResult });

		await port.readInput("input-1");
		await port.writeResult(descriptor, new ReadableStream<Uint8Array>());

		const readContext = readInput.mock.calls[0]?.[0];
		expect(readContext).toMatchObject({
			...binding,
			fileId: "input-1",
			operation: "read",
		});
		expect(Object.isFrozen(readContext)).toBe(true);
		const writeContext = (
			writeResult.mock.calls[0] as unknown[] | undefined
		)?.[2];
		expect(writeContext).toMatchObject({
			...binding,
			fileId: "result",
			operation: "write",
		});
		expect(Object.isFrozen(writeContext)).toBe(true);
	});

	it("forwards the caller signal and never reaches the reader once aborted", async () => {
		const forwarded: (AbortSignal | undefined)[] = [];
		const readInput = vi.fn(
			async (context: RuntimeFileBridgeContextV1, signal?: AbortSignal) => {
				forwarded.push(signal);
				return {
					fileId: context.fileId,
					descriptor,
					body: new ReadableStream<Uint8Array>(),
				};
			},
		);
		const port = bridge({ readInput });
		const signal = new AbortController().signal;

		await port.readInput("input-1", signal);
		expect(forwarded[0]).toBe(signal);

		const aborted = new AbortController();
		aborted.abort();
		await expect(port.readInput("input-1", aborted.signal)).rejects.toThrow(
			"RUNTIME_FILE_INPUT_ABORTED",
		);
		expect(readInput).toHaveBeenCalledTimes(1);
	});

	it("revalidates the current authority on demand", async () => {
		let revoked = false;
		const port = bridge({ isRevoked: () => revoked });

		expect(() => port.revalidate()).not.toThrow();
		revoked = true;
		expect(() => port.revalidate()).toThrow(
			"RUNTIME_FILE_BRIDGE_CONTEXT_REVOKED",
		);
	});

	it("refuses bytes whose authority lapsed during the exchange", async () => {
		let cancelled = false;
		let live = true;
		const port = bridge({
			isRevoked: () => !live,
			readInput: async (context: RuntimeFileBridgeContextV1) => {
				// The deployment authority lapses while the exchange is in flight.
				live = false;
				return {
					fileId: context.fileId,
					descriptor,
					body: new ReadableStream<Uint8Array>({
						cancel() {
							cancelled = true;
						},
					}),
				};
			},
		});

		await expect(port.readInput("input-1")).rejects.toThrow(
			"RUNTIME_FILE_BRIDGE_CONTEXT_REVOKED",
		);
		expect(cancelled).toBe(true);
	});

	it("cancels the body when the authority returns a foreign file id", async () => {
		let cancelled = false;
		const port = bridge({
			readInput: async () => ({
				fileId: "input-2",
				descriptor,
				body: new ReadableStream<Uint8Array>({
					cancel() {
						cancelled = true;
					},
				}),
			}),
		});

		await expect(port.readInput("input-1")).rejects.toThrow(
			"RUNTIME_FILE_BRIDGE_BINDING_INVALID",
		);
		expect(cancelled).toBe(true);
	});

	it("keeps result writes valid for a maximum-length execution id", async () => {
		const longBinding = { ...binding, executionId: "e".repeat(255) };
		const writeResult = vi.fn(
			async (
				..._args: [
					FileDescriptorV1,
					ReadableStream<Uint8Array>,
					RuntimeFileBridgeContextV1,
				]
			) => projection,
		);
		const port = bridge({ binding: longBinding, writeResult });
		await expect(
			port.writeResult(descriptor, new ReadableStream<Uint8Array>()),
		).resolves.toEqual(projection);
		expect(writeResult.mock.calls[0]?.[2]).toMatchObject({
			fileId: "result",
			operation: "write",
			executionId: longBinding.executionId,
		});
	});

	it("rejects a file outside the signed input set before invoking the reader", async () => {
		const readInput = vi.fn(async (context: RuntimeFileBridgeContextV1) => ({
			fileId: context.fileId,
			descriptor,
			body: new ReadableStream<Uint8Array>(),
		}));
		await expect(bridge({ readInput }).readInput("other-file")).rejects.toThrow(
			"RUNTIME_FILE_INPUT_NOT_AUTHORIZED",
		);
		expect(readInput).not.toHaveBeenCalled();
	});

	it.each([
		["expired", { now: () => 20_000 }],
		["revoked", { isRevoked: () => true }],
		["stale generation", { isCurrent: () => false }],
	] as const)(
		"rejects %s contexts before callbacks",
		async (_name, options) => {
			const readInput = vi.fn(async (context: RuntimeFileBridgeContextV1) => ({
				fileId: context.fileId,
				descriptor,
				body: new ReadableStream<Uint8Array>(),
			}));
			const writeResult = vi.fn(
				async (
					..._args: [
						FileDescriptorV1,
						ReadableStream<Uint8Array>,
						RuntimeFileBridgeContextV1,
					]
				) => projection,
			);
			const port = bridge({ ...options, readInput, writeResult });
			await expect(port.readInput("input-1")).rejects.toThrow();
			await expect(
				port.writeResult(descriptor, new ReadableStream<Uint8Array>()),
			).rejects.toThrow();
			expect(readInput).not.toHaveBeenCalled();
			expect(writeResult).not.toHaveBeenCalled();
		},
	);

	it("rejects a context with a wrong operation or substituted binding", () => {
		const wrong = {
			...binding,
			fileId: "input-1",
			operation: "write",
		} as RuntimeFileBridgeContextV1;
		expect(() => assertRuntimeFileBridgeContextV1(wrong, "read")).toThrow(
			"RUNTIME_FILE_BRIDGE_CONTEXT_INVALID",
		);
		const foreign = {
			...binding,
			agentId: "agent-foreign",
			fileId: "input-1",
			operation: "read",
		} as RuntimeFileBridgeContextV1;
		expect(() =>
			assertRuntimeFileBridgeContextMatchesV1(binding, foreign, "read"),
		).toThrow("RUNTIME_FILE_BRIDGE_CONTEXT_INVALID");
	});

	it("contains no durable FileRuntimeStore or file authority material", () => {
		const encoded = JSON.stringify(binding);
		expect(encoded).not.toContain("token");
		expect(encoded).not.toContain("body");
		expect(encoded).not.toContain("temporary");
		expect(encoded).toContain('"executionId":"execution-1"');
	});

	it("requires revocation and current-generation checks for every bridge", () => {
		expect(() =>
			createRuntimeFileBridgeV1({
				binding,
				readInput: async () => ({
					fileId: "input-1",
					descriptor,
					body: new ReadableStream<Uint8Array>(),
				}),
				writeResult: async () => projection,
			} as never),
		).toThrow("RUNTIME_FILE_BRIDGE_AUTHORITY_REQUIRED");
	});

	it("keeps a RuntimeHost without deployment bridge fail-closed", async () => {
		const directory = await mkdtemp(join(tmpdir(), "runtime-file-bridge-"));
		try {
			const host = await RuntimeHost.open({
				store: await FileRuntimeStore.open(join(directory, "host.json")),
				driver: await FakeRuntimeDriver.open(join(directory, "driver.json")),
				grantValidation: {
					expectedIssuer: "agent-platform",
					now: () => "2026-10-10T00:00:00Z",
				},
				validateGrantV4: vi.fn(async () => {
					throw new Error("validator must not run without a bridge");
				}),
			});
			await expect(host.getFileBridge({} as never)).rejects.toThrow(
				"Runtime authorization is unavailable",
			);
			await host.close();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("does not persist bridge authority material in FileRuntimeStore records", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "runtime-file-bridge-store-"),
		);
		const storePath = join(directory, "host.json");
		try {
			const store = await FileRuntimeStore.open(storePath);
			const host = await RuntimeHost.open({
				store,
				driver: await FakeRuntimeDriver.open(join(directory, "driver.json")),
				grantValidation: {
					expectedIssuer: "agent-platform",
					now: () => "2026-08-28T10:00:00Z",
				},
				fileBridge: () => bridge(),
			});
			const binding = {
				agentId: "agent-1",
				actorId: "actor-1",
				channelId: "web",
				conversationId: "conversation-1",
				executionId: "execution-1",
				turnId: "turn-1",
				sessionGeneration: 1,
				traceId: "trace-1",
			};
			const grant = runtimeGrantFixture(binding, ["turn.submit"], {
				attachments: [{ attachmentId: "input-1", operations: ["read"] }],
			});
			await ingressVerifiedRuntimeHost(host).submitTurn({
				schemaVersion: 1,
				requestId: "request-1",
				...binding,
				deliveryFence: 1,
				grant,
				input: { text: "persist only references", attachments: ["input-1"] },
			});
			await host.close();
			const durable = await readFile(storePath, "utf8");
			expect(durable).toContain('"executionId":"execution-1"');
			expect(durable).not.toContain("fileBridge");
			expect(durable).not.toContain("temporary");
			expect(durable).not.toContain('"body"');
			expect(durable).not.toContain("objectUrl");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
