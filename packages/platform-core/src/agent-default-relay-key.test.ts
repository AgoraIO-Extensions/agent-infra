import { describe, expect, it } from "vitest";
import { agentConfigurationConformanceRecordV1 } from "./agent-configuration.conformance.ts";
import {
	type AgentDefaultRelayKeyAuditV1,
	type AgentDefaultRelayKeyTransactionV1,
	createAgentDefaultRelayKeyUseCaseV1,
} from "./agent-default-relay-key.ts";

const key = "SYNTHETIC_DEFAULT_RELAY_KEY";
const trusted = {
	userId: "owner_01",
	agentId: "agent_01",
	traceId: "trace_01",
	requestId: "request_01",
};
const command = {
	configurationRevision: 7,
	expectedVersion: null,
	keyValue: key,
};
function fixture() {
	let configuration = structuredClone(agentConfigurationConformanceRecordV1);
	let current: number | null = null;
	let owned = true;
	let active = true;
	let auditFailure = false;
	let candidates = [
		{ endpointId: "endpoint_01", modelId: "gpt-5", reasoningLevels: ["low"] },
	];
	const audits: AgentDefaultRelayKeyAuditV1[] = [];
	const encrypted: number[] = [];
	let onValidate = () => {};
	const useCase = createAgentDefaultRelayKeyUseCaseV1({
		transaction: {
			async execute<T>(
				work: (tx: AgentDefaultRelayKeyTransactionV1) => Promise<T>,
			) {
				const before = current;
				const beforeAudit = audits.length;
				try {
					return await work({
						ownedConfiguration: async () =>
							owned ? structuredClone(configuration) : null,
						current: async () => current,
						replace: async (agentId, expected, encrypt) => {
							if (current !== expected) return null;
							const next = (current ?? 0) + 1;
							await encrypt({
								purpose: "agent-default",
								subjectId: agentId,
								keyId: `key_${next}`,
								keyVersion: next,
							});
							current = next;
							return next;
						},
						audit: async (event) => {
							if (auditFailure) throw new Error(key);
							audits.push(event);
						},
					});
				} catch (error) {
					current = before;
					audits.splice(beforeAudit);
					throw error;
				}
			},
			recordRefusal: async (event) => {
				audits.push(event);
			},
		},
		currentIdentity: async () => ({
			userId: trusted.userId,
			accountStatus: active ? "active" : "disabled",
			authorizationRevision: "auth-1",
		}),
		candidates: async () => {
			onValidate();
			return structuredClone(candidates);
		},
		encrypt: async (binding, value) => {
			expect(binding.purpose).toBe("agent-default");
			expect(value).toBe(key);
			encrypted.push(binding.keyVersion);
			return {};
		},
	});
	return {
		useCase,
		audits,
		encrypted,
		setOwned: (value: boolean) => {
			owned = value;
		},
		setActive: (value: boolean) => {
			active = value;
		},
		setAuditFailure: () => {
			auditFailure = true;
		},
		setCandidates: (value: typeof candidates) => {
			candidates = value;
		},
		setConfiguration: (value: typeof configuration) => {
			configuration = value;
		},
		setOnValidate: (value: () => void) => {
			onValidate = value;
		},
		current: () => current,
	};
}
describe("default Agent Key command contract (controlled transaction)", () => {
	it("sets and replaces one version without exposing the key", async () => {
		const f = fixture();
		expect(await f.useCase.replace(trusted, command)).toEqual({
			schemaVersion: 1,
			isSet: true,
			keyVersion: 1,
			configurationRevision: 7,
		});
		expect(
			await f.useCase.replace(trusted, { ...command, expectedVersion: 1 }),
		).toMatchObject({ keyVersion: 2 });
		expect(
			f.audits.map((event) => [event.previousVersion, event.keyVersion]),
		).toEqual([
			[null, 1],
			[1, 2],
		]);
		expect(JSON.stringify(f.audits)).not.toContain(key);
	});
	it("requires every configured model and reasoning level in the fresh intersection", async () => {
		const f = fixture();
		f.setCandidates([
			{
				endpointId: "endpoint_01",
				modelId: "gpt-5",
				reasoningLevels: ["high"],
			},
		]);
		await expect(f.useCase.replace(trusted, command)).rejects.toMatchObject({
			code: "invalid_input",
		});
		expect(f.encrypted).toEqual([]);
	});
	it("does not accept a stale preview or configuration revision", async () => {
		const f = fixture();
		await f.useCase.candidates(trusted, {
			configurationRevision: 7,
			keyValue: key,
		});
		f.setCandidates([]);
		await expect(f.useCase.replace(trusted, command)).rejects.toMatchObject({
			code: "invalid_input",
		});
		await expect(
			f.useCase.replace(trusted, { ...command, configurationRevision: 6 }),
		).rejects.toMatchObject({ code: "conflict" });
		expect(f.encrypted).toEqual([]);
	});
	it.each([
		"nonowner",
		"identity revoked",
		"audit failed",
		"custom Agent",
		"stale Key",
		"raw extra field",
	])("fails closed for %s", async (mode) => {
		const f = fixture();
		if (mode === "nonowner") f.setOwned(false);
		if (mode === "identity revoked") f.setOnValidate(() => f.setActive(false));
		if (mode === "audit failed") f.setAuditFailure();
		if (mode === "custom Agent")
			f.setConfiguration({
				...agentConfigurationConformanceRecordV1,
				source: {
					kind: "custom",
					imageDigest: `sha256:${"a".repeat(64)}`,
					admissionRevision: "image_1",
					interactionMode: "platform-adapter",
					connectionEnabled: false,
				},
			});
		const request =
			mode === "stale Key"
				? { ...command, expectedVersion: 2 }
				: mode === "raw extra field"
					? { ...command, subjectId: "other" }
					: command;
		await expect(f.useCase.replace(trusted, request)).rejects.toThrow(
			"Agent default Relay Key operation failed",
		);
		expect(f.current()).toBeNull();
		expect(JSON.stringify(f.audits)).not.toContain(key);
	});
	it("rejects response-loss retry using the old expected version", async () => {
		const f = fixture();
		await f.useCase.replace(trusted, command);
		await expect(f.useCase.replace(trusted, command)).rejects.toMatchObject({
			code: "conflict",
		});
		expect((await f.useCase.current(trusted)).keyVersion).toBe(1);
	});
});
