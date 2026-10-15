import { describe, expect, it, vi } from "vitest";
import {
	type BrowserHandoffAdmissionPlanV1,
	browserHandoffAdmissionRequestDigestV1,
	createBrowserHandoffAdmissionUseCaseV1,
} from "./browser-handoff-admission.js";

const request = {
	schemaVersion: 1 as const,
	conversationId: "conversation-1",
	command: {
		schemaVersion: 1 as const,
		command: "take_over" as const,
		handoffId: "handoff-1",
	},
	idempotencyKey: "command-1",
	requestId: "request-1",
	traceId: "trace-1",
};

const authority = {
	schemaVersion: 1 as const,
	actorId: "user-1",
	agentId: "agent-1",
	channelId: "web",
	authorizationRevision: "auth-1",
	supportsSupplementaryInstruction: true,
};

function harness() {
	let saved: BrowserHandoffAdmissionPlanV1 | undefined;
	const transaction = {
		admit: vi.fn(
			async (_request: unknown, decide: (state: never) => Promise<unknown>) => {
				if (saved) return { outcome: "replayed" as const, plan: saved };
				saved = (await decide({
					conversation: {
						schemaVersion: 1,
						conversationId: "conversation-1",
						agentId: "agent-1",
						actorId: "user-1",
						channelId: "web",
						sessionGeneration: 2,
						hostSessionRef: "host-1",
						authorizationRevision: "auth-1",
						status: "active",
					},
					activeExecution: {
						executionId: "execution-1",
						turnId: "turn-1",
						sessionGeneration: 2,
						deliveryFence: 7,
						status: "processing",
					},
				} as never)) as BrowserHandoffAdmissionPlanV1;
				return { outcome: "accepted" as const, plan: saved };
			},
		),
	};
	const useCase = createBrowserHandoffAdmissionUseCaseV1({
		authorization: {
			authorize: vi.fn(async () => ({
				outcome: "allowed" as const,
				authority,
			})),
		},
		state: { read: vi.fn() },
		transaction,
	});
	return { useCase, transaction };
}

describe("Browser handoff admission", () => {
	it("creates a bound outbox plan and replays the exact idempotency result", async () => {
		const state = harness();
		const first = await state.useCase.admit(request);
		const second = await state.useCase.admit(request);
		expect(first).toMatchObject({
			outcome: "accepted",
			plan: {
				outbox: {
					operation: "conversation.browser.handoff.v1",
					payload: { deliveryFence: 7, sessionGeneration: 2 },
				},
			},
		});
		expect(second).toMatchObject({ outcome: "replayed" });
		expect(browserHandoffAdmissionRequestDigestV1(request)).toHaveLength(64);
		expect(state.transaction.admit).toHaveBeenCalledTimes(2);
	});

	it("rejects unsupported pause/side-effect commands without a transaction plan", async () => {
		const state = harness();
		const result = await state.useCase.admit({
			...request,
			command: { schemaVersion: 1, command: "pause", handoffId: "handoff-1" },
		});
		expect(result).toMatchObject({ outcome: "unavailable" });
	});
});
