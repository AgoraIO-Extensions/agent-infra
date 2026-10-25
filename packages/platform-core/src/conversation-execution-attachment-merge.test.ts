import { describe, expect, it } from "vitest";
import {
	type ConversationExecutionAuthorityV1,
	type ConversationExecutionStateV1,
	type ConversationExecutionTransactionPortV1,
	type ConversationMessageWritePlanV1,
	conversationAttachmentMergeMaxCountV1,
	createConversationExecutionUseCaseV1,
} from "./conversation-execution.ts";

// #3374：企微只含附件的消息打开合并窗口，窗口内同一发送者的消息并入同一个初始 Turn（工程 Spec §14.2.4）。
const authority = {
	schemaVersion: 1 as const,
	actorId: "user_01",
	agentId: "agent_01",
	channelId: "wecom_bot:binding",
	authorizationRevision: "authorization_01",
	supportsSupplementaryInstruction: false,
	attachmentMergeWindow: true as const,
} satisfies ConversationExecutionAuthorityV1;

const conversation = {
	schemaVersion: 1,
	conversationId: "conversation_merge",
	agentId: authority.agentId,
	actorId: authority.actorId,
	channelId: authority.channelId,
	status: "active",
	sessionGeneration: 1,
	hostSessionRef: null,
	authorizationRevision: authority.authorizationRevision,
	lastConversationCursor: 0,
	selectedModelOptionId: null,
	selectedReasoningLevel: null,
	createdAt: new Date("2026-10-24T00:00:00.000Z"),
	updatedAt: new Date("2026-10-24T00:00:00.000Z"),
} as const;

const activeExecution = {
	executionId: "execution_attachments",
	conversationId: conversation.conversationId,
	actorId: authority.actorId,
	turnId: "turn_attachments",
	sessionGeneration: 1,
	modelConfigurationRevision: null,
	modelOptionId: null,
	reasoningLevel: null,
	lastEventSequence: 0,
	stopPending: false,
	status: "submitted",
} as const;

function state(
	active?: ConversationExecutionStateV1["activeExecution"],
): ConversationExecutionStateV1 {
	return {
		conversation,
		modelConfiguration: undefined,
		sourceMessage: undefined,
		targetExecution: undefined,
		existingStop: undefined,
		activeExecution: active,
		// #3376：会话内没有排队消息，Agent 级排队尚有容量。
		queue: { waitingCount: 0, agent: { waitingCount: 0, lastWaitOrder: 0 } },
	};
}

/** 用给定的 Store 状态执行一次受理，返回 Core 给出的写入计划或结论。 */
async function decide(
	input: {
		readonly text: string;
		readonly attachments?: readonly string[];
	},
	current: ConversationExecutionStateV1,
	actor: ConversationExecutionAuthorityV1 = authority,
) {
	let decision: ConversationMessageWritePlanV1 | { outcome: string } | null =
		null;
	const transaction = {
		async requestMetadataRecovery() {
			return { outcome: "not_applicable" as const };
		},
		async readConversation() {
			throw new Error("Not used by this test");
		},
		async createConversation() {
			throw new Error("Not used by this test");
		},
		async executeMessage(_request, plan) {
			const result = plan(current);
			decision = result;
			if ("outcome" in result) return result;
			return { outcome: "accepted", result: result.result };
		},
		async executeModelSelection() {
			throw new Error("Not used by this test");
		},
		async executeRegeneration() {
			throw new Error("Not used by this test");
		},
		async executeStop() {
			throw new Error("Not used by this test");
		},
	} satisfies ConversationExecutionTransactionPortV1;
	const useCase = createConversationExecutionUseCaseV1({
		authorization: {
			async authorize() {
				return { outcome: "allowed" as const, authority: actor };
			},
		},
		transaction,
	});
	const outcome = await useCase.accept({
		schemaVersion: 1,
		command: "message",
		conversationId: conversation.conversationId,
		text: input.text,
		...(input.attachments ? { attachments: input.attachments } : {}),
		idempotencyKey: "message_merge",
		requestId: "request_merge",
		traceId: "trace_merge",
	});
	return { outcome, decision };
}

describe("WeCom attachment merge window (#3374)", () => {
	it("opens the window only for an attachment-only message of a WeCom bot authority", async () => {
		const opened = await decide(
			{ text: "", attachments: ["file_1"] },
			state(undefined),
		);
		expect(opened.decision).toMatchObject({
			kind: "initial",
			attachmentWindow: "open",
		});
		// 文字消息、Web 消息与不带窗口能力的企微授权都不开窗。
		for (const [input, actor] of [
			[{ text: "看看这张图", attachments: ["file_1"] }, authority],
			[{ text: "你好" }, authority],
			[
				{ text: "", attachments: ["file_1"] },
				{ ...authority, attachmentMergeWindow: undefined },
			],
		] as const) {
			const { attachmentMergeWindow: _flag, ...withoutFlag } = actor;
			const result = await decide(
				input,
				state(undefined),
				actor.attachmentMergeWindow ? actor : withoutFlag,
			);
			expect(result.decision).toMatchObject({ kind: "initial" });
			expect(result.decision).not.toHaveProperty("attachmentWindow");
		}
	});

	it("binds the following text to the unclaimed Execution and closes the window", async () => {
		const { outcome, decision } = await decide(
			{ text: "图里写了什么？" },
			state({ ...activeExecution, attachmentMerge: { attachmentCount: 1 } }),
		);
		expect(outcome).toMatchObject({
			outcome: "accepted",
			result: { executionId: activeExecution.executionId },
		});
		expect(decision).toMatchObject({
			kind: "merge",
			attachmentWindow: "close",
			message: {
				text: "图里写了什么？",
				executionId: activeExecution.executionId,
			},
			outboxIntent: {
				operation: "conversation.turn.submit.v1",
				executionId: activeExecution.executionId,
				turnId: activeExecution.turnId,
			},
			auditEvent: { action: "conversation.message.accepted" },
		});
		expect(decision).not.toHaveProperty("execution");
	});

	it("extends the window for another attachment-only message within the attachment limit", async () => {
		const { decision } = await decide(
			{ text: "", attachments: ["file_2", "file_3"] },
			state({
				...activeExecution,
				attachmentMerge: {
					attachmentCount: conversationAttachmentMergeMaxCountV1 - 2,
				},
			}),
		);
		expect(decision).toMatchObject({
			kind: "merge",
			attachmentWindow: "extend",
		});
		// 超过上限的附件不再并入；不支持补充指令时进入排队（#3376）。
		const over = await decide(
			{ text: "", attachments: ["file_2", "file_3", "file_4"] },
			state({
				...activeExecution,
				attachmentMerge: {
					attachmentCount: conversationAttachmentMergeMaxCountV1 - 2,
				},
			}),
		);
		expect(over.decision).toMatchObject({ kind: "queued" });
		// 不带附件的文字不受附件上限限制。
		const text = await decide(
			{ text: "这些图有什么共同点" },
			state({
				...activeExecution,
				attachmentMerge: { attachmentCount: 12 },
			}),
		);
		expect(text.decision).toMatchObject({
			kind: "merge",
			attachmentWindow: "close",
		});
	});

	it("queues instead of merging outside an open window", async () => {
		for (const [active, actor] of [
			// 窗口已结束、Turn 已认领或已绑定文字：Store 不给出窗口。
			[activeExecution, authority],
			[
				{
					...activeExecution,
					stopPending: true,
					attachmentMerge: { attachmentCount: 1 },
				},
				authority,
			],
			// 只有企微智能机器人授权带合并能力。
			[
				{ ...activeExecution, attachmentMerge: { attachmentCount: 1 } },
				{
					schemaVersion: 1 as const,
					actorId: authority.actorId,
					agentId: authority.agentId,
					channelId: authority.channelId,
					authorizationRevision: authority.authorizationRevision,
					supportsSupplementaryInstruction: false,
				},
			],
		] as const) {
			const result = await decide({ text: "追问" }, state(active), actor);
			expect(result.decision).toMatchObject({ kind: "queued" });
		}
	});

	it("rejects a merge window authority outside the WeCom bot channel", async () => {
		for (const channelId of ["web", "wecom_app:binding", "api"]) {
			await expect(
				decide({ text: "", attachments: ["file_1"] }, state(undefined), {
					...authority,
					channelId,
				}),
			).rejects.toMatchObject({ code: "unavailable" });
		}
	});
});
