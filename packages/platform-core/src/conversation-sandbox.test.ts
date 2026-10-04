import { expect, it } from "vitest";
import {
	type ConversationExecutionTransactionPortV1,
	type CreateConversationWritePlanV1,
	createConversationExecutionUseCaseV1,
} from "./conversation-execution.js";

it("allocates a distinct server-owned Sandbox with each new Session in the original create plan", async () => {
	const plans: CreateConversationWritePlanV1[] = [];
	const unused = async (): Promise<never> => {
		throw new Error("unexpected operation");
	};
	const transaction: ConversationExecutionTransactionPortV1 = {
		readConversation: unused,
		requestMetadataRecovery: unused,
		executeMessage: unused,
		executeModelSelection: unused,
		executeRegeneration: unused,
		executeStop: unused,
		async createConversation(_request, decide) {
			const plan = decide();
			plans.push(plan);
			return { outcome: "accepted", result: plan.result };
		},
	};
	let nextId = 0;
	const useCase = createConversationExecutionUseCaseV1(
		{
			transaction,
			authorization: {
				async authorize() {
					return {
						outcome: "allowed",
						authority: {
							schemaVersion: 1,
							actorId: "user-one",
							agentId: "agent-one",
							channelId: "web",
							authorizationRevision: "revision-one",
							supportsSupplementaryInstruction: false,
						},
					};
				},
			},
		},
		{ newId: () => `session-${++nextId}` },
	);
	for (const key of ["first", "second"]) {
		await useCase.createConversation({
			schemaVersion: 1,
			agentId: "agent-one",
			idempotencyKey: key,
			requestId: key,
			traceId: key,
		});
	}
	for (const plan of plans) {
		expect(plan).toHaveProperty("sandbox");
		expect(plan.sandbox).toMatchObject({
			schemaVersion: 1,
			sessionId: plan.conversation.conversationId,
			agentId: "agent-one",
			principal: { kind: "user", id: "user-one" },
			channelId: "web",
			generation: 1,
		});
		expect(plan.sandbox.sandboxId).not.toBe(plan.conversation.conversationId);
		expect(plan.sandbox.resourceName).toMatch(/^sandbox-[a-f0-9-]{36}$/);
		expect(plan.sandbox.workspaceScope).toBe(plan.sandbox.sandboxId);
	}
	expect(plans[0]?.sandbox.sandboxId).not.toBe(plans[1]?.sandbox.sandboxId);
});
