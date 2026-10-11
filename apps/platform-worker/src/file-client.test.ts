import { createHash } from "node:crypto";
import type { RuntimeFileBridgeBindingV1 } from "@agent-infra/agent-runtime";
import type { FileDescriptorV1 } from "@agent-infra/contracts/files";
import { describe, expect, it } from "vitest";
import { createWorkerRuntimeFileBridgeFactoryV1 } from "./file-client.js";

const binding: RuntimeFileBridgeBindingV1 = {
	actorId: "actor-1",
	channelId: "web",
	agentId: "agent-1",
	conversationId: "conversation-1",
	executionId: "execution-1",
	sessionGeneration: 2,
	grantId: "grant-1",
	expiresAt: Date.now() + 60_000,
	inputFileIds: ["input-1"],
};

const descriptor: FileDescriptorV1 = {
	name: "input.txt",
	mediaType: "text/plain",
	sizeBytes: 3,
	sha256: createHash("sha256").update("abc").digest("hex"),
};

function access(file: Record<string, unknown>, path: string) {
	return {
		schemaVersion: 1,
		accessId: "access-1",
		file: {
			schemaVersion: 1,
			createdAt: new Date().toISOString(),
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
			...file,
		},
		path,
		expiresAt: new Date(Date.now() + 60_000).toISOString(),
		grant: {
			schemaVersion: 1,
			format: "compact-jws",
			token: "a.b.c",
		},
	};
}

describe("Worker V4 runtime file client", () => {
	it("exchanges an exact binding and streams an authorized input", async () => {
		const calls: { url: string; init?: RequestInit }[] = [];
		const factory = createWorkerRuntimeFileBridgeFactoryV1({
			origin: "https://platform.example",
			serviceToken: "s".repeat(32),
			fetch: async (input, init) => {
				calls.push({ url: String(input), init });
				if (String(input).endsWith("runtime-exchange"))
					return Response.json(
						access(
							{
								fileId: "input-1",
								kind: "attachment",
								status: "available",
								descriptor,
							},
							"/api/v1/conversations/conversation-1/files/input-1/content",
						),
					);
				return new Response("abc");
			},
		});
		const input = await factory(binding).readInput("input-1");
		await expect(new Response(input.body).text()).resolves.toBe("abc");
		const request = JSON.parse(String(calls[0]?.init?.body)) as Record<
			string,
			unknown
		>;
		expect(request).toMatchObject({
			operation: "read",
			actorId: binding.actorId,
			executionId: binding.executionId,
			fileId: "input-1",
		});
	});

	it("bounds and confirms an execution-bound result write", async () => {
		const calls: string[] = [];
		const resultDescriptor = { ...descriptor, name: "result.txt" };
		const result = access(
			{
				fileId: "result-1",
				kind: "result",
				status: "pending",
				descriptor: resultDescriptor,
			},
			"/api/v1/conversations/conversation-1/files/result-1/content",
		);
		const factory = createWorkerRuntimeFileBridgeFactoryV1({
			origin: "https://platform.example",
			serviceToken: "s".repeat(32),
			fetch: async (input) => {
				calls.push(String(input));
				if (calls.length === 1) return Response.json(result);
				if (calls.length === 2) return new Response(null, { status: 201 });
				return Response.json({
					...result.file,
					status: "available",
				});
			},
		});
		await expect(
			factory(binding).writeResult(
				resultDescriptor,
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode("abc"));
						controller.close();
					},
				}),
			),
		).resolves.toMatchObject({
			projection: { fileId: "result-1", status: "available" },
		});
		expect(calls).toHaveLength(3);
	});

	it("rejects a stale binding before contacting Platform", async () => {
		let calls = 0;
		const factory = createWorkerRuntimeFileBridgeFactoryV1({
			origin: "https://platform.example",
			serviceToken: "s".repeat(32),
			isCurrent: () => false,
			fetch: async () => {
				calls += 1;
				return Response.error();
			},
		});
		await expect(factory(binding).readInput("input-1")).rejects.toThrow(
			"WORKER_RUNTIME_FILE_BINDING_STALE",
		);
		expect(calls).toBe(0);
	});

	it("revalidates before minting a receipt after completion", async () => {
		let clock = 1;
		const localBinding = { ...binding, expiresAt: 100 };
		const resultDescriptor = { ...descriptor, name: "result.txt" };
		const result = access(
			{
				fileId: "result-1",
				kind: "result",
				status: "pending",
				descriptor: resultDescriptor,
			},
			"/api/v1/conversations/conversation-1/files/result-1/content",
		);
		let calls = 0;
		const factory = createWorkerRuntimeFileBridgeFactoryV1({
			origin: "https://platform.example",
			serviceToken: "s".repeat(32),
			now: () => clock,
			fetch: async (_input) => {
				calls += 1;
				if (calls === 1) return Response.json(result);
				if (calls === 2) return new Response(null, { status: 201 });
				clock = 101;
				return Response.json({ ...result.file, status: "available" });
			},
		});
		await expect(
			factory(localBinding).writeResult(
				resultDescriptor,
				new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode("abc"));
						controller.close();
					},
				}),
			),
		).rejects.toThrow("WORKER_RUNTIME_FILE_BINDING_STALE");
	});

	it("revalidates while an input stream is being consumed", async () => {
		let checks = 0;
		const factory = createWorkerRuntimeFileBridgeFactoryV1({
			origin: "https://platform.example",
			serviceToken: "s".repeat(32),
			isCurrent: () => checks++ < 1,
			fetch: async (input) =>
				String(input).endsWith("runtime-exchange")
					? Response.json(
							access(
								{
									fileId: "input-1",
									kind: "attachment",
									status: "available",
									descriptor,
								},
								"/api/v1/conversations/conversation-1/files/input-1/content",
							),
						)
					: new Response("abc"),
		});
		const input = await factory(binding).readInput("input-1");
		await expect(new Response(input.body).text()).rejects.toThrow(
			"WORKER_RUNTIME_FILE_BINDING_STALE",
		);
	});
});
