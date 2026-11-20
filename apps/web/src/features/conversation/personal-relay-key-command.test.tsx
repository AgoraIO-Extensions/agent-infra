import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { createClient } from "../../pilot/generated/client/index.js";
import { CommandNotice } from "./conversation-command-notice.js";
import { performConversationCommand } from "./conversation-commands.js";

afterEach(cleanup);
it("4270 shows personal settings guidance without caching server messages or retrying", async () => {
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
		{ kind: "message", body: { schemaVersion: 1, text: "Synthetic" } },
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
});

it.each([403, 404])(
	"4270 keeps %s refusals opaque even if an error body names a personal Key",
	async (status) => {
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
			{ kind: "message", body: { schemaVersion: 1, text: "Synthetic" } },
			{
				agentId: "agent",
				conversationId: "conversation",
				executionId: undefined,
			},
			"opaque-4270",
			client,
			new AbortController().signal,
		);
		expect(result.kind).toBe("denied");
		expect(result).not.toHaveProperty("reason");
		expect(result).not.toHaveProperty("message");
	},
);
