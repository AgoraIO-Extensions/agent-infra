import {
	AgentProjectionV2Schema,
	CommandAcceptedProjectionV1Schema,
	ConversationDetailProjectionV2Schema,
	PilotProtocolErrorV1Schema,
} from "@agent-infra/contracts/pilot";
import { pilotFakeScenariosV2 } from "@agent-infra/test-support/pilot";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as v1 } from "../../pilot/generated/client.gen.js";
import { client as v2 } from "../../pilot/generated-v2/client.gen.js";
import {
	ConversationScreen,
	type ConversationScreenProps,
} from "./conversation-screen.js";
import {
	deferred,
	event,
	execution,
	history,
	sse,
	timestamp,
} from "./conversation-test-fixtures.js";

const agent = AgentProjectionV2Schema.parse({
	...pilotFakeScenariosV2.starting.response.body,
	agentId: "agent-1",
	managementStatus: "available",
	serviceAvailability: "ready",
});
const originalV1 = v1.getConfig();
const originalV2 = v2.getConfig();
const queries: QueryClient[] = [];
function setup(
	handler?: (request: Request) => Response | Promise<Response> | undefined,
	changes: Partial<ConversationScreenProps> = {},
) {
	const requests: Request[] = [];
	const streams: ReturnType<typeof sse>[] = [];
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	queries.push(queryClient);
	const fetcher: typeof fetch = async (input, init) => {
		const request = new Request(input, init);
		requests.push(request.clone());
		const custom = await handler?.(request);
		if (custom) return custom;
		const path = new URL(request.url).pathname;
		if (path === "/api/v2/agents/agent-1") return Response.json(agent);
		if (path.endsWith("/events")) {
			const stream = sse();
			streams.push(stream);
			return stream.response;
		}
		if (path.includes("/executions/"))
			return Response.json(execution("conversation-1", path.split("/").at(-1)));
		if (path === "/api/v2/conversations/conversation-1")
			return Response.json({
				...history("conversation-1", []),
				conversation: { ...history().conversation, status: "ready" },
			});
		if (path === "/api/v1/agents/agent-1/conversations")
			return Response.json({ items: [], nextCursor: null });
		throw new Error(`Unhandled test request: ${request.method} ${path}`);
	};
	v1.setConfig({ baseUrl: "https://platform.example.test", fetch: fetcher });
	v2.setConfig({ baseUrl: "https://platform.example.test", fetch: fetcher });
	const props: ConversationScreenProps = {
		agentId: "agent-1",
		conversationId: "conversation-1",
		identityKey: "session-a",
		onConversationChange: vi.fn(),
		...changes,
	};
	const view = (value: ConversationScreenProps) => (
		<QueryClientProvider client={queryClient}>
			<ConversationScreen {...value} />
		</QueryClientProvider>
	);
	const result = render(view(props));
	return {
		requests,
		streams,
		queryClient,
		props,
		...result,
		rerenderScope: (value: Partial<ConversationScreenProps>) =>
			result.rerender(view({ ...props, ...value })),
	};
}
afterEach(() => {
	cleanup();
	for (const query of queries.splice(0)) query.clear();
	v1.setConfig(originalV1);
	v2.setConfig(originalV2);
});
async function composer() {
	return (await screen.findByRole("textbox", {
		name: "消息",
	})) as HTMLTextAreaElement;
}
function receipt() {
	return Response.json(
		CommandAcceptedProjectionV1Schema.parse({
			schemaVersion: 1,
			executionId: "execution-1",
			messageId: "message-1",
			status: "submitted",
		}),
		{ status: 202 },
	);
}
function userMessage(text = "Private question") {
	return {
		messageId: "message-1",
		role: "user",
		text,
		status: "completed",
		executionId: "execution-1",
		replyToMessageId: null,
		answerVersion: null,
		isCurrentAnswer: null,
		error: null,
		createdAt: timestamp,
	} as const;
}

describe("functional conversation screen", () => {
	it("restores a regenerated execution with no answer text from persisted status and stops that execution", async () => {
		const completed = {
			...event(1),
			schemaVersion: 1 as const,
			type: "execution.status" as const,
			payload: { status: "completed" as const },
		};
		const processing = {
			...event(2),
			schemaVersion: 1 as const,
			executionId: "execution-2",
			type: "execution.status" as const,
			payload: { status: "processing" as const },
		};
		const { requests } = setup((request) => {
			const path = new URL(request.url).pathname;
			if (path === "/api/v2/agents/agent-1")
				return Response.json({
					...agent,
					capabilities: {
						...agent.capabilities,
						supplementaryInstruction: false,
					},
				});
			if (path === "/api/v2/conversations/conversation-1")
				return Response.json({
					...history("conversation-1", [completed, processing]),
					messages: [
						userMessage(),
						{
							...userMessage(),
							role: "assistant",
							messageId: "answer-1",
							replyToMessageId: "message-1",
							text: "Previous answer",
							answerVersion: 1,
							isCurrentAnswer: true,
						},
					],
				});
			if (request.method === "POST")
				return Response.json(
					{
						schemaVersion: 1,
						status: "submitted",
						executionId: "execution-2",
						messageId: null,
					},
					{ status: 202 },
				);
		});
		const input = await composer();
		fireEvent.change(input, {
			target: { value: "Cannot start a parallel reply" },
		});
		expect(
			(screen.getByRole("button", { name: "重新生成" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
		expect(
			(screen.getByRole("button", { name: "发送" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
		fireEvent.click(screen.getByRole("button", { name: "停止回复" }));
		await screen.findByRole("button", { name: "正在停止" });
		const post = requests.find((request) => request.method === "POST");
		expect(await post?.json()).toEqual({
			schemaVersion: 1,
			targetExecutionId: "execution-2",
		});
	});

	it("refreshes an open execution detail when a terminal status is persisted", async () => {
		let completed = false;
		const terminal = {
			...event(2),
			schemaVersion: 1 as const,
			type: "execution.status" as const,
			payload: { status: "completed" as const },
		};
		const { streams, requests } = setup((request) => {
			const path = new URL(request.url).pathname;
			if (path === "/api/v2/conversations/conversation-1")
				return Response.json({
					...history("conversation-1", completed ? [terminal] : []),
					conversation: {
						...history().conversation,
						status: completed ? "ready" : "active",
					},
					messages: [userMessage()],
				});
			if (path.includes("/executions/"))
				return Response.json({
					...execution(),
					status: completed ? "completed" : "processing",
					finishedAt: completed ? timestamp : null,
					events: completed ? [terminal] : [],
				});
		});
		fireEvent.click(await screen.findByRole("button", { name: "执行详情" }));
		await screen.findByText("处理中");
		completed = true;
		act(() => streams.at(-1)?.send(terminal));
		await screen.findByText("已完成");
		expect(screen.queryByText("处理中")).toBeNull();
		expect(
			requests.filter((request) =>
				new URL(request.url).pathname.includes("/executions/"),
			).length,
		).toBeGreaterThan(1);
	});

	it("does not claim a stop receipt is cancellation and retains the original execution target", async () => {
		const { requests } = setup((request) => {
			const path = new URL(request.url).pathname;
			if (request.method === "POST") return receipt();
			if (path === "/api/v2/conversations/conversation-1")
				return Response.json({
					...history("conversation-1", []),
					messages: [userMessage()],
				});
		});
		const stop = await screen.findByRole("button", { name: "停止回复" });
		fireEvent.click(stop);
		await screen.findByRole("button", { name: "正在停止" });
		const post = requests.find((request) => request.method === "POST");
		expect(await post?.json()).toEqual({
			schemaVersion: 1,
			targetExecutionId: "execution-1",
		});
		expect(screen.queryByText("已停止")).toBeNull();
		expect(
			(screen.getByRole("button", { name: "正在停止" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
	});
	it("requires saving a changed model before sending and applies the confirmed future selection", async () => {
		let saved = false;
		const config = {
			...agent.configuration,
			defaultModelOptionId: "option-a",
			defaultReasoningLevel: "low",
			modelOptions: [
				{
					optionId: "option-a",
					displayName: "Model A",
					modelId: "model-a",
					reasoningLevels: ["low"],
				},
				{
					optionId: "option-b",
					displayName: "Model B",
					modelId: "model-b",
					reasoningLevels: ["high"],
				},
			],
		};
		const conversation = () => ({
			...history("conversation-1", []).conversation,
			status: "ready",
			selectedModelOptionId: saved ? "option-b" : "option-a",
			selectedReasoningLevel: saved ? "high" : "low",
		});
		const { requests } = setup((request) => {
			const path = new URL(request.url).pathname;
			if (path === "/api/v2/agents/agent-1")
				return Response.json({
					...agent,
					capabilities: { ...agent.capabilities, modelSelection: true },
					configuration: config,
				});
			if (path.endsWith("/model-selection")) {
				saved = true;
				return Response.json(conversation());
			}
			if (path === "/api/v2/conversations/conversation-1")
				return Response.json({
					...history("conversation-1", []),
					conversation: conversation(),
				});
		});
		const input = await composer();
		fireEvent.change(input, { target: { value: "Use chosen model" } });
		fireEvent.change(screen.getByRole("combobox", { name: "模型" }), {
			target: { value: "option-b" },
		});
		expect(
			(screen.getByRole("button", { name: "发送" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
		fireEvent.click(screen.getByRole("button", { name: "保存模型选择" }));
		await screen.findByText("模型选择已保存，从下一条消息开始生效。");
		await waitFor(() =>
			expect(
				(screen.getByRole("button", { name: "发送" }) as HTMLButtonElement)
					.disabled,
			).toBe(false),
		);
		const update = requests.find((request) =>
			request.url.endsWith("/model-selection"),
		);
		expect(await update?.json()).toEqual({
			schemaVersion: 1,
			modelOptionId: "option-b",
			reasoningLevel: "high",
		});
		expect(input.value).toBe("Use chosen model");
	});

	it("submits multiline text only outside IME and treats acceptance as pending execution", async () => {
		let accepted = false;
		const { requests } = setup((request) => {
			if (request.method === "POST") {
				accepted = true;
				return receipt();
			}
			if (
				accepted &&
				new URL(request.url).pathname === "/api/v2/conversations/conversation-1"
			)
				return Response.json(
					ConversationDetailProjectionV2Schema.parse({
						...history("conversation-1", []),
						messages: [userMessage("第一行\n第二行")],
					}),
				);
		});
		const input = await composer();
		fireEvent.change(input, { target: { value: "第一行\n第二行" } });
		fireEvent.compositionStart(input);
		fireEvent.keyDown(input, { key: "Enter" });
		fireEvent.compositionEnd(input);
		fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
		expect(
			requests.filter((request) => request.method === "POST"),
		).toHaveLength(0);
		fireEvent.keyDown(input, { key: "Enter" });
		await screen.findByText("消息已受理，等待处理结果。");
		const posts = requests.filter((request) => request.method === "POST");
		expect(posts).toHaveLength(1);
		expect(await posts[0].json()).toEqual({
			schemaVersion: 1,
			text: "第一行\n第二行",
		});
		expect(input.value).toBe("");
		expect(screen.queryByText("已完成")).toBeNull();
		expect(screen.getByRole("button", { name: "停止回复" })).toBeTruthy();
	});

	it("retains an unknown command and only retries the same idempotency key explicitly", async () => {
		const { requests, streams } = setup((request) =>
			request.method === "POST"
				? Promise.reject(new TypeError("offline"))
				: undefined,
		);
		const input = await composer();
		fireEvent.change(input, { target: { value: "one operation" } });
		fireEvent.click(screen.getByRole("button", { name: "发送" }));
		const verify = await screen.findByRole("button", { name: "核实原请求" });
		expect(input.value).toBe("one operation");
		expect(
			(screen.getByRole("button", { name: "发送" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
		act(() => streams.at(-1)?.disconnect());
		await screen.findByRole("button", { name: "重新连接" });
		fireEvent.click(screen.getByRole("button", { name: "重新连接" }));
		await waitFor(() => expect(streams.length).toBe(2));
		expect(
			requests.filter((request) => request.method === "POST"),
		).toHaveLength(1);
		fireEvent.click(verify);
		await waitFor(() =>
			expect(
				requests.filter((request) => request.method === "POST"),
			).toHaveLength(2),
		);
		const posts = requests.filter((request) => request.method === "POST");
		expect(posts[1].headers.get("Idempotency-Key")).toBe(
			posts[0].headers.get("Idempotency-Key"),
		);
	});

	it("clears private draft and timeline before a new identity read completes", async () => {
		let delayed = false;
		const next = deferred<Response>();
		const state = setup((request) =>
			delayed && new URL(request.url).pathname.includes("/agents/")
				? next.promise
				: undefined,
		);
		const input = await composer();
		fireEvent.change(input, { target: { value: "Private draft A" } });
		delayed = true;
		state.rerenderScope({ identityKey: "session-b" });
		expect(screen.queryByDisplayValue("Private draft A")).toBeNull();
		expect(screen.queryByRole("textbox")).toBeNull();
		await act(async () => next.resolve(Response.json(agent)));
		expect((await composer()).value).toBe("");
		expect(
			JSON.stringify(
				state.queryClient
					.getQueryCache()
					.getAll()
					.map((query) => query.state.data),
			),
		).not.toContain("Private draft A");
	});

	it("does not render a conversation returned under a different Agent", async () => {
		setup((request) =>
			new URL(request.url).pathname === "/api/v2/conversations/conversation-1"
				? Response.json({
						...history(),
						conversation: { ...history().conversation, agentId: "other-agent" },
						messages: [userMessage("Other scope body")],
					})
				: undefined,
		);
		await screen.findByText(/当前登录或访问权限已失效/);
		expect(screen.queryByText("Other scope body")).toBeNull();
		expect(screen.queryByRole("textbox")).toBeNull();
	});

	it("revocation removes history and draft without a new submission", async () => {
		const { streams, requests } = setup();
		const input = await composer();
		fireEvent.change(input, { target: { value: "Private draft" } });
		act(() =>
			streams.at(-1)?.send({
				schemaVersion: 1,
				kind: "control",
				type: "authorization.revoked",
				error: {
					schemaVersion: 1,
					code: "AUTHORIZATION_REVOKED",
					message: "Denied",
					retryable: false,
					traceId: "trace-1",
				},
			}),
		);
		await screen.findByText(/当前登录或访问权限已失效/);
		expect(screen.queryByDisplayValue("Private draft")).toBeNull();
		expect(requests.some((request) => request.method === "POST")).toBe(false);
	});

	it("preserves the composer while viewing personal history and binds navigation to server IDs", async () => {
		const { props } = setup((request) =>
			new URL(request.url).pathname === "/api/v1/agents/agent-1/conversations"
				? Response.json({
						items: [history().conversation],
						nextCursor: null,
					})
				: undefined,
		);
		fireEvent.change(await composer(), { target: { value: "Kept draft" } });
		fireEvent.click(screen.getByRole("button", { name: "个人历史" }));
		const historyLink = await screen.findByRole("link", {
			name: /Test conversation/,
		});
		expect(historyLink.getAttribute("href")).toBe(
			"/agents/agent-1/conversations?conversation=conversation-1",
		);
		fireEvent.click(historyLink, { ctrlKey: true });
		expect(props.onConversationChange).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "返回对话" }));
		expect((await composer()).value).toBe("Kept draft");
		fireEvent.click(screen.getByRole("button", { name: "个人历史" }));
		fireEvent.click(
			await screen.findByRole("link", { name: /Test conversation/ }),
		);
		expect(props.onConversationChange).toHaveBeenCalledWith("conversation-1");
	});

	it("creates a durable conversation before navigating", async () => {
		const { props, requests } = setup(
			(request) =>
				request.method === "POST"
					? Response.json(history().conversation, { status: 201 })
					: undefined,
			{ conversationId: undefined },
		);
		fireEvent.click(await screen.findByRole("button", { name: "创建会话" }));
		await waitFor(() =>
			expect(props.onConversationChange).toHaveBeenCalledWith("conversation-1"),
		);
		expect(
			requests.filter((request) => request.method === "POST"),
		).toHaveLength(1);
	});

	it("keeps stopped Agents read-only while showing retained messages", async () => {
		setup((request) => {
			const path = new URL(request.url).pathname;
			if (path === "/api/v2/agents/agent-1")
				return Response.json({ ...agent, managementStatus: "stopped" });
			if (path === "/api/v2/conversations/conversation-1")
				return Response.json({
					...history(),
					messages: [userMessage("Retained question")],
				});
		});
		expect((await composer()).disabled).toBe(true);
		await screen.findByText("Retained question");
		expect(
			(screen.getByRole("button", { name: "新建会话" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
	});

	it("preserves rejected busy text and reports the protocol reason", async () => {
		setup((request) =>
			request.method === "POST"
				? Response.json(
						PilotProtocolErrorV1Schema.parse({
							schemaVersion: 1,
							code: "AGENT_BUSY",
							message: "Do not render raw error",
							retryable: true,
							traceId: "trace",
						}),
						{ status: 409 },
					)
				: undefined,
		);
		const input = await composer();
		fireEvent.change(input, { target: { value: "Busy draft" } });
		fireEvent.click(screen.getByRole("button", { name: "发送" }));
		await screen.findByText(/当前回复仍在处理，暂不支持补充指令/);
		expect(input.value).toBe("Busy draft");
		expect(screen.queryByText("Do not render raw error")).toBeNull();
	});

	it("renders snapshot plus new deltas once and opens the selected answer version detail", async () => {
		const first = {
			...event(1),
			schemaVersion: 1 as const,
			type: "text.delta" as const,
			payload: { text: "Old answer" },
		};
		const { streams, requests } = setup((request) =>
			new URL(request.url).pathname === "/api/v2/conversations/conversation-1"
				? Response.json({
						...history("conversation-1", [first]),
						messages: [
							userMessage(),
							{
								...userMessage(),
								role: "assistant",
								messageId: "answer-1",
								replyToMessageId: "message-1",
								text: "Old answer",
								answerVersion: 1,
								isCurrentAnswer: false,
							},
							{
								...userMessage(),
								role: "assistant",
								executionId: "execution-2",
								messageId: "answer-2",
								replyToMessageId: "message-1",
								text: "New answer",
								answerVersion: 2,
								isCurrentAnswer: true,
							},
						],
					})
				: undefined,
		);
		await screen.findByText("New answer");
		act(() =>
			streams.at(-1)?.send({
				...event(2),
				executionId: "execution-2",
				payload: { text: " continuation" },
			}),
		);
		await screen.findByText("New answer continuation");
		fireEvent.click(screen.getByRole("button", { name: "上一个回答版本" }));
		await screen.findByText("Old answer");
		expect(screen.queryByText("Old answerOld answer")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "执行详情" }));
		await waitFor(() =>
			expect(
				requests.some((request) =>
					request.url.endsWith("/executions/execution-1"),
				),
			).toBe(true),
		);
	});
});
