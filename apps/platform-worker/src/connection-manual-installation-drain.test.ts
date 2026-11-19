import { connectionSystemAccessFingerprintV1 } from "@agent-infra/contracts/connection-consumer-profile";
import { connectionServiceCredentialSecretNameV1 } from "@agent-infra/platform-core";
import type { ConnectionManualInstallationClaimV1 } from "@agent-infra/platform-store";
import { describe, expect, it, vi } from "vitest";
import type { ConnectionInstallHostClientV1 } from "./connection-install-host-client.js";
import { createConnectionManualInstallationDrainV1 } from "./connection-manual-installation-drain.js";

const system = {
	schemaVersion: 1 as const,
	publicOrigin: "https://connection.test",
	mcpPath: "/mcp",
	audience: "mcp",
	egressProfile: { ref: "egress", revision: "r1" },
	issuer: "https://connection.test/",
	oauthCallbackUrl: "https://platform.test/connection/callback",
};
const approval = {
	schemaVersion: 1 as const,
	configFingerprint: connectionSystemAccessFingerprintV1(system),
	egressEnforced: true as const,
	source: { ref: "platform-deployment", revision: "r1" },
};
const reference = {
	agentId: "agent-a",
	conversationId: "conversation-a",
	executionId: "execution-a",
	sessionGeneration: 1,
};
const claim: ConnectionManualInstallationClaimV1 = {
	command: {
		commandId: "command-a",
		command: "prepare",
		attemptId: "attempt-a",
		attemptOwner: "worker-a",
	},
	authorization: {
		authorizationId: "authorization-a",
		confirmationRevision: "revision-a",
		principal: { kind: "user", id: "alice" },
		reference,
		expiresAt: Date.now() + 60_000,
	},
	current: {
		reference,
		preparation: {
			agentId: "agent-a",
			sandboxId: "sandbox-a",
			podUid: "pod-a",
			sessionGeneration: 1,
			hostRef: "host-a",
			resourceFence: 1,
			resourceName: "sandbox-sandbox-a",
			association: { connectionAgentId: "connection-agent-a", revision: 1 },
		},
		claim: { owner: "worker-a", fence: 3 },
	} as ConnectionManualInstallationClaimV1["current"],
	installation: {
		supplyState: "pending",
		registrationState: "pending",
		revokeState: "not_required",
	},
};
const ciphertext = {
	ownerType: "platform",
	agentId: "agent-a",
	ownerId: "owner",
	name: connectionServiceCredentialSecretNameV1,
	secretVersion: 1,
	configRevision: 1,
	secretId: `${connectionServiceCredentialSecretNameV1}:agent-a:1`,
};

function harness(
	overrides: {
		readonly ciphertext?: unknown;
		readonly decrypt?: () => Promise<unknown>;
		readonly supply?: () => Promise<void>;
		readonly commit?: boolean;
		readonly command?: () => Promise<unknown>;
	} = {},
) {
	const plaintext = new TextEncoder().encode("conn_consumer_synthetic-0001");
	const store = {
		listPending: vi.fn(async () => [
			{
				commandId: "command-a",
				command: "prepare" as const,
				authorizationId: "authorization-a",
				executionId: "execution-a",
			},
		]),
		claim: vi.fn(async () => structuredClone(claim)),
		fixSupply: vi.fn(async () => ({
			ciphertext: overrides.ciphertext ?? ciphertext,
			binding: { agentId: "agent-a", ownerId: "owner", associationRevision: 1 },
		})),
		settleSupply: vi.fn(async () => true),
		commitDelivery: vi.fn(async () => overrides.commit ?? true),
		settleRegistration: vi.fn(async () => "registered" as const),
		settleRevoke: vi.fn(async () => "revoked" as const),
		firstBeginContext: vi.fn(async () => null),
		settleBegin: vi.fn(async () => "mapped" as const),
	};
	const decryptor = {
		decrypt: vi.fn(
			overrides.decrypt ??
				(async () => ({ outcome: "decrypted" as const, plaintext })),
		),
	};
	const host = {
		supply: vi.fn(overrides.supply ?? (async () => {})),
		command: vi.fn(
			overrides.command ??
				(async () => ({
					schemaVersion: 1 as const,
					outcome: "unknown" as const,
					commandId: "command-a",
				})),
		),
		firstBegin: vi.fn(),
		beginStatus: vi.fn(),
	};
	const drain = createConnectionManualInstallationDrainV1({
		store: store as never,
		decryptor: decryptor as never,
		host: host as unknown as ConnectionInstallHostClientV1,
		systemAccess: system,
		approval,
		clientName: "Agent Infra",
		namespace: "agents",
		receiverPort: 4443,
		deploymentWorkerId: "worker-a",
		attemptOwner: "worker-a",
	});
	return { store, decryptor, host, drain, plaintext };
}

describe("manual install drain", () => {
	it("supplies, commits the exact digest and sends one prepare per attempt", async () => {
		const h = harness();
		expect(
			await h.drain.drain(["execution-a"], new AbortController().signal),
		).toBe(1);
		expect(h.store.fixSupply).toHaveBeenCalledTimes(1);
		const fixed = (h.store.fixSupply.mock.calls as unknown[][])[0]?.[0] as {
			template: {
				target: { runtimeOrigin: string; deploymentIdentity: string };
			};
			registrationKey: string;
		};
		expect(fixed.template.target).toMatchObject({
			runtimeOrigin: "https://sandbox-sandbox-a.agents.svc:4443/",
			deploymentIdentity: "session-sandbox-v1/agents/worker-a",
		});
		expect(fixed.registrationKey).toMatch(/^mi-[A-Za-z0-9_-]{43}$/);
		expect(h.host.supply).toHaveBeenCalledTimes(1);
		expect(h.store.commitDelivery).toHaveBeenCalledTimes(1);
		expect(h.host.command).toHaveBeenCalledTimes(1);
		// The decrypted bytes are zeroed once the Host has its ciphertext.
		expect([...h.plaintext].every((byte) => byte === 0)).toBe(true);
		expect(h.store.settleRegistration).toHaveBeenLastCalledWith(
			expect.objectContaining({
				command: "prepare",
				response: expect.objectContaining({ outcome: "unknown" }),
			}),
		);
	});

	it.each([
		[
			"a ciphertext bound to another Agent",
			{ ciphertext: { ...ciphertext, agentId: "agent-b" } },
		],
		[
			"a keyring failure",
			{
				decrypt: async () => ({
					outcome: "failed",
					code: "SECRET_AUTHENTICATION_FAILED",
				}),
			},
		],
		[
			"a Host supply failure",
			{ supply: async () => Promise.reject(new Error("tls")) },
		],
		["a lost delivery commit", { commit: false }],
	])("sends nothing to Connection after %s", async (_name, overrides) => {
		const h = harness(overrides as never);
		await h.drain.drain(["execution-a"], new AbortController().signal);
		expect(h.host.command).not.toHaveBeenCalled();
		expect(h.store.settleRegistration).toHaveBeenLastCalledWith(
			expect.objectContaining({
				command: "prepare",
				response: expect.objectContaining({ outcome: "rejected" }),
			}),
		);
	});

	it("records a lost prepare response as unknown without a second send", async () => {
		const h = harness({
			command: async () => Promise.reject(new Error("reset")),
		});
		await h.drain.drain(["execution-a"], new AbortController().signal);
		expect(h.host.command).toHaveBeenCalledTimes(1);
		const settled = (h.store.settleRegistration.mock.calls as unknown[][]).at(
			-1,
		)?.[0] as Record<string, unknown>;
		expect(settled).not.toHaveProperty("response");
	});

	it("only drains Executions this Worker currently holds", async () => {
		const h = harness();
		expect(
			await h.drain.drain(["execution-other"], new AbortController().signal),
		).toBe(0);
		expect(h.store.claim).not.toHaveBeenCalled();
		expect(await h.drain.drain([], new AbortController().signal)).toBe(0);
	});

	it("refuses an unapproved system access or a privileged receiver port", () => {
		expect(() =>
			createConnectionManualInstallationDrainV1({
				store: {} as never,
				decryptor: {} as never,
				host: {} as never,
				systemAccess: system,
				approval: { ...approval, configFingerprint: "0".repeat(64) },
				clientName: "Agent Infra",
				namespace: "agents",
				receiverPort: 4443,
				deploymentWorkerId: "worker-a",
				attemptOwner: "worker-a",
			}),
		).toThrow("CONNECTION_MANUAL_INSTALLATION_UNAVAILABLE");
		expect(() =>
			createConnectionManualInstallationDrainV1({
				store: {} as never,
				decryptor: {} as never,
				host: {} as never,
				systemAccess: system,
				approval,
				clientName: "Agent Infra",
				namespace: "agents",
				receiverPort: 443,
				deploymentWorkerId: "worker-a",
				attemptOwner: "worker-a",
			}),
		).toThrow("CONNECTION_MANUAL_INSTALLATION_UNAVAILABLE");
	});
});
