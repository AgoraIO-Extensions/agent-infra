import { connectionSystemAccessFingerprintV1 } from "@agent-infra/contracts/connection-consumer-profile";
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

const connectionSystemAccess = {
	schemaVersion: 1 as const,
	publicOrigin: "https://connection.example.test",
	mcpPath: "/mcp",
	audience: "https://connection.example.test/mcp",
	egressProfile: { ref: "egress", revision: "r1" },
	issuer: "https://connection.example.test/",
	oauthCallbackUrl: "https://platform.example.test/oauth/callback",
};
const approved = {
	schemaVersion: 1 as const,
	configFingerprint: connectionSystemAccessFingerprintV1(
		connectionSystemAccess,
	),
	egressEnforced: true,
	source: { ref: "system-approval", revision: "r1" },
};

function fixture(
	options: Partial<
		Parameters<typeof createOwnerConnectionBindingsResolverV1>[0]
	> = {},
) {
	const agentA = row("agent-a");
	const agentB = row("agent-b", 7);
	let rows: Record<string, ReturnType<typeof row>> = {
		"agent-a": agentA,
		"agent-b": agentB,
	};
	const presented: boolean[] = [];
	const materialize = vi.fn(
		async ({
			agentId,
			associationRevision,
			credential,
		}: {
			agentId: string;
			associationRevision: number;
			credential: Uint8Array;
		}) => {
			presented.push(
				Buffer.from(credential).toString() ===
					`conn_consumer_synthetic-${agentId}`,
			);
			return {
				agentId,
				associationRevision,
				ref: `supply-${agentId}`,
				revision: `r${associationRevision}`,
			};
		},
	);
	const revoke = vi.fn(async () => {});
	const current = vi.fn(async (agentIds?: readonly string[]) =>
		Object.fromEntries(
			Object.entries(rows).filter(([id]) => !agentIds || agentIds.includes(id)),
		),
	);
	const close = vi.fn(async () => {});
	const resolve = createOwnerConnectionBindingsResolverV1(
		{
			databaseUrl: "postgres://unused",
			associationReader: { current, close },
			decryptor: {
				decrypt: async ({ encryptedRecord }) => ({
					outcome: "decrypted",
					plaintext: new TextEncoder().encode(
						`conn_consumer_synthetic-${(encryptedRecord as { fixture: string }).fixture}`,
					),
				}),
			},
			hostSupply: { materialize, revoke },
			connectionSystemAccess,
			connectionSystemAccessApproval: approved,
			...options,
		},
		() => ({
			reserve: async () => ({ state: "reserved" }),
			publish: async () => true,
			fence: async () => {},
			cleanupResult: async () => {},
			close: async () => {},
		}),
	);
	return {
		resolve,
		materialize,
		presented,
		revoke,
		current,
		close,
		replaceFirst(next: ReturnType<typeof row>) {
			rows = { ...rows, "agent-a": next };
		},
	};
}

describe("Owner Connection Host binding resolver", () => {
	it("projects distinct Consumer profiles without registering an OAuth client", async () => {
		const { resolve, materialize, presented } = fixture();
		const network = vi.spyOn(globalThis, "fetch");
		try {
			const bindings = await resolve(new AbortController().signal);
			expect(network).not.toHaveBeenCalled();
			expect(
				materialize.mock.calls.map(([v]) => [v.agentId, v.associationRevision]),
			).toEqual([
				["agent-a", 3],
				["agent-b", 7],
			]);
			expect(presented).toEqual([true, true]);
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
			return {
				agentId: "agent-a",
				associationRevision: 3,
				ref: "supply-agent-a",
				revision: "r3",
			};
		});
		const bindings = await f.resolve(new AbortController().signal);
		expect(Object.keys(bindings)).toEqual(["agent-b"]);
		expect(f.revoke).toHaveBeenCalledExactlyOnceWith({
			agentId: "agent-a",
			associationRevision: 3,
		});
	});
	it.each([undefined, { ...approved, configFingerprint: "0".repeat(64) }])(
		"requires full system approval before calling the Host port",
		async (approval) => {
			const f = fixture({ connectionSystemAccessApproval: approval });
			await expect(f.resolve(new AbortController().signal)).rejects.toThrow(
				"CONNECTION_OWNER_BINDINGS_UNAVAILABLE",
			);
			expect(f.materialize).not.toHaveBeenCalled();
		},
	);

	it.each(["read", "abort", "second-row", "close"] as const)(
		"closes every attempted scope on %s failure",
		async (mode) => {
			const f = fixture();
			const abort = new AbortController();
			const write = f.materialize.getMockImplementation();
			if (!write) throw new Error("fixture is missing its Host writer");
			f.materialize.mockImplementation(async (input) => {
				const receipt = await write(input);
				if (mode === "read")
					f.current.mockRejectedValueOnce(new Error("read timeout"));
				if (mode === "abort") abort.abort();
				if (mode === "second-row" && input.agentId === "agent-b")
					throw new Error("response lost after write");
				return receipt;
			});
			if (mode === "close")
				f.close.mockRejectedValueOnce(new Error("close failure"));
			await expect(f.resolve(abort.signal)).rejects.toThrow();
			const attempted =
				mode === "read" || mode === "abort"
					? [{ agentId: "agent-a", associationRevision: 3 }]
					: [
							{ agentId: "agent-a", associationRevision: 3 },
							{ agentId: "agent-b", associationRevision: 7 },
						];
			expect(f.revoke.mock.calls).toEqual(
				attempted.map((identity) => [identity]),
			);
		},
	);

	it("rejects a receipt for another Agent at the direct injection boundary", async () => {
		const f = fixture();
		f.materialize.mockImplementationOnce(async () => ({
			agentId: "agent-b",
			associationRevision: 3,
			ref: "supply-agent-b",
			revision: "r3",
		}));
		await expect(f.resolve(new AbortController().signal)).rejects.toThrow(
			"CONNECTION_OWNER_BINDINGS_UNAVAILABLE",
		);
		expect(f.revoke).toHaveBeenCalledExactlyOnceWith({
			agentId: "agent-a",
			associationRevision: 3,
		});
	});
});
