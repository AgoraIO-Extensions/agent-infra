import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
	createPlatformRuntimeModelDirectoryPortsV1,
	createPlatformRuntimeModelDirectoryResolverV1,
} from "./runtime-model-directory-deployment.js";

const request = {
	schemaVersion: 1 as const,
	requestId: "request-model-directory",
	traceId: "trace-model-directory",
	actorId: "user-1",
	channelId: "web",
	agentId: "agent-1",
	conversationId: "conversation-1",
	executionId: "execution-1",
	turnId: "turn-1",
	sessionGeneration: 2,
	deliveryFence: 7,
	hostSessionRef: "host-session-1",
};

describe("production model-directory assembly", () => {
	it("supplies a Worker-owned short-lived Grant signer by default", () => {
		const keys = generateKeyPairSync("ed25519");
		const ports = createPlatformRuntimeModelDirectoryPortsV1({
			resolveRuntimeHost: vi.fn(),
			signing: {
				issuer: "platform-worker",
				keyId: "runtime-grant-current",
				privateKey: keys.privateKey,
				now: () => 1_800_000_000_000,
				id: () => "grant-model-directory",
			},
		});
		const grant = ports.signGrant?.(request);
		expect(grant).toMatchObject({ schemaVersion: 1, format: "compact-jws" });
		expect(grant?.token.split(".")).toHaveLength(3);
	});

	it("preserves an explicitly deployment-owned signer and Host resolver", () => {
		const signGrant = vi.fn(() => ({
			schemaVersion: 1 as const,
			format: "compact-jws" as const,
			token: "header.claims.signature",
		}));
		const resolveRuntimeHost = vi.fn();
		const ports = createPlatformRuntimeModelDirectoryPortsV1({
			resolveRuntimeHost,
			signGrant,
			signing: {
				issuer: "platform-worker",
				keyId: "runtime-grant-current",
				privateKey: generateKeyPairSync("ed25519").privateKey,
			},
			port: 3_006,
		});
		expect(ports.resolveRuntimeHost).toBe(resolveRuntimeHost);
		expect(ports.signGrant).toBe(signGrant);
		expect(ports.port).toBe(3_006);
	});

	it("maps Store Workload state into the existing Conversation resolver", async () => {
		const workload = { agentId: "agent-1", phase: "ready" } as never;
		const readWorkloadState = vi.fn().mockResolvedValue(workload);
		const resolveConversationRuntimeHost = vi.fn().mockResolvedValue({
			baseUrl: "http://agent-runtime",
			serviceToken: "service-token",
			workerId: "worker",
		});
		const resolver = createPlatformRuntimeModelDirectoryResolverV1({
			readWorkloadState,
			resolveConversationRuntimeHost,
		});
		const signal = new AbortController().signal;
		await expect(resolver(request, signal)).resolves.toMatchObject({
			modelDirectory: expect.any(Function),
		});
		expect(readWorkloadState).toHaveBeenCalledWith("agent-1", signal);
		expect(resolveConversationRuntimeHost).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: "agent-1",
				actorId: "user-1",
				sessionGeneration: 2,
				deliveryFence: 7,
				purpose: "control",
				command: "session.status",
				workload,
			}),
		);
	});

	it("fails closed when no current Workload state exists", async () => {
		const resolver = createPlatformRuntimeModelDirectoryResolverV1({
			readWorkloadState: vi.fn().mockResolvedValue(null),
			resolveConversationRuntimeHost: vi.fn(),
		});
		await expect(
			resolver(request, new AbortController().signal),
		).rejects.toThrow("RUNTIME_WORKLOAD_UNAVAILABLE");
	});
});
