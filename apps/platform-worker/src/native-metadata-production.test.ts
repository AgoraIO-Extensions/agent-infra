import { generateKeyPairSync } from "node:crypto";
import type { NativeMetadataObjectScopeV1 } from "@agent-infra/contracts";
import { expect, it, vi } from "vitest";
import {
	createProductionNativeMetadataWorkerOptionsV1,
	type ProductionNativeMetadataWorkerInputV1,
} from "./native-metadata-production.js";

function fixture() {
	const metadata = generateKeyPairSync("ed25519");
	const executionKey = generateKeyPairSync("ed25519");
	const fetcher = vi.fn<typeof fetch>();
	const execution = {
		signing: {
			issuer: "execution-issuer",
			keyId: "execution-key",
			workerId: "worker-1",
			privateKey: executionKey.privateKey,
		},
		serviceToken: "synthetic-business-token",
	};
	const input: ProductionNativeMetadataWorkerInputV1 = {
		hostname: "127.0.0.1",
		port: 3010,
		maxActiveReads: 8,
		signing: {
			issuer: "metadata-issuer",
			keyVersion: "metadata-key",
			workerId: "worker-1",
			privateKey: metadata.privateKey,
		},
		apiSources: new Map([
			[
				"api-1",
				{
					origin: "https://api-instance.test:3000",
					apiToWorkerToken: "synthetic-api-to-worker",
					workerToApiToken: "synthetic-worker-to-api",
				},
			],
		]),
		agents: new Map([
			[
				"agent-1",
				{
					hostServiceId: "host-1",
					origin: "https://host-instance.test:3003",
					workerToHostToken: "synthetic-worker-to-host",
					hostToWorkerToken: "synthetic-host-to-worker",
				},
			],
		]),
		fetch: fetcher,
	};
	const scope: NativeMetadataObjectScopeV1 = {
		schemaVersion: 1,
		principal: { kind: "user", id: "alice" },
		agentId: "agent-1",
		channelId: "web",
		conversationId: "conversation-1",
		executionId: "execution-1",
		sessionGeneration: 1,
		authorizationRevision: "revision-1",
	};
	return { input, execution, fetcher, scope };
}

it("routes only to the fixed deployed Host without readiness or native I/O, retaining mapping after caller mutation", async () => {
	const { input, execution, fetcher, scope } = fixture();
	const options = createProductionNativeMetadataWorkerOptionsV1(
		input,
		execution,
		new AbortController().signal,
	);
	const host = await options.runtime.resolveHost(
		scope,
		new AbortController().signal,
	);
	expect(host.hostServiceId).toBe("host-1");
	expect(fetcher).not.toHaveBeenCalled();
	const now = Date.now();
	const request = {
		schemaVersion: 1 as const,
		readId: "read-1",
		selector: "status" as const,
		scope,
		readStartedAt: now,
		expiresAt: now + 30_000,
		requestId: "request-1",
		traceId: "trace-1",
	};
	fetcher.mockResolvedValue(
		Response.json({ ...request, originalHostScopeRef: "a".repeat(64) }),
	);
	const signal = new AbortController().signal;
	await host.client.resolveOriginalBinding(request, signal);
	expect(fetcher.mock.calls[0]?.[0].toString()).toBe(
		"https://host-instance.test:3003/internal/runtime/native-metadata/v1/binding",
	);
	expect(fetcher.mock.calls[0]?.[1]?.signal).toBe(signal);
	expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({
		authorization: "Bearer synthetic-worker-to-host",
	});
	const mutable = input.agents.get("agent-1");
	Object.assign(mutable ?? {}, {
		hostServiceId: "replacement-host",
		origin: "https://replacement.test",
		workerToHostToken: "replacement-token",
	});
	expect(await options.runtime.resolveHost(scope, signal)).toBe(host);
	fetcher.mockClear();
	await expect(
		options.runtime.resolveHost({ ...scope, agentId: "unknown-agent" }, signal),
	).rejects.toThrow();
	expect(fetcher).not.toHaveBeenCalled();
});

it("uses a metadata signing key independent of the business key and rejects role credential reuse before I/O", () => {
	const { input, execution, fetcher } = fixture();
	const abort = new AbortController();
	const invalid = [
		{
			...input,
			signing: { ...input.signing, privateKey: execution.signing.privateKey },
		},
		{
			...input,
			signing: { ...input.signing, keyVersion: execution.signing.keyId },
		},
		{ ...input, signing: { ...input.signing, workerId: "foreign-worker" } },
		{
			...input,
			apiSources: new Map([
				[
					"api-1",
					{
						origin: "https://api.test",
						apiToWorkerToken: execution.serviceToken,
						workerToApiToken: "callback-token",
					},
				],
			]),
		},
		{
			...input,
			apiSources: new Map([
				[
					"api-1",
					{
						origin: "https://api.test",
						apiToWorkerToken: "same-token",
						workerToApiToken: "same-token",
					},
				],
			]),
		},
		{
			...input,
			agents: new Map([
				[
					"agent-1",
					{
						hostServiceId: "host-1",
						origin: "https://host.test",
						workerToHostToken: "synthetic-api-to-worker",
						hostToWorkerToken: "host-callback-token",
					},
				],
			]),
		},
		{
			...input,
			agents: new Map([
				[
					"agent-1",
					{
						hostServiceId: "host-1",
						origin: "https://host.test/inject",
						workerToHostToken: "host-token",
						hostToWorkerToken: "host-callback-token",
					},
				],
			]),
		},
	];
	for (const value of invalid)
		expect(() =>
			createProductionNativeMetadataWorkerOptionsV1(
				value,
				execution,
				abort.signal,
			),
		).toThrow("Native metadata Worker deployment is invalid");
	expect(() =>
		createProductionNativeMetadataWorkerOptionsV1(
			input,
			execution,
			abort.signal,
		),
	).not.toThrow();
	abort.abort();
	expect(() =>
		createProductionNativeMetadataWorkerOptionsV1(
			input,
			execution,
			abort.signal,
		),
	).toThrow();
	expect(fetcher).not.toHaveBeenCalled();
});
