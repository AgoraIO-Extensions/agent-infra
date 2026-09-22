import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it, vi } from "vitest";
import { readCallbackCorpusBytes } from "../../../deploy/runtime/vendor/codex/callback-corpus.mjs";
import { codexCallbackSchema } from "./codex-callback-schema.generated.js";
import {
	type CodexConnectionBootstrapRequest,
	type CodexConnectionBootstrapResponse,
	type CodexConnectionEvidence,
	type CodexConnectionOperationRequest,
	createCodexConnectionClient,
	validateCodexConnectionProfile,
} from "./codex-connection-client.js";

const corpus = JSON.parse(readCallbackCorpusBytes().toString("utf8")) as {
	cases: { id: string; frame: unknown; schemaValid: boolean }[];
};
const ajv = new Ajv2020({ strict: true, strictRequired: false });
ajv.addFormat(
	"uuid",
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
);
ajv.addSchema(codexCallbackSchema);
function checked<T>(definition: string, id: string): T {
	const value: unknown = structuredClone(
		corpus.cases.find((item) => item.id === id)?.frame,
	);
	const validate = ajv.compile<T>({
		$ref: `${codexCallbackSchema.$id}#/$defs/${definition}`,
	});
	assert(validate(value), id);
	return value;
}
function bootstrapRequest() {
	return checked<CodexConnectionBootstrapRequest>(
		"connectionBootstrapRequest",
		"v2-bootstrap-request-before-native-session",
	);
}
function originalConfiguration() {
	const response = checked<CodexConnectionBootstrapResponse>(
		"connectionBootstrapResponse",
		"v2-bootstrap-user-permit",
	);
	assert.equal(response.decision, "permit");
	if (response.decision !== "permit") throw new Error("fixture");
	const { slotId: _slotId, ...configuration } = response.slot;
	return configuration;
}
const time = 1_800_000_000_350;
const profile = {
	profileRef: "connection-fixture-v1",
	serviceRef: "connection-fixture",
	issuer: "https://connection.example.test",
	resource: "https://connection.example.test/mcp",
};
const authorizedService = {
	serviceRef: profile.serviceRef,
	issuer: profile.issuer,
	resource: profile.resource,
};
function descriptorFromIntent() {
	const frame = checked<CodexConnectionOperationRequest>(
		"connectionOperationRequest",
		"v2-connection-intent",
	);
	return frame.connectionRequest;
}
function evidence(
	id = "v2-connection-completed-verified",
): CodexConnectionEvidence {
	const frame = checked<CodexConnectionOperationRequest>(
		"connectionOperationRequest",
		id,
	);
	assert("connectionEvidence" in frame);
	return frame.connectionEvidence;
}
async function fixture() {
	// The corpus contains full frames. Only validated descriptor/evidence crosses this seam.
	let configuration = originalConfiguration();
	const resolveOriginalClient = vi.fn(async () =>
		structuredClone(configuration),
	);
	const client = createCodexConnectionClient({
		profile,
		authorizedService,
		resolveOriginalClient,
		now: () => time,
	});
	const response = await client.bootstrap(
		bootstrapRequest(),
		new AbortController().signal,
	);
	assert(response.decision === "permit");
	return {
		client,
		response,
		resolveOriginalClient,
		setConfiguration: (next: typeof configuration) => {
			configuration = next;
		},
		descriptor: { ...descriptorFromIntent(), slotId: response.slot.slotId },
	};
}

describe("canonical private callback schema", () => {
	it("matches the generated literal and every shared structural corpus case", () => {
		execFileSync(process.execPath, [
			new URL("../scripts/generate-callback-schema.mjs", import.meta.url)
				.pathname,
			"--check",
		]);
		const validate = ajv.getSchema(codexCallbackSchema.$id);
		assert(validate);
		for (const item of corpus.cases)
			expect(validate(item.frame), item.id).toBe(item.schemaValid);
	});
});

describe("socket-bound independent Connection client", () => {
	it("resolves the first original binding without requiring a native session and exposes no token in ordinary metadata", async () => {
		const { client, response, descriptor, resolveOriginalClient } =
			await fixture();
		expect(resolveOriginalClient).toHaveBeenCalledExactlyOnceWith(
			{ profileRef: profile.profileRef },
			expect.any(AbortSignal),
		);
		assert(response.decision === "permit");
		expect(response.slot.credential.accessToken).toBe(
			"FAKE-TEST-ONLY-NOT-A-CREDENTIAL",
		);
		const binding = client.assertRequest(descriptor);
		expect(binding).toEqual(originalConfiguration().originalBinding);
		expect(JSON.stringify(binding)).not.toContain("FAKE-TEST");
	});
	it("accepts an independently bound application principal without falling back to a user", async () => {
		const config = originalConfiguration();
		config.originalBinding.principal = {
			kind: "application",
			id: "platform-app-fixture",
		};
		config.connectionIdentity.principal = {
			type: "application",
			key: "connection-app-fixture",
		};
		const client = createCodexConnectionClient({
			profile,
			authorizedService,
			resolveOriginalClient: async () => config,
			now: () => time,
		});
		const reply = await client.bootstrap(
			bootstrapRequest(),
			new AbortController().signal,
		);
		assert(reply.decision === "permit");
		expect(reply.slot.originalBinding.principal.kind).toBe("application");
		expect(reply.slot.connectionIdentity.principal.key).toBe(
			"connection-app-fixture",
		);
	});
	it("rejects repeated bootstrap ids and a changed process nonce without reloading credentials", async () => {
		const { client, resolveOriginalClient } = await fixture();
		await expect(
			client.bootstrap(bootstrapRequest(), new AbortController().signal),
		).rejects.toThrow("CODEX_CONNECTION_CLIENT_UNAVAILABLE");
		const changed = {
			...bootstrapRequest(),
			requestId: "00000000-0000-4000-8000-000000009999",
			processNonce: "00000000-0000-4000-8000-000000008888",
		};
		expect(
			await client.bootstrap(changed, new AbortController().signal),
		).toMatchObject({ decision: "unavailable", reason: "binding_mismatch" });
		expect(resolveOriginalClient).toHaveBeenCalledTimes(1);
	});
	it.each(["principal", "agent", "generation", "service", "actor"])(
		"rejects %s swapping on the existing process",
		async (change) => {
			const { client, setConfiguration } = await fixture();
			const configuration = originalConfiguration();
			if (change === "principal")
				configuration.originalBinding.principal.id = "another-principal";
			if (change === "agent")
				configuration.originalBinding.scope.agentId = "another-agent";
			if (change === "generation")
				configuration.originalBinding.scope.sessionGeneration = 2;
			if (change === "service")
				configuration.service.resource =
					"https://connection.example.test/other";
			if (change === "actor")
				configuration.connectionIdentity.actorId = "another-actor";
			setConfiguration(configuration);
			const request = {
				...bootstrapRequest(),
				requestId: "00000000-0000-4000-8000-000000009999",
			};
			expect(
				await client.bootstrap(request, new AbortController().signal),
			).toMatchObject({ decision: "unavailable", reason: "binding_mismatch" });
		},
	);
	it("rotates an admitted next Execution without reopening the old slot for dispatch", async () => {
		const { client, descriptor, setConfiguration } = await fixture();
		const configuration = originalConfiguration();
		configuration.originalBinding.scope.executionId = "execution-fixture-b";
		setConfiguration(configuration);
		const next = await client.bootstrap(
			{
				...bootstrapRequest(),
				requestId: "00000000-0000-4000-8000-000000009999",
			},
			new AbortController().signal,
		);
		assert(next.decision === "permit");
		expect(() => client.assertRequest(descriptor)).toThrow(
			"CODEX_CONNECTION_CLIENT_UNAVAILABLE",
		);
		expect(
			client.assertRequest({ ...descriptor, slotId: next.slot.slotId }).scope
				.executionId,
		).toBe("execution-fixture-b");
		expect(
			client.associate({
				requestDescriptor: descriptor,
				evidence: evidence(),
				metadataOnly: false,
				occurredAt: time,
			}),
		).toEqual({
			serviceRef: profile.serviceRef,
			verification: "verified",
			callRef: "callref-fixture-a",
		});
	});
	it("bounds historical bootstrap slots", async () => {
		const { client } = await fixture();
		for (let index = 2; index <= 1_024; index++) {
			const request = {
				...bootstrapRequest(),
				requestId: `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
			};
			expect(
				(await client.bootstrap(request, new AbortController().signal))
					.decision,
			).toBe("permit");
		}
		const denied = await client.bootstrap(
			{
				...bootstrapRequest(),
				requestId: "00000000-0000-4000-8000-000000001025",
			},
			new AbortController().signal,
		);
		expect(denied).toMatchObject({
			decision: "unavailable",
			reason: "credential_unavailable",
		});
	});
	it("rejects expired credentials and redacts a loader error", async () => {
		const config = originalConfiguration();
		config.credential.expiresAt = time;
		for (const resolveOriginalClient of [
			async () => config,
			async () => {
				throw new Error("FAKE-SECRET-ERROR");
			},
		]) {
			const client = createCodexConnectionClient({
				profile,
				authorizedService,
				resolveOriginalClient,
				now: () => time,
			});
			const result = await client.bootstrap(
				bootstrapRequest(),
				new AbortController().signal,
			);
			expect(result.decision).toBe("unavailable");
			expect(JSON.stringify(result)).not.toContain("FAKE-");
			expect(result).not.toHaveProperty("slot");
		}
	});
	it("rejects an unknown or expired dispatch slot", async () => {
		const { client, descriptor } = await fixture();
		expect(() =>
			client.assertRequest({
				...descriptor,
				slotId: "00000000-0000-4000-8000-000000001111",
			}),
		).toThrow();
		client.close();
		expect(() => client.assertRequest(descriptor)).toThrow();
	});
	it("checks credential expiry again at the actual dispatch boundary", async () => {
		const configuration = originalConfiguration();
		let now = time;
		const client = createCodexConnectionClient({
			profile,
			authorizedService,
			resolveOriginalClient: async () => configuration,
			now: () => now,
		});
		const reply = await client.bootstrap(
			bootstrapRequest(),
			new AbortController().signal,
		);
		assert(reply.decision === "permit");
		const descriptor = { ...descriptorFromIntent(), slotId: reply.slot.slotId };
		expect(client.assertRequest(descriptor)).toEqual(
			configuration.originalBinding,
		);
		now = configuration.credential.expiresAt;
		expect(() => client.assertRequest(descriptor)).toThrow(
			"CODEX_CONNECTION_CLIENT_UNAVAILABLE",
		);
	});
	it("projects only the public association and keeps missing original response unverified", async () => {
		const { client, descriptor } = await fixture();
		const projection = client.associate({
			requestDescriptor: descriptor,
			evidence: evidence(),
			metadataOnly: false,
			occurredAt: time,
		});
		expect(projection).toEqual({
			serviceRef: profile.serviceRef,
			verification: "verified",
			callRef: "callref-fixture-a",
		});
		const lost = evidence("v2-connection-unknown-response-lost");
		const result = client.associate({
			requestDescriptor: descriptor,
			evidence: lost,
			metadataOnly: false,
			occurredAt: time,
		});
		expect(result).toEqual({
			serviceRef: profile.serviceRef,
			verification: "unverified",
			reason: "response_unconfirmed",
		});
	});
	it.each([
		"receipt-operation-nonce-swap",
		"receipt-rpc-id-swap",
		"record-missing-attempt",
		"record-digest-mismatch",
		"record-principal-mismatch",
		"record-actor-mismatch",
		"record-client-mismatch",
		"record-consumer-mismatch",
		"record-action-version-mismatch",
		"record-ref-mismatch",
		"verified-time-in-future",
		"real-callref-cross-execution-graft",
	])("rejects the shared semantic evidence case %s", async (name) => {
		const { client, descriptor } = await fixture();
		expect(() =>
			client.associate({
				requestDescriptor: descriptor,
				evidence: evidence(`semantic-reject-${name}`),
				metadataOnly: false,
				occurredAt: time,
			}),
		).toThrow("CODEX_CONNECTION_CLIENT_UNAVAILABLE");
	});
	it("requires an already saved original receipt for metadata-only updates and never downgrades verified", async () => {
		const { client, descriptor } = await fixture();
		const good = evidence();
		const prior = evidence("v2-connection-unverified-record_unavailable");
		expect(
			client.associate({
				requestDescriptor: descriptor,
				evidence: good,
				previousEvidence: prior,
				metadataOnly: true,
				occurredAt: time,
			})?.verification,
		).toBe("verified");
		expect(() =>
			client.associate({
				requestDescriptor: descriptor,
				evidence: good,
				previousEvidence: evidence("v2-connection-unknown-response-lost"),
				metadataOnly: true,
				occurredAt: time,
			}),
		).toThrow();
		expect(() =>
			client.associate({
				requestDescriptor: descriptor,
				evidence: prior,
				previousEvidence: good,
				metadataOnly: true,
				occurredAt: time,
			}),
		).toThrow();
	});
	it("rejects a recovery origin whose service is not the fixed profile", async () => {
		const { client, descriptor } = await fixture();
		const origin = client.snapshotOriginal(descriptor);
		const forged = structuredClone(origin);
		forged.service.resource = "https://attacker.example.test/mcp";
		expect(() =>
			client.associate({
				requestDescriptor: descriptor,
				evidence: evidence(),
				metadataOnly: false,
				occurredAt: time,
				origin: forged,
			}),
		).toThrow("CODEX_CONNECTION_CLIENT_UNAVAILABLE");
	});
	it("validates fixed HTTPS origin/path without accepting a response-provided endpoint", () => {
		for (const resource of [
			"http://connection.example.test/mcp",
			"https://attacker.example.test/mcp",
			"https://connection.example.test/elsewhere",
			"https://connection.example.test/mcp?url=evil",
		])
			expect(() =>
				validateCodexConnectionProfile(
					{ ...profile, resource },
					authorizedService,
				),
			).toThrow();
		const attacker = {
			...profile,
			issuer: "https://attacker.example.test",
			resource: "https://attacker.example.test/mcp",
		};
		expect(() =>
			validateCodexConnectionProfile(attacker, authorizedService),
		).toThrow();
	});
});
