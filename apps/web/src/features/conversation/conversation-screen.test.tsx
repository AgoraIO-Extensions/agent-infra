import {
	AgentProjectionV2Schema,
	CommandAcceptedProjectionV1Schema,
	ConversationDetailProjectionV2Schema,
	PersistedConversationEventV2Schema,
	PilotProtocolErrorV1Schema,
} from "@agent-infra/contracts/pilot";
import { pilotFakeScenariosV2 } from "@agent-infra/test-support/pilot";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterContextProvider,
} from "@tanstack/react-router";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
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
		if (path === "/api/v2/me/conversations/recent")
			return Response.json({ items: [], nextCursor: null });
		if (path === "/api/v2/agents/agent-1") return Response.json(agent);
		if (path === "/api/v1/conversations/conversation-1/files/limits")
			return Response.json({
				schemaVersion: 1,
				revision: "test-files-v1",
				expiresAt: "2027-01-01T00:00:00Z",
				mediaTypes: ["text/plain", "application/pdf"],
				maxBytes: 10 * 1024 * 1024,
			});
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
	const router = createRouter({
		routeTree: createRootRoute(),
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	const view = (value: ConversationScreenProps) => (
		<RouterContextProvider router={router}>
			<QueryClientProvider client={queryClient}>
				<ConversationScreen {...value} />
			</QueryClientProvider>
		</RouterContextProvider>
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

function fileProjection(status: "pending" | "available" = "available") {
	return {
		schemaVersion: 1,
		fileId: "file-1",
		kind: "attachment",
		descriptor: {
			name: "notes.txt",
			mediaType: "text/plain",
			sizeBytes: 5,
			sha256: "a".repeat(64),
		},
		status,
		createdAt: timestamp,
		expiresAt: "2027-01-01T00:00:00Z",
	};
}

describe("functional conversation screen", () => {
	it("rejects unsupported and oversized files before creating an upload", async () => {
		const { requests } = setup();
		const input = await screen.findByLabelText("添加附件");
		fireEvent.change(input, {
			target: {
				files: [
					new File(["bad"], "bad.bin", { type: "application/octet-stream" }),
				],
			},
		});
		await screen.findByText("当前 Agent 不支持此文件类型。");
		expect(
			requests.some((request) =>
				new URL(request.url).pathname.endsWith("/files"),
			),
		).toBe(false);
	});

	it("closes the attachment entry when the limits response is not the contract shape", async () => {
		setup((request) =>
			new URL(request.url).pathname ===
			"/api/v1/conversations/conversation-1/files/limits"
				? Response.json({ items: [], nextCursor: null })
				: undefined,
		);
		await screen.findByText("文件限制暂不可用，上传入口已关闭。");
		expect(
			(screen.getByRole("button", { name: "添加附件" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
	});

	it("reads the read-only file limits before the attachment entry opens", async () => {
		const { requests } = setup();
		await screen.findByText(/支持 text\/plain/);
		expect(
			(screen.getByRole("button", { name: "添加附件" }) as HTMLButtonElement)
				.disabled,
		).toBe(false);
		const limits = requests.filter((request) =>
			new URL(request.url).pathname.endsWith("/files/limits"),
		);
		expect(limits).toHaveLength(1);
		expect(limits[0]?.method).toBe("GET");
		expect(await limits[0]?.text()).toBe("");
	});

	it("binds an available uploaded file to the submitted message", async () => {
		const originalCrypto = globalThis.crypto;
		vi.stubGlobal("crypto", {
			...(originalCrypto ?? {}),
			randomUUID: () => "upload-local-1",
			subtle: { digest: async () => new ArrayBuffer(32) },
		});
		try {
			const projection = fileProjection();
			const { requests } = setup((request) => {
				const path = new URL(request.url).pathname;
				if (request.method === "POST" && path.endsWith("/files"))
					return Response.json(projection, { status: 201 });
				if (request.method === "POST" && path.endsWith("/files/file-1/access"))
					return Response.json({
						schemaVersion: 1,
						accessId: "access-1",
						file: projection,
						path: "/api/v1/conversations/conversation-1/files/file-1/content",
						grant: { format: "compact-jws", schemaVersion: 1, token: "grant" },
						expiresAt: "2027-01-01T00:00:00Z",
					});
				if (request.method === "PUT" && path.endsWith("/content"))
					return new Response(null, { status: 204 });
				if (request.method === "POST" && path.endsWith("/complete"))
					return Response.json(projection);
				if (request.method === "POST" && path.endsWith("/messages"))
					return receipt();
				return undefined;
			});
			fireEvent.change(await screen.findByLabelText("添加附件"), {
				target: {
					files: [new File(["hello"], "notes.txt", { type: "text/plain" })],
				},
			});
			await screen.findByText("已上传");
			fireEvent.change(await composer(), {
				target: { value: "Summarize this" },
			});
			fireEvent.click(screen.getByRole("button", { name: "发送" }));
			await screen.findByText("消息已受理，等待处理结果。");
			const messageRequest = requests.find(
				(request) =>
					request.method === "POST" &&
					new URL(request.url).pathname.endsWith("/messages"),
			);
			expect(await messageRequest?.json()).toEqual({
				schemaVersion: 1,
				text: "Summarize this",
				attachments: ["file-1"],
			});
		} finally {
			vi.stubGlobal("crypto", originalCrypto);
		}
	});

	it("downloads a result.file through a fresh read grant", async () => {
		const resultEvent = PersistedConversationEventV2Schema.parse({
			...event(2),
			type: "result.file",
			payload: {
				fileId: "result-1",
				name: "report.txt",
				mediaType: "text/plain",
				sizeBytes: 5,
			},
		});
		const { requests } = setup((request) => {
			const path = new URL(request.url).pathname;
			if (request.method === "POST" && path.endsWith("/files/result-1/access"))
				return Response.json({
					schemaVersion: 1,
					accessId: "read-access-1",
					file: { ...fileProjection(), fileId: "result-1", kind: "result" },
					path: "/api/v1/conversations/conversation-1/files/result-1/content",
					grant: {
						format: "compact-jws",
						schemaVersion: 1,
						token: "read-grant",
					},
					expiresAt: "2027-01-01T00:00:00Z",
				});
			if (request.method === "GET" && path.endsWith("/files/result-1/content"))
				return new Response("hello", { status: 200 });
			if (path === "/api/v2/conversations/conversation-1")
				return Response.json({
					...history("conversation-1", [resultEvent]),
					conversation: { ...history().conversation, status: "ready" },
				});
			return undefined;
		});
		const createObjectUrl = vi.fn(() => "blob:result-1");
		const originalCreateObjectUrl = URL.createObjectURL;
		Object.defineProperty(URL, "createObjectURL", {
			configurable: true,
			value: createObjectUrl,
		});
		try {
			fireEvent.click(await screen.findByRole("button", { name: "下载" }));
			await waitFor(() => expect(createObjectUrl).toHaveBeenCalled());
			expect(
				requests.some((request) =>
					request.url.endsWith("/files/result-1/access"),
				),
			).toBe(true);
			expect(
				requests.some((request) =>
					request.url.endsWith("/files/result-1/content"),
				),
			).toBe(true);
		} finally {
			if (originalCreateObjectUrl)
				Object.defineProperty(URL, "createObjectURL", {
					configurable: true,
					value: originalCreateObjectUrl,
				});
			else delete (URL as { createObjectURL?: unknown }).createObjectURL;
		}
	});

	it.each(["stream", "snapshot"] as const)(
		"clears waiting and refreshes recent history when completion arrives via %s",
		async (source) => {
			let accepted = false;
			let completed = false;
			const completedEvent = {
				...event(1),
				schemaVersion: 1 as const,
				type: "execution.status" as const,
				payload: { status: "completed" as const },
			};
			const { streams } = setup((request) => {
				if (new URL(request.url).pathname === "/api/v2/me/conversations/recent")
					return Response.json({
						items: [
							{
								...history().conversation,
								title: completed ? "Completed task" : "Pending task",
							},
						],
						nextCursor: null,
					});
				if (request.method === "POST") {
					accepted = true;
					return receipt();
				}
				if (
					new URL(request.url).pathname ===
					"/api/v2/conversations/conversation-1"
				)
					return Response.json({
						...history("conversation-1", completed ? [completedEvent] : []),
						messages: accepted ? [userMessage()] : [],
					});
			});
			fireEvent.change(await composer(), {
				target: { value: "Complete this task" },
			});
			fireEvent.click(screen.getByRole("button", { name: "发送" }));
			await screen.findByText("消息已受理，等待处理结果。");
			await screen.findByRole("link", { name: /Pending task/ });
			completed = true;
			if (source === "stream") act(() => streams.at(-1)?.send(completedEvent));
			else fireEvent.click(screen.getByRole("button", { name: "刷新会话" }));
			await screen.findByText("已完成");
			expect(screen.queryByText("消息已受理，等待处理结果。")).toBeNull();
			expect(
				await screen.findByRole("link", { name: /Completed task/ }),
			).toBeTruthy();
		},
	);

	it.each(["timeline", "unknown", "removed-unknown"] as const)(
		"restores focus after closing execution details opened from %s",
		async (entry) => {
			let completed = false;
			const statusEvent = () => ({
				...event(completed ? 2 : 1),
				schemaVersion: 1 as const,
				type: "execution.status" as const,
				payload: {
					status: completed ? ("completed" as const) : ("unknown" as const),
				},
			});
			const { streams, requests } = setup((request) =>
				new URL(request.url).pathname === "/api/v2/conversations/conversation-1"
					? Response.json({
							...history("conversation-1", [statusEvent()]),
							conversation: {
								...history().conversation,
								status: completed ? "ready" : "active",
							},
							messages: [userMessage()],
						})
					: undefined,
			);
			const trigger =
				entry === "timeline"
					? (await screen.findAllByRole("button", { name: "执行详情" }))[0]
					: await screen.findByRole("button", { name: "核实原执行状态" });
			if (!trigger) throw new Error("Missing execution detail trigger");
			trigger.focus();
			fireEvent.click(trigger);
			const heading = await screen.findByRole("heading", { name: "执行详情" });
			await waitFor(() => expect(document.activeElement).toBe(heading));
			if (entry === "removed-unknown") {
				completed = true;
				act(() => streams.at(-1)?.send(statusEvent()));
				await waitFor(() => expect(trigger.isConnected).toBe(false));
			} else {
				expect(trigger.isConnected).toBe(true);
			}
			const back = screen.getByRole("button", { name: "返回对话" });
			back.focus();
			fireEvent.click(back);
			const target =
				entry === "removed-unknown"
					? screen.getByRole("heading", { name: "Test conversation" })
					: trigger;
			expect(target.isConnected).toBe(true);
			await waitFor(() => expect(document.activeElement).toBe(target));
			expect(requests.every((request) => request.method === "GET")).toBe(true);
		},
	);

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
	it("keeps a preparing Session read-only with its draft and enables sending once ready (#1534)", async () => {
		let ready = false;
		const { requests } = setup((request) => {
			const path = new URL(request.url).pathname;
			if (path === "/api/v2/conversations/conversation-1")
				return Response.json({
					...history("conversation-1", []),
					conversation: { ...history().conversation, status: "ready" },
					sessionAvailability: ready ? "ready" : "preparing",
				});
			if (request.method === "POST") return receipt();
		});
		const input = await composer();
		fireEvent.change(input, { target: { value: "First question" } });
		await screen.findByText("会话准备中，完成后即可发送。草稿会保留。");
		const send = screen.getByRole("button", {
			name: "发送",
		}) as HTMLButtonElement;
		expect(send.disabled).toBe(true);
		expect(input.disabled).toBe(false);
		ready = true;
		// No event announces readiness; the screen re-reads the projection.
		await waitFor(() => expect(send.disabled).toBe(false), { timeout: 4_000 });
		expect(
			screen.queryByText("会话准备中，完成后即可发送。草稿会保留。"),
		).toBeNull();
		expect(input.value).toBe("First question");
		expect(requests.some((request) => request.method === "POST")).toBe(false);
	});

	it("shows an upgrading Session as updating with read-only history until it is ready (#1523)", async () => {
		let ready = false;
		const { requests } = setup((request) => {
			const path = new URL(request.url).pathname;
			if (path === "/api/v2/conversations/conversation-1")
				return Response.json({
					...history("conversation-1", []),
					conversation: { ...history().conversation, status: "ready" },
					sessionAvailability: ready ? "ready" : "updating",
				});
			if (request.method === "POST") return receipt();
		});
		const input = await composer();
		fireEvent.change(input, { target: { value: "Follow-up" } });
		await screen.findByText("会话更新中，完成后即可发送。草稿会保留。");
		const send = screen.getByRole("button", {
			name: "发送",
		}) as HTMLButtonElement;
		expect(send.disabled).toBe(true);
		expect(
			screen.queryByText("会话准备中，完成后即可发送。草稿会保留。"),
		).toBeNull();
		ready = true;
		await waitFor(() => expect(send.disabled).toBe(false), { timeout: 4_000 });
		expect(
			screen.queryByText("会话更新中，完成后即可发送。草稿会保留。"),
		).toBeNull();
		expect(input.value).toBe("Follow-up");
		expect(requests.some((request) => request.method === "POST")).toBe(false);
	});

	it("re-reads an open Session when its Agent update becomes ready and shows the Sandbox upgrade (#1523)", async () => {
		let phase: "agent-updating" | "session-updating" | "ready" =
			"agent-updating";
		setup((request) => {
			const path = new URL(request.url).pathname;
			if (path === "/api/v2/agents/agent-1")
				return Response.json({
					...agent,
					serviceAvailability:
						phase === "agent-updating" ? "updating" : "ready",
				});
			if (path === "/api/v2/conversations/conversation-1")
				return Response.json({
					...history("conversation-1", []),
					conversation: { ...history().conversation, status: "ready" },
					sessionAvailability:
						phase === "session-updating" ? "updating" : "ready",
				});
		});
		await screen.findByText(/Agent 更新中/);
		// The ready Agent commits the Session's Sandbox upgrade with it; the
		// page polls the updating Agent and then re-reads the Session.
		phase = "session-updating";
		await screen.findByText(
			"会话更新中，完成后即可发送。草稿会保留。",
			undefined,
			{
				timeout: 4_000,
			},
		);
		phase = "ready";
		await waitFor(
			() =>
				expect(
					screen.queryByText("会话更新中，完成后即可发送。草稿会保留。"),
				).toBeNull(),
			{ timeout: 4_000 },
		);
	});

	it("keeps the draft and explains a preparing Session rejection instead of lost access (#1534)", async () => {
		setup((request) => {
			if (request.method === "POST")
				return Response.json(
					PilotProtocolErrorV1Schema.parse({
						schemaVersion: 1,
						code: "AGENT_STARTING",
						message: "The conversation is still preparing.",
						retryable: true,
						traceId: "trace-starting",
					}),
					{ status: 409 },
				);
		});
		const input = await composer();
		fireEvent.change(input, { target: { value: "Early question" } });
		fireEvent.click(screen.getByRole("button", { name: "发送" }));
		await screen.findByText(
			"会话尚未准备完成，消息未发送，草稿已保留。准备完成后请重新发送。",
		);
		expect(input.value).toBe("Early question");
		expect(screen.queryByText("访问权限已失效。")).toBeNull();
		expect(
			screen.queryByText(
				"当前登录或访问权限已失效，请重新登录或返回 Agent 列表。",
			),
		).toBeNull();
	});

	it("settles a stop whose reply had already finished (#1524)", async () => {
		const { requests } = setup((request) => {
			const path = new URL(request.url).pathname;
			if (request.method === "POST")
				return Response.json(
					CommandAcceptedProjectionV1Schema.parse({
						schemaVersion: 1,
						executionId: "execution-1",
						messageId: null,
						status: "already_finished",
					}),
					{ status: 202 },
				);
			if (path === "/api/v2/conversations/conversation-1")
				return Response.json({
					...history("conversation-1", []),
					messages: [userMessage()],
				});
		});
		fireEvent.click(await screen.findByRole("button", { name: "停止回复" }));
		await screen.findByText("原回复已结束。");
		const post = requests.findIndex((request) => request.method === "POST");
		expect(post).toBeGreaterThanOrEqual(0);
		// The receipt re-reads the timeline instead of waiting for a stop event.
		await waitFor(() =>
			expect(
				requests
					.slice(post + 1)
					.some(
						(request) =>
							new URL(request.url).pathname ===
							"/api/v2/conversations/conversation-1",
					),
			).toBe(true),
		);
		expect(screen.queryByRole("button", { name: "正在停止" })).toBeNull();
	});
	it("shows a stored terminal answer whose terminal event is missing (#1524)", async () => {
		const processing = {
			...event(1),
			schemaVersion: 1 as const,
			type: "execution.status" as const,
			payload: { status: "processing" as const },
		};
		setup((request) => {
			if (
				new URL(request.url).pathname === "/api/v2/conversations/conversation-1"
			)
				return Response.json({
					...history("conversation-1", [processing]),
					conversation: { ...history().conversation, status: "ready" },
					messages: [
						userMessage(),
						{
							...userMessage(),
							role: "assistant",
							messageId: "answer-1",
							replyToMessageId: "message-1",
							text: "Finished answer",
							answerVersion: 1,
							isCurrentAnswer: true,
						},
					],
				});
		});
		await screen.findByText("Finished answer");
		expect(screen.getByText("已完成")).toBeTruthy();
		expect(screen.queryByText("处理中")).toBeNull();
		expect(screen.queryByRole("button", { name: "停止回复" })).toBeNull();
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
		fireEvent.click(screen.getByRole("combobox", { name: "模型" }));
		const modelOption = await screen.findByRole("option", { name: "Model B" });
		fireEvent.pointerDown(modelOption, { pointerType: "mouse" });
		fireEvent.click(modelOption, { detail: 1 });
		expect(screen.getByRole("button", { name: "保存模型选择" })).toHaveProperty(
			"type",
			"button",
		);
		await waitFor(() =>
			expect(
				(screen.getByRole("button", { name: "发送" }) as HTMLButtonElement)
					.disabled,
			).toBe(true),
		);
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
		const guard = document.querySelector<HTMLElement>("[data-c02-guard]");
		expect(guard?.dataset.c02Guard).toBe("pending-submit");
		expect(guard?.dataset.c02SessionId).toBe("conversation-1");
		expect(guard?.dataset.c02MessageCount).toBe("0");
		expect(
			screen
				.getByRole("button", { name: "发送" })
				.getAttribute("data-c02-send-button"),
		).toBe("send");
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

	it("guards synchronous send repeats within one session", async () => {
		const { requests } = setup((request) =>
			request.method === "POST" ? receipt() : undefined,
		);
		const input = await composer();
		fireEvent.change(input, { target: { value: "one operation" } });
		const send = screen.getByRole("button", { name: "发送" });
		fireEvent.click(send);
		fireEvent.click(send);
		await screen.findByText("消息已受理，等待处理结果。");
		expect(
			requests.filter((request) => request.method === "POST"),
		).toHaveLength(1);
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

	it("clears private roles and draft before a new identity read and rejects the previous private conversation", async () => {
		let delayed = false;
		const next = deferred<Response>();
		const state = setup((request) => {
			const path = new URL(request.url).pathname;
			if (path === "/api/v2/agents/agent-1")
				return delayed
					? next.promise
					: Response.json({ ...agent, name: "Private Agent A" });
			if (path === "/api/v2/conversations/conversation-1") {
				if (delayed)
					return Response.json(
						PilotProtocolErrorV1Schema.parse({
							schemaVersion: 1,
							code: "AUTHORIZATION_REVOKED",
							message: "Controlled current-subject denial",
							retryable: false,
							traceId: "controlled-identity-denial",
						}),
						{ status: 403 },
					);
				return Response.json(
					history("conversation-1", [
						{
							...event(1),
							schemaVersion: 1,
							type: "text.delta",
							payload: {
								text: "Private reply A",
							},
						},
					]),
				);
			}
			return undefined;
		});
		const input = await composer();
		await screen.findByRole("article", { name: "Private Agent A的消息" });
		await screen.findByText("Private reply A");
		fireEvent.change(input, { target: { value: "Private draft A" } });
		delayed = true;
		state.rerenderScope({ identityKey: "session-b" });
		expect(screen.queryByDisplayValue("Private draft A")).toBeNull();
		expect(screen.queryByRole("textbox")).toBeNull();
		expect(
			screen.queryByRole("article", { name: "Private Agent A的消息" }),
		).toBeNull();
		expect(screen.queryByText("Private reply A")).toBeNull();
		await act(async () =>
			next.resolve(Response.json({ ...agent, name: "Current Agent B" })),
		);
		await screen.findByText(/当前登录或访问权限已失效/);
		expect(screen.queryByRole("textbox")).toBeNull();
		expect(
			screen.queryByRole("article", { name: "Current Agent B的消息" }),
		).toBeNull();
		expect(
			screen.queryByRole("article", { name: "Private Agent A的消息" }),
		).toBeNull();
		expect(screen.queryByText("Private reply A")).toBeNull();
		expect(
			state.requests.filter((request) => request.method === "POST"),
		).toHaveLength(0);
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
		const { props, requests, streams } = setup((request) =>
			new URL(request.url).pathname === "/api/v1/agents/agent-1/conversations"
				? Response.json({
						items: [history().conversation],
						nextCursor: null,
					})
				: undefined,
		);
		fireEvent.change(await composer(), { target: { value: "Kept draft" } });
		await screen.findByRole("heading", { name: "最近对话" });
		await waitFor(() => expect(streams).toHaveLength(1));
		fireEvent.click(
			screen.getByRole("button", { name: "此 Agent 的全部历史" }),
		);
		expect((await composer()).value).toBe("Kept draft");
		expect(document.activeElement?.getAttribute("aria-label")).toBe("对话历史");
		const historyLink = await screen.findByRole("link", {
			name: /Test conversation/,
		});
		expect(historyLink.getAttribute("href")).toBe(
			"/chat/agent-1/conversation-1",
		);
		fireEvent.click(historyLink, { ctrlKey: true });
		expect(props.onConversationChange).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "返回对话" }));
		expect((await composer()).value).toBe("Kept draft");
		fireEvent.click(
			screen.getByRole("button", { name: "此 Agent 的全部历史" }),
		);
		fireEvent.click(
			await screen.findByRole("link", { name: /Test conversation/ }),
		);
		expect(props.onConversationChange).toHaveBeenCalledWith("conversation-1");
		expect(streams).toHaveLength(1);
		expect(requests.every((request) => request.method === "GET")).toBe(true);
	});

	it("opens recent history without changing the route and returns from full history to recent scope", async () => {
		const onViewChange = vi.fn();
		const { rerenderScope, streams, requests } = setup(undefined, {
			view: "conversation",
			onViewChange,
		});
		const input = await composer();
		fireEvent.change(input, { target: { value: "Scope draft" } });
		fireEvent.click(screen.getByRole("button", { name: "个人历史" }));
		expect(screen.getByRole("region", { name: "最近对话" })).toBeTruthy();
		expect(onViewChange).not.toHaveBeenCalled();
		fireEvent.click(
			screen.getByRole("button", { name: "此 Agent 的全部历史" }),
		);
		expect(onViewChange).toHaveBeenLastCalledWith("history");
		rerenderScope({ view: "history" });
		await screen.findByRole("heading", { name: "个人历史", level: 2 });
		fireEvent.click(screen.getByRole("button", { name: "最近对话" }));
		expect(onViewChange).toHaveBeenLastCalledWith("conversation");
		rerenderScope({ view: "conversation" });
		expect(screen.getByRole("region", { name: "最近对话" })).toBeTruthy();
		expect(await composer()).toBe(input);
		expect(input.value).toBe("Scope draft");
		await waitFor(() => expect(streams).toHaveLength(1));
		expect(requests.every((request) => request.method === "GET")).toBe(true);
	});

	it.each([
		[401, "最近对话无法读取，请重新登录。"],
		[403, "当前无权读取最近对话。"],
		[404, "最近对话读取入口不可用。"],
		[503, "最近对话暂时无法读取。"],
	])(
		"keeps recent read failure %s distinct from an empty list and conversation denial",
		async (status, message) => {
			const onAccessDenied = vi.fn();
			const { requests } = setup(
				(request) =>
					new URL(request.url).pathname === "/api/v2/me/conversations/recent"
						? Response.json(
								{ message: "Controlled failure" },
								{ status: Number(status) },
							)
						: undefined,
				{ onAccessDenied },
			);
			await screen.findByText(String(message));
			await composer();
			expect(screen.queryByText("暂无个人对话。")).toBeNull();
			expect(screen.queryByText(/当前登录或访问权限已失效/)).toBeNull();
			expect(onAccessDenied).not.toHaveBeenCalled();
			expect(requests.every((request) => request.method === "GET")).toBe(true);
		},
	);

	it("shows projection-backed source and separate management/service status in the header", async () => {
		setup();
		const header = (
			await screen.findByRole("heading", { name: agent.name })
		).closest("header");
		if (!header) throw new Error("Expected conversation header");
		expect(within(header).getByText("标准模板 · codex")).toBeTruthy();
		expect(within(header).getByText("管理：可用")).toBeTruthy();
		expect(within(header).getByText("服务：就绪")).toBeTruthy();
	});

	it("keeps unknown service availability out of the header status", async () => {
		setup((request) =>
			new URL(request.url).pathname === "/api/v2/agents/agent-1"
				? Response.json({ ...agent, serviceAvailability: null })
				: undefined,
		);
		const header = await screen
			.findByRole("heading", { name: agent.name })
			.then((heading) => heading.closest("header"));
		if (!header) throw new Error("Expected conversation header");
		expect(within(header).getByText("管理：可用")).toBeTruthy();
		expect(within(header).queryByText(/服务：/)).toBeNull();
	});

	it("discards a late recent response when the login identity changes", async () => {
		const old = deferred<Response>();
		let changed = false;
		const { rerenderScope } = setup((request) => {
			if (new URL(request.url).pathname !== "/api/v2/me/conversations/recent")
				return undefined;
			return changed
				? Response.json({
						items: [
							{ ...history().conversation, title: "New identity recent" },
						],
						nextCursor: null,
					})
				: old.promise;
		});
		await screen.findByText("正在读取最近对话…");
		changed = true;
		rerenderScope({ identityKey: "session-b" });
		await screen.findByRole("link", { name: /New identity recent/ });
		await act(async () => {
			old.resolve(
				Response.json({
					items: [
						{ ...history().conversation, title: "Old identity private recent" },
					],
					nextCursor: null,
				}),
			);
		});
		expect(screen.queryByText("Old identity private recent")).toBeNull();
	});

	it("restores the history deep link and reports view navigation without replacing the conversation", async () => {
		const onViewChange = vi.fn();
		const { rerenderScope, props } = setup(undefined, {
			view: "history",
			onViewChange,
		});
		await screen.findByRole("heading", { name: "个人历史", level: 2 });
		fireEvent.click(screen.getByRole("button", { name: "返回对话" }));
		expect(onViewChange).toHaveBeenCalledWith("conversation");
		expect(props.onConversationChange).not.toHaveBeenCalled();
		rerenderScope({ view: "conversation" });
		await composer();
		fireEvent.click(
			screen.getByRole("button", { name: "此 Agent 的全部历史" }),
		);
		expect(onViewChange).toHaveBeenLastCalledWith("history");
	});

	it("creates a durable conversation and refreshes recent history before navigating", async () => {
		let created = false;
		const { props, requests } = setup(
			(request) => {
				if (request.method === "POST") {
					created = true;
					return Response.json(history().conversation, { status: 201 });
				}
				if (new URL(request.url).pathname === "/api/v2/me/conversations/recent")
					return Response.json({
						items: created ? [history().conversation] : [],
						nextCursor: null,
					});
			},
			{ conversationId: undefined },
		);
		await screen.findByText("暂无个人对话。");
		fireEvent.click(await screen.findByRole("button", { name: "创建会话" }));
		await waitFor(() =>
			expect(props.onConversationChange).toHaveBeenCalledWith("conversation-1"),
		);
		expect(
			requests.filter((request) => request.method === "POST"),
		).toHaveLength(1);
		expect(
			await screen.findByRole("link", { name: /Test conversation/ }),
		).toBeTruthy();
	});

	it.each([
		["starting", "启动中"],
		["updating", "更新中"],
		["unavailable", "当前不可用"],
		[null, "当前不可用"],
	] as const)(
		"keeps service %s distinct from management availability",
		async (serviceAvailability, label) => {
			setup((request) =>
				new URL(request.url).pathname === "/api/v2/agents/agent-1"
					? Response.json({ ...agent, serviceAvailability })
					: undefined,
			);
			await screen.findByRole("heading", { name: agent.name });
			const header = screen
				.getByRole("heading", { name: agent.name })
				.closest("header");
			if (!header) throw new Error("Expected conversation header");
			expect(screen.getByText(new RegExp(`Agent ${label}`))).toBeTruthy();
			expect(screen.queryByText("服务状态：就绪")).toBeNull();
			expect(
				within(header)
					.getByRole("link", { name: "切换 Agent" })
					.getAttribute("href"),
			).toBe("/agents?mode=conversation");
			expect((await composer()).disabled).toBe(true);
		},
	);

	it("keeps self-managed header navigation without platform composer or creation", async () => {
		const custom = AgentProjectionV2Schema.parse({
			...agent,
			source: {
				kind: "custom",
				imageReference: "registry.example/agents/pilot@sha256:abc",
				interactionMode: "self-managed",
				identityResponsibility: "self-managed",
			},
		});
		const { requests } = setup((request) =>
			new URL(request.url).pathname === "/api/v2/agents/agent-1"
				? Response.json(custom)
				: undefined,
		);
		await screen.findByText("此 Agent 使用自有交互入口，请从 Agent 详情进入。");
		expect(
			screen.queryByText("个人 Web 对话 · 离开页面不会取消已提交的任务"),
		).toBeNull();
		expect(
			screen.getByRole("link", { name: "切换 Agent" }).getAttribute("href"),
		).toBe("/agents?mode=conversation");
		expect(screen.queryByRole("textbox", { name: "消息" })).toBeNull();
		expect(
			(screen.getByRole("button", { name: "新建会话" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
		expect(requests.every((request) => request.method === "GET")).toBe(true);
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
		let agentName = "正式投影工程助手";
		const first = {
			...event(1),
			schemaVersion: 1 as const,
			type: "text.delta" as const,
			payload: { text: "Old answer" },
		};
		const { streams, requests } = setup((request) => {
			const path = new URL(request.url).pathname;
			if (path === "/api/v2/agents/agent-1")
				return Response.json(
					AgentProjectionV2Schema.parse({ ...agent, name: agentName }),
				);
			return path === "/api/v2/conversations/conversation-1"
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
				: undefined;
		});
		await screen.findByText("New answer");
		const answer = await screen.findByRole("article", {
			name: `${agentName}的消息`,
		});
		expect(within(answer).getByText(agentName)).toBeTruthy();
		expect(
			within(screen.getByRole("article", { name: "你的消息" })).getByText(
				"Private question",
			),
		).toBeTruthy();
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
		agentName = "更新后的正式投影助手";
		fireEvent.click(screen.getByRole("button", { name: "刷新会话" }));
		await screen.findByRole("article", { name: `${agentName}的消息` });
		expect(
			screen.queryByRole("article", { name: "正式投影工程助手的消息" }),
		).toBeNull();
		expect(screen.getByText("Old answer")).toBeTruthy();
		expect(
			requests.filter((request) => request.method === "POST"),
		).toHaveLength(0);
		fireEvent.click(screen.getByRole("button", { name: "执行详情" }));
		await waitFor(() =>
			expect(
				requests.some((request) =>
					request.url.endsWith("/executions/execution-1"),
				),
			).toBe(true),
		);
	});

	it("renders executions that only have lifecycle events", async () => {
		const status = {
			...event(1),
			schemaVersion: 1 as const,
			type: "execution.status" as const,
			payload: { status: "failed" as const },
		};
		setup((request) =>
			new URL(request.url).pathname === "/api/v2/conversations/conversation-1"
				? Response.json({
						...history("conversation-1", [status]),
						conversation: {
							...history().conversation,
							status: "active",
						},
						messages: [userMessage()],
					})
				: undefined,
		);
		await screen.findByText("执行失败");
		const live = screen.getByRole("article", { name: `${agent.name}的消息` });
		expect(within(live).getByText(agent.name)).toBeTruthy();
		expect(within(live).getByText("执行失败")).toBeTruthy();
		expect(screen.getByRole("article", { name: "你的消息" })).toBeTruthy();
		expect(screen.getAllByRole("button", { name: "执行详情" })).toHaveLength(2);
	});
});
