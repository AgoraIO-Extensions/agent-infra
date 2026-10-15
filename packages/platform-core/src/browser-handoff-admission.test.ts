import { describe, expect, it, vi } from "vitest";
import {
	type BrowserHandoffAdmissionPlanV1,
	browserHandoffAdmissionRequestDigestV1,
	createBrowserHandoffAdmissionUseCaseV1,
} from "./browser-handoff-admission.js";
import { parseBrowserHandoffCommandV1 } from "./conversation-dispatch-input.js";

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

	it("admits a side-effect command with its confirmation identity", async () => {
		const state = harness();
		const result = await state.useCase.admit({
			...request,
			command: {
				schemaVersion: 1,
				command: "confirm_side_effect",
				confirmationId: "confirmation-1",
			},
		});
		expect(result).toMatchObject({ outcome: "accepted" });
	});

	it.each([
		[{ schemaVersion: 1, command: "pause" }],
		[{ schemaVersion: 1, command: "pause", handoffId: "handoff-1" }],
		[
			{
				schemaVersion: 1,
				command: "reject_side_effect",
				confirmationId: "confirmation-1",
			},
		],
		[
			{
				schemaVersion: 1,
				command: "cancel_side_effect",
				confirmationId: "confirmation-1",
			},
		],
	] as const)("admits the command-specific identity shape", async (command) => {
		const state = harness();
		const result = await state.useCase.admit({
			...request,
			command,
		});
		expect(result).toMatchObject({ outcome: "accepted", plan: { command } });
	});

	it.each([
		{
			schemaVersion: 1,
			command: "pause",
			confirmationId: "confirmation-1",
		},
		{ schemaVersion: 1, command: "confirm_side_effect" },
		{
			schemaVersion: 1,
			command: "confirm_side_effect",
			confirmationId: "confirmation-1",
			handoffId: "foreign-handoff",
		},
		{
			schemaVersion: 1,
			command: "pause",
			handoffId: "",
		},
	] as const)(
		"fails closed for a missing or foreign command identity",
		async (command) => {
			const state = harness();
			const result = await state.useCase.admit({
				...request,
				command: command as never,
			});
			expect(result).toEqual({
				outcome: "unavailable",
				reason: "conversation_unavailable",
			});
			expect(state.transaction.admit).not.toHaveBeenCalled();
		},
	);

	it.each([
		{ schemaVersion: 1, command: "pause" },
		{ schemaVersion: 1, command: "pause", handoffId: "handoff-1" },
		{
			schemaVersion: 1,
			command: "confirm_side_effect",
			confirmationId: "confirmation-1",
		},
		{
			schemaVersion: 1,
			command: "reject_side_effect",
			confirmationId: "confirmation-1",
		},
		{
			schemaVersion: 1,
			command: "cancel_side_effect",
			confirmationId: "confirmation-1",
		},
	] as const)("parses %j as an exact Browser command", (command) => {
		expect(parseBrowserHandoffCommandV1(command)).toEqual(command);
	});

	it("rejects mixed or missing command identity in the dispatch parser", () => {
		expect(() =>
			parseBrowserHandoffCommandV1({
				schemaVersion: 1,
				command: "confirm_side_effect",
				confirmationId: "confirmation-1",
				handoffId: "foreign-handoff",
			}),
		).toThrow();
		expect(() =>
			parseBrowserHandoffCommandV1({
				schemaVersion: 1,
				command: "pause",
				handoffId: "",
			}),
		).toThrow();
	});
});
