import { connectionServiceCredentialFingerprintV1 } from "@agent-infra/platform-core";
import { describe, expect, it, vi } from "vitest";
import { createOwnerConnectionBindingsResolverV1 } from "./connection-manual-bindings.js";

function row(agentId: string, revision = 3) {
	const credential = `conn_consumer_synthetic-${agentId}`;
	return {
		agentId,
		ownerId: `owner-${agentId}`,
		connectionAgentId: `consumer-${agentId}`,
		associationRevision: revision,
		credentialFingerprint: connectionServiceCredentialFingerprintV1(credential),
		credentialCiphertext: { fixture: agentId },
	};
}

function fixture() {
	const agentA = row("agent-a");
	const agentB = row("agent-b", 7);
	let rows: Record<string, ReturnType<typeof row>> = {
		"agent-a": agentA,
		"agent-b": agentB,
	};
	const materialize = vi.fn(
		async ({
			agentId,
			associationRevision,
		}: {
			agentId: string;
			associationRevision: number;
			serviceCredential: string;
		}) => ({ ref: `supply-${agentId}`, revision: `r${associationRevision}` }),
	);
	const revoke = vi.fn(async () => {});
	const resolve = createOwnerConnectionBindingsResolverV1({
		databaseUrl: "postgres://unused",
		associationReader: {
			current: async (agentIds) =>
				Object.fromEntries(
					Object.entries(rows).filter(
						([id]) => !agentIds || agentIds.includes(id),
					),
				),
			close: async () => {},
		},
		decryptor: {
			decrypt: async ({ encryptedRecord }) => ({
				outcome: "decrypted",
				plaintext: new TextEncoder().encode(
					`conn_consumer_synthetic-${(encryptedRecord as { fixture: string }).fixture}`,
				),
			}),
		},
		hostSupply: { materialize, revoke },
		publicOrigin: "https://connection.example.test",
		mcpPath: "/mcp",
		audience: "https://connection.example.test/mcp",
		egressProfile: { ref: "egress", revision: "r1" },
		approvalSource: { ref: "association", revision: "r1" },
	});
	return {
		resolve,
		materialize,
		revoke,
		replaceFirst(next: ReturnType<typeof row>) {
			rows = { ...rows, "agent-a": next };
		},
	};
}

describe("Owner Connection Host binding resolver", () => {
	it("projects distinct Consumer profiles without registering an OAuth client", async () => {
		const { resolve, materialize } = fixture();
		const network = vi.spyOn(globalThis, "fetch");
		try {
			const bindings = await resolve(new AbortController().signal);
			expect(network).not.toHaveBeenCalled();
			expect(
				materialize.mock.calls.map(([v]) => [
					v.agentId,
					v.associationRevision,
					v.serviceCredential === `conn_consumer_synthetic-${v.agentId}`,
				]),
			).toEqual([
				["agent-a", 3, true],
				["agent-b", 7, true],
			]);
			expect(bindings).toMatchObject({
				"agent-a": {
					profile: { consumerId: "consumer-agent-a" },
					installationSupply: { ref: "supply-agent-a", revision: "r3" },
				},
				"agent-b": {
					profile: { consumerId: "consumer-agent-b" },
					installationSupply: { ref: "supply-agent-b", revision: "r7" },
				},
			});
			expect(
				Object.values(bindings).every(
					(b) => b.oauthClientBinding === undefined,
				),
			).toBe(true);
			expect(JSON.stringify(bindings)).not.toContain(
				"conn_consumer_synthetic-",
			);
		} finally {
			network.mockRestore();
		}
	});

	it("closes a stale supply without associating another Agent", async () => {
		const f = fixture();
		f.materialize.mockImplementationOnce(async () => {
			f.replaceFirst(row("agent-a", 4));
			return { ref: "supply-agent-a", revision: "r3" };
		});
		const bindings = await f.resolve(new AbortController().signal);
		expect(Object.keys(bindings)).toEqual(["agent-b"]);
		expect(f.revoke).toHaveBeenCalledExactlyOnceWith({
			agentId: "agent-a",
			associationRevision: 3,
		});
	});
});
