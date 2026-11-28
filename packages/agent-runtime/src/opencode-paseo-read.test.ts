import type { PaseoAgentTimelineEvent } from "@getpaseo/client";
import { expect, it, vi } from "vitest";
import { openCodeDeploymentReadActions } from "./opencode-deployment-skills.js";
import { openPaseoNativeSession } from "./paseo-native-session.js";

const provider = "agent-infra-opencode";
const path =
	"/opt/agent/deployment-view/published/files/.agents/skills/weekly-report/SKILL.md";
const agentId = "1cf75af1-1077-4972-8f7c-7b889c89ecc0";
const callId = "toolu_weekly";
const turnId = "turn-1";
const prompt = "Help me prepare my weekly report";

it.each([
	"read",
	"reselected",
	"foreign session",
	"foreign turn",
	"reused call",
	"lost response",
] as const)(
	"answers the original OpenCode read only once for %s",
	async (mode) => {
		let publish: (message: PaseoAgentTimelineEvent) => void;
		let status = "running";
		const replies: { behavior: string; selectedActionId?: string }[] = [];
		const permission = {
			type: "permission_requested",
			provider,
			request: {
				id: "permission-1",
				kind: "tool",
				name: "read",
				provider: "acp",
				detail: { type: "read", filePath: path },
				metadata: {
					toolCallId: callId,
					rawRequest: {
						sessionId: mode === "foreign session" ? "other" : "native",
						toolCall: { toolCallId: callId, title: "read", kind: "read" },
						options: [
							{ optionId: "once", kind: "allow_once" },
							{ optionId: "always", kind: "allow_always" },
							{ optionId: "reject", kind: "reject_once" },
						],
					},
				},
			},
		};
		const item = () => ({
			type: "tool_call",
			name: "read",
			callId,
			status,
			detail: { type: "read", filePath: path },
		});
		const event = (value: unknown) =>
			publish({ agentId, event: value } as PaseoAgentTimelineEvent);
		const respond = vi.fn(
			async (
				_agent: string,
				_request: string,
				choose: () => { behavior: string; selectedActionId?: string },
			) => {
				const response = choose();
				replies.push(response);
				if (mode === "lost response") throw new Error("response lost");
				if (mode === "reused call" && _request === "permission-1") {
					event({
						...permission,
						request: { ...permission.request, id: "permission-2" },
					});
					return;
				}
				status = response.behavior === "allow" ? "completed" : "failed";
				event({ type: "timeline", provider, turnId, item: item() });
				event({ type: "turn_completed", provider, turnId });
			},
		);
		const record = vi.fn(async (_fact: { phase: string }) => {});
		const authorize = vi.fn(async () => ({ revalidate: () => {} }));
		const verifyRead = vi.fn(async (file: string) => {
			expect(file).toBe(path);
			if (mode === "reselected") throw new Error("source changed");
		});
		const session = {
			executionId: "execution",
			ordinaryTurn: true as const,
			runtimeSessionRef: agentId,
			update: vi.fn(),
			recordOperationFact: record,
		};
		const entry = {
			name: "weekly-report",
			description: "Prepare reports",
			path,
		};
		const actions = openCodeDeploymentReadActions(
			{
				verifyRead,
				entries: [entry],
				conflictingNames: [],
				assertUnambiguous() {},
			},
			() => session,
			authorize,
		);
		const writeInstructions = vi.fn();
		const native = await openPaseoNativeSession({
			session,
			model: "anthropic/model",
			close: vi.fn(),
			hasConfirmedModelTurn: () => status === "completed",
			openCodeRead: { actions, writeInstructions, respond },
			transport: {
				ensureAgent: vi.fn(),
				commands: async () => [],
				subscribe: async (_: string, callback: typeof publish) => {
					publish = callback;
					return vi.fn();
				},
				timeline: async () => ({
					agentId,
					agent: {
						id: agentId,
						provider,
						persistence: { sessionId: "native" },
					},
					epoch: "epoch",
					entries: [
						{
							turnId,
							item: {
								type: "user_message",
								clientMessageId: "execution",
								text: prompt,
							},
						},
						{
							turnId: mode === "foreign turn" ? "other" : turnId,
							item: item(),
						},
					],
				}),
				send: async (
					_agentId: string,
					_messageId: string,
					_text: string,
					onSubmit: () => void,
				) => {
					onSubmit();
					event(permission);
					event(permission);
				},
			},
		} as never);
		if (mode === "lost response") {
			await expect(native.prompt(prompt)).rejects.toThrow();
			expect(respond).toHaveBeenCalledTimes(1);
			expect(record.mock.calls.map(([f]) => f.phase)).toEqual([
				"intent",
				"started",
				"unknown",
			]);
			return;
		}
		if (mode === "foreign turn") {
			await expect(native.prompt(prompt)).rejects.toThrow(
				"RUNTIME_ACCEPTANCE_UNKNOWN",
			);
		} else {
			expect((await native.prompt(prompt)).stopReason).toBe(
				mode === "read" ? "stop" : "error",
			);
		}
		expect(writeInstructions.mock.calls[0]?.[0]).toContain(path);
		expect(replies).toEqual(
			mode === "reused call"
				? [
						{ behavior: "allow", selectedActionId: "once" },
						{ behavior: "deny", selectedActionId: "reject" },
					]
				: [
						mode === "read"
							? { behavior: "allow", selectedActionId: "once" }
							: { behavior: "deny", selectedActionId: "reject" },
					],
		);
		expect(authorize).toHaveBeenCalledTimes(mode.startsWith("foreign") ? 0 : 1);
		if (mode === "read")
			expect(record.mock.calls.map(([f]) => f.phase)).toEqual([
				"intent",
				"started",
				"completed",
			]);
	},
);
