import { describe, expect, it, vi } from "vitest";
import {
	AgentConnectionAssociationErrorV1,
	type AgentConnectionAssociationTransactionV1,
	connectionServiceCredentialFingerprintV1,
	connectionServiceCredentialSecretInputV1,
	createAgentConnectionAssociationUseCaseV1,
	presentAgentConnectionAssociationStateV1,
} from "./agent-connection-association.js";

const credential = "SYNTHETIC_CONNECTION_SERVICE_CREDENTIAL";
const request = {
	entry: { kind: "browser" as const, userId: "owner" },
	agentId: "agent-a",
	traceId: "trace",
	requestId: "request",
};
const manual = {
	schemaVersion: 1,
	mode: "manual",
	connectionAgentId: "connection-agent-a",
	serviceCredential: credential,
	expectedRevision: null,
};

function transaction(
	overrides: Partial<AgentConnectionAssociationTransactionV1> = {},
) {
	const audits: unknown[] = [];
	const tx: AgentConnectionAssociationTransactionV1 = {
		owner: async () => ({
			userId: "owner",
			agentName: "Agent A",
			agentStatus: "available",
		}),
		current: async () => null,
		inUseElsewhere: async () => false,
		saveManual: async (input) => {
			input.encrypt({
				agentId: "agent-a",
				ownerId: "owner",
				associationRevision: 1,
			});
			return 1;
		},
		deleteManual: async () => true,
		enableAutomatic: async () => {},
		audit: async (event) => {
			audits.push(event);
		},
		...overrides,
	};
	return {
		audits,
		port: {
			execute: <T>(
				work: (t: AgentConnectionAssociationTransactionV1) => Promise<T>,
			) => work(tx),
			recordRefusal: async (event: unknown) => {
				audits.push(event);
			},
		},
	};
}

describe("Owner Connection association command", () => {
	it("projects every state without Consumer details", () => {
		expect(presentAgentConnectionAssociationStateV1(null, false)).toEqual({
			schemaVersion: 1,
			status: "not_enabled",
			source: null,
			associationRevision: null,
			automaticRegistrationAvailable: false,
		});
		expect(
			presentAgentConnectionAssociationStateV1(
				{ source: "automatic", status: "unknown", disableStatus: null },
				true,
			),
		).toMatchObject({ status: "unverified", source: "automatic" });
		expect(
			presentAgentConnectionAssociationStateV1(
				{ source: "automatic", status: "registered", disableStatus: "sending" },
				true,
			),
		).toMatchObject({ status: "disabling" });
	});

	it("binds the ciphertext to Agent, Owner and revision and never audits the credential", async () => {
		const encrypt = vi.fn(() => ({ ciphertext: "opaque" }));
		const t = transaction();
		const result = await createAgentConnectionAssociationUseCaseV1({
			transaction: t.port,
			verify: async () => "verified",
			encrypt,
		}).associate(request, manual);
		expect(result).toMatchObject({
			status: "associated",
			associationRevision: 1,
		});
		expect(encrypt).toHaveBeenCalledWith(
			{ agentId: "agent-a", ownerId: "owner", associationRevision: 1 },
			credential,
		);
		expect(JSON.stringify(t.audits)).not.toContain(credential);
		expect(JSON.stringify(t.audits)).not.toContain("connection-agent-a");
		expect(
			connectionServiceCredentialSecretInputV1(
				{ agentId: "agent-a", ownerId: "owner", associationRevision: 2 },
				credential,
				"2026-11-16T00:00:00.000Z",
			),
		).toMatchObject({
			ownerType: "platform",
			name: "connection-service-credential",
			secretVersion: 2,
			configRevision: 2,
		});
		expect(connectionServiceCredentialFingerprintV1(credential)).toMatch(
			/^[a-f0-9]{64}$/,
		);
		expect(connectionServiceCredentialFingerprintV1(credential)).not.toContain(
			credential,
		);
	});

	it("does not call Connection for a non-Owner and saves nothing when verification times out", async () => {
		const verify = vi.fn(async () => "verified" as const);
		const denied = transaction({ owner: async () => null });
		await expect(
			createAgentConnectionAssociationUseCaseV1({
				transaction: denied.port,
				verify,
				encrypt: () => ({}),
			}).associate(request, manual),
		).rejects.toMatchObject({ code: "not_authorized" });
		expect(verify).not.toHaveBeenCalled();

		const saveManual = vi.fn(async () => 1);
		const slow = transaction({ saveManual });
		await expect(
			createAgentConnectionAssociationUseCaseV1({
				transaction: slow.port,
				verificationTimeoutMs: 5,
				verify: (_input, signal) =>
					new Promise((_resolve, reject) =>
						signal.addEventListener("abort", () =>
							reject(new Error("aborted")),
						),
					),
				encrypt: () => ({}),
			}).associate(request, manual),
		).rejects.toBeInstanceOf(AgentConnectionAssociationErrorV1);
		expect(saveManual).not.toHaveBeenCalled();
	});

	it("rejects extra or identity fields in the command", async () => {
		const t = transaction();
		for (const value of [
			{ ...manual, userId: "owner" },
			{ ...manual, connectionAgentId: "A" },
			{ schemaVersion: 1, mode: "automatic", agentId: "agent-b" },
		])
			await expect(
				createAgentConnectionAssociationUseCaseV1({
					transaction: t.port,
					verify: async () => "verified",
					encrypt: () => ({}),
				}).associate(request, value),
			).rejects.toMatchObject({ code: "invalid_input" });
	});
});
