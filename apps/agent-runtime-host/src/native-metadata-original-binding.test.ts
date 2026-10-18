import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	FakeRuntimeDriver,
	FileRuntimeStore,
	RuntimeHost,
} from "@agent-infra/agent-runtime";
import {
	NativeMetadataCurrentRequestV1Schema,
	type RuntimeNativeMetadataBindingResponseV1,
} from "@agent-infra/contracts/runtime";
import { afterEach, expect, it, vi } from "vitest";
import {
	fixtureNow,
	runtimeV2Keys,
	signV3Fixture,
	submitV3Fixture,
	verifyRuntimeV2Fixture,
} from "../../../packages/agent-runtime/src/grant-v2-fixture.test-support.js";
import { createWorkerRuntimeNativeMetadataProofIssuerV1 } from "../../platform-worker/src/runtime-native-metadata-proof.js";
import { createRuntimeNativeMetadataDeploymentAssemblyV1 } from "./index.js";
import { createRuntimeNativeMetadataReadV1 } from "./native-metadata-assembly.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.useRealTimers();
});

it.each([
	"expired",
	"control",
	"principal",
	"channel",
	"Host",
	"proof",
	"current",
] as const)(
	"keeps production metadata assembly independent and bound: %s",
	async (mode) => {
		let clock = fixtureNow;
		vi.setSystemTime(clock);
		const directory = await mkdtemp(
			join(tmpdir(), "native-metadata-original-"),
		);
		const path = join(directory, "host.json");
		const store = await FileRuntimeStore.open(path);
		const driver = await FakeRuntimeDriver.open(join(directory, "driver.json"));
		const host = await RuntimeHost.open({
			store,
			driver,
			grantValidation: { expectedIssuer: "platform-fixture" },
			grantValidationV2: {
				expectedIssuer: "platform-fixture",
				expectedWorkerId: "worker-fixture",
				now: () => clock,
			},
		});
		cleanups.push(async () => {
			await host.close();
			await store.close();
			await rm(directory, { recursive: true, force: true });
		});
		const submit = signV3Fixture(submitV3Fixture(), "turn.submit");
		const accepted = await host.submitTurnV3(
			submit,
			verifyRuntimeV2Fixture(submit.grant),
		);
		await driver.setOperationStatus(submit.executionId, "completed");
		await store.resolveOperation(accepted.hostSessionRef, submit.executionId, {
			outcome: "accepted",
			status: "completed",
		});
		if (mode === "control") {
			const { input: _input, ...binding } = submitV3Fixture();
			const control = signV3Fixture(
				{
					...binding,
					hostSessionRef: accepted.hostSessionRef,
					consumer: "platform_worker_persistence" as const,
					afterCursor: null,
				},
				"events.persist",
				{ purpose: "control", reason: "recovery" },
			);
			for await (const _event of await host.streamEventsV3(
				control,
				verifyRuntimeV2Fixture(control.grant),
				new AbortController().signal,
			)) {
			}
		}
		if (mode === "expired") clock += 30_001;
		vi.setSystemTime(clock);
		const readDriver = vi.fn(async () => ({
			selector: "status" as const,
			status: "idle" as const,
			readAt: new Date(clock).toISOString(),
		}));
		Object.assign(driver, { readNativeMetadataV1: readDriver });
		let currentRequests = 0;
		const server = createServer(async (request, response) => {
			try {
				expect(request.url).toBe(
					"/internal/platform-worker/v1/native-metadata/current",
				);
				expect(request.headers.authorization).toBe(
					"Bearer synthetic-current-token",
				);
				const chunks: Buffer[] = [];
				for await (const chunk of request) chunks.push(Buffer.from(chunk));
				const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				expect(body.apiRequestSourceRef).toBe("synthetic-api-source");
				const current = NativeMetadataCurrentRequestV1Schema.parse(
					body.request,
				);
				currentRequests++;
				response.setHeader("content-type", "application/json");
				response.end(
					JSON.stringify(
						mode === "current"
							? { outcome: "denied" }
							: {
									outcome: "allowed",
									request: current,
								},
					),
				);
			} catch {
				response.writeHead(503).end();
			}
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		cleanups.push(async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		});
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("Missing fixture listener");
		const assembly = await createRuntimeNativeMetadataDeploymentAssemblyV1({
			host,
			environment: {
				AGENT_INFRA_RUNTIME_NATIVE_METADATA_WORKER_ORIGIN: `http://127.0.0.1:${address.port}`,
				AGENT_INFRA_RUNTIME_NATIVE_METADATA_WORKER_SERVICE_TOKEN:
					"synthetic-current-token",
				AGENT_INFRA_RUNTIME_GRANT_PUBLIC_KEY: runtimeV2Keys.publicKey
					.export({ type: "spki", format: "pem" })
					.toString(),
				AGENT_INFRA_RUNTIME_GRANT_ISSUER: "platform-fixture",
				AGENT_INFRA_RUNTIME_GRANT_KEY_ID: "fixture",
				AGENT_INFRA_RUNTIME_WORKER_ID: "worker-fixture",
			},
		});
		if (!assembly) throw new Error("Missing production metadata assembly");
		const binding: RuntimeNativeMetadataBindingResponseV1 = {
			schemaVersion: 1,
			readId: "synthetic-read",
			selector: "status",
			scope: {
				schemaVersion: 1,
				principal:
					mode === "principal"
						? { kind: "user", id: "other-user" }
						: submit.principal,
				channelId: mode === "channel" ? "api" : submit.channelId,
				agentId: submit.agentId,
				conversationId: submit.conversationId,
				executionId: submit.executionId,
				sessionGeneration: submit.sessionGeneration,
				authorizationRevision: "synthetic-authorization",
			},
			originalHostScopeRef:
				mode === "Host" ? "other-host" : accepted.hostSessionRef,
			readStartedAt: clock,
			expiresAt: clock + 10_000,
			requestId: "synthetic-request",
			traceId: "synthetic-trace",
		};
		const issuer = createWorkerRuntimeNativeMetadataProofIssuerV1({
			issuer: "platform-fixture",
			workerId: "worker-fixture",
			keyVersion: "fixture",
			privateKey: runtimeV2Keys.privateKey,
			now: () => clock,
		});
		const signal = new AbortController().signal;
		const proof = await issuer.issue({
			request: binding,
			apiRequestSourceRef: "synthetic-api-source",
			signal,
		});
		const before = await readFile(path, "utf8");
		const read = createRuntimeNativeMetadataReadV1(host, assembly)(
			{
				...binding,
				apiRequestSourceRef: "synthetic-api-source",
				proof: mode === "proof" ? { ...proof, token: "invalid-proof" } : proof,
			},
			signal,
		);
		if (mode === "expired" || mode === "control") {
			const response = await read;
			expect(response).toMatchObject({
				projection: { selector: "status", status: "idle" },
			});
			expect(response).not.toHaveProperty("apiRequestSourceRef");
			expect(response).not.toHaveProperty("proof");
			expect(readDriver).toHaveBeenCalledTimes(1);
			expect(currentRequests).toBeGreaterThanOrEqual(3);
		} else {
			await expect(read).rejects.toMatchObject({
				code: "RUNTIME_NATIVE_METADATA_UNAVAILABLE",
			});
			expect(readDriver).not.toHaveBeenCalled();
			expect(currentRequests).toBe(mode === "proof" ? 0 : 1);
		}
		expect(await readFile(path, "utf8")).toBe(before);
	},
);
