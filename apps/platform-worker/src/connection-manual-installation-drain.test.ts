import { connectionSystemAccessFingerprintV1 } from "@agent-infra/contracts/connection-consumer-profile";
import { connectionManualConfirmContractV1 } from "@agent-infra/contracts/runtime";
import { connectionInstallRequestDigestV1 } from "@agent-infra/contracts/runtime/connection-install-node";
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

const pinReceipt = {
	id: "receipt-a",
	revision: 1,
	candidateDigest: "c".repeat(64),
};

function harness(
	overrides: {
		readonly ciphertext?: unknown;
		readonly decrypt?: () => Promise<unknown>;
		readonly supply?: () => Promise<void>;
		readonly commit?: boolean;
		readonly command?: () => Promise<unknown>;
		readonly readback?: () => Promise<unknown>;
		readonly exchange?: () => Promise<unknown>;
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
		recoverSupply: vi.fn(),
		commitDelivery: vi.fn(async () => overrides.commit ?? true),
		settleRegistration: vi.fn(async () => "registered" as const),
		settleRevoke: vi.fn(async () => "revoked" as const),
		firstBeginContext: vi.fn(async () => null),
		settleBegin: vi.fn(async () => "mapped" as const),
		openConfirmPhase: vi.fn(async (input: { phase: string }) =>
			input.phase === "confirm_exchange"
				? {
						phaseCommandId: "phase-b",
						requestDigest: "d".repeat(64),
						receipt: pinReceipt,
					}
				: { phaseCommandId: "phase-a", requestDigest: "e".repeat(64) },
		),
		commitConfirmPin: vi.fn(async () => ({
			outcome: "pinned" as const,
			receipt: pinReceipt,
		})),
		settleConfirmPhase: vi.fn(
			async (input: { outcome: string }) => input.outcome as never,
		),
		commitPermit: vi.fn(
			async (): Promise<"permitted" | "stale"> => "permitted",
		),
		endConfirmWithoutPermit: vi.fn(
			async (): Promise<"unknown" | "stale"> => "unknown",
		),
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
		confirmBindingReadback: vi.fn(
			overrides.readback ?? (async () => Promise.reject(new Error("unset"))),
		),
		confirmExchange: vi.fn(
			overrides.exchange ?? (async () => Promise.reject(new Error("unset"))),
		),
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

const confirmContext = {
	template: { synthetic: "template" },
	configuration: { synthetic: "configuration" },
	receipt: { synthetic: "receipt" },
	supplyAttemptId: "supply-attempt-a",
	registrationKey: `mi-${"a".repeat(43)}`,
	descriptor: { synthetic: "descriptor" },
};

function confirmHarness(
	overrides: {
		readonly context?: null;
		readonly phase?: null;
		readonly commit?: boolean;
		readonly readback?: () => Promise<unknown>;
		readonly exchange?: () => Promise<unknown>;
	} = {},
) {
	const h = harness({
		commit: overrides.commit,
		readback: overrides.readback,
		exchange: overrides.exchange,
	});
	h.store.listPending.mockResolvedValue([
		{
			commandId: "confirm-a",
			command: "confirm" as never,
			authorizationId: "authorization-a",
			executionId: "execution-a",
		},
	]);
	h.store.claim.mockResolvedValue({
		...structuredClone(claim),
		command: { ...claim.command, commandId: "confirm-a", command: "confirm" },
	} as never);
	h.store.firstBeginContext.mockResolvedValue(
		("context" in overrides ? null : confirmContext) as never,
	);
	if ("phase" in overrides)
		h.store.openConfirmPhase.mockResolvedValue(null as never);
	return h;
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

	it("keeps failed supply delivery separate from a rejected registration", async () => {
		const h = harness({
			supply: async () => {
				throw new Error("tls");
			},
		});
		await h.drain.drain(["execution-a"], new AbortController().signal);
		expect(h.store.settleSupply).toHaveBeenCalledWith(
			expect.objectContaining({ outcome: "unknown" }),
		);
		expect(h.store.settleRegistration).not.toHaveBeenCalled();
		expect(h.host.command).not.toHaveBeenCalled();
		expect([...h.plaintext].every((byte) => byte === 0)).toBe(true);
	});

	it("logs only a fixed code when the supply delivery fails", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const h = harness({
				supply: async () => {
					throw new Error("tls-secret-detail");
				},
			});
			await h.drain.drain(["execution-a"], new AbortController().signal);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toEqual({
				service: "platform-worker",
				code: "CONNECTION_MANUAL_SUPPLY_FAILED",
			});
			expect(JSON.stringify(warn.mock.calls)).not.toContain("tls-secret");
		} finally {
			warn.mockRestore();
		}
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

	it("drains Session installations without active Turn claims and respects an explicit filter", async () => {
		const h = harness();
		expect(
			await h.drain.drain(["execution-other"], new AbortController().signal),
		).toBe(0);
		expect(h.store.claim).not.toHaveBeenCalled();
		expect(await h.drain.drain([], new AbortController().signal)).toBe(1);
	});

	it("commits the binding readback's sending before it sends and pins its own candidate", async () => {
		const h = confirmHarness({
			readback: async () => ({
				schemaVersion: 1,
				contract: connectionManualConfirmContractV1,
				outcome: "candidate",
				commandId: "phase-a",
				candidate: { synthetic: "candidate" },
			}),
		});
		expect(
			await h.drain.drain(["execution-a"], new AbortController().signal),
		).toBe(1);
		expect(h.store.firstBeginContext).toHaveBeenCalledWith(
			expect.objectContaining({ commandId: "confirm-a", command: "confirm" }),
		);
		expect(h.store.openConfirmPhase).toHaveBeenCalledWith(
			expect.objectContaining({
				confirmCommandId: "confirm-a",
				phase: "confirm_binding_readback",
			}),
		);
		const request = {
			confirmCommandId: "confirm-a",
			commandId: "phase-a",
			attemptId: "attempt-a",
			attemptOwner: "worker-a",
			template: confirmContext.template,
			supplyAttemptId: confirmContext.supplyAttemptId,
			registrationKey: confirmContext.registrationKey,
			descriptor: confirmContext.descriptor,
		};
		expect(h.store.commitDelivery).toHaveBeenCalledWith({
			attemptId: "attempt-a",
			attemptOwner: "worker-a",
			authorizationId: "authorization-a",
			commandId: "phase-a",
			command: "confirm_binding_readback",
			deliveryDigest: connectionInstallRequestDigestV1({
				schemaVersion: 1,
				contract: connectionManualConfirmContractV1,
				phase: "binding_readback",
				...request,
			}),
		});
		expect(h.host.confirmBindingReadback).toHaveBeenCalledTimes(1);
		expect(h.host.confirmBindingReadback).toHaveBeenCalledWith(
			{ ...request, authorizationExpiresAt: claim.authorization.expiresAt },
			expect.any(AbortSignal),
		);
		expect(h.store.commitDelivery.mock.invocationCallOrder[0]).toBeLessThan(
			h.host.confirmBindingReadback.mock.invocationCallOrder[0] ?? 0,
		);
		expect(h.store.commitConfirmPin).toHaveBeenCalledWith(
			expect.objectContaining({
				confirmCommandId: "confirm-a",
				phaseCommandId: "phase-a",
				authorizationId: "authorization-a",
				candidate: { synthetic: "candidate" },
			}),
		);
		expect(h.store.settleConfirmPhase).not.toHaveBeenCalledWith(
			expect.objectContaining({ phaseCommandId: "phase-a" }),
		);
		// Phase 1 never exchanges, begins or sends an install command.
		expect(h.host.command).not.toHaveBeenCalled();
		expect(h.host.firstBegin).not.toHaveBeenCalled();
		expect(h.host.beginStatus).not.toHaveBeenCalled();
	});

	const candidateReply = async () => ({
		schemaVersion: 1,
		contract: connectionManualConfirmContractV1,
		outcome: "candidate",
		commandId: "phase-a",
		candidate: { synthetic: "candidate" },
	});
	const exchangeReply = (outcome: string) => async () => ({
		schemaVersion: 1,
		contract: connectionManualConfirmContractV1,
		outcome,
		commandId: "phase-b",
	});

	const publication = {
		commitDigest: "f".repeat(64),
		expiresAt: 4_102_444_800_000,
	};

	it("commits the permit from this exchange's own publication evidence", async () => {
		const h = confirmHarness({
			readback: candidateReply,
			exchange: async () => ({
				...(await exchangeReply("exchanged")()),
				publication,
			}),
		});
		await h.drain.drain(["execution-a"], new AbortController().signal);
		expect(h.store.commitPermit).toHaveBeenCalledTimes(1);
		expect(h.store.commitPermit).toHaveBeenCalledWith({
			attemptId: "attempt-a",
			attemptOwner: "worker-a",
			authorizationId: "authorization-a",
			confirmCommandId: "confirm-a",
			exchangeCommandId: "phase-b",
			publication,
		});
		expect(h.store.settleConfirmPhase.mock.invocationCallOrder[0]).toBeLessThan(
			h.store.commitPermit.mock.invocationCallOrder[0] ?? 0,
		);
	});

	it.each([
		["no publication evidence", exchangeReply("exchanged"), "exchanged"],
		[
			"a rejected exchange with evidence",
			async () => ({ ...(await exchangeReply("rejected")()), publication }),
			"rejected",
		],
		[
			"an exchange whose settlement no longer holds",
			async () => ({ ...(await exchangeReply("exchanged")()), publication }),
			"unknown",
		],
	] as const)("writes no permit after %s", async (_name, exchange, settled) => {
		const h = confirmHarness({ readback: candidateReply, exchange });
		h.store.settleConfirmPhase.mockResolvedValue(settled as never);
		await h.drain.drain(["execution-a"], new AbortController().signal);
		expect(h.host.confirmExchange).toHaveBeenCalledTimes(1);
		expect(h.store.commitPermit).not.toHaveBeenCalled();
	});

	// C1c-2b-2b: only this attempt may write the permit, so an exchange that
	// completed without one ends its confirm at once (close and revoke the
	// original key) rather than waiting for the attempt to lapse.
	it.each([
		["no publication evidence", exchangeReply("exchanged"), undefined],
		[
			"a permit CAS that no longer holds",
			async () => ({ ...(await exchangeReply("exchanged")()), publication }),
			"stale",
		],
		[
			"a permit CAS that failed",
			async () => ({ ...(await exchangeReply("exchanged")()), publication }),
			new Error("permit CAS lost"),
		],
	] as const)(
		"ends the confirm under the same attempt after %s",
		async (_name, exchange, permit) => {
			const h = confirmHarness({ readback: candidateReply, exchange });
			if (permit instanceof Error)
				h.store.commitPermit.mockRejectedValue(permit);
			else if (permit) h.store.commitPermit.mockResolvedValue(permit as never);
			await h.drain.drain(["execution-a"], new AbortController().signal);
			expect(h.host.confirmExchange).toHaveBeenCalledTimes(1);
			expect(h.store.endConfirmWithoutPermit).toHaveBeenCalledTimes(1);
			expect(h.store.endConfirmWithoutPermit).toHaveBeenCalledWith({
				attemptId: "attempt-a",
				attemptOwner: "worker-a",
				authorizationId: "authorization-a",
				confirmCommandId: "confirm-a",
				exchangeCommandId: "phase-b",
			});
		},
	);

	it.each([
		["a committed permit", "exchanged", "permitted"],
		["a rejected exchange", "rejected", undefined],
		["an unknown exchange", "unknown", undefined],
	] as const)(
		"leaves the confirm to its settlement after %s",
		async (_name, settled, permit) => {
			const h = confirmHarness({
				readback: candidateReply,
				exchange: async () => ({
					...(await exchangeReply(settled)()),
					publication,
				}),
			});
			h.store.settleConfirmPhase.mockResolvedValue(settled as never);
			if (permit) h.store.commitPermit.mockResolvedValue(permit as never);
			await h.drain.drain(["execution-a"], new AbortController().signal);
			expect(h.store.endConfirmWithoutPermit).not.toHaveBeenCalled();
		},
	);

	it("continues into phase 2 with its own committed receipt and commits before it sends", async () => {
		const h = confirmHarness({
			readback: candidateReply,
			exchange: exchangeReply("exchanged"),
		});
		await h.drain.drain(["execution-a"], new AbortController().signal);
		expect(h.store.openConfirmPhase).toHaveBeenLastCalledWith(
			expect.objectContaining({
				confirmCommandId: "confirm-a",
				phase: "confirm_exchange",
			}),
		);
		const request = {
			confirmCommandId: "confirm-a",
			attemptId: "attempt-a",
			attemptOwner: "worker-a",
			template: confirmContext.template,
			supplyAttemptId: confirmContext.supplyAttemptId,
			registrationKey: confirmContext.registrationKey,
			descriptor: confirmContext.descriptor,
			commandId: "phase-b",
			pinReceipt,
			candidate: { synthetic: "candidate" },
		};
		expect(h.store.commitDelivery).toHaveBeenLastCalledWith({
			attemptId: "attempt-a",
			attemptOwner: "worker-a",
			authorizationId: "authorization-a",
			commandId: "phase-b",
			command: "confirm_exchange",
			deliveryDigest: connectionInstallRequestDigestV1({
				schemaVersion: 1,
				contract: connectionManualConfirmContractV1,
				phase: "exchange",
				...request,
			}),
		});
		expect(h.host.confirmExchange).toHaveBeenCalledTimes(1);
		expect(h.host.confirmExchange).toHaveBeenCalledWith(
			{ ...request, authorizationExpiresAt: claim.authorization.expiresAt },
			expect.any(AbortSignal),
		);
		expect(h.store.commitDelivery.mock.invocationCallOrder[1]).toBeLessThan(
			h.host.confirmExchange.mock.invocationCallOrder[0] ?? 0,
		);
		expect(h.store.settleConfirmPhase).toHaveBeenCalledTimes(1);
		expect(h.store.settleConfirmPhase).toHaveBeenCalledWith(
			expect.objectContaining({
				confirmCommandId: "confirm-a",
				phaseCommandId: "phase-b",
				phase: "confirm_exchange",
				outcome: "exchanged",
			}),
		);
	});

	it.each([
		["a drifted binding", exchangeReply("rejected"), "rejected"],
		["an unknown exchange", exchangeReply("unknown"), "unknown"],
		[
			"a lost exchange response",
			async () => Promise.reject(new Error("reset")),
			"unknown",
		],
	] as const)(
		"settles phase 2 after %s as %s",
		async (_name, exchange, outcome) => {
			const h = confirmHarness({ readback: candidateReply, exchange });
			await h.drain.drain(["execution-a"], new AbortController().signal);
			expect(h.host.confirmExchange).toHaveBeenCalledTimes(1);
			expect(h.store.settleConfirmPhase).toHaveBeenCalledWith(
				expect.objectContaining({
					phaseCommandId: "phase-b",
					phase: "confirm_exchange",
					outcome,
				}),
			);
		},
	);

	it.each([
		[
			"a refused pin",
			(h: ReturnType<typeof confirmHarness>) =>
				h.store.commitConfirmPin.mockResolvedValue({
					outcome: "rejected",
				} as never),
		],
		[
			"no openable exchange phase",
			(h: ReturnType<typeof confirmHarness>) =>
				h.store.openConfirmPhase.mockImplementation(async (input) =>
					input.phase === "confirm_exchange"
						? (null as never)
						: { phaseCommandId: "phase-a", requestDigest: "e".repeat(64) },
				),
		],
		[
			"a phase opened with another receipt",
			(h: ReturnType<typeof confirmHarness>) =>
				h.store.openConfirmPhase.mockImplementation(async (input) =>
					input.phase === "confirm_exchange"
						? {
								phaseCommandId: "phase-b",
								requestDigest: "d".repeat(64),
								receipt: { ...pinReceipt, id: "receipt-other" },
							}
						: { phaseCommandId: "phase-a", requestDigest: "e".repeat(64) },
				),
		],
		[
			"a lost exchange sending commit",
			(h: ReturnType<typeof confirmHarness>) =>
				h.store.commitDelivery
					.mockResolvedValueOnce(true)
					.mockResolvedValueOnce(false),
		],
	] as const)("sends no exchange after %s", async (_name, arrange) => {
		const h = confirmHarness({
			readback: candidateReply,
			exchange: exchangeReply("exchanged"),
		});
		arrange(h);
		await h.drain.drain(["execution-a"], new AbortController().signal);
		expect(h.host.confirmExchange).not.toHaveBeenCalled();
		expect(h.store.settleConfirmPhase).not.toHaveBeenCalled();
	});

	it.each([
		["a gate-failing readback", "rejected", "rejected"],
		["an unknown readback", "unknown", "unknown"],
		["a lost readback response", "throw", "unknown"],
	] as const)(
		"settles %s as %s without a pin",
		async (_name, answer, outcome) => {
			const h = confirmHarness({
				readback:
					answer === "throw"
						? async () => Promise.reject(new Error("reset"))
						: async () => ({
								schemaVersion: 1,
								contract: connectionManualConfirmContractV1,
								outcome: answer,
								commandId: "phase-a",
							}),
			});
			await h.drain.drain(["execution-a"], new AbortController().signal);
			expect(h.host.confirmBindingReadback).toHaveBeenCalledTimes(1);
			expect(h.store.commitConfirmPin).not.toHaveBeenCalled();
			expect(h.store.settleConfirmPhase).toHaveBeenCalledWith(
				expect.objectContaining({
					confirmCommandId: "confirm-a",
					phaseCommandId: "phase-a",
					outcome,
				}),
			);
		},
	);

	it.each([
		["no first-begin context", { context: null }],
		["no openable phase", { phase: null }],
		["a lost phase sending commit", { commit: false }],
	] as const)("sends no binding readback with %s", async (_name, overrides) => {
		const h = confirmHarness(overrides);
		await h.drain.drain(["execution-a"], new AbortController().signal);
		expect(h.host.confirmBindingReadback).not.toHaveBeenCalled();
		expect(h.store.commitConfirmPin).not.toHaveBeenCalled();
		expect(h.store.settleConfirmPhase).not.toHaveBeenCalled();
		if ("context" in overrides)
			expect(h.store.openConfirmPhase).not.toHaveBeenCalled();
		if ("phase" in overrides)
			expect(h.store.commitDelivery).not.toHaveBeenCalled();
	});

	it("hands its cancellation signal to the bounded recovery pass", async () => {
		const h = harness();
		const controller = new AbortController();
		await h.drain.drain(["execution-a"], controller.signal);
		const [, , passed] = h.store.listPending.mock.calls[0] as unknown as [
			number,
			readonly string[],
			AbortSignal,
		];
		expect(passed).toBeInstanceOf(AbortSignal);
		expect(passed.aborted).toBe(false);
		controller.abort();
		expect(passed.aborted).toBe(true);
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
