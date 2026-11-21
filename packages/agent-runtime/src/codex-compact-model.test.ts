import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { seedNativeCommandState } from "./codex-native-command.test-support.js";
import { createCodexSessionExecutorBindingV1 } from "./codex-session-executor-binding.js";
import { CompactModelTransport } from "./compact-model.test-support.js";
import {
	MetadataDriver,
	MetadataTransport,
} from "./compact-transport.test-support.js";

it.each([
	"completed",
	"prototype-execution",
	"drain-unproven",
	"restart",
	"nonempty-rpc",
	"rpc-timeout",
	"rpc-disconnected",
	"item-only",
	"turn-only",
	"failed-turn",
	"http-failure",
	"incomplete-stream",
	"revoked",
	"key-rotated",
	"cross-user",
	"cross-session",
	"cross-agent",
] as const)(
	"protects the compact model Execution and its terminal proof (%s, #4045)",
	async (mode) => {
		const executionId =
			mode === "prototype-execution" ? "__proto__" : "compact-model";
		const directory = await mkdtemp(join(tmpdir(), "compact-model-admission-"));
		const transport = new CompactModelTransport();
		transport.threadId = randomUUID();
		transport.compactTurnId = randomUUID();
		transport.compactItemId = randomUUID();
		let providerRequests = 0;
		let current = true;
		const drainConfirmed = false;
		if (mode === "restart") transport.holdCompactTerminal = true;
		const key = "synthetic-private-compact-key-canary";
		if (mode === "nonempty-rpc") transport.rpcMode = "nonempty";
		if (mode === "rpc-timeout") transport.rpcMode = "timeout";
		if (mode === "rpc-disconnected") transport.rpcMode = "disconnect";
		if (mode === "item-only" || mode === "turn-only")
			transport.completionMode = mode;
		if (mode === "failed-turn") transport.completionMode = "failed";
		const server = createServer(async (request, response) => {
			for await (const _ of request) {
				/* No request bodies are retained. */
			}
			providerRequests++;
			expect(request.headers.authorization).toBe(`Bearer ${key}`);
			if (mode === "http-failure") {
				response.writeHead(503).end();
				return;
			}
			const item = {
				type: "message",
				id: "synthetic-summary",
				role: "assistant",
				content: [{ type: "output_text", text: "Synthetic summary" }],
			};
			response.writeHead(200, { "content-type": "text/event-stream" });
			for (const event of [
				{ type: "response.created", response: { id: "synthetic-response" } },
				{ type: "response.output_item.done", item },
				{
					type: "response.completed",
					response: {
						id: "synthetic-response",
						status: "completed",
						usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
					},
				},
			].filter(
				(event) =>
					mode !== "incomplete-stream" || event.type !== "response.completed",
			))
				response.write(
					`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
				);
			response.end();
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("Missing mock address");
		const seeded = await seedNativeCommandState(
			directory,
			transport.threadId,
			true,
		);
		const actions: string[] = [];
		const observations: unknown[] = [];
		const driver = await MetadataDriver.openFixture(seeded.path, transport, {
			observeNativeCompactStage: (event) => observations.push(event),
			observeModelTransportFailure: (event) => observations.push(event),
			modelOptions: [
				{
					modelOptionId: "primary",
					model: "gpt-5.3-codex",
					reasoningLevels: ["high"],
					endpoint: `http://127.0.0.1:${address.port}/v1`,
				},
			],
			authorizeExternalAction: async (action) => {
				actions.push(action.executionId);
				if (mode === "revoked")
					throw new Error("Synthetic authorization denied");
				if (mode === "key-rotated") current = false;
				return {
					relayKey: key,
					revalidate: () => {
						if (!current) throw new Error("Synthetic frozen Key changed");
					},
				};
			},
		});
		try {
			const binding = {
				...seeded.binding,
				scope: { ...seeded.binding.scope, executionId: executionId },
			};
			const read = {
				nativeSessionRef: seeded.nativeSessionRef,
				allowUnboundExecution: true,
				signal: AbortSignal.timeout(mode === "rpc-timeout" ? 75 : 5000),
				expiresAt: Date.now() + (mode === "rpc-timeout" ? 75 : 5000),
				assertCurrent: () => binding,
				revalidate: async () => binding,
			};
			const catalog = await driver.readNativeMetadataV2("commands", read);
			const capability = catalog.capabilities.find((c) => c.name === "compact");
			if (!capability) throw new Error("Missing compact");
			const command = driver.createNativeCommandCommandV2({
				schemaVersion: 2,
				kind: "native-command",
				operationId: executionId,
				...binding.scope,
				turnId: "platform-compact-model",
				nativeSessionRef: seeded.nativeSessionRef,
				capabilityId: capability.id,
				directoryRevision: catalog.revision,
				capabilityName: capability.name,
				capabilitySourceVersion: capability.source.version,
				parameters: "",
				parametersDigest: createHash("sha256").update("").digest("hex"),
				effect: "state_changing",
				selection: {
					schemaVersion: 1,
					modelOptionId: "primary",
					reasoningLevel: "high",
				},
				keyBinding: {
					purpose: "agent-default",
					subjectId: "agent-1",
					ciphertextRef: "synthetic-compact-key-ref",
					version: 1,
				},
				authorizationRecordId: "compact-authorization",
			});
			if (mode.startsWith("cross-")) {
				if (mode === "cross-user") binding.principal.id = "another-user";
				if (mode === "cross-session")
					binding.scope.conversationId = "another-session";
				if (mode === "cross-agent") binding.scope.agentId = "another-agent";
				await expect(
					driver.execute(command, { nativeCommand: read }),
				).rejects.toThrow();
				expect(
					transport.requests.filter((r) => r.method === "thread/compact/start"),
				).toHaveLength(0);
				expect(providerRequests).toBe(0);
				return;
			}
			if (mode === "drain-unproven") {
				const executorBinding = createCodexSessionExecutorBindingV1({
					namespace: "runtime",
					podName: "sandbox-a",
					sandboxId: "a",
					agentId: binding.scope.agentId,
					conversationId: binding.scope.conversationId,
					sessionGeneration: 1,
					resourceFence: 1,
					imageDigest: `registry.example.test/runtime@sha256:${"a".repeat(64)}`,
				});
				Object.defineProperty(driver, "sessionExecutor", {
					value: {
						binding: executorBinding,
						assertCurrent: async () => {},
						onFailure: () => () => {},
						drain: {
							arm: async () => {},
							bindNativeTurn: async () => {},
							confirm: async () => drainConfirmed,
							proven: () => drainConfirmed,
						},
					},
				});
				Object.defineProperty(driver, "executorExecutionId", {
					value: command.executionId,
					writable: true,
				});
			}
			const result = await driver.execute(command, { nativeCommand: read });
			if (mode === "restart") {
				await expect.poll(() => transport.modelStatuses).toEqual([200]);
				await expect
					.poll(async () =>
						(
							await driver.replayEvents(
								seeded.nativeSessionRef,
								command.executionId,
							)
						)
							.filter((e) => e.type === "operation")
							.map((e) => e.payload.phase),
					)
					.toEqual(["intent", "started", "completed"]);
				await driver.close();
				const recoveredTransport = new MetadataTransport();
				recoveredTransport.threadId = transport.threadId;
				recoveredTransport.turns = [
					{
						id: transport.compactTurnId,
						status: "completed",
						items: [{ type: "contextCompaction", id: transport.compactItemId }],
					},
				];
				const recovered = await MetadataDriver.openFixture(
					seeded.path,
					recoveredTransport,
				);
				try {
					expect(
						await recovered.getStatus(
							seeded.nativeSessionRef,
							command.executionId,
						),
					).toBe("completed");
					const persisted = await recovered.lookupOperation(command);
					expect(persisted).toMatchObject({
						state: "found",
						record: { result: { outcome: "accepted", status: "completed" } },
					});
					expect(
						recoveredTransport.requests.some(
							(f) => f.method === "thread/compact/start",
						),
					).toBe(false);
					expect(
						recoveredTransport.requests.some((f) => f.method === "thread/read"),
					).toBe(true);
				} finally {
					await recovered.close();
				}
				expect(providerRequests).toBe(1);
				return;
			}

			if (mode !== "completed" && mode !== "prototype-execution") {
				if (
					mode === "rpc-timeout" ||
					mode === "rpc-disconnected" ||
					mode === "nonempty-rpc"
				)
					expect(result.result.outcome).toBe("unknown");
				else
					await expect
						.poll(() => driver.getStatus(seeded.nativeSessionRef, executionId))
						.toBe("unknown");
				if (mode === "failed-turn") {
					await transport.replayModel();
					expect(providerRequests).toBe(1);
					expect(transport.modelStatuses.at(-1)).not.toBe(200);
					await driver.close();
					const recoveryTransport = new MetadataTransport();
					recoveryTransport.threadId = transport.threadId;
					recoveryTransport.turns = [
						{
							id: transport.compactTurnId,
							status: "completed",
							items: [
								{ type: "contextCompaction", id: transport.compactItemId },
							],
						},
					];
					const recovered = await MetadataDriver.openFixture(
						seeded.path,
						recoveryTransport,
					);
					try {
						expect(
							await recovered.getStatus(seeded.nativeSessionRef, executionId),
						).toBe("unknown");
						expect(
							recoveryTransport.requests.some(
								(frame) => frame.method === "thread/compact/start",
							),
						).toBe(false);
					} finally {
						await recovered.close();
					}
				}
				const facts = await driver
					.replayEvents(seeded.nativeSessionRef, executionId)
					.catch(() => []);
				expect(
					facts.some(
						(e) => e.type === "completed" && e.payload.status === "completed",
					),
				).toBe(false);
				expect(JSON.stringify(facts)).not.toContain(key);
				expect(providerRequests).toBe(
					[
						"revoked",
						"key-rotated",
						"nonempty-rpc",
						"rpc-timeout",
						"rpc-disconnected",
					].includes(mode)
						? 0
						: 1,
				);
				expect(
					transport.requests.filter((r) => r.method === "thread/compact/start"),
				).toHaveLength(1);
				return;
			}

			expect(result.result).toEqual({ outcome: "accepted", status: "running" });

			await expect
				.poll(() => driver.getStatus(seeded.nativeSessionRef, executionId))
				.toBe("completed");
			expect(transport.modelStatuses).toEqual([200]);
			expect(await driver.lookupOperation(command)).toMatchObject({
				state: "found",
				record: { result: { outcome: "accepted", status: "completed" } },
			});
			expect(providerRequests).toBe(1);
			expect(actions).toEqual([executionId]);
			const events = await driver.replayEvents(
				seeded.nativeSessionRef,
				executionId,
			);
			expect(
				events
					.filter((e) => e.type === "operation")
					.map((e) => e.payload.phase),
			).toEqual(["intent", "started", "completed"]);
			expect(
				transport.requests.filter((r) => r.method === "thread/compact/start"),
			).toHaveLength(1);
		} finally {
			const persisted = await readFile(seeded.path, "utf8");
			expect(persisted).not.toContain(key);
			expect(persisted).not.toContain("Synthetic summary input");
			expect(JSON.stringify(observations)).not.toContain(key);
			expect(JSON.stringify(observations)).not.toContain(
				"Synthetic summary input",
			);
			await driver.close();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(directory, { recursive: true, force: true });
		}
	},
	10000,
);
