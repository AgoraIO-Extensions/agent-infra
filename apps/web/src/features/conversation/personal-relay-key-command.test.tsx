import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { createClient } from "../../pilot/generated/client/index.js";
import { CommandNotice } from "./conversation-command-notice.js";
import { performConversationCommand } from "./conversation-commands.js";

afterEach(cleanup);
it.each(["message", "regenerate", "native-capability"] as const)(
	"4281 %s shows personal settings guidance without retrying",
	async (kind) => {
		let requests = 0;
		const client = createClient({
			baseUrl: "https://platform.example.test",
			fetch: async () => {
				requests++;
				return Response.json(
					{
						schemaVersion: 1,
						code: "ACTION_UNAVAILABLE",
						retryable: false,
						traceId: "trace-4270",
						message:
							"Personal Relay Key is unavailable. Configure it in personal settings.",
					},
					{ status: 409 },
				);
			},
		});
		const result = await performConversationCommand(
			kind === "native-capability"
				? {
						kind,
						body: {
							capabilityId: "a".repeat(64),
							directoryRevision: "b".repeat(64),
							parameters: "Synthetic",
						},
					}
				: kind === "regenerate"
					? { kind, body: { schemaVersion: 1, messageId: "message" } }
					: { kind, body: { schemaVersion: 1, text: "Synthetic" } },
			{
				agentId: "agent",
				conversationId: "conversation",
				executionId: undefined,
			},
			"4270",
			client,
			new AbortController().signal,
		);
		expect(result).toEqual({
			kind: "rejected",
			code: "ACTION_UNAVAILABLE",
			retryable: false,
			reason: "personal_relay_key_unavailable",
		});
		expect(requests).toBe(1);
		render(<CommandNotice pending={false} result={result} />);
		expect(screen.getByRole("alert").textContent).toContain(
			"个人 Relay Key 不可用，请到个人设置处理",
		);
		expect(screen.queryByRole("button", { name: /重试/ })).toBeNull();
	},
);

it.each(
	[403, 404].flatMap((status) =>
		["message", "regenerate", "native-capability"].map((kind) => ({
			status,
			kind,
		})),
	),
)(
	"4281 keeps $kind $status refusals opaque even if an error body names a personal Key",
	async ({ status, kind }) => {
		const client = createClient({
			baseUrl: "https://platform.example.test",
			fetch: async () =>
				Response.json(
					{
						schemaVersion: 1,
						code: "ACTION_UNAVAILABLE",
						retryable: false,
						traceId: "trace-4270",
						message:
							"Personal Relay Key is unavailable. Configure it in personal settings.",
					},
					{ status },
				),
		});
		const result = await performConversationCommand(
			kind === "native-capability"
				? {
						kind,
						body: {
							capabilityId: "a".repeat(64),
							directoryRevision: "b".repeat(64),
							parameters: "Synthetic",
						},
					}
				: kind === "regenerate"
					? { kind, body: { schemaVersion: 1, messageId: "message" } }
					: { kind: "message", body: { schemaVersion: 1, text: "Synthetic" } },
			{
				agentId: "agent",
				conversationId: "conversation",
				executionId: undefined,
			},
			"opaque-4270",
			client,
			new AbortController().signal,
		);
		expect(result.kind).toBe(
			kind === "native-capability" ? "unknown" : "denied",
		);
		expect(result).not.toHaveProperty("reason");
		expect(result).not.toHaveProperty("message");
	},
);
