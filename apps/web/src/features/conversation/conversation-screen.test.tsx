import {
	AgentProjectionV2Schema,
	CommandAcceptedProjectionV1Schema,
	ConversationDetailProjectionV2Schema,
	ConversationSseMessageV2Schema,
	PersistedConversationEventV2Schema,
	PilotProtocolErrorV1Schema,
	ReasoningDeltaEventV2Schema,
} from "@agent-infra/contracts/pilot";
import { BrowserCapabilityProjectionV1Schema } from "@agent-infra/contracts/runtime";
import { pilotFakeScenariosV2 } from "@agent-infra/test-support/pilot";
import {
	focusManager,
	QueryClient,
	QueryClientProvider,
} from "@tanstack/react-query";
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
import { ToastProvider } from "../../components/ui/toast.js";
import { client as v1 } from "../../pilot/generated/client.gen.js";
import { client as v2 } from "../../pilot/generated-v2/client.gen.js";
import { operationEvent } from "./browser-test-fixtures.js";
import {
	ConversationScreen,
	type ConversationScreenProps,
} from "./conversation-screen.js";
import {
	deferred,
	event,
	execution,
	history,
	reload,
	sse,
	timestamp,
} from "./conversation-test-fixtures.js";

const agent = AgentProjectionV2Schema.parse({
	...pilotFakeScenariosV2.starting.response.body,
	agentId: "agent-1",
	managementStatus: "available",
	serviceAvailability: "ready",
	capabilities: {
		...pilotFakeScenariosV2.starting.response.body.capabilities,
		nativeMetadata: true,
	},
});
/** 当前登录用户：用户消息卡显示真实姓名（CH-08）。不是 Agent Owner。 */
const currentUser = {
	schemaVersion: 1 as const,
	user: {
		displayName: "陈昊",
		roles: ["employee" as const],
		userId: "user-chat",
	},
};
const originalV1 = v1.getConfig();
const originalV2 = v2.getConfig();
const queries: QueryClient[] = [];
function setup(
	handler?: (
		request: Request,
	) => Response | Promise<Response | undefined> | undefined,
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
		if (path.endsWith("/native-metadata"))
			return Response.json({
				selector: new URL(request.url).searchParams.get("selector"),
				revision: "c".repeat(64),
				capabilities: [],
			});
		if (path === "/api/v2/agents/agent-1/file-limits")
			return Response.json({
				schemaVersion: 1,
				declaration: {
					schemaVersion: 1,
					scope: "agent",
					revision: 1,
					expiresAt: "2027-01-01T00:00:00Z",
					mediaTypes: ["text/plain", "application/pdf"],
					maxBytes: 10 * 1024 * 1024,
					updatedAt: "2026-01-01T00:00:00Z",
					updatedBy: "user-chat",
				},
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
		session: currentUser,
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
				<ToastProvider>
					<ConversationScreen {...value} />
				</ToastProvider>
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
/**
 * 处理中的回复卡：meta 右侧 spinner + 阶段（role=status），属于 Agent 的消息卡（R4-07）。
 * #3377：阶段取自已持久的事实，刚受理还没有 Runtime 状态时为「准备会话」。
 */
async function pendingReply(label = "准备会话") {
	const status = await screen.findByText(label, {
		selector: '[data-slot="loading-line"]',
	});
	expect(status.getAttribute("role")).toBe("status");
	expect(status.closest("article")?.getAttribute("aria-label")).toBe(
		`${agent.name}的消息`,
	);
	return status;
}
function noPendingReply() {
	expect(document.querySelector('[data-slot="loading-line"]')).toBeNull();
	// 受理提示只在回复卡内出现一次，卡外不再有单独的受理行（R4-07、AC-6）。
	expect(screen.queryByText(/消息已受理，等待处理/)).toBeNull();
}
/** 读取「模型回退」弹窗里某一项事实（dt 后紧跟的 dd）的文字（G-07）。 */
function fact(dialog: HTMLElement, label: string) {
	const term = within(dialog).getByText(label, { selector: "dt" });
	const value = term.nextElementSibling;
	expect(value?.tagName).toBe("DD");
	return value?.textContent;
}
/** 打开「会话文件」折叠条：添加附件入口按设计在条内（CH-03）。 */
function openFiles() {
	const trigger = screen.getByRole("button", { name: /^会话文件/ });
	if (trigger.getAttribute("aria-expanded") !== "true")
		fireEvent.click(trigger);
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

function namedFileProjection(fileId: string, name: string) {
	const projection = fileProjection();
	return {
		...projection,
		fileId,
		descriptor: { ...projection.descriptor, name },
	};
}

const completedExecution = {
	...event(2),
	schemaVersion: 1 as const,
	type: "execution.status" as const,
	payload: { status: "completed" as const },
};
/** 已有终态 Execution 的就绪会话：命令与 Skill 目录可按该 Execution 读取。 */
function idleHistory() {
	return {
		...history("conversation-1", [event(1), completedExecution]),
		conversation: { ...history().conversation, status: "ready" },
	};
}
function nativeCatalog(url: URL) {
	if (url.searchParams.get("selector") === "commands")
		return Response.json({
			selector: "commands",
			revision: "c".repeat(64),
			capabilities: [
				{
					id: "f".repeat(64),
					kind: "command",
					name: "list-files",
					description: "List approved workspace files",
					source: { name: "codex", version: "1.0.0" },
					parameters: [],
					effect: "read_only",
					availability: "available",
				},
			],
		});
	return Response.json({
		selector: "skills",
		revision: "d".repeat(64),
		capabilities: [
			{
				id: "e".repeat(64),
				kind: "skill",
				name: "workspace-summary",
				description: "Summarize approved workspace files",
				source: { name: "skillhub", version: "1.0.0" },
				availability: "discovered",
			},
		],
	});
}

describe("functional conversation screen", () => {
	it("searches native commands and Skills inside the composer and invokes a confirmed Skill", async () => {
		let invoked: unknown;
		// 服务端快照随 SSE 一起包含该 Execution 的状态事件，重读后阶段不回退。
		const nativeEvents: ReturnType<typeof event>[] = [];
		const { requests, streams } = setup((request) => {
			const url = new URL(request.url);
			if (url.pathname.endsWith("/native-capability/invoke")) {
				invoked = true;
				return Response.json(
					{
						outcome: "accepted",
						result: {
							schemaVersion: 1,
							status: "submitted",
							executionId: "execution-native",
							capabilityId: "e".repeat(64),
							capabilityKind: "skill",
							conversationId: "conversation-1",
							directoryRevision: "d".repeat(64),
						},
					},
					{ status: 202 },
				);
			}
			if (url.pathname.endsWith("/native-metadata")) return nativeCatalog(url);
			if (url.pathname === "/api/v2/conversations/conversation-1") {
				const idle = idleHistory();
				return Response.json({
					...idle,
					events: [...idle.events, ...nativeEvents],
				});
			}
		});
		function nativeStatus(
			sequence: number,
			status: "processing" | "completed",
		) {
			const next = PersistedConversationEventV2Schema.parse({
				...event(sequence),
				executionId: "execution-native",
				type: "execution.status",
				payload: { status },
			});
			nativeEvents.push(next);
			act(() => streams.at(-1)?.send(next));
		}
		function receiptStatus() {
			const receipt = screen
				.getByText("Skill · workspace-summary · v1.0.0")
				.closest(".capability-receipt");
			if (!(receipt instanceof HTMLElement)) throw new Error("Missing receipt");
			return within(receipt).getByRole("status").textContent;
		}
		const input = await composer();
		expect(input.getAttribute("role")).toBeNull();
		expect(input.placeholder).toBe("输入消息，或 / 搜索命令与 Skill…");
		fireEvent.change(input, { target: { value: "/" } });
		const listbox = await screen.findByRole("listbox", {
			name: "命令与 Skill 搜索结果",
		});
		// 唯一输入框：没有独立搜索框与旧能力卡片。
		expect(
			screen.queryByRole("textbox", { name: "搜索命令或 Skill" }),
		).toBeNull();
		expect(screen.queryByRole("region", { name: "对话能力" })).toBeNull();
		expect(input.getAttribute("role")).toBe("combobox");
		expect(input.getAttribute("aria-expanded")).toBe("true");
		expect(input.getAttribute("aria-controls")).toBe(listbox.id);
		const options = within(listbox).getAllByRole("option");
		expect(options).toHaveLength(2);
		expect(input.getAttribute("aria-activedescendant")).toBe(options[0].id);
		expect(options[0].getAttribute("aria-selected")).toBe("true");
		expect(within(listbox).getByText("只读命令")).toBeTruthy();
		expect(within(listbox).getByText("Skill")).toBeTruthy();
		expect(within(listbox).queryByText("command")).toBeNull();
		expect(within(listbox).queryByText("skill")).toBeNull();
		expect(screen.getByText("命令 / Skill · 输入 / 搜索")).toBeTruthy();
		expect(screen.getByRole("button", { name: "关闭命令选择" })).toBeTruthy();
		expect(
			new Set(
				requests
					.filter((request) =>
						new URL(request.url).pathname.endsWith("/native-metadata"),
					)
					.map((request) => new URL(request.url).searchParams.get("selector")),
			),
		).toEqual(new Set(["commands", "skills"]));
		// ↑↓ 在首尾停住，不循环。
		fireEvent.keyDown(input, { key: "ArrowUp" });
		expect(options[0].getAttribute("aria-selected")).toBe("true");
		fireEvent.keyDown(input, { key: "ArrowDown" });
		fireEvent.keyDown(input, { key: "ArrowDown" });
		expect(
			within(listbox).getAllByRole("option")[1].getAttribute("aria-selected"),
		).toBe("true");
		// CH-02：Home / End 跳到第一项 / 最后一项，并阻止输入框移动光标；带 Shift 时交还输入框。
		expect(fireEvent.keyDown(input, { key: "Home" })).toBe(false);
		expect(options[0].getAttribute("aria-selected")).toBe("true");
		expect(input.getAttribute("aria-activedescendant")).toBe(options[0].id);
		expect(fireEvent.keyDown(input, { key: "End" })).toBe(false);
		expect(options[1].getAttribute("aria-selected")).toBe("true");
		expect(input.getAttribute("aria-activedescendant")).toBe(options[1].id);
		expect(fireEvent.keyDown(input, { key: "Home", shiftKey: true })).toBe(
			true,
		);
		expect(options[1].getAttribute("aria-selected")).toBe("true");
		expect(input.value).toBe("/");
		// 输入法组合中的 Enter 不选择、不发送。
		fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
		expect(screen.getByRole("listbox")).toBeTruthy();
		fireEvent.keyDown(input, { key: "Escape" });
		expect(screen.queryByRole("listbox")).toBeNull();
		expect(input.getAttribute("role")).toBeNull();
		expect(document.activeElement === input || input.value === "/").toBe(true);
		fireEvent.change(input, { target: { value: "/summary" } });
		await screen.findByRole("listbox");
		expect(screen.getAllByRole("option")).toHaveLength(1);
		fireEvent.keyDown(input, { key: "Tab" });
		expect(screen.queryByRole("listbox")).toBeNull();
		expect(input.value).toBe("");
		expect(screen.getByText("Skill · workspace-summary")).toBeTruthy();
		expect(screen.getByText("skillhub · v1.0.0 · 等待发送确认")).toBeTruthy();
		expect(input.placeholder).toBe("补充这次任务的目标与范围…");
		const confirm = screen.getByRole("button", { name: "确认发送" });
		fireEvent.click(confirm);
		expect((await screen.findByRole("alert")).textContent).toBe(
			"请在输入框补充这次任务的目标与范围。",
		);
		expect(invoked).toBeUndefined();
		expect(document.activeElement).toBe(input);
		fireEvent.change(input, { target: { value: "梳理当前工作区" } });
		fireEvent.click(confirm);
		await screen.findByText("已受理，尚未开始");
		const invoke = requests.find((request) =>
			request.url.endsWith("/native-capability/invoke"),
		);
		expect(await invoke?.json()).toEqual({
			capabilityId: "e".repeat(64),
			directoryRevision: "d".repeat(64),
			parameters: "梳理当前工作区",
		});
		expect(screen.getByText("Skill · workspace-summary · v1.0.0")).toBeTruthy();
		expect(screen.queryByText("能力请求已受理。")).toBeNull();
		await waitFor(() => expect(input.value).toBe(""));
		// 受理、执行中期间发送与入口都不可用，草稿保留。
		fireEvent.change(input, { target: { value: "下一条" } });
		expect(
			(screen.getByRole("button", { name: "发送" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
		expect(
			(
				screen.getByRole("button", {
					name: "选择命令或 Skill",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
		expect(receiptStatus()).toBe("已受理，尚未开始");
		// 调用进行中：回执之后有「停止回复」（设计 .skill-actions），不另画处理中的回复卡（R4-07）。
		const capabilityStop = screen.getByRole("button", { name: "停止回复" });
		expect(capabilityStop.closest(".skill-actions")).toBeTruthy();
		expect(capabilityStop.closest("form")).toBeNull();
		expect(document.querySelector('[data-slot="loading-line"]')).toBeNull();
		await waitFor(() => expect(streams.length).toBeGreaterThan(1));
		nativeStatus(5, "processing");
		await waitFor(() => expect(receiptStatus()).toBe("正在执行"));
		nativeStatus(6, "completed");
		await waitFor(() => expect(receiptStatus()).toBe("已完成"));
		await waitFor(() =>
			expect(
				(screen.getByRole("button", { name: "发送" }) as HTMLButtonElement)
					.disabled,
			).toBe(false),
		);
		expect(input.value).toBe("下一条");
		expect(
			requests.filter((request) =>
				request.url.endsWith("/native-capability/invoke"),
			),
		).toHaveLength(1);
	});

	it("invokes a Skill with ordered text control files over Invocation V2", async () => {
		const originalCrypto = globalThis.crypto;
		let ids = 0;
		vi.stubGlobal("crypto", {
			...(originalCrypto ?? {}),
			randomUUID: () => `control-local-${++ids}`,
			subtle: { digest: async () => new ArrayBuffer(32) },
		});
		try {
			let created = 0;
			const { requests } = setup((request) => {
				const url = new URL(request.url);
				const path = url.pathname;
				if (path.endsWith("/native-capability/invoke"))
					return Response.json(
						{
							outcome: "accepted",
							result: {
								schemaVersion: 1,
								status: "submitted",
								executionId: "execution-native",
								capabilityId: "e".repeat(64),
								capabilityKind: "skill",
								conversationId: "conversation-1",
								directoryRevision: "d".repeat(64),
							},
						},
						{ status: 202 },
					);
				if (path.endsWith("/native-metadata")) return nativeCatalog(url);
				if (path === "/api/v2/conversations/conversation-1")
					return Response.json(idleHistory());
				if (request.method === "POST" && path.endsWith("/files")) {
					created += 1;
					return Response.json(
						namedFileProjection(`file-${created}`, `control-${created}.txt`),
						{ status: 201 },
					);
				}
				if (request.method === "POST" && path.endsWith("/access")) {
					const fileId = path.split("/").at(-2) ?? "";
					return Response.json({
						schemaVersion: 1,
						accessId: `access-${fileId}`,
						file: namedFileProjection(fileId, "control.txt"),
						path: `/api/v1/conversations/conversation-1/files/${fileId}/content`,
						grant: {
							format: "compact-jws",
							schemaVersion: 1,
							token: "grant",
						},
						expiresAt: "2027-01-01T00:00:00Z",
					});
				}
				if (request.method === "PUT" && path.endsWith("/content"))
					return new Response(null, { status: 204 });
				if (request.method === "POST" && path.endsWith("/complete")) {
					const fileId = path.split("/").at(-2) ?? "";
					return Response.json(namedFileProjection(fileId, "control.txt"));
				}
				return undefined;
			});
			const input = await composer();
			fireEvent.change(input, { target: { value: "/summary" } });
			await screen.findByRole("option", { name: /workspace-summary/ });
			fireEvent.keyDown(input, { key: "Enter" });
			const picker = await screen.findByLabelText("添加 Skill 控制文件");
			expect(
				screen.getByText(
					"仅支持 text/plain 文本文件，最多 4 个，单个文件不超过 4096 字节。",
				),
			).toBeTruthy();
			await waitFor(() =>
				expect((picker as HTMLInputElement).disabled).toBe(false),
			);
			fireEvent.change(picker, {
				target: {
					files: [
						new File(["a"], "a.txt", { type: "text/plain" }),
						new File(["b"], "b.txt", { type: "text/plain" }),
					],
				},
			});
			await waitFor(() =>
				expect(screen.getAllByText("已上传")).toHaveLength(2),
			);
			fireEvent.change(input, { target: { value: "总结这些控制文件" } });
			fireEvent.click(screen.getByRole("button", { name: "确认发送" }));
			await screen.findByText("已受理，尚未开始");
			const invoke = requests.find((request) =>
				request.url.endsWith("/native-capability/invoke"),
			);
			const body = await invoke?.json();
			expect(body).toMatchObject({
				capabilityId: "e".repeat(64),
				directoryRevision: "d".repeat(64),
				parameters: "总结这些控制文件",
				schemaVersion: 2,
				attachments: ["file-1", "file-2"],
			});
			expect(body.idempotencyKey).toBe(invoke?.headers.get("Idempotency-Key"));
			expect(body.requestId).toEqual(expect.any(String));
			expect(body.traceId).toEqual(expect.any(String));
			// 调用受理后选择与上传列表清空，回执仍回显本次提交的控制文件。
			expect(screen.getByText("控制文件：a.txt、b.txt")).toBeTruthy();
		} finally {
			vi.stubGlobal("crypto", originalCrypto);
		}
	});

	it("rejects Skill control files outside the limits before uploading", async () => {
		const { requests } = setup((request) => {
			const url = new URL(request.url);
			if (url.pathname.endsWith("/native-metadata")) return nativeCatalog(url);
			if (url.pathname === "/api/v2/conversations/conversation-1")
				return Response.json(idleHistory());
			return undefined;
		});
		const input = await composer();
		fireEvent.change(input, { target: { value: "/summary" } });
		await screen.findByRole("option", { name: /workspace-summary/ });
		fireEvent.keyDown(input, { key: "Enter" });
		const picker = await screen.findByLabelText("添加 Skill 控制文件");
		await waitFor(() =>
			expect((picker as HTMLInputElement).disabled).toBe(false),
		);
		fireEvent.change(picker, {
			target: {
				files: [new File(["x"], "notes.pdf", { type: "application/pdf" })],
			},
		});
		expect((await screen.findByRole("alert")).textContent).toBe(
			"仅支持 text/plain 文本文件。",
		);
		fireEvent.change(picker, {
			target: {
				files: [
					new File(["x".repeat(4097)], "big.txt", { type: "text/plain" }),
				],
			},
		});
		await waitFor(() =>
			expect(screen.getByRole("alert").textContent).toBe(
				"单个控制文件不能超过 4096 字节。",
			),
		);
		fireEvent.change(picker, {
			target: {
				files: Array.from(
					{ length: 5 },
					(_, index) => new File(["x"], `${index}.txt`, { type: "text/plain" }),
				),
			},
		});
		await waitFor(() =>
			expect(screen.getByRole("alert").textContent).toBe(
				"最多只能附加 4 个控制文件。",
			),
		);
		expect(
			requests.filter(
				(request) =>
					request.method === "POST" &&
					new URL(request.url).pathname.endsWith("/files"),
			),
		).toHaveLength(0);
	});

	it("keeps commands on Invocation V1 and never offers control files", async () => {
		const { requests } = setup((request) => {
			const url = new URL(request.url);
			if (url.pathname.endsWith("/native-capability/invoke"))
				return Response.json(
					{
						outcome: "accepted",
						result: {
							schemaVersion: 1,
							status: "submitted",
							executionId: "execution-native",
							capabilityId: "f".repeat(64),
							capabilityKind: "command",
							conversationId: "conversation-1",
							directoryRevision: "c".repeat(64),
						},
					},
					{ status: 202 },
				);
			if (url.pathname.endsWith("/native-metadata")) return nativeCatalog(url);
			if (url.pathname === "/api/v2/conversations/conversation-1")
				return Response.json(idleHistory());
			return undefined;
		});
		const input = await composer();
		fireEvent.change(input, { target: { value: "/list" } });
		await screen.findByRole("listbox");
		fireEvent.keyDown(input, { key: "Enter" });
		expect(screen.getByText("原生命令 · list-files")).toBeTruthy();
		expect(screen.queryByText("Skill 控制文件")).toBeNull();
		expect(screen.queryByLabelText("添加 Skill 控制文件")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "确认发送" }));
		await screen.findByText("已受理，尚未开始");
		const invoke = requests.find((request) =>
			request.url.endsWith("/native-capability/invoke"),
		);
		expect(await invoke?.json()).toEqual({
			capabilityId: "f".repeat(64),
			directoryRevision: "c".repeat(64),
			parameters: "",
		});
	});

	it("keeps an unselected slash draft out of plain messages while the catalog is available", async () => {
		const { requests } = setup((request) => {
			const url = new URL(request.url);
			if (url.pathname.endsWith("/native-metadata")) return nativeCatalog(url);
			if (url.pathname === "/api/v2/conversations/conversation-1")
				return Response.json(idleHistory());
		});
		const input = await composer();
		fireEvent.change(input, { target: { value: "/xyz" } });
		await screen.findByText("没有匹配项，换一个关键词试试。");
		// 没有可选项时 Enter 不被弹层拦截，但目录可用时也不作为普通消息发出。
		fireEvent.keyDown(input, { key: "Enter" });
		expect((await screen.findByRole("alert")).textContent).toBe(
			"请先选择目录中的命令或 Skill。",
		);
		expect(requests.filter((request) => request.method === "POST")).toEqual([]);
	});

	it.each([
		["busy", undefined],
		["stale", undefined],
		["disabled", undefined],
		["invalid_parameters", undefined],
		["unsupported", undefined],
		["unavailable", "metadata_unavailable"],
		["conflict", "idempotency_conflict"],
		["denied", "authorization_lost"],
	] as const)(
		"explains a %s capability rejection once without downgrading it to a message",
		async (outcome, reason) => {
			const { requests } = setup((request) => {
				const url = new URL(request.url);
				if (url.pathname.endsWith("/native-capability/invoke"))
					return Response.json(
						{ outcome, ...(reason ? { reason } : {}) },
						{ status: outcome === "unavailable" ? 503 : 409 },
					);
				if (url.pathname.endsWith("/native-metadata"))
					return nativeCatalog(url);
				if (url.pathname === "/api/v2/conversations/conversation-1")
					return Response.json(idleHistory());
			});
			const input = await composer();
			fireEvent.change(input, { target: { value: "/list" } });
			await screen.findByRole("listbox");
			fireEvent.keyDown(input, { key: "Enter" });
			expect(screen.getByText("原生命令 · list-files")).toBeTruthy();
			expect(input.placeholder).toBe("这项只读命令不需要额外参数");
			fireEvent.click(screen.getByRole("button", { name: "确认发送" }));
			const alert = await screen.findByRole("alert");
			expect(alert.textContent).toContain("没有降级为普通消息");
			expect(alert.closest("form")).toBeTruthy();
			expect(screen.getAllByRole("alert")).toHaveLength(1);
			expect(document.body.textContent).not.toContain(outcome);
			expect(screen.getByText("原生命令 · list-files")).toBeTruthy();
			const invoke = requests.find((request) =>
				request.url.endsWith("/native-capability/invoke"),
			);
			expect(await invoke?.json()).toMatchObject({ parameters: "" });
			expect(
				requests.filter(
					(request) =>
						request.method === "POST" &&
						new URL(request.url).pathname.endsWith("/messages"),
				),
			).toHaveLength(0);
		},
	);

	it.each([
		["not integrated", false, 200, "当前模板尚未接入命令与 Skill。"],
		["unreadable", true, 503, "目录读取失败"],
	] as const)(
		"sends a slash message normally when the catalog is %s",
		async (_label, nativeMetadata, status, notice) => {
			const { requests } = setup((request) => {
				const url = new URL(request.url);
				if (url.pathname === "/api/v2/agents/agent-1")
					return Response.json({
						...agent,
						capabilities: { ...agent.capabilities, nativeMetadata },
					});
				if (url.pathname.endsWith("/native-metadata"))
					return status === 200
						? nativeCatalog(url)
						: new Response(null, { status });
				if (url.pathname === "/api/v2/conversations/conversation-1")
					return Response.json(idleHistory());
				if (request.method === "POST") return receipt();
			});
			const input = await composer();
			fireEvent.click(screen.getByRole("button", { name: "选择命令或 Skill" }));
			expect(input.value).toBe("/");
			await screen.findByText(notice);
			expect(screen.queryAllByRole("option")).toHaveLength(0);
			expect(input.getAttribute("aria-controls")).toBe(
				screen.getByRole("listbox").id,
			);
			if (!nativeMetadata) {
				expect(
					requests.some((request) =>
						new URL(request.url).pathname.endsWith("/native-metadata"),
					),
				).toBe(false);
				fireEvent.keyDown(input, { key: "Escape" });
				expect(input.value).toBe("");
			} else {
				// #3269 N8-3-02：键盘焦点在「重试」上触发，重读时按钮卸载，焦点先回到输入框。
				const retry = screen.getByRole("button", { name: "重试" });
				retry.focus();
				fireEvent.click(retry);
				expect(document.activeElement).toBe(input);
				await waitFor(() =>
					expect(
						requests.filter((request) =>
							new URL(request.url).pathname.endsWith("/native-metadata"),
						).length,
					).toBeGreaterThan(2),
				);
			}
			fireEvent.change(input, {
				target: { value: "/etc/hosts 这个文件是做什么的？" },
			});
			expect(
				screen.queryByText("请选择一个命令或 Skill 后再发送。"),
			).toBeNull();
			fireEvent.click(screen.getByRole("button", { name: "发送" }));
			await waitFor(() =>
				expect(
					requests.filter((request) => request.method === "POST"),
				).toHaveLength(1),
			);
			const posts = requests.filter((request) => request.method === "POST");
			expect(new URL(posts[0].url).pathname).toBe(
				"/api/v1/conversations/conversation-1/messages",
			);
			expect(await posts[0].json()).toEqual({
				schemaVersion: 1,
				text: "/etc/hosts 这个文件是做什么的？",
			});
		},
	);

	it("explains that commands need a first message when the conversation has no execution", async () => {
		const { requests } = setup((request) =>
			new URL(request.url).pathname === "/api/v2/conversations/conversation-1"
				? Response.json({
						...history("conversation-1", []),
						conversation: { ...history().conversation, status: "ready" },
					})
				: undefined,
		);
		const input = await composer();
		fireEvent.change(input, { target: { value: "/" } });
		await screen.findByText("发送第一条消息后可使用命令与 Skill。");
		expect(
			requests.some((request) =>
				new URL(request.url).pathname.endsWith("/native-metadata"),
			),
		).toBe(false);
	});

	it("shows a partial-unavailable notice inside the command menu when one native selector fails", async () => {
		setup((request) => {
			const url = new URL(request.url);
			if (url.pathname.endsWith("/native-metadata")) {
				if (url.searchParams.get("selector") === "commands")
					return nativeCatalog(url);
				return new Response(null, { status: 503 });
			}
			if (url.pathname === "/api/v2/conversations/conversation-1")
				return Response.json(idleHistory());
		});
		const input = await composer();
		fireEvent.change(input, { target: { value: "/" } });
		await screen.findByText(
			"部分命令或 Skill 目录暂不可用，已隐藏对应旧数据。",
		);
		expect(screen.getAllByRole("option")).toHaveLength(1);
	});

	it("rejects unsupported and oversized files before creating an upload", async () => {
		const { requests } = setup();
		const input = await screen.findByLabelText("选择附件文件");
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
			new URL(request.url).pathname === "/api/v2/agents/agent-1/file-limits"
				? Response.json({ items: [], nextCursor: null })
				: undefined,
		);
		await screen.findByText("文件限制暂不可用，上传入口已关闭。");
		// 收起状态的「会话文件」摘要直接反映失败，不显示「0 个待重试」（CH-03、AC-2）。
		const summary = screen.getByRole("button", { name: /^会话文件/ });
		expect(summary.getAttribute("aria-expanded")).toBe("false");
		expect(summary.textContent).toContain("上传暂不可用");
		expect(summary.textContent).not.toContain("0 个待重试");
		openFiles();
		// #3267 N8-1-06：不能上传时只留一行说明，不渲染禁用的入口（与 #3259 同一规则）。
		expect(screen.queryByRole("button", { name: "添加附件" })).toBeNull();
	});

	it("reads the read-only file limits before the attachment entry opens", async () => {
		const { requests } = setup();
		await screen.findByText(/支持 text\/plain/);
		openFiles();
		expect(
			(screen.getByRole("button", { name: "添加附件" }) as HTMLButtonElement)
				.disabled,
		).toBe(false);
		const limits = requests.filter((request) =>
			new URL(request.url).pathname.endsWith("/file-limits"),
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
			await composer();
			openFiles();
			fireEvent.change(await screen.findByLabelText("选择附件文件"), {
				target: {
					files: [new File(["hello"], "notes.txt", { type: "text/plain" })],
				},
			});
			await screen.findByText("已上传");
			expect(
				screen.getByRole("button", { name: /^会话文件/ }).textContent,
			).toContain("1 个文件 · 0 个待重试");
			fireEvent.change(await composer(), {
				target: { value: "Summarize this" },
			});
			fireEvent.click(screen.getByRole("button", { name: "发送" }));
			await pendingReply();
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
			fireEvent.click(
				await screen.findByRole("button", { name: "预览：report.txt" }),
			);
			await waitFor(() => expect(screen.getByText("hello")).toBeTruthy());
			fireEvent.click(screen.getByRole("button", { name: "关闭" }));
			fireEvent.click(
				await screen.findByRole("button", { name: "下载：report.txt" }),
			);
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
			await pendingReply();
			await screen.findByRole("link", { name: /Pending task/ });
			completed = true;
			if (source === "stream") act(() => streams.at(-1)?.send(completedEvent));
			// 页面不再提供「刷新会话」：快照由服务端要求的重读（timeline.reload）带回。
			else act(() => streams.at(-1)?.send(reload()));
			await screen.findByText("已完成");
			noPendingReply();
			expect(
				await screen.findByRole("link", { name: /Completed task/ }),
			).toBeTruthy();
		},
	);

	it("clears the accepted placeholder, shows the failure, and allows resending when the Platform persists a failed execution over SSE", async () => {
		let accepted = false;
		let failureDelivered = false;
		const failedEvent = {
			...event(1),
			schemaVersion: 1 as const,
			type: "execution.status" as const,
			payload: { status: "failed" as const },
		};
		const slowRefresh = deferred<Response>();
		const { streams, requests } = setup((request) => {
			if (request.method === "POST") {
				accepted = true;
				return receipt();
			}
			if (
				new URL(request.url).pathname !== "/api/v2/conversations/conversation-1"
			)
				return undefined;
			// Hold the post-failure projection re-read open: the three behaviors
			// below must come from the SSE event alone, without a refresh or reload.
			if (failureDelivered) return slowRefresh.promise;
			return Response.json({
				...history("conversation-1", []),
				messages: accepted ? [userMessage()] : [],
			});
		});
		const input = await composer();
		fireEvent.change(input, { target: { value: "Fail this task" } });
		fireEvent.click(screen.getByRole("button", { name: "发送" }));
		await pendingReply();
		// The receipt re-read opens the stream that carries the persisted failure.
		await waitFor(() => expect(streams.length).toBe(2));
		expect(
			(
				screen.getByRole("button", {
					name: "发送补充指令",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
		failureDelivered = true;
		act(() => streams.at(-1)?.send(failedEvent));
		await screen.findByText("执行失败");
		noPendingReply();
		expect(input.disabled).toBe(false);
		fireEvent.change(input, { target: { value: "Try once more" } });
		const send = screen.getByRole("button", {
			name: "发送",
		}) as HTMLButtonElement;
		await waitFor(() => expect(send.disabled).toBe(false));
		fireEvent.click(send);
		await waitFor(() =>
			expect(
				requests.filter((request) => request.method === "POST"),
			).toHaveLength(2),
		);
		await act(async () => {
			slowRefresh.resolve(
				Response.json({
					...history("conversation-1", [failedEvent]),
					messages: [userMessage()],
				}),
			);
		});
	});

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
					? (await screen.findAllByRole("button", { name: /^查看执行详情/ }))[0]
					: await screen.findByRole("button", { name: "核实原执行状态" });
			if (!trigger) throw new Error("Missing execution detail trigger");
			trigger.focus();
			fireEvent.click(trigger);
			// 执行详情是模态弹窗（R4-09 / N-08）：打开时聚焦弹窗本身，背后的对话不再被隐藏。
			const dialog = await screen.findByRole("dialog", { name: "执行详情" });
			expect(dialog.getAttribute("aria-modal")).toBe("true");
			await waitFor(() => expect(document.activeElement).toBe(dialog));
			expect(
				document.querySelector(".chat-thread")?.hasAttribute("hidden"),
			).toBe(false);
			if (entry === "removed-unknown") {
				completed = true;
				act(() => streams.at(-1)?.send(statusEvent()));
				await waitFor(() => expect(trigger.isConnected).toBe(false));
			} else {
				expect(trigger.isConnected).toBe(true);
			}
			expect(
				within(dialog).queryByRole("button", { name: "返回对话" }),
			).toBeNull();
			const close = within(dialog).getByText("关闭", { selector: "button" });
			close.focus();
			fireEvent.click(close);
			await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
			const target =
				entry === "removed-unknown"
					? screen.getByRole("heading", { name: agent.name, level: 1 })
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
		// 有进行中的回复时不提供「重新生成」（CH-08 过渡，AC-5）。
		expect(screen.queryByRole("button", { name: /^重新生成/ })).toBeNull();
		expect(
			(screen.getByRole("button", { name: "发送" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
		const stop = screen.getByRole("button", { name: "停止回复" });
		// 「停止回复」在处理中的回复卡内，composer 工具栏里没有（R4-07）。
		expect(stop.closest("article")?.getAttribute("aria-label")).toBe(
			`${agent.name}的消息`,
		);
		expect(stop.closest("form")).toBeNull();
		fireEvent.click(stop);
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
		fireEvent.click(
			await screen.findByRole("button", { name: /^查看执行详情/ }),
		);
		const details = await screen.findByRole("dialog", { name: "执行详情" });
		await within(details).findByText("处理中");
		completed = true;
		act(() => streams.at(-1)?.send(terminal));
		// 回复卡状态行也有「已完成」，这里只看执行详情。
		await within(details).findByText("已完成");
		expect(screen.queryByText("处理中")).toBeNull();
		expect(screen.queryByText("执行中")).toBeNull();
		expect(
			requests.filter((request) =>
				new URL(request.url).pathname.includes("/executions/"),
			).length,
		).toBeGreaterThan(1);
	});

	it("keeps sending available while a loaded conversation refreshes after a reply ends (#2136)", async () => {
		let completed = false;
		let releaseRefresh: (() => void) | undefined;
		const terminal = {
			...event(2),
			schemaVersion: 1 as const,
			type: "execution.status" as const,
			payload: { status: "completed" as const },
		};
		const projection = () =>
			Response.json({
				...history("conversation-1", completed ? [terminal] : []),
				conversation: {
					...history().conversation,
					status: completed ? "ready" : "active",
				},
				messages: [userMessage()],
			});
		const { streams, requests } = setup((request) => {
			const path = new URL(request.url).pathname;
			if (request.method === "POST") return receipt();
			if (path !== "/api/v2/conversations/conversation-1") return undefined;
			if (!completed) return projection();
			// 终态之后的投影刷新被慢查询拖住，模拟长会话或高负载。
			return new Promise<Response>((resolve) => {
				releaseRefresh = () => resolve(projection());
			});
		});
		const input = await composer();
		completed = true;
		act(() => streams.at(-1)?.send(terminal));
		await waitFor(() => expect(releaseRefresh).toBeDefined());
		fireEvent.change(input, { target: { value: "Next question" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() =>
			expect(
				requests.filter((request) => request.method === "POST"),
			).toHaveLength(1),
		);
		expect(await requests.find((r) => r.method === "POST")?.json()).toEqual({
			schemaVersion: 1,
			text: "Next question",
		});
		act(() => releaseRefresh?.());
		// 受理后清空草稿。
		await waitFor(() => expect(input.value).toBe(""));
	});

	it("keeps sending blocked while the first projection is still loading (#2136)", async () => {
		let release: (() => void) | undefined;
		const { requests } = setup((request) => {
			if (request.method === "POST") return receipt();
			if (
				new URL(request.url).pathname !== "/api/v2/conversations/conversation-1"
			)
				return undefined;
			// 首次读取尚未返回：没有投影时仍不能发送。
			return new Promise<Response>((resolve) => {
				release = () =>
					resolve(
						Response.json({
							...history("conversation-1", []),
							conversation: { ...history().conversation, status: "ready" },
						}),
					);
			});
		});
		await waitFor(() => expect(release).toBeDefined());
		const input = screen.queryByRole("textbox", {
			name: "消息",
		}) as HTMLTextAreaElement | null;
		if (input) {
			fireEvent.change(input, { target: { value: "Too early" } });
			fireEvent.keyDown(input, { key: "Enter" });
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(
			requests.filter((request) => request.method === "POST"),
		).toHaveLength(0);
		act(() => release?.());
		await composer();
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
		// 「正在停止」不可再次操作；按 A2-09 用 aria-disabled 保持可聚焦，焦点不在等待确认时落到 body。
		const stopping = screen.getByRole("button", { name: "正在停止" });
		expect(stopping.getAttribute("aria-disabled")).toBe("true");
		fireEvent.click(stopping);
		await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
		expect(
			requests.filter((request) => request.method === "POST"),
		).toHaveLength(1);
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

	it("re-reads a preparing Session only after the previous read finishes (#1732)", async () => {
		let reads = 0;
		let inFlight = 0;
		let maxInFlight = 0;
		let aborted = 0;
		setup((request) => {
			const path = new URL(request.url).pathname;
			if (path !== "/api/v2/conversations/conversation-1") return undefined;
			return (async () => {
				reads++;
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				let pending = true;
				request.signal.addEventListener(
					"abort",
					() => {
						if (pending) aborted++;
					},
					{ once: true },
				);
				try {
					// A re-read slower than the refresh interval, as on a busy database.
					if (reads > 1)
						await new Promise((resolve) => setTimeout(resolve, 2_500));
					return Response.json({
						...history("conversation-1", []),
						conversation: { ...history().conversation, status: "ready" },
						sessionAvailability: "preparing",
					});
				} finally {
					pending = false;
					inFlight--;
				}
			})();
		});
		const input = await composer();
		await screen.findByText("会话准备中，完成后即可发送。草稿会保留。");
		expect(input.disabled).toBe(false);
		await waitFor(() => expect(reads).toBe(2), { timeout: 3_000 });
		// A fixed interval would start, and abort, another read meanwhile.
		await new Promise((resolve) => setTimeout(resolve, 2_800));
		expect(reads).toBe(2);
		expect(maxInFlight).toBe(1);
		expect(aborted).toBe(0);
		expect(input.disabled).toBe(false);
		expect(screen.queryByText("正在读取会话…")).toBeNull();
	}, 10_000);

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
		await screen.findByText("可以查看历史，草稿仍可编辑；更新完成后才能发送。");
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
				"当前登录或访问权限已失效，请重新登录或返回 Agent 目录。",
			),
		).toBeNull();
	});

	it("surfaces a runtime-unavailable refusal and keeps the draft (#1607)", async () => {
		setup((request) =>
			request.method === "POST"
				? Response.json(
						PilotProtocolErrorV1Schema.parse({
							schemaVersion: 1,
							code: "RUNTIME_UNAVAILABLE",
							message: "The Agent runtime is temporarily unavailable.",
							retryable: true,
							traceId: "trace-runtime-unavailable",
						}),
						{ status: 503 },
					)
				: undefined,
		);
		const input = await composer();
		fireEvent.change(input, { target: { value: "Keep this draft" } });
		fireEvent.click(screen.getByRole("button", { name: "发送" }));
		await screen.findByText("Agent 暂时不可用，请稍后重试或联系 Owner。");
		expect(input.value).toBe("Keep this draft");
		expect(
			screen.queryByText(
				"提交结果尚未确认。原请求可能已受理，请核实原请求，避免重复创建回复。",
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
		expect(screen.queryByText("执行中")).toBeNull();
		expect(screen.queryByRole("button", { name: "停止回复" })).toBeNull();
	});
	function modelScenario(
		respond: (attempt: number) => Response | Promise<Response>,
	) {
		let saved = false;
		let attempts = 0;
		const config = {
			...agent.configuration,
			defaultModelOptionId: "option-a",
			defaultReasoningLevel: "medium",
			modelOptions: [
				{
					optionId: "option-a",
					displayName: "Model A",
					modelId: "model-a",
					reasoningLevels: ["medium"],
				},
				{
					optionId: "option-b",
					displayName: "Model B",
					modelId: "model-b",
					reasoningLevels: ["high", "max"],
				},
			],
		};
		const conversation = () => ({
			...history("conversation-1", []).conversation,
			status: "ready",
			selectedModelOptionId: saved ? "option-b" : "option-a",
			selectedReasoningLevel: saved ? "high" : "medium",
		});
		const view = setup(async (request) => {
			const path = new URL(request.url).pathname;
			if (path === "/api/v2/agents/agent-1")
				return Response.json({
					...agent,
					capabilities: { ...agent.capabilities, modelSelection: true },
					configuration: config,
				});
			if (path.endsWith("/model-selection")) {
				attempts += 1;
				const response = await respond(attempts);
				if (response.status === 200) saved = true;
				return response.status === 200
					? Response.json(conversation())
					: response;
			}
			if (path === "/api/v2/conversations/conversation-1")
				return Response.json({
					...history("conversation-1", []),
					conversation: conversation(),
				});
		});
		return {
			...view,
			selections: () =>
				view.requests.filter((request) =>
					request.url.endsWith("/model-selection"),
				),
		};
	}
	async function chooseModelB() {
		const trigger = await screen.findByRole("button", {
			name: "选择模型，当前 Model A，思考均衡，下一条消息生效",
		});
		expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
		trigger.focus();
		fireEvent.click(trigger);
		const option = await screen.findByRole("menuitemradio", {
			name: "Model B",
		});
		expect(
			screen
				.getByRole("menuitemradio", { name: "Model A" })
				.getAttribute("aria-checked"),
		).toBe("true");
		fireEvent.pointerDown(option, { pointerType: "mouse" });
		fireEvent.click(option, { detail: 1 });
		return trigger;
	}
	function sendButton() {
		return screen.getByRole("button", { name: "发送" }) as HTMLButtonElement;
	}

	it("autosaves a chosen model from the composer toolbar without locking the draft", async () => {
		const pending = deferred<Response>();
		const { selections } = modelScenario(() => pending.promise);
		const input = await composer();
		fireEvent.change(input, { target: { value: "Use chosen model" } });
		// 入口在 composer 工具栏内，没有保存按钮和「请先保存」提示。
		const form = input.closest("form");
		if (!form) throw new Error("Expected composer form");
		expect(
			within(form).getByRole("button", { name: /^选择思考强度，当前均衡/ }),
		).toBeTruthy();
		const trigger = await chooseModelB();
		expect(screen.queryByRole("button", { name: "保存模型选择" })).toBeNull();
		const status = await screen.findByRole("status", {
			name: "模型设置保存中",
		});
		expect(
			status.querySelector('[data-slot="spinner"]')?.getAttribute("data-size"),
		).toBe("sm");
		// 保存中草稿可编辑、触发器不被禁用，只禁止发送。
		expect(input.disabled).toBe(false);
		expect((trigger as HTMLButtonElement).disabled).toBe(false);
		expect(sendButton().disabled).toBe(true);
		input.focus();
		input.setSelectionRange(3, 3);
		fireEvent.change(input, { target: { value: "Use chosen model!" } });
		input.setSelectionRange(3, 3);
		pending.resolve(new Response(null, { status: 200 }));
		await screen.findByText("设置已保存，对下一条消息生效");
		await waitFor(() => expect(sendButton().disabled).toBe(false));
		expect(document.activeElement).toBe(input);
		expect(input.selectionStart).toBe(3);
		expect(input.value).toBe("Use chosen model!");
		expect(
			screen.queryByText("模型选择已保存，从下一条消息开始生效。"),
		).toBeNull();
		expect(screen.queryByText("请先保存模型选择，再发送消息。")).toBeNull();
		expect(selections()).toHaveLength(1);
		expect(await selections()[0].json()).toEqual({
			schemaVersion: 1,
			modelOptionId: "option-b",
			reasoningLevel: "high",
		});
		await screen.findByRole("button", {
			name: "选择模型，当前 Model B，思考高，下一条消息生效",
		});
	});

	it.each([
		["a server failure", () => new Response(null, { status: 500 })],
		[
			"a retryable runtime refusal",
			() =>
				Response.json(
					PilotProtocolErrorV1Schema.parse({
						schemaVersion: 1,
						code: "RUNTIME_UNAVAILABLE",
						message: "Runtime unavailable",
						retryable: true,
						traceId: "trace-runtime",
					}),
					{ status: 503 },
				),
		],
	] as const)(
		"keeps retry usable after %s and replays the same idempotency key",
		async (_label, failure) => {
			const { selections } = modelScenario((attempt) =>
				attempt === 1 ? failure() : new Response(null, { status: 200 }),
			);
			const input = await composer();
			fireEvent.change(input, { target: { value: "Draft" } });
			await chooseModelB();
			const retry = await screen.findByRole("button", {
				name: "设置未保存，点击重试",
			});
			expect((retry as HTMLButtonElement).disabled).toBe(false);
			expect(retry.closest("fieldset")).toBeNull();
			expect(input.disabled).toBe(false);
			expect(sendButton().disabled).toBe(true);
			expect(screen.queryByText(/提交结果尚未确认/)).toBeNull();
			retry.focus();
			fireEvent.click(retry);
			await waitFor(() => expect(sendButton().disabled).toBe(false));
			// #3269 N8-3-02：重试开始即换成保存中的 spinner、按钮卸载，焦点交给模型入口，不落到 body。
			expect(document.activeElement?.getAttribute("aria-label")).toMatch(
				/^选择模型，当前 /,
			);
			expect(selections()).toHaveLength(2);
			expect(selections()[1].headers.get("Idempotency-Key")).toBe(
				selections()[0].headers.get("Idempotency-Key"),
			);
		},
	);

	it("rolls back to the saved model and explains a non-retryable refusal", async () => {
		modelScenario(() =>
			Response.json(
				PilotProtocolErrorV1Schema.parse({
					schemaVersion: 1,
					code: "MODEL_SELECTION_INVALID",
					message: "Do not render raw error",
					retryable: false,
					traceId: "trace-model",
				}),
				{ status: 409 },
			),
		);
		const input = await composer();
		fireEvent.change(input, { target: { value: "Draft" } });
		await chooseModelB();
		await screen.findByText("模型选项已变化，请刷新模型清单后重新选择。");
		expect(
			screen.getByRole("button", {
				name: "选择模型，当前 Model A，思考均衡，下一条消息生效",
			}),
		).toBeTruthy();
		expect(
			screen.queryByRole("button", { name: "设置未保存，点击重试" }),
		).toBeNull();
		expect(sendButton().disabled).toBe(false);
		expect(screen.queryByText("Do not render raw error")).toBeNull();
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
		await pendingReply();
		const posts = requests.filter((request) => request.method === "POST");
		expect(posts).toHaveLength(1);
		expect(await posts[0].json()).toEqual({
			schemaVersion: 1,
			text: "第一行\n第二行",
		});
		expect(input.value).toBe("");
		expect(screen.queryByText("已完成")).toBeNull();
		expect(
			screen
				.getByRole("button", { name: "停止回复" })
				.closest("article")
				?.getAttribute("aria-label"),
		).toBe(`${agent.name}的消息`);
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
		await pendingReply();
		expect(
			requests.filter((request) => request.method === "POST"),
		).toHaveLength(1);
	});

	it("keeps the draft editable but blocks sending while the conversation read is temporarily unavailable (#2151)", async () => {
		let unavailable = false;
		const view = setup((request) =>
			unavailable &&
			request.method === "GET" &&
			new URL(request.url).pathname === "/api/v2/conversations/conversation-1"
				? new Response("Unavailable", { status: 503 })
				: undefined,
		);
		const { streams } = view;
		const input = await composer();
		unavailable = true;
		act(() => streams.at(-1)?.send(reload()));
		await screen.findByText(/恢复后会自动继续读取/);
		expect(input.disabled).toBe(false);
		fireEvent.change(input, { target: { value: "断线期间的草稿" } });
		expect(input.value).toBe("断线期间的草稿");
		const send = screen.getByRole("button", {
			name: "发送",
		}) as HTMLButtonElement;
		expect(send.disabled).toBe(true);
		fireEvent.keyDown(input, { key: "Enter" });
		expect(
			view.requests.filter((request) => request.method === "POST"),
		).toHaveLength(0);
	});

	it("sends an edited draft after the conversation read recovers (#2151)", async () => {
		let failRefresh = false;
		const { requests, streams } = setup((request) => {
			if (
				failRefresh &&
				request.method === "GET" &&
				new URL(request.url).pathname === "/api/v2/conversations/conversation-1"
			) {
				failRefresh = false;
				return new Response("Unavailable", { status: 503 });
			}
			return request.method === "POST" ? receipt() : undefined;
		});
		const input = await composer();
		failRefresh = true;
		act(() => streams.at(-1)?.send(reload()));
		await screen.findByText(/恢复后会自动继续读取/);
		// B-10：连接中断是读取失败，用 warn notice 并以 role="alert" 播报。
		const interrupted = screen
			.getByText(/恢复后会自动继续读取/)
			.closest('[data-slot="alert"]');
		expect(interrupted?.getAttribute("role")).toBe("alert");
		expect(interrupted?.getAttribute("data-tone")).toBe("warn");
		fireEvent.change(input, { target: { value: "断线期间的草稿" } });
		fireEvent.click(screen.getByRole("button", { name: "重新连接" }));
		await waitFor(() =>
			expect(
				(screen.getByRole("button", { name: "发送" }) as HTMLButtonElement)
					.disabled,
			).toBe(false),
		);
		fireEvent.click(screen.getByRole("button", { name: "发送" }));
		await waitFor(() =>
			expect(
				requests.filter((request) => request.method === "POST"),
			).toHaveLength(1),
		);
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
		// #3242 K7-02：提交结果未确认期间发送按钮是可聚焦的禁用（aria-disabled），不再是原生 disabled；
		// 下方断言 POST 仍只有一次。
		const send = screen.getByRole("button", {
			name: "发送",
		}) as HTMLButtonElement;
		expect(send.getAttribute("aria-disabled")).toBe("true");
		expect(send.disabled).toBe(false);
		act(() => streams.at(-1)?.disconnect());
		// The read reconnects by itself and never repeats the command (#1606).
		await waitFor(() => expect(streams.length).toBe(2), { timeout: 3_000 });
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
		// 两个范围共用设计头部：h2「个人历史」；区域名称仍区分「最近对话」。
		const recent = await screen.findByRole("region", { name: "最近对话" });
		expect(
			within(recent).getByRole("heading", { name: "个人历史", level: 2 }),
		).toBeTruthy();
		expect(within(recent).getByText("只显示你的会话")).toBeTruthy();
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
			const failure = await screen.findByText(String(message));
			// B-10：读取失败是 danger notice，以 role="alert" 播报。
			const notice = failure.closest('[data-slot="alert"]');
			expect(notice?.getAttribute("role")).toBe("alert");
			expect(notice?.getAttribute("data-tone")).toBe("danger");
			await composer();
			expect(screen.queryByText("暂无个人对话。")).toBeNull();
			expect(screen.queryByText(/当前登录或访问权限已失效/)).toBeNull();
			expect(onAccessDenied).not.toHaveBeenCalled();
			expect(requests.every((request) => request.method === "GET")).toBe(true);
		},
	);

	it("keeps the page header to the Agent name and the design subtitle", async () => {
		setup();
		const heading = await screen.findByRole("heading", {
			name: agent.name,
			level: 1,
		});
		const header = heading.closest("header");
		if (!header) throw new Error("Expected conversation header");
		// h1 只显示 Agent 名称：不做链接、没有下拉箭头。
		expect(heading.closest("a")).toBeNull();
		expect(heading.querySelector("svg")).toBeNull();
		expect(screen.queryByRole("link", { name: "切换 Agent" })).toBeNull();
		expect(
			within(header).getByText("Web 对话 · 已提交的任务会继续处理。"),
		).toBeTruthy();
		expect(within(header).queryByText(/管理：|服务：/)).toBeNull();
		expect(within(header).queryByText("标准模板 · codex")).toBeNull();
		expect(screen.queryByRole("button", { name: "刷新会话" })).toBeNull();
		expect(within(header).getByRole("button", { name: "新会话" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "新建会话" })).toBeNull();
	});

	it("labels personal history items with the shared time format and current marker", async () => {
		setup((request) =>
			new URL(request.url).pathname === "/api/v2/me/conversations/recent"
				? Response.json({
						items: [
							{ ...history().conversation, title: null },
							{
								...history("conversation-2").conversation,
								title: "Other",
							},
						],
						nextCursor: "next",
					})
				: undefined,
		);
		const current = await screen.findByRole("link", { name: /未命名对话/ });
		expect(current.getAttribute("aria-current")).toBe("page");
		const time = current.querySelector("time");
		expect(time?.getAttribute("dateTime")).toBe(timestamp);
		expect(current.querySelector("small")?.textContent).toBe(
			`${time?.textContent} · 当前`,
		);
		expect(current.textContent).not.toContain("当前对话");
		expect(current.textContent).not.toContain("未命名会话");
		// 历史接口没有总数：已加载 2 条且还有下一页时显示「2+」。
		const recent = screen.getByRole("region", { name: "最近对话" });
		expect(within(recent).getByText("2+")).toBeTruthy();
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

	it("creates a durable conversation on the first send and refreshes recent history before navigating", async () => {
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
		// CH-10：直接进入就是可输入的 composer，没有「创建会话」；打开页面不产生写入。
		const input = await composer();
		expect(input.disabled).toBe(false);
		expect(input.placeholder).toBe("输入消息，或 / 搜索命令与 Skill…");
		expect(screen.queryByRole("button", { name: "创建会话" })).toBeNull();
		expect(requests.every((request) => request.method === "GET")).toBe(true);
		fireEvent.change(input, { target: { value: "第一条任务" } });
		fireEvent.click(screen.getByRole("button", { name: "发送" }));
		await waitFor(() =>
			expect(props.onConversationChange).toHaveBeenCalledWith("conversation-1"),
		);
		expect(
			requests
				.filter((request) => request.method === "POST")
				.map((request) => new URL(request.url).pathname),
		).toEqual(["/api/v1/agents/agent-1/conversations"]);
		expect(
			await screen.findByRole("link", { name: /Test conversation/ }),
		).toBeTruthy();
	});

	describe("first message from the new-conversation page (CH-10)", () => {
		function firstMessageScenario({
			preparing = false,
			create = () => Response.json(history().conversation, { status: 201 }),
		}: {
			preparing?: boolean;
			create?: () => Response;
		} = {}) {
			const state = { ready: !preparing };
			const view = setup(
				(request) => {
					const path = new URL(request.url).pathname;
					if (request.method === "POST")
						return path === "/api/v1/agents/agent-1/conversations"
							? create()
							: receipt();
					if (path === "/api/v2/conversations/conversation-1")
						return Response.json({
							...history("conversation-1", []),
							conversation: { ...history().conversation, status: "ready" },
							sessionAvailability: state.ready ? "ready" : "preparing",
						});
				},
				{ conversationId: undefined },
			);
			const posts = () =>
				view.requests
					.filter((request) => request.method === "POST")
					.map((request) => new URL(request.url).pathname);
			return { ...view, state, posts };
		}
		async function submitFirst(text: string) {
			const input = await composer();
			fireEvent.change(input, { target: { value: text } });
			fireEvent.keyDown(input, { key: "Enter" });
		}

		it("creates the conversation, then sends the original draft once after navigating", async () => {
			const { props, posts, requests, rerenderScope } = firstMessageScenario();
			await submitFirst("第一条任务");
			await waitFor(() =>
				expect(props.onConversationChange).toHaveBeenCalledWith(
					"conversation-1",
				),
			);
			// 跳转前只有创建请求：消息由新会话页发送。
			expect(posts()).toEqual(["/api/v1/agents/agent-1/conversations"]);
			rerenderScope({ conversationId: "conversation-1" });
			await waitFor(() =>
				expect(posts()).toEqual([
					"/api/v1/agents/agent-1/conversations",
					"/api/v1/conversations/conversation-1/messages",
				]),
			);
			const message = requests.find((request) =>
				request.url.endsWith("/messages"),
			);
			expect(await message?.json()).toEqual({
				schemaVersion: 1,
				text: "第一条任务",
			});
			const input = await composer();
			await waitFor(() => expect(input.value).toBe(""));
			expect(document.activeElement).toBe(input);
			// 再次进入同一会话不会重复发送。
			rerenderScope({ conversationId: undefined });
			await composer();
			rerenderScope({ conversationId: "conversation-1" });
			await composer();
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(posts()).toHaveLength(2);
		});

		it("waits for a preparing Session and then sends the first message", async () => {
			const { props, posts, state, rerenderScope } = firstMessageScenario({
				preparing: true,
			});
			await submitFirst("准备完成后发送");
			await waitFor(() =>
				expect(props.onConversationChange).toHaveBeenCalledWith(
					"conversation-1",
				),
			);
			rerenderScope({ conversationId: "conversation-1" });
			const status = await screen.findByText(
				"会话准备中，完成后自动发送这条消息。",
			);
			expect(status.getAttribute("role")).toBe("status");
			const input = await composer();
			expect(input.value).toBe("准备完成后发送");
			expect(posts()).toHaveLength(1);
			state.ready = true;
			await waitFor(() => expect(posts()).toHaveLength(2), { timeout: 4_000 });
			await waitFor(() => expect(input.value).toBe(""));
		});

		it("leaves a rewritten draft for a manual send", async () => {
			const { props, posts, state, rerenderScope } = firstMessageScenario({
				preparing: true,
			});
			await submitFirst("原草稿");
			await waitFor(() =>
				expect(props.onConversationChange).toHaveBeenCalledWith(
					"conversation-1",
				),
			);
			rerenderScope({ conversationId: "conversation-1" });
			await screen.findByText("会话准备中，完成后自动发送这条消息。");
			const input = await composer();
			fireEvent.change(input, { target: { value: "改写后的草稿" } });
			await screen.findByText("会话准备中，完成后即可发送。草稿会保留。");
			state.ready = true;
			const send = screen.getByRole("button", {
				name: "发送",
			}) as HTMLButtonElement;
			await waitFor(() => expect(send.disabled).toBe(false), {
				timeout: 4_000,
			});
			expect(posts()).toHaveLength(1);
			expect(input.value).toBe("改写后的草稿");
		});

		it("keeps the draft and explains a refused creation above the composer", async () => {
			const { props, posts } = firstMessageScenario({
				create: () =>
					Response.json(
						PilotProtocolErrorV1Schema.parse({
							schemaVersion: 1,
							code: "AGENT_BUSY",
							message: "Do not render raw error",
							retryable: true,
							traceId: "trace-busy",
						}),
						{ status: 409 },
					),
			});
			await submitFirst("创建失败也保留");
			const refused = await screen.findByRole("alert");
			const input = await composer();
			const form = input.closest("form");
			if (!form) throw new Error("Expected composer form");
			// 提示在 composer 上方，不在表单内，也没有原始错误文本。
			expect(form.contains(refused)).toBe(false);
			expect(
				refused.compareDocumentPosition(form) &
					Node.DOCUMENT_POSITION_FOLLOWING,
			).toBeTruthy();
			expect(refused.textContent).not.toContain("Do not render raw error");
			expect(input.value).toBe("创建失败也保留");
			expect(props.onConversationChange).not.toHaveBeenCalled();
			expect(posts()).toEqual(["/api/v1/agents/agent-1/conversations"]);
		});
	});

	it.each([
		["starting", "启动中"],
		["updating", "更新中"],
		["unavailable", "暂时不可用"],
		[null, "暂时不可用"],
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
			const banner = screen
				.getByText(label, { selector: "strong" })
				.closest('[data-slot="alert"]');
			expect(banner?.getAttribute("role")).toBe("status");
			expect(banner?.getAttribute("data-tone")).toBe("warn");
			expect(header.contains(banner)).toBe(false);
			expect(screen.queryByText("服务状态：就绪")).toBeNull();
			const input = await composer();
			if (
				serviceAvailability === "starting" ||
				serviceAvailability === "updating"
			)
				fireEvent.change(input, {
					target: { value: "Draft while transitioning" },
				});
			expect(input.disabled).toBe(
				serviceAvailability !== "starting" &&
					serviceAvailability !== "updating",
			);
			if (
				serviceAvailability === "starting" ||
				serviceAvailability === "updating"
			)
				expect(input.value).toBe("Draft while transitioning");
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
		expect(screen.queryByRole("link", { name: "切换 Agent" })).toBeNull();
		expect(screen.queryByRole("textbox", { name: "消息" })).toBeNull();
		expect(
			(screen.getByRole("button", { name: "新会话" }) as HTMLButtonElement)
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
			(screen.getByRole("button", { name: "新会话" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
	});

	it.each([
		["the Owner", "user-owner-1", ["employee"], "stopped", true],
		["a system administrator", "admin-1", ["system_admin"], "stopped", true],
		["another member", "member-1", ["employee"], "stopped", false],
		[
			"the Owner of a disabled Agent",
			"user-owner-1",
			["employee"],
			"disabled",
			false,
		],
	] as const)(
		"shows the stopped-Agent warning with an Owner entry only for %s",
		async (_label, userId, roles, managementStatus, ownerEntry) => {
			setup(
				(request) =>
					new URL(request.url).pathname === "/api/v2/agents/agent-1"
						? Response.json({ ...agent, managementStatus })
						: undefined,
				{
					session: {
						schemaVersion: 1,
						user: { userId, displayName: "受控用户", roles: [...roles] },
					},
				},
			);
			const title = await screen.findByText(
				managementStatus === "stopped" ? "已停止" : "已停用",
				{ selector: "strong" },
			);
			const banner = title.closest('[data-slot="alert"]');
			if (!(banner instanceof HTMLElement)) throw new Error("Missing banner");
			expect(banner.getAttribute("role")).toBe("status");
			expect(banner.getAttribute("data-tone")).toBe("warn");
			expect(banner.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
				"true",
			);
			// 横幅在页头与对话栅格之间，不在页头或对话列内。
			expect(banner.closest("header")).toBeNull();
			expect(banner.closest(".conversation-columns")).toBeNull();
			const link = within(banner).queryByRole("link", {
				name: "进入 Owner 操作",
			});
			if (ownerEntry) {
				expect(
					within(banner).getByText(
						"历史会话仍可查看，Owner 可以重启或修改运行配置。",
					),
				).toBeTruthy();
				expect(link?.getAttribute("href")).toBe(
					"/agents/agent-1/configuration",
				);
			} else {
				expect(
					within(banner).getByText("可以查看历史，暂时不能发送消息。"),
				).toBeTruthy();
				expect(link).toBeNull();
			}
			expect(screen.queryByText(/联系 Owner/)).toBeNull();
			expect(
				screen.queryByRole("button", { name: "刷新 Agent 状态" }),
			).toBeNull();
			expect((await composer()).disabled).toBe(true);
		},
	);

	it("creates a new conversation in one step from the header", async () => {
		let created = false;
		const { props, requests } = setup((request) => {
			if (request.method === "POST") {
				created = true;
				return Response.json(
					{ ...history().conversation, conversationId: "conversation-created" },
					{ status: 201 },
				);
			}
			if (new URL(request.url).pathname === "/api/v2/me/conversations/recent")
				return Response.json({
					items: created ? [history().conversation] : [],
					nextCursor: null,
				});
		});
		await composer();
		fireEvent.click(screen.getByRole("button", { name: "新会话" }));
		await waitFor(() =>
			expect(props.onConversationChange).toHaveBeenCalledWith(
				"conversation-created",
			),
		);
		expect(
			requests
				.filter((request) => request.method === "POST")
				.map((request) => new URL(request.url).pathname),
		).toEqual(["/api/v1/agents/agent-1/conversations"]);
		expect(screen.queryByRole("button", { name: "创建会话" })).toBeNull();
		await screen.findByText("新会话已创建，已出现在最近对话");
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
			within(screen.getByRole("article", { name: "陈昊的消息" })).getByText(
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
		// Agent 名称来自 Agent 投影：回到页面时随窗口聚焦重读（不再有「刷新会话」按钮）。
		act(() => {
			focusManager.setFocused(false);
			focusManager.setFocused(true);
		});
		await screen.findByRole("article", { name: `${agentName}的消息` });
		focusManager.setFocused(undefined);
		expect(
			screen.queryByRole("article", { name: "正式投影工程助手的消息" }),
		).toBeNull();
		expect(screen.getByText("Old answer")).toBeTruthy();
		expect(
			requests.filter((request) => request.method === "POST"),
		).toHaveLength(0);
		fireEvent.click(
			screen.getByRole("button", { name: "查看执行详情：Private question" }),
		);
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
		expect(screen.getByRole("article", { name: "陈昊的消息" })).toBeTruthy();
		// 每个执行最多一个执行详情入口：卡外的受理行与第二个「执行详情」已删除（R4-07、AC-6）。
		expect(
			screen.getAllByRole("button", { name: /^查看执行详情/ }),
		).toHaveLength(1);
		expect(
			within(live).getByRole("button", { name: /^查看执行详情/ }),
		).toBeTruthy();
	});
});

describe("a 404 that may only mean the Agent is stopped (#2570)", () => {
	const resourceUnavailable = () =>
		Response.json(
			PilotProtocolErrorV1Schema.parse({
				schemaVersion: 1,
				code: "RESOURCE_UNAVAILABLE",
				message: "The resource is unavailable.",
				retryable: false,
				traceId: "trace-404",
			}),
			{ status: 404 },
		);
	const stoppedAgent = AgentProjectionV2Schema.parse({
		...agent,
		managementStatus: "stopped",
		serviceAvailability: null,
	});

	/** The Agent starts out available; the test flips it the way an Owner would elsewhere. */
	function scenario(changes: Partial<ConversationScreenProps> = {}) {
		const state = {
			agent: "available" as "available" | "stopped" | "failing",
			post: resourceUnavailable as () => Response,
			/** 设置后 Agent 重读要等它完成，用来观察复核进行中的状态。 */
			hold: undefined as Promise<void> | undefined,
		};
		const posts: Request[] = [];
		const view = setup(async (request) => {
			const path = new URL(request.url).pathname;
			if (request.method === "POST") {
				posts.push(request);
				return state.post();
			}
			if (path === "/api/v2/agents/agent-1") {
				if (state.hold) await state.hold;
				if (state.agent === "stopped") return Response.json(stoppedAgent);
				if (state.agent === "failing")
					return new Response("down", { status: 500 });
			}
			return undefined;
		}, changes);
		return { ...view, state, posts };
	}
	const agentReads = (requests: readonly Request[]) =>
		requests.filter(
			(request) => new URL(request.url).pathname === "/api/v2/agents/agent-1",
		).length;

	it("keeps the draft and says the Agent is stopped instead of claiming lost access", async () => {
		const onAccessDenied = vi.fn();
		const { state, posts, requests } = scenario({ onAccessDenied });
		const input = await composer();
		await waitFor(() => expect(agentReads(requests)).toBe(1));
		fireEvent.change(input, { target: { value: "Keep this draft" } });
		state.agent = "stopped";
		fireEvent.click(screen.getByRole("button", { name: "发送" }));
		await screen.findByText("可以查看历史，暂时不能发送消息。");
		expect(screen.getByText("已停止", { selector: "strong" })).toBeTruthy();
		expect(screen.queryByText(/联系 Owner/)).toBeNull();
		expect(
			screen.queryByRole("button", { name: "刷新 Agent 状态" }),
		).toBeNull();
		expect(screen.queryByRole("link", { name: "进入 Owner 操作" })).toBeNull();
		// 确认 Agent 不可用后只保留页顶一处提示；命令区不重复（NW-13），也没有被折叠条藏起来的提示。
		expect(screen.queryByText(/消息未送达/)).toBeNull();
		expect(screen.queryByText("正在确认 Agent 状态…")).toBeNull();
		expect(document.querySelectorAll('[data-slot="alert"]')).toHaveLength(1);
		expect(input.value).toBe("Keep this draft");
		expect(screen.queryByText(/当前登录或访问权限已失效/)).toBeNull();
		expect(onAccessDenied).not.toHaveBeenCalled();
		expect(posts).toHaveLength(1);
		// 只重新读取一次，不会因为反复确认而循环请求。
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(agentReads(requests)).toBe(2);
		expect(
			screen.getByRole("button", { name: "发送" }).hasAttribute("disabled"),
		).toBe(true);
	});

	it("still treats the 404 as lost access while the Agent is available", async () => {
		const onAccessDenied = vi.fn();
		const { posts } = scenario({ onAccessDenied });
		const input = await composer();
		fireEvent.change(input, { target: { value: "Private draft" } });
		fireEvent.click(screen.getByRole("button", { name: "发送" }));
		await screen.findByText(/当前登录或访问权限已失效/);
		expect(screen.queryByRole("textbox")).toBeNull();
		expect(screen.queryByDisplayValue("Private draft")).toBeNull();
		expect(onAccessDenied).toHaveBeenCalledOnce();
		expect(posts).toHaveLength(1);
	});

	it("falls back to lost access when the Agent cannot be re-read", async () => {
		const onAccessDenied = vi.fn();
		const { state } = scenario({ onAccessDenied });
		const input = await composer();
		fireEvent.change(input, { target: { value: "Private draft" } });
		state.agent = "failing";
		fireEvent.click(screen.getByRole("button", { name: "发送" }));
		await screen.findByText(/当前登录或访问权限已失效/);
		expect(screen.queryByDisplayValue("Private draft")).toBeNull();
		expect(onAccessDenied).toHaveBeenCalledOnce();
	});

	it("sends again once the Agent is available, without reloading the page", async () => {
		const { state, posts } = scenario();
		const input = await composer();
		fireEvent.change(input, { target: { value: "Resend me" } });
		state.agent = "stopped";
		fireEvent.click(screen.getByRole("button", { name: "发送" }));
		await screen.findByText("已停止", { selector: "strong" });
		state.agent = "available";
		state.post = receipt;
		// 已停止横幅不再提供「刷新 Agent 状态」：回到页面时 Agent 状态随窗口聚焦重读。
		act(() => {
			focusManager.setFocused(false);
			focusManager.setFocused(true);
		});
		await waitFor(() =>
			expect(screen.queryByText("已停止", { selector: "strong" })).toBeNull(),
		);
		focusManager.setFocused(undefined);
		expect(input.value).toBe("Resend me");
		fireEvent.click(screen.getByRole("button", { name: "发送" }));
		await waitFor(() => expect(posts).toHaveLength(2));
		await waitFor(() => expect(input.value).toBe(""));
		expect(screen.queryByText(/当前登录或访问权限已失效/)).toBeNull();
	});

	// CH-10：新会话页在首次发送时创建会话，创建遇 404 的处理与原「创建会话」入口相同。
	async function sendFirstMessage(text: string) {
		const input = await composer();
		fireEvent.change(input, { target: { value: text } });
		fireEvent.click(screen.getByRole("button", { name: "发送" }));
		return input;
	}

	it("explains a stopped Agent when a new Session is refused with 404", async () => {
		const onAccessDenied = vi.fn();
		const { state } = scenario({
			conversationId: undefined,
			onAccessDenied,
		});
		await composer();
		state.agent = "stopped";
		const input = await sendFirstMessage("Stopped first draft");
		await screen.findByText("已停止", { selector: "strong" });
		expect(screen.queryByText(/当前登录或访问权限已失效/)).toBeNull();
		expect(onAccessDenied).not.toHaveBeenCalled();
		expect(input.value).toBe("Stopped first draft");
	});

	it("still treats a refused new Session as lost access while the Agent is available", async () => {
		const onAccessDenied = vi.fn();
		scenario({ conversationId: undefined, onAccessDenied });
		await sendFirstMessage("Lost access draft");
		await screen.findByText(/当前登录或访问权限已失效/);
		expect(onAccessDenied).toHaveBeenCalledOnce();
		// 失去访问后草稿随页面一起清除。
		expect(screen.queryByDisplayValue("Lost access draft")).toBeNull();
	});

	it("only says it is checking the Agent while the 404 is being verified (NW-13)", async () => {
		const { state } = scenario();
		const input = await composer();
		fireEvent.change(input, { target: { value: "Keep this draft" } });
		const gate = deferred<void>();
		state.hold = gate.promise;
		state.agent = "stopped";
		fireEvent.click(screen.getByRole("button", { name: "发送" }));
		const checking = await screen.findByText("正在确认 Agent 状态…");
		expect(checking.getAttribute("role")).toBe("status");
		// 复核返回前不出现「恢复后重新发送」类文案，也没有页顶不可用横幅。
		expect(screen.queryByText(/消息未送达|重新发送|草稿已保留/)).toBeNull();
		expect(document.querySelectorAll('[data-slot="alert"]')).toHaveLength(0);
		await act(async () => gate.resolve());
		await screen.findByText("已停止", { selector: "strong" });
		expect(screen.queryByText("正在确认 Agent 状态…")).toBeNull();
		expect(document.querySelectorAll('[data-slot="alert"]')).toHaveLength(1);
		expect(input.value).toBe("Keep this draft");
	});

	it("offers 重新发送 with the current draft once the stopped Agent recovers (G-04)", async () => {
		const { state, posts } = scenario();
		const input = await composer();
		fireEvent.change(input, { target: { value: "原文A" } });
		state.agent = "stopped";
		fireEvent.click(screen.getByRole("button", { name: "发送" }));
		await screen.findByText("已停止", { selector: "strong" });
		expect(screen.queryByText("消息未送达")).toBeNull();
		state.agent = "available";
		state.post = receipt;
		act(() => {
			focusManager.setFocused(false);
			focusManager.setFocused(true);
		});
		// Agent 恢复后无需任何操作即可看到状态卡：标题、说明与 outline「重新发送」。
		const title = await screen.findByText("消息未送达");
		focusManager.setFocused(undefined);
		const card = title.closest('[data-slot="alert"]') as HTMLElement;
		expect(card.textContent).toContain("原文仍保留在输入框");
		expect(card.closest('[data-slot="collapsible-panel"]')).toBeNull();
		const resend = within(card).getByRole("button", { name: "重新发送" });
		fireEvent.change(input, { target: { value: "  " } });
		expect((resend as HTMLButtonElement).disabled).toBe(true);
		fireEvent.change(input, { target: { value: "改写B" } });
		expect((resend as HTMLButtonElement).disabled).toBe(false);
		fireEvent.click(resend);
		await waitFor(() => expect(posts).toHaveLength(2));
		// 原尝试已结束：重新发送是一次新的消息命令（新的幂等键），正文是当前草稿。
		expect(await posts[1].clone().json()).toEqual({
			schemaVersion: 1,
			text: "改写B",
		});
		expect(posts[1].headers.get("Idempotency-Key")).not.toBe(
			posts[0].headers.get("Idempotency-Key"),
		);
		await waitFor(() =>
			expect(document.querySelector('[data-slot="toast"]')?.textContent).toBe(
				"已重新发送，正在等待 Agent 确认",
			),
		);
		await waitFor(() => expect(input.value).toBe(""));
		expect(screen.queryByText("消息未送达")).toBeNull();
	});

	it("never says a refused new Session lost a message or a draft (NW-12)", async () => {
		const { state, posts } = scenario({ conversationId: undefined });
		await composer();
		const gate = deferred<void>();
		state.hold = gate.promise;
		state.agent = "stopped";
		const input = await sendFirstMessage("NW-12 draft");
		await screen.findByText("正在确认 Agent 状态…");
		expect(screen.queryByText(/消息未送达|草稿已保留/)).toBeNull();
		await act(async () => gate.resolve());
		await screen.findByText("已停止", { selector: "strong" });
		expect(
			screen.queryByText(/消息未送达|草稿已保留|正在确认 Agent 状态/),
		).toBeNull();
		expect(document.querySelectorAll('[data-slot="alert"]')).toHaveLength(1);
		// Agent 已停止：草稿保留但不可编辑，发送不可用，不会再次创建。
		expect(input.value).toBe("NW-12 draft");
		expect(input.disabled).toBe(true);
		expect(
			(screen.getByRole("button", { name: "发送" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
		expect(posts).toHaveLength(1);
	});
});

describe("answers outside the loaded event window (#2635)", () => {
	function exchange(
		suffix: "old" | "new",
		status: "completed" | "cancelled" | "processing",
		answer = "",
	) {
		const user = {
			...userMessage(`${suffix} question`),
			messageId: `message-${suffix}`,
			executionId: `execution-${suffix}`,
		};
		const assistant = {
			...user,
			role: "assistant" as const,
			messageId: `answer-${suffix}`,
			replyToMessageId: `message-${suffix}`,
			text: answer,
			status,
			answerVersion: 1,
			isCurrentAnswer: true,
		};
		return [user, assistant];
	}
	function windowEvent(
		sequence: number,
		executionId: string,
		body:
			| { type: "text.delta"; payload: { text: string } }
			| {
					type: "execution.status";
					payload: { status: "completed" | "cancelled" };
			  },
	) {
		return PersistedConversationEventV2Schema.parse({
			...event(sequence),
			executionId,
			...body,
		});
	}
	function windowed(options: {
		hasEarlier: boolean;
		oldStatus?: "completed" | "cancelled" | "processing";
		newestEvents?: ReturnType<typeof windowEvent>[];
	}) {
		const newest = windowEvent(2, "execution-new", {
			type: "execution.status",
			payload: { status: "completed" },
		});
		const older = windowEvent(1, "execution-old", {
			type: "text.delta",
			payload: { text: "Old answer" },
		});
		return (request: Request) => {
			const url = new URL(request.url);
			if (url.pathname !== "/api/v2/conversations/conversation-1")
				return undefined;
			if (url.searchParams.has("beforeCursor"))
				return Response.json({
					...history("conversation-1", [older]),
					messages: [],
					eventWindow: { hasEarlier: false, beforeCursor: null },
				});
			return Response.json({
				...history("conversation-1", options.newestEvents ?? [newest]),
				messages: [
					...exchange("old", options.oldStatus ?? "completed"),
					...exchange("new", "completed", "Newest answer"),
				],
				eventWindow: options.hasEarlier
					? { hasEarlier: true, beforeCursor: "before-cursor" }
					: { hasEarlier: false, beforeCursor: null },
			});
		};
	}

	it("says the content is not loaded instead of 'not output yet', then shows it after loading earlier content", async () => {
		const { requests } = setup(windowed({ hasEarlier: true }));

		expect(await screen.findByText("Newest answer")).toBeTruthy();
		// 窗口外的已完成回复：不把提示当正文，改为状态行 + 就地「加载更早内容」（NW-15）。
		const inline = screen.getByRole("button", {
			name: "加载更早内容：old question",
		});
		const reply = inline.closest("article") as HTMLElement;
		expect(reply.querySelector(".assistant-markdown")).toBeNull();
		expect(inline.closest("p")?.textContent).toContain(
			"已完成 · 正文在更早的记录中",
		);
		expect(screen.queryByText(/点上方的/)).toBeNull();
		expect(screen.queryByText("尚未输出正文。")).toBeNull();

		const earlierReads = () =>
			requests.filter((request) =>
				new URL(request.url).searchParams.has("beforeCursor"),
			).length;
		fireEvent.click(inline);
		fireEvent.click(inline);
		expect(await screen.findByText("Old answer")).toBeTruthy();
		// 与顶部按钮同一请求，只发一次；成功后焦点落到该回复，而不是 body。
		expect(earlierReads()).toBe(1);
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByText("Old answer").closest("article"),
			),
		);
		expect(
			screen.queryByRole("button", { name: /^加载更早内容：/ }),
		).toBeNull();
	});

	it("keeps 'not output yet' when the earlier content is already loaded or there is none", async () => {
		const { unmount } = setup(windowed({ hasEarlier: false }));
		expect(await screen.findByText("Newest answer")).toBeTruthy();
		expect(screen.getAllByText("尚未输出正文。")).toHaveLength(1);
		expect(screen.queryByRole("button", { name: /^加载更早内容/ })).toBeNull();
		unmount();
		cleanup();

		// 窗口里已经有这条回复的 Execution 事件（比如被停止、没有正文）：不是「没有加载」。
		const stopped = windowEvent(1, "execution-old", {
			type: "execution.status",
			payload: { status: "cancelled" },
		});
		const newest = windowEvent(2, "execution-new", {
			type: "execution.status",
			payload: { status: "completed" },
		});
		setup(
			windowed({
				hasEarlier: true,
				oldStatus: "cancelled",
				newestEvents: [stopped, newest],
			}),
		);
		expect(await screen.findByText("Newest answer")).toBeTruthy();
		// 已停止且无正文：不显示「尚未输出正文。」，只用一行状态说明（R4-08）。
		expect(screen.queryByText("尚未输出正文。")).toBeNull();
		expect(screen.getByText("已停止")).toBeTruthy();
		expect(
			screen.queryByRole("button", { name: /^加载更早内容：/ }),
		).toBeNull();
	});

	it("does not call a running reply that has no events yet 'not loaded'", async () => {
		setup(windowed({ hasEarlier: true, oldStatus: "processing" }));

		expect(await screen.findByText("Newest answer")).toBeTruthy();
		// 进行中的回复在卡内显示 spinner 与「正在整理结果…」（R4-07），不提示可加载。
		await pendingReply("执行中");
		expect(screen.getByText("正在整理结果…")).toBeTruthy();
		expect(
			screen.queryByRole("button", { name: /^加载更早内容：/ }),
		).toBeNull();
	});
});

describe("session context, command feedback and reply cards (design alignment)", () => {
	const browserCapability = BrowserCapabilityProjectionV1Schema.parse({
		schemaVersion: 1,
		capabilityVersion: 1,
		status: "available",
		operations: ["navigate", "observe", "interact", "handoff"],
		policy: {
			allowedOrigins: ["https://example.test/"],
			maxContexts: 1,
			maxTabs: 2,
			maxPages: 4,
			maxViewportWidth: 1280,
			maxViewportHeight: 720,
			maxConcurrentActions: 1,
			maxDownloads: 2,
			maxDownloadBytes: 1_000_000,
			maxUploadBytes: 1_000_000,
			maxScreenshotBytes: 1_000_000,
			maxBrowserDurationMs: 60_000,
			maxRetainedProfileBytes: 10_000_000,
			navigationTimeoutMs: 15_000,
			actionTimeoutMs: 5_000,
			requireSideEffectConfirmation: true,
			allowUserHandoff: true,
		},
		provenance: {
			browser: "chromium",
			chromiumVersion: "153.0.8010.12",
			playwrightVersion: "1.63.0",
			imageDigest: `sha256:${"a".repeat(64)}`,
		},
		conformance: {
			schemaVersion: 1,
			receiptId: "browser-receipt-1",
			probeVersion: "browser-probe-1",
			verifiedAt: "2026-10-10T00:00:00Z",
			manifestDigest: `sha256:${"b".repeat(64)}`,
			evidenceHash: "c".repeat(64),
			operations: ["navigate", "observe", "interact", "handoff"],
		},
	});
	const binding = {
		subjectId: "subject-1",
		agentId: "agent-1",
		conversationId: "conversation-1",
		executionId: "execution-1",
		sessionGeneration: 1,
		resourceFence: 2,
		workloadRevision: 3,
		imageDigest: `sha256:${"a".repeat(64)}`,
		capabilityVersion: 1,
		capabilityRevision: 1,
		pageRevision: 4,
	};
	function handoff(sequence: number, status: "requested" | "active") {
		return PersistedConversationEventV2Schema.parse({
			schemaVersion: 2,
			kind: "event",
			eventId: `handoff-${sequence}`,
			conversationId: "conversation-1",
			executionId: "execution-1",
			sequence,
			conversationCursor: `cursor-${sequence}`,
			occurredAt: timestamp,
			type: "browser.handoff",
			payload: {
				handoffId: "handoff-1",
				status,
				reason: "mfa",
				requestedAt: timestamp,
				expiresAt: "2099-01-01T00:00:00.000Z",
				binding,
			},
		});
	}
	function withAgent(
		patch: Partial<typeof agent.capabilities>,
		handler?: (request: Request) => Response | undefined,
	) {
		return (request: Request) => {
			if (new URL(request.url).pathname === "/api/v2/agents/agent-1")
				return Response.json({
					...agent,
					capabilities: { ...agent.capabilities, ...patch },
				});
			return handler?.(request);
		};
	}
	function conversationWith(
		events: ReturnType<typeof event>[],
		messages: unknown[] = [],
		status: "ready" | "active" = "ready",
	) {
		return (request: Request) =>
			new URL(request.url).pathname === "/api/v2/conversations/conversation-1"
				? Response.json({
						...history("conversation-1", events),
						conversation: { ...history().conversation, status },
						messages,
					})
				: undefined;
	}
	function answer(
		patch: Record<string, unknown> = {},
	): Record<string, unknown> {
		return {
			...userMessage(),
			role: "assistant",
			messageId: "answer-1",
			replyToMessageId: "message-1",
			text: "",
			answerVersion: 1,
			isCurrentAnswer: true,
			...patch,
		};
	}

	it.each([
		["an empty conversation", { conversationId: "conversation-1" }],
		["the new-conversation page", { conversationId: undefined }],
	] as const)(
		"leaves the timeline of %s blank like the design (Z-01)",
		async (_, changes) => {
			setup(undefined, changes);
			await composer();
			// 时间线出现后再检查：旧实现的欢迎空态与时间线同时渲染。
			await waitFor(() =>
				expect(document.querySelector(".chat-thread .timeline")).not.toBeNull(),
			);
			const main = document.querySelector(".chat-thread");
			expect(main?.querySelector('[data-slot="empty"]')).toBeNull();
			expect(main?.textContent).not.toContain("从一个明确的任务开始");
			expect(main?.textContent).not.toContain("对话仅对你可见");
		},
	);

	it("puts a collapsed 会话上下文 bar above the timeline with a session-level Connection notice (CH-03, BR-04)", async () => {
		setup(undefined, { connectionUrl: "https://connection.example.test/mcp" });
		const trigger = await screen.findByRole("button", { name: /^会话上下文/ });
		const timeline = await screen.findByRole("region", { name: "会话时间线" });
		expect(
			trigger.compareDocumentPosition(timeline) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		expect(trigger.textContent).toContain("Connection");
		expect(trigger.textContent).toContain("按需查看");
		// 只列 Agent 实际具备的能力；「展开 / 收起」不进入可访问名称。
		expect(trigger.textContent).not.toContain("浏览器操作");
		expect(screen.queryByRole("button", { name: /展开|收起/ })).toBeNull();
		const panel = document.getElementById(
			trigger.getAttribute("aria-controls") ?? "",
		);
		expect(panel?.hidden).toBe(true);
		// 对话主视图不挂执行级安装面板，也不外露会话 / 执行 ID（NI-92、NI-93）。
		expect(screen.queryByText(/开始安装|Connection 安装/)).toBeNull();
		expect(screen.queryByText(/执行：|conversation-1 \//)).toBeNull();

		fireEvent.click(trigger);
		expect(trigger.getAttribute("aria-expanded")).toBe("true");
		expect(panel?.hidden).toBe(false);
		expect(screen.getByText("需要 Connection 授权")).toBeTruthy();
		// 与 Agent 详情「连接器」同一句 needs-auth 正文，不断言当前主体的授权状态。
		expect(
			screen.getByText(
				"使用前需在独立 Connection 完成当前账号的授权；具体 Action allowlist 由 Connection Grant 决定，Platform 不保存或编辑这份授权。",
			),
		).toBeTruthy();
		expect(screen.getByText("Action 范围")).toBeTruthy();
		expect(screen.getByText("在 Connection 中确认")).toBeTruthy();
		expect(screen.getByText("按当前主体 / Consumer / Actor 生效")).toBeTruthy();
		const open = screen.getByRole("link", { name: "打开 Connection" });
		expect(open.getAttribute("href")).toBe(
			"https://connection.example.test/mcp",
		);
		expect(open.getAttribute("target")).toBe("_blank");
		expect(open.getAttribute("rel")).toContain("noopener");
		expect(open.getAttribute("rel")).toContain("noreferrer");
		open.addEventListener("click", (clicked) => clicked.preventDefault());
		fireEvent.click(open);
		expect(await screen.findByText("等待 Connection 授权返回")).toBeTruthy();

		// 收起再展开：handoff 状态不丢（NI-87）。
		fireEvent.click(trigger);
		expect(panel?.hidden).toBe(true);
		fireEvent.click(trigger);
		expect(
			screen
				.getByRole("link", { name: "返回查看授权状态" })
				.getAttribute("href"),
		).toBe("https://connection.example.test/mcp");
	});

	it("explains an unavailable Connection entry without rendering a link", async () => {
		setup();
		fireEvent.click(await screen.findByRole("button", { name: /^会话上下文/ }));
		expect(screen.getByText("Connection 入口暂不可用。")).toBeTruthy();
		expect(screen.queryByRole("link", { name: "打开 Connection" })).toBeNull();
	});

	it("does not render the session context without Connection or Browser capabilities (NI-92, NI-93)", async () => {
		setup(withAgent({ connection: false }));
		await composer();
		expect(screen.queryByRole("button", { name: /^会话上下文/ })).toBeNull();
		expect(screen.queryByText(/Connection/)).toBeNull();
	});

	it("shows the 会话文件 bar between the timeline and the composer only with attachments (CH-03)", async () => {
		const { unmount } = setup();
		const files = await screen.findByRole("button", { name: /^会话文件/ });
		const timeline = screen.getByRole("region", { name: "会话时间线" });
		const input = await composer();
		expect(
			timeline.compareDocumentPosition(files) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(
			files.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(files.getAttribute("aria-expanded")).toBe("false");
		expect(files.textContent).toContain("0 个文件 · 0 个待重试");
		// 附件入口不再放在 composer 表单内。
		expect(
			input.closest("form")?.querySelector('input[type="file"]'),
		).toBeNull();
		unmount();
		cleanup();
		setup(withAgent({ attachments: false }));
		await composer();
		expect(screen.queryByRole("button", { name: /^会话文件/ })).toBeNull();
	});

	it("shows an active Browser card in the timeline, outside the collapsed context (NI-83, BR-01)", async () => {
		const { streams } = setup(
			withAgent(
				{ browser: browserCapability },
				conversationWith([handoff(1, "requested")]),
			),
		);
		const input = await composer();
		act(() => input.focus());
		const trigger = await screen.findByRole("button", { name: /^会话上下文/ });
		const timeline = screen.getByRole("region", { name: "会话时间线" });
		// 接管请求卡在时间线里：不用展开折叠条即可见、可操作；上下文条保持收起，焦点不动。
		const card = await within(timeline).findByRole("region", {
			name: "需要你接管浏览器",
		});
		expect(
			within(card).getByRole("button", { name: "接管浏览器" }),
		).toBeTruthy();
		expect(card.closest('[data-slot="collapsible-panel"]')).toBeNull();
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		expect(document.activeElement).toBe(input);
		expect(
			document.querySelectorAll("section.browser-capability"),
		).toHaveLength(1);
		// 展开上下文条：条内只有指向时间线的说明，不重复渲染浏览器卡。
		fireEvent.click(trigger);
		expect(
			screen.getByText(
				"浏览器操作：有请求、接管或进行中的操作时，浏览器卡显示在会话时间线里。",
			),
		).toBeTruthy();
		expect(
			document.querySelectorAll("section.browser-capability"),
		).toHaveLength(1);
		fireEvent.click(trigger);

		// 已接管：同一张卡更新为「交还给 Agent」，仍在时间线里，上下文条不自动展开。
		act(() => streams.at(-1)?.send(handoff(2, "active")));
		expect(
			await within(timeline).findByRole("button", { name: "交还给 Agent" }),
		).toBeTruthy();
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		expect(
			document.querySelectorAll("section.browser-capability"),
		).toHaveLength(1);
	});

	it("keeps the idle Browser card inside the collapsed context only (BR-01)", async () => {
		setup(withAgent({ browser: browserCapability }));
		await composer();
		const trigger = await screen.findByRole("button", { name: /^会话上下文/ });
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		const cards = document.querySelectorAll("section.browser-capability");
		expect(cards).toHaveLength(1);
		expect(cards[0]?.closest('[data-slot="collapsible-panel"]')).toBeTruthy();
		expect(
			screen
				.queryByRole("region", { name: "会话时间线" })
				?.querySelector("section.browser-capability") ?? null,
		).toBeNull();
		fireEvent.click(trigger);
		const region = screen.getByRole("region", { name: "浏览器操作" });
		expect(region.textContent).toContain("可请求");
		expect(within(region).queryByRole("button")).toBeNull();
	});

	it("keeps command feedback outside every collapsed panel (NI-83)", async () => {
		const pending = deferred<Response>();
		let attempt = 0;
		setup((request) => {
			if (request.method !== "POST") return undefined;
			attempt += 1;
			if (attempt === 1) return pending.promise;
			return new Response("down", { status: 500 });
		});
		const input = await composer();
		fireEvent.change(input, { target: { value: "Keep this draft" } });
		fireEvent.click(screen.getByRole("button", { name: "发送" }));
		const submitting = await screen.findByText("正在提交，请勿重复操作…");
		expect(submitting.getAttribute("role")).toBe("status");
		expect(submitting.closest('[data-slot="collapsible-panel"]')).toBeNull();
		await act(async () =>
			pending.resolve(
				Response.json(
					PilotProtocolErrorV1Schema.parse({
						schemaVersion: 1,
						code: "RUNTIME_UNAVAILABLE",
						message: "Runtime unavailable",
						retryable: true,
						traceId: "trace-503",
					}),
					{ status: 503 },
				),
			),
		);
		const refused = await screen.findByRole("alert");
		expect(refused.textContent).toContain(
			"Agent 暂时不可用，请稍后重试或联系 Owner。",
		);
		expect(
			within(refused).getByRole("button", { name: "重试原请求" }),
		).toBeTruthy();
		fireEvent.click(
			within(refused).getByRole("button", { name: "重试原请求" }),
		);
		const unknown = await screen.findByText(/提交结果尚未确认/);
		expect(unknown.closest('[data-slot="alert"]')?.getAttribute("role")).toBe(
			"alert",
		);
		expect(screen.getByRole("button", { name: "核实原请求" })).toBeTruthy();
		// 输入框被锁时读屏仍能读到原因。#3242 K7-02：提交未确认期间输入框只读并标为 aria-disabled，
		// 不再是原生 disabled（焦点不落到 body）。
		expect(input.readOnly).toBe(true);
		expect(input.getAttribute("aria-disabled")).toBe("true");
		expect(input.disabled).toBe(false);
		expect(input.getAttribute("aria-describedby")).toBe(unknown.id);
	});

	it("keeps a draft rewritten while the original request is retried (NI-91)", async () => {
		let attempt = 0;
		const { requests } = setup((request) => {
			if (request.method !== "POST") return undefined;
			attempt += 1;
			if (attempt > 1) return receipt();
			return Response.json(
				PilotProtocolErrorV1Schema.parse({
					schemaVersion: 1,
					code: "RUNTIME_UNAVAILABLE",
					message: "Runtime unavailable",
					retryable: true,
					traceId: "trace-503",
				}),
				{ status: 503 },
			);
		});
		const input = await composer();
		fireEvent.change(input, { target: { value: "原文A" } });
		fireEvent.click(screen.getByRole("button", { name: "发送" }));
		const retry = await screen.findByRole("button", { name: "重试原请求" });
		fireEvent.change(input, { target: { value: "改写B" } });
		fireEvent.click(retry);
		await pendingReply();
		const posts = requests.filter((request) => request.method === "POST");
		expect(posts).toHaveLength(2);
		expect(await posts[1].json()).toEqual({ schemaVersion: 1, text: "原文A" });
		expect(posts[1].headers.get("Idempotency-Key")).toBe(
			posts[0].headers.get("Idempotency-Key"),
		);
		expect(input.value).toBe("改写B");
	});

	it("explains unsupported supplementary instructions only when the draft is blocked by them (R4-07)", async () => {
		const processing = PersistedConversationEventV2Schema.parse({
			...event(1),
			type: "execution.status",
			payload: { status: "processing" },
		});
		setup(
			withAgent(
				{ supplementaryInstruction: false },
				conversationWith([processing], [userMessage()], "active"),
			),
		);
		const input = await composer();
		await pendingReply("执行中");
		expect(screen.getByText("正在整理结果…")).toBeTruthy();
		const hint = "当前回复仍在处理，不支持补充指令。草稿会保留。";
		expect(screen.queryByText(hint)).toBeNull();
		const send = screen.getByRole("button", { name: "发送" });
		expect(send.getAttribute("aria-describedby")).toBeNull();
		fireEvent.change(input, { target: { value: "补充一句" } });
		const note = screen.getByText(hint);
		expect((send as HTMLButtonElement).disabled).toBe(true);
		expect(send.getAttribute("aria-describedby")).toBe(note.id);
		// 停止入口只在处理中的回复卡内；composer 内没有。
		expect(input.closest("form")?.textContent).not.toContain("停止回复");
	});

	// E3-02：活跃回复期间不再启动新的命令任务或 Skill（PRD §11.3），「命令 / Skill」入口禁用；
	// 输入框与「发送补充指令」不受影响，回复结束后入口恢复。
	it("disables the command and Skill trigger during an active reply but keeps supplementary instructions (E3-02)", async () => {
		const processing = PersistedConversationEventV2Schema.parse({
			...event(1),
			type: "execution.status",
			payload: { status: "processing" },
		});
		setup(
			withAgent(
				{ supplementaryInstruction: true },
				conversationWith([processing], [userMessage()], "active"),
			),
		);
		const input = await composer();
		await pendingReply("执行中");
		const trigger = screen.getByRole("button", {
			name: "选择命令或 Skill",
		}) as HTMLButtonElement;
		expect(trigger.disabled).toBe(true);
		expect(input.disabled).toBe(false);
		fireEvent.change(input, { target: { value: "补充一句" } });
		expect(
			(
				screen.getByRole("button", {
					name: "发送补充指令",
				}) as HTMLButtonElement
			).disabled,
		).toBe(false);
	});

	it("collapses a failed reply into one status line with inline actions (R4-08, NI-07)", async () => {
		const failed = PersistedConversationEventV2Schema.parse({
			...event(1),
			type: "execution.status",
			payload: { status: "failed" },
		});
		const { requests } = setup((request) => {
			if (request.method === "POST")
				return Response.json(
					CommandAcceptedProjectionV1Schema.parse({
						schemaVersion: 1,
						executionId: "execution-2",
						messageId: null,
						status: "submitted",
					}),
					{ status: 202 },
				);
			return conversationWith(
				[failed],
				[
					userMessage(),
					answer({
						status: "failed",
						error: PilotProtocolErrorV1Schema.parse({
							schemaVersion: 1,
							code: "PROVIDER_RATE_LIMITED",
							message: "Synthetic provider detail",
							retryable: true,
							traceId: "trace-rate",
						}),
					}),
				],
			)(request);
		});
		const reply = await screen.findByRole("article", {
			name: `${agent.name}的消息`,
		});
		await within(reply).findByText("执行失败");
		expect(within(reply).queryByText("尚未输出正文。")).toBeNull();
		expect(reply.querySelector('[data-slot="badge"]')).toBeNull();
		const line = within(reply)
			.getByText("执行失败")
			.closest("p") as HTMLElement;
		expect(line.classList.contains("message-status")).toBe(true);
		expect(line.textContent).toContain("使用标准模板时，请检查个人 Relay Key");
		expect(line.textContent).toContain("可重新生成");
		expect(screen.queryByText("Synthetic provider detail")).toBeNull();
		// 同卡只有一个「重新生成」和一个「查看执行详情」，都在状态行内。
		const regenerate = within(line).getByRole("button", {
			name: "重新生成：Private question",
		});
		expect(
			within(reply).getAllByRole("button", { name: /^重新生成/ }),
		).toHaveLength(1);
		expect(
			within(reply).getAllByRole("button", { name: /^查看执行详情/ }),
		).toHaveLength(1);
		expect(
			within(reply).queryByRole("button", { name: "上一个回答版本" }),
		).toBeNull();
		expect(within(reply).queryByText(/版本 1\/1/)).toBeNull();
		fireEvent.click(regenerate);
		await waitFor(() =>
			expect(
				requests.some(
					(request) =>
						request.method === "POST" &&
						new URL(request.url).pathname.endsWith("/regenerations"),
				),
			).toBe(true),
		);
	});

	// #3377：失败回答显示 Core 给出的用户可见分类说明（工程 Spec §16.1.1），与企微同源。
	it("explains a failed reply with its failure category instead of the generic code text (#3377 AC-2)", async () => {
		const failed = PersistedConversationEventV2Schema.parse({
			...event(1),
			type: "execution.status",
			payload: { status: "failed" },
		});
		setup(
			conversationWith(
				[failed],
				[
					userMessage(),
					answer({
						status: "failed",
						error: PilotProtocolErrorV1Schema.parse({
							schemaVersion: 1,
							code: "EXECUTION_FAILED",
							message: "Execution failed.",
							retryable: false,
							traceId: "trace-file",
						}),
						failure: {
							category: "attachment_unreadable",
							message: "附件无法读取，请重新发送附件",
						},
					}),
				],
			),
		);
		const reply = await screen.findByRole("article", {
			name: `${agent.name}的消息`,
		});
		const line = (await within(reply).findByText("执行失败")).closest(
			"p",
		) as HTMLElement;
		expect(line.textContent).toContain(
			"执行失败 · 附件无法读取，请重新发送附件",
		);
		expect(line.textContent).not.toContain("请求未完成");
	});

	// #3377（PRD 11.2）：处理中的回复卡显示实际阶段与实时耗时，阶段只取已持久的事实。
	it("shows the persisted phase and a live elapsed time on a pending reply (#3377 AC-1)", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(Date.parse(timestamp) + 12_000);
		try {
			let sequence = 1;
			const next = (body: Record<string, unknown>) =>
				ConversationSseMessageV2Schema.parse({
					...event(++sequence),
					...body,
				});
			const modelFact = (phase: string, attemptRef: string) =>
				next({
					schemaVersion: 2,
					type: "execution.operation",
					payload: {
						kind: "model",
						operationRef: "model-call-1",
						attemptRef,
						phase,
						model: {
							configVersion: "config-1",
							modelOptionId: "model-1",
							modelId: "model-1",
						},
					},
				});
			const { streams } = setup(
				conversationWith(
					[],
					[{ ...userMessage(), status: "submitted" }],
					"active",
				),
			);
			const status = await pendingReply("准备会话");
			const elapsed = await screen.findByText("已用 12 秒");
			// 耗时每秒刷新，不放进读屏播报的状态区域。
			expect(elapsed.closest('[role="status"]')).toBeNull();
			expect(elapsed.closest("article")).toBe(status.closest("article"));
			vi.setSystemTime(Date.parse(timestamp) + 15_000);
			await screen.findByText("已用 15 秒", undefined, { timeout: 3_000 });
			act(() =>
				streams.at(-1)?.send(
					next({
						type: "execution.status",
						payload: { status: "processing" },
					}),
				),
			);
			await pendingReply("执行中");
			act(() =>
				streams.at(-1)?.send(
					ConversationSseMessageV2Schema.parse({
						...operationEvent(++sequence, "started"),
						conversationId: "conversation-1",
						conversationCursor: `conversation-1-cursor-${sequence}`,
					}),
				),
			);
			await pendingReply("调用工具：打开页面");
			act(() =>
				streams.at(-1)?.send(
					ConversationSseMessageV2Schema.parse({
						...operationEvent(++sequence, "completed"),
						conversationId: "conversation-1",
						conversationCursor: `conversation-1-cursor-${sequence}`,
					}),
					modelFact("started", "attempt-1"),
					modelFact("failed", "attempt-1"),
					modelFact("intent", "attempt-2"),
				),
			);
			await pendingReply("模型重试");
			act(() => streams.at(-1)?.send(modelFact("completed", "attempt-2")));
			await pendingReply("执行中");
		} finally {
			vi.useRealTimers();
		}
	});

	it("says 已停止 · 可重新生成 for a stopped reply without body text", async () => {
		const cancelled = PersistedConversationEventV2Schema.parse({
			...event(1),
			type: "execution.status",
			payload: { status: "cancelled" },
		});
		setup(
			conversationWith(
				[cancelled],
				[userMessage(), answer({ status: "cancelled" })],
			),
		);
		const reply = await screen.findByRole("article", {
			name: `${agent.name}的消息`,
		});
		const line = (await within(reply).findByText("已停止")).closest("p");
		expect(line?.textContent).toContain("已停止 · 可重新生成");
		expect(within(reply).queryByText("尚未输出正文。")).toBeNull();
	});

	it("confirms a cancelled stop with a toast and offers regeneration (Z-14)", async () => {
		const cancelled = PersistedConversationEventV2Schema.parse({
			...event(1),
			type: "execution.status",
			payload: { status: "cancelled" },
		});
		let stopped = false;
		const { requests } = setup((request) => {
			if (request.method === "POST") {
				const path = new URL(request.url).pathname;
				if (path.endsWith("/stops")) stopped = true;
				return receipt();
			}
			// 服务端投影：已取消的 Execution 即使没有正文也有一条回答（conversation-read-projection）。
			return stopped
				? conversationWith(
						[cancelled],
						[userMessage(), answer({ status: "cancelled" })],
					)(request)
				: conversationWith([], [userMessage()], "active")(request);
		});
		fireEvent.click(await screen.findByRole("button", { name: "停止回复" }));
		const toast = await screen.findByText("回复已停止", {
			selector: '[data-slot="toast"]',
		});
		expect(toast.getAttribute("data-state")).toBe("open");
		const reply = await screen.findByRole("article", {
			name: `${agent.name}的消息`,
		});
		const line = (await within(reply).findByText("已停止")).closest("p");
		expect(line?.textContent).toBe(
			"已停止 · 可重新生成 · 重新生成 · 查看执行详情",
		);
		// 停止已确认：不再说「原回复已结束。」，也不再显示「正在停止」。
		expect(screen.queryByText("原回复已结束。")).toBeNull();
		expect(
			screen.queryByRole("button", { name: /正在停止|停止回复/ }),
		).toBeNull();
		fireEvent.click(
			within(reply).getByRole("button", { name: "重新生成：Private question" }),
		);
		await waitFor(() =>
			expect(
				requests.some(
					(request) =>
						request.method === "POST" &&
						new URL(request.url).pathname.endsWith("/regenerations"),
				),
			).toBe(true),
		);
	});

	// A2-09：「停止回复」随处理中卡片卸载后，焦点移到该回复卡的「重新生成」，没有时移到输入框；
	// 用户已把焦点移到别处时不抢焦点。
	describe("focus after stopping a reply (A2-09)", () => {
		const cancelled = PersistedConversationEventV2Schema.parse({
			...event(1),
			type: "execution.status",
			payload: { status: "cancelled" },
		});
		function stoppable(
			answers: "with-answer" | "without-answer",
			gate?: Promise<void>,
		) {
			let stopped = false;
			setup(async (request) => {
				if (request.method === "POST") {
					if (new URL(request.url).pathname.endsWith("/stops")) stopped = true;
					return receipt();
				}
				if (!stopped)
					return conversationWith([], [userMessage()], "active")(request);
				// 停止受理后的回读可先挂起，页面停在「正在停止」。
				if (gate) await gate;
				return conversationWith(
					[cancelled],
					answers === "with-answer"
						? [userMessage(), answer({ status: "cancelled" })]
						: [userMessage()],
				)(request);
			});
		}

		it("moves focus to the stopped reply's 重新生成", async () => {
			stoppable("with-answer");
			const stop = await screen.findByRole("button", { name: "停止回复" });
			stop.focus();
			fireEvent.click(stop);
			const regenerate = await screen.findByRole("button", {
				name: "重新生成：Private question",
			});
			await waitFor(() => expect(document.activeElement).toBe(regenerate));
		});

		it("falls back to the message input when the reply has no 重新生成 yet", async () => {
			stoppable("without-answer");
			const stop = await screen.findByRole("button", { name: "停止回复" });
			stop.focus();
			fireEvent.click(stop);
			await screen.findByText("回复已停止", {
				selector: '[data-slot="toast"]',
			});
			await waitFor(() =>
				expect(
					screen.queryByRole("button", { name: /正在停止|停止回复/ }),
				).toBeNull(),
			);
			await waitFor(() =>
				expect(document.activeElement).toBe(
					screen.getByRole("textbox", { name: "消息" }),
				),
			);
		});

		it("keeps focus on 正在停止 while waiting and leaves it where the user moved it", async () => {
			let release = () => {};
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			stoppable("with-answer", gate);
			const stop = await screen.findByRole("button", { name: "停止回复" });
			stop.focus();
			fireEvent.click(stop);
			const stopping = await screen.findByRole("button", { name: "正在停止" });
			expect(document.activeElement).toBe(stopping);
			const input = await composer();
			await waitFor(() => expect(input.disabled).toBe(false));
			input.focus();
			release();
			await screen.findByRole("button", { name: "重新生成：Private question" });
			await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
			expect(document.activeElement).toBe(input);
		});
	});

	it("says 原回复已结束 when the reply finished before the stop took effect (Z-14, #1524)", async () => {
		const completed = PersistedConversationEventV2Schema.parse({
			...event(2),
			type: "execution.status",
			payload: { status: "completed" },
		});
		let stopped = false;
		setup((request) => {
			if (request.method === "POST") {
				stopped = true;
				return receipt();
			}
			return stopped
				? conversationWith(
						[event(1), completed],
						[userMessage(), answer({ text: "output 1" })],
					)(request)
				: conversationWith([event(1)], [userMessage()], "active")(request);
		});
		fireEvent.click(await screen.findByRole("button", { name: "停止回复" }));
		const notice = await screen.findByText("原回复已结束。");
		expect(notice.getAttribute("role")).toBe("status");
		expect(notice.closest("article")?.getAttribute("aria-label")).toBe(
			`${agent.name}的消息`,
		);
		expect(screen.queryByText("回复已停止")).toBeNull();
	});

	it("labels messages with the signed-in user and their times (CH-08)", async () => {
		const completed = PersistedConversationEventV2Schema.parse({
			...event(2),
			type: "execution.status",
			payload: { status: "completed" },
		});
		setup(
			conversationWith(
				[event(1), completed],
				[userMessage(), answer({ text: "output 1" })],
			),
		);
		const mine = await screen.findByRole("article", { name: "陈昊的消息" });
		expect(screen.queryByRole("article", { name: "你的消息" })).toBeNull();
		expect(within(mine).getByText("陈昊").tagName).toBe("STRONG");
		expect(
			mine.querySelector(".message-meta time")?.getAttribute("dateTime"),
		).toBe(timestamp);
		const reply = screen.getByRole("article", { name: `${agent.name}的消息` });
		expect(
			reply.querySelector(".message-meta time")?.getAttribute("dateTime"),
		).toBe(timestamp);
		expect(reply.querySelector('[data-slot="spinner"]')).toBeNull();
		const details = within(reply).getByRole("button", {
			name: "查看执行详情：Private question",
		});
		expect(details.closest("p")?.textContent).toContain("已完成");
		fireEvent.click(details);
		expect(
			await screen.findByRole("heading", { name: "执行详情" }),
		).toBeTruthy();
	});

	it("attaches model fallback to its reply and explains it in a dialog (G-07)", async () => {
		const completed = PersistedConversationEventV2Schema.parse({
			...event(3),
			type: "execution.status",
			payload: { status: "completed" },
		});
		const fallback = PersistedConversationEventV2Schema.parse({
			...event(1),
			type: "model.selection.fell_back",
			payload: {
				modelOptionId: "model-primary",
				reasoningLevel: "medium",
				reason: "selection_unavailable",
			},
		});
		setup((request) => {
			const path = new URL(request.url).pathname;
			if (path !== "/api/v2/conversations/conversation-1") return undefined;
			return Response.json({
				...history("conversation-1", [fallback, event(2), completed]),
				conversation: {
					...history().conversation,
					status: "ready",
					// 回退后会话所选已是默认项：不能据此推断「请求模型」。
					selectedModelOptionId: "model-primary",
					selectedReasoningLevel: "medium",
				},
				messages: [userMessage(), answer({ text: "output 2" })],
			});
		});
		const reply = await screen.findByRole("article", {
			name: `${agent.name}的消息`,
		});
		const line = (
			await within(reply).findByText(/模型回退 · 实际模型/)
		).closest("p") as HTMLElement;
		expect(line.textContent).toContain("实际模型 Primary model");
		const trigger = within(line).getByRole("button", {
			name: "查看模型状态：Private question",
		});
		act(() => trigger.focus());
		fireEvent.click(trigger);
		const dialog = await screen.findByRole("dialog", { name: "模型回退" });
		// 旧事件没有记录原选项：请求模型写中性文案，不按当前所选推断（AC-2、AC-3）。
		expect(fact(dialog, "请求模型")).toBe("已删除的模型选项");
		expect(fact(dialog, "实际模型")).toBe("Primary model");
		expect(within(dialog).getByText("原因")).toBeTruthy();
		expect(dialog.textContent).not.toContain("暂时不可用");
		expect(dialog.textContent).not.toContain("model-primary");
		expect(
			within(dialog).getByText(
				"执行记录会保留实际模型；不会静默切换到个人 Key 或未授权模型。",
			),
		).toBeTruthy();
		fireEvent.click(
			within(dialog)
				.getAllByRole("button", { name: "关闭" })
				.at(-1) as HTMLElement,
		);
		await waitFor(() =>
			expect(screen.queryByRole("dialog", { name: "模型回退" })).toBeNull(),
		);
		await waitFor(() => expect(document.activeElement).toBe(trigger));
		// 时间线末尾不再有独立的回退提示框。
		expect(screen.queryByText(/原模型选项已移除，此条消息/)).toBeNull();
	});

	it("shows the requested model recorded at fallback beside the actual model (G-07)", async () => {
		const completed = PersistedConversationEventV2Schema.parse({
			...event(3),
			type: "execution.status",
			payload: { status: "completed" },
		});
		const fallback = PersistedConversationEventV2Schema.parse({
			...event(1),
			schemaVersion: 2,
			type: "model.selection.fell_back",
			payload: {
				modelOptionId: "model-primary",
				reasoningLevel: "medium",
				reason: "selection_unavailable",
				requestedModelOptionId: "model-removed",
				requestedModelDisplayName: "gpt-removed-by-owner",
			},
		});
		setup((request) => {
			const path = new URL(request.url).pathname;
			if (path !== "/api/v2/conversations/conversation-1") return undefined;
			return Response.json({
				...history("conversation-1", [fallback, event(2), completed]),
				conversation: {
					...history().conversation,
					status: "ready",
					selectedModelOptionId: "model-primary",
					selectedReasoningLevel: "medium",
				},
				messages: [userMessage(), answer({ text: "output 2" })],
			});
		});
		const reply = await screen.findByRole("article", {
			name: `${agent.name}的消息`,
		});
		const line = (
			await within(reply).findByText(/模型回退 · 实际模型/)
		).closest("p") as HTMLElement;
		fireEvent.click(
			within(line).getByRole("button", {
				name: "查看模型状态：Private question",
			}),
		);
		const dialog = await screen.findByRole("dialog", { name: "模型回退" });
		expect(fact(dialog, "请求模型")).toBe("gpt-removed-by-owner");
		expect(fact(dialog, "实际模型")).toBe("Primary model");
		expect(dialog.textContent).not.toContain("model-removed");
		expect(dialog.textContent).not.toContain("model-primary");
	});

	it("shows the requested model from a fallback delivered live after sending (G-07, AC-1)", async () => {
		let accepted = false;
		const { streams } = setup((request) => {
			if (request.method === "POST") {
				accepted = true;
				return receipt();
			}
			if (
				new URL(request.url).pathname !== "/api/v2/conversations/conversation-1"
			)
				return undefined;
			return Response.json({
				...history("conversation-1", []),
				messages: accepted ? [userMessage("After removal")] : [],
			});
		});
		const input = await composer();
		fireEvent.change(input, { target: { value: "After removal" } });
		fireEvent.click(screen.getByRole("button", { name: "发送" }));
		await pendingReply();
		await waitFor(() => expect(streams.length).toBe(2));
		// 服务端在受理这条消息的同一事务里写入的 V2 回退事件，经 SSE 实时到达。
		act(() =>
			streams.at(-1)?.send({
				...event(1),
				schemaVersion: 2,
				type: "model.selection.fell_back",
				payload: {
					modelOptionId: "model-primary",
					reasoningLevel: "medium",
					reason: "selection_unavailable",
					requestedModelOptionId: "model-removed",
					requestedModelDisplayName: "gpt-removed-by-owner",
				},
			}),
		);
		const line = (await screen.findByText(/模型回退 · 实际模型/)).closest(
			"p",
		) as HTMLElement;
		fireEvent.click(
			within(line).getByRole("button", {
				name: "查看模型状态：After removal",
			}),
		);
		const dialog = await screen.findByRole("dialog", { name: "模型回退" });
		expect(fact(dialog, "请求模型")).toBe("gpt-removed-by-owner");
		expect(fact(dialog, "实际模型")).toBe("Primary model");
		expect(dialog.textContent).not.toContain("model-removed");
	});

	it("never mentions model fallback when no fallback event exists (AC-13)", async () => {
		setup(
			conversationWith(
				[event(1)],
				[userMessage(), answer({ text: "output 1" })],
			),
		);
		await screen.findByText("output 1");
		expect(document.body.textContent).not.toContain("回退");
		expect(document.body.textContent).not.toContain("不会静默切换");
		expect(screen.queryByRole("button", { name: /^查看模型状态/ })).toBeNull();
	});
});

describe("loading lines, read failures and notices on the conversation page (N-19, B-10)", () => {
	function loadingLine(text: string) {
		const line = screen.getByText(text);
		expect(line.getAttribute("data-slot")).toBe("loading-line");
		expect(line.getAttribute("role")).toBe("status");
		expect(line.querySelector('[data-slot="spinner"]')).not.toBeNull();
	}

	it("uses loading lines while the Agent, Conversation and history are read", async () => {
		const agentRead = deferred<Response>();
		const conversationRead = deferred<Response>();
		const recentRead = deferred<Response>();
		const historyRead = deferred<Response>();
		setup((request) => {
			const path = new URL(request.url).pathname;
			if (path === "/api/v2/agents/agent-1") return agentRead.promise;
			if (path === "/api/v2/conversations/conversation-1")
				return conversationRead.promise;
			if (path === "/api/v2/me/conversations/recent") return recentRead.promise;
			if (path === "/api/v1/agents/agent-1/conversations")
				return historyRead.promise;
		});
		await screen.findByText("正在读取 Agent…");
		loadingLine("正在读取 Agent…");
		await act(async () => agentRead.resolve(Response.json(agent)));
		await screen.findByText("正在读取会话…");
		loadingLine("正在读取会话…");
		loadingLine("正在读取最近对话…");
		fireEvent.click(
			screen.getByRole("button", { name: "此 Agent 的全部历史" }),
		);
		await screen.findByText("正在读取历史…");
		loadingLine("正在读取历史…");
		await act(async () => {
			conversationRead.resolve(
				Response.json({
					...history("conversation-1", []),
					conversation: { ...history().conversation, status: "ready" },
				}),
			);
			recentRead.resolve(Response.json({ items: [], nextCursor: null }));
			historyRead.resolve(Response.json({ items: [], nextCursor: null }));
		});
		await waitFor(() =>
			expect(document.querySelector('[data-slot="loading-line"]')).toBeNull(),
		);
	});

	it.each([
		[
			401,
			"登录",
			"当前会话已过期，需要重新登录后再进入工作区。",
			"button",
			"重新登录",
			"alert",
		],
		[
			403,
			"无法访问",
			"Agent 不存在，或你没有访问权限。",
			"link",
			"返回 Agent 目录",
			null,
		],
		[
			404,
			"无法访问",
			"Agent 不存在，或你没有访问权限。",
			"link",
			"返回 Agent 目录",
			null,
		],
		[
			503,
			"服务暂不可用",
			"暂时无法读取 Agent，请稍后重试。",
			"button",
			"重新读取",
			"alert",
		],
	] as const)(
		"shows the shared state card when the Agent read fails with %s",
		async (status, title, description, actionRole, action, role) => {
			setup((request) => {
				const path = new URL(request.url).pathname;
				if (path === "/api/v2/agents/agent-1")
					return Response.json({ message: "Controlled failure" }, { status });
				if (path.startsWith("/api/v1/session") || path.includes("/connection"))
					return new Response(null, { status: 503 });
			});
			const heading = await screen.findByRole("heading", {
				name: title,
				level: 2,
			});
			const card = heading.closest('[data-slot="state-card"]');
			if (!(card instanceof HTMLElement))
				throw new Error("Expected state card");
			expect(card.getAttribute("role")).toBe(role);
			expect(within(card).getByText(description)).toBeTruthy();
			expect(within(card).getByRole(actionRole, { name: action })).toBeTruthy();
			expect(
				screen.getByRole("heading", { name: "对话", level: 1 }),
			).toBeTruthy();
			expect(screen.queryByText(/Agent 列表/)).toBeNull();
			expect(screen.queryByRole("textbox", { name: "消息" })).toBeNull();
		},
	);

	it.each([
		["ready", 2],
		["expired", 1],
	] as const)(
		"re-reads the Agent after 重新登录 only when the session is %s (W-03)",
		async (kind, agentReads) => {
			let agentStatus = 401;
			let sessionStatus = 200;
			const { requests } = setup(
				(request) => {
					const path = new URL(request.url).pathname;
					if (path === "/api/v2/agents/agent-1")
						return agentStatus === 200
							? Response.json(agent)
							: Response.json(
									{
										schemaVersion: 1,
										code: "AUTHENTICATION_REQUIRED",
										message: "Controlled failure",
										retryable: false,
										traceId: "trace-w03",
									},
									{ status: agentStatus },
								);
					if (path === "/api/v1/session")
						return sessionStatus === 200
							? Response.json(currentUser)
							: Response.json(
									{
										schemaVersion: 1,
										code: "AUTHENTICATION_REQUIRED",
										message: "Controlled failure",
										retryable: false,
										traceId: "trace-w03",
									},
									{ status: sessionStatus },
								);
					if (path.includes("/connection"))
						return new Response(null, { status: 503 });
				},
				{ conversationId: undefined },
			);
			const agentRequests = () =>
				requests.filter(
					(request) =>
						new URL(request.url).pathname === "/api/v2/agents/agent-1",
				).length;
			const sessionRequests = () =>
				requests.filter(
					(request) => new URL(request.url).pathname === "/api/v1/session",
				).length;
			const relogin = await screen.findByRole("button", { name: "重新登录" });
			await waitFor(() => expect(sessionRequests()).toBeGreaterThan(0));
			const sessionReads = sessionRequests();
			expect(agentRequests()).toBe(1);
			agentStatus = 200;
			if (kind === "expired") sessionStatus = 401;
			fireEvent.click(relogin);
			await waitFor(() =>
				expect(sessionRequests()).toBeGreaterThan(sessionReads),
			);
			if (kind === "ready") {
				// 会话仍有效：解除闭锁后重读 Agent，进入可输入的新会话页，不再停在登录卡。
				expect(await composer()).toBeTruthy();
				expect(
					screen.getByRole("heading", { name: agent.name, level: 1 }),
				).toBeTruthy();
				expect(screen.queryByRole("button", { name: "重新登录" })).toBeNull();
			} else {
				// 会话已失效：不重读 Agent，仍停在登录卡，交给壳层切换到登录页。
				await waitFor(() =>
					expect(
						(
							screen.getByRole("button", {
								name: "重新登录",
							}) as HTMLButtonElement
						).disabled,
					).toBe(false),
				);
				expect(screen.queryByRole("textbox", { name: "消息" })).toBeNull();
			}
			expect(agentRequests()).toBe(agentReads);
			// 打开页面与恢复读取都不发写请求。
			expect(
				requests.filter((request) => request.method !== "GET"),
			).toHaveLength(0);
		},
	);

	it("shows the invalid-data card when the Agent response does not match", async () => {
		setup((request) =>
			new URL(request.url).pathname === "/api/v2/agents/agent-1"
				? Response.json({ ...agent, agentId: "agent-other" })
				: undefined,
		);
		const heading = await screen.findByRole("heading", {
			name: "数据无法读取",
			level: 2,
		});
		expect(
			heading.closest('[data-slot="state-card"]')?.getAttribute("role"),
		).toBe("alert");
		expect(screen.queryByRole("button", { name: "重新读取" })).toBeNull();
	});

	it("retries an unavailable Agent read from the state card", async () => {
		let failing = true;
		setup((request) =>
			failing && new URL(request.url).pathname === "/api/v2/agents/agent-1"
				? new Response("down", { status: 503 })
				: undefined,
		);
		const retry = await screen.findByRole("button", { name: "重新读取" });
		failing = false;
		fireEvent.click(retry);
		await composer();
		expect(screen.queryByRole("heading", { name: "服务暂不可用" })).toBeNull();
	});

	it("says lost access with a danger alert and a link back to the Agent directory", async () => {
		setup((request) =>
			new URL(request.url).pathname === "/api/v2/conversations/conversation-1"
				? Response.json(
						PilotProtocolErrorV1Schema.parse({
							schemaVersion: 1,
							code: "AUTHORIZATION_REVOKED",
							message: "Denied",
							retryable: false,
							traceId: "trace-denied",
						}),
						{ status: 403 },
					)
				: undefined,
		);
		const text = await screen.findByText(
			"当前登录或访问权限已失效，请重新登录或返回 Agent 目录。",
		);
		const notice = text.closest('[data-slot="alert"]');
		if (!(notice instanceof HTMLElement)) throw new Error("Expected notice");
		expect(notice.getAttribute("role")).toBe("alert");
		expect(notice.getAttribute("data-tone")).toBe("danger");
		expect(
			within(notice)
				.getByRole("link", { name: "返回 Agent 目录" })
				.getAttribute("href"),
		).toBe("/agents");
	});

	it("explains an unavailable conversation as a static warn notice", async () => {
		setup((request) =>
			new URL(request.url).pathname === "/api/v2/conversations/conversation-1"
				? Response.json({
						...history("conversation-1", []),
						conversation: { ...history().conversation, status: "unavailable" },
					})
				: undefined,
		);
		const text = await screen.findByText(
			"当前会话不可用，历史只读。请使用上方入口明确新建会话。",
		);
		const notice = text.closest('[data-slot="alert"]');
		if (!(notice instanceof HTMLElement)) throw new Error("Expected notice");
		expect(notice.getAttribute("role")).toBeNull();
		expect(notice.getAttribute("data-tone")).toBe("warn");
		expect(notice.querySelector(":scope > svg")).not.toBeNull();
	});
});

describe("thinking process above the answer (#2981)", () => {
	function thought(
		sequence: number,
		text: string,
		executionId = "execution-1",
		kind: "raw" | "summary" = "raw",
	) {
		return ReasoningDeltaEventV2Schema.parse({
			...event(sequence),
			executionId,
			schemaVersion: 2,
			type: "reasoning.delta",
			payload: { kind, text },
		});
	}
	function answerDelta(
		sequence: number,
		text: string,
		executionId = "execution-1",
	) {
		return PersistedConversationEventV2Schema.parse({
			...event(sequence),
			executionId,
			payload: { text },
		});
	}
	function answer(
		text: string,
		changes: Partial<{
			executionId: string;
			messageId: string;
			replyToMessageId: string;
			answerVersion: number;
			isCurrentAnswer: boolean;
		}> = {},
	) {
		return {
			...userMessage(),
			role: "assistant" as const,
			messageId: "answer-1",
			replyToMessageId: "message-1",
			text,
			answerVersion: 1,
			isCurrentAnswer: true,
			...changes,
		};
	}
	function detail(
		events: unknown[],
		messages: unknown[],
		status: "active" | "ready" = "ready",
		eventWindow?: { hasEarlier: boolean; beforeCursor: string | null },
	) {
		const last = events.at(-1) as { conversationCursor?: string } | undefined;
		return Response.json(
			ConversationDetailProjectionV2Schema.parse({
				...history("conversation-1", []),
				conversation: {
					...history().conversation,
					status,
					lastConversationCursor: last?.conversationCursor ?? null,
				},
				messages,
				events,
				...(eventWindow ? { eventWindow } : {}),
			}),
		);
	}
	const detailPath = "/api/v2/conversations/conversation-1";
	function thinkingToggle(objectName = "Private question") {
		return screen.getByRole("button", { name: `思考过程：${objectName}` });
	}
	function thinkingPanel(toggle: HTMLElement) {
		const panel = document.getElementById(
			toggle.getAttribute("aria-controls") ?? "",
		);
		if (!panel) throw new Error("Expected the thinking panel");
		return panel;
	}

	it("streams the thinking open above a pending reply and folds it once the answer starts", async () => {
		const { streams } = setup((request) =>
			new URL(request.url).pathname === detailPath
				? detail([], [{ ...userMessage(), status: "processing" }], "active")
				: undefined,
		);
		await screen.findByText("Private question");
		await waitFor(() => expect(streams.length).toBeGreaterThan(0));
		// 没有思考内容时不渲染思考区域。
		expect(screen.queryByRole("button", { name: /^思考过程/ })).toBeNull();
		act(() =>
			streams.at(-1)?.send(thought(1, "先读题，"), thought(2, "再作答。")),
		);
		const toggle = await screen.findByRole("button", {
			name: "思考过程：Private question",
		});
		const panel = thinkingPanel(toggle);
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		expect(panel.hidden).toBe(false);
		expect(panel.textContent).toBe("先读题，再作答。");
		// 「展开 / 收起」只是视觉提示，不进入可访问名称；正文不是 live region。
		expect(toggle.textContent).toContain("收起");
		expect(panel.closest("[role=status],[aria-live]")).toBeNull();
		const article = toggle.closest("article") as HTMLElement;
		// 思考过程在回答正文之上。
		expect(
			within(article)
				.getByText("正在整理结果…")
				.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_PRECEDING,
		).toBeTruthy();

		act(() => streams.at(-1)?.send(answerDelta(3, "最终答案")));
		await within(article).findByText("最终答案");
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		expect(panel.hidden).toBe(true);
		expect(article.querySelector(".assistant-markdown")?.textContent).toBe(
			"最终答案",
		);
	});

	it("keeps a completed answer's thinking folded, complete and unduplicated after reload", async () => {
		const events = [thought(1, "第一步，"), thought(2, "第二步。")];
		const { streams } = setup((request) =>
			new URL(request.url).pathname === detailPath
				? detail(
						[...events, answerDelta(3, "最终答案")],
						[userMessage(), answer("最终答案")],
					)
				: undefined,
		);
		await screen.findByText("最终答案");
		const toggle = thinkingToggle();
		const panel = thinkingPanel(toggle);
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		expect(panel.hidden).toBe(true);
		// 流里重放的同一事件不会让思考过程重复。
		await waitFor(() => expect(streams.length).toBeGreaterThan(0));
		act(() => streams.at(-1)?.send(events[1]));
		fireEvent.click(toggle);
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		expect(panel.hidden).toBe(false);
		expect(panel.textContent).toBe("第一步，第二步。");
		expect(screen.getByText("最终答案").textContent).toBe("最终答案");
	});

	it("shows each answer version's own thinking", async () => {
		setup((request) =>
			new URL(request.url).pathname === detailPath
				? detail(
						[
							thought(1, "旧版本的思考"),
							thought(2, "新版本的思考", "execution-2"),
						],
						[
							userMessage(),
							answer("Old answer", { isCurrentAnswer: false }),
							answer("New answer", {
								executionId: "execution-2",
								messageId: "answer-2",
								answerVersion: 2,
							}),
						],
					)
				: undefined,
		);
		await screen.findByText("New answer");
		expect(thinkingPanel(thinkingToggle()).textContent).toBe("新版本的思考");
		fireEvent.click(screen.getByRole("button", { name: "上一个回答版本" }));
		await screen.findByText("Old answer");
		expect(thinkingPanel(thinkingToggle()).textContent).toBe("旧版本的思考");
		expect(screen.queryByText("新版本的思考")).toBeNull();
	});

	it("keeps the reader's choice when the live reply becomes the recorded answer", async () => {
		let phase: "running" | "completed" = "running";
		const { streams } = setup((request) =>
			new URL(request.url).pathname === detailPath
				? phase === "running"
					? detail(
							[thought(1, "推理中")],
							[{ ...userMessage(), status: "processing" }],
							"active",
						)
					: detail(
							[
								thought(1, "推理中"),
								answerDelta(2, "完成的答案"),
								PersistedConversationEventV2Schema.parse({
									...event(3),
									type: "execution.status",
									payload: { status: "completed" },
								}),
							],
							[userMessage(), answer("完成的答案")],
						)
				: undefined,
		);
		const toggle = await screen.findByRole("button", {
			name: "思考过程：Private question",
		});
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		await waitFor(() => expect(streams.length).toBeGreaterThan(0));
		act(() => streams.at(-1)?.send(answerDelta(2, "完成的答案")));
		await waitFor(() =>
			expect(thinkingToggle().getAttribute("aria-expanded")).toBe("false"),
		);
		// 用户在答案出现后手动展开；回复卡换成已记录的回答后仍保持展开。
		fireEvent.click(thinkingToggle());
		expect(thinkingToggle().getAttribute("aria-expanded")).toBe("true");
		phase = "completed";
		act(() =>
			streams.at(-1)?.send(
				PersistedConversationEventV2Schema.parse({
					...event(3),
					type: "execution.status",
					payload: { status: "completed" },
				}),
			),
		);
		await screen.findByRole("button", {
			name: "重新生成：Private question",
		});
		expect(thinkingToggle().getAttribute("aria-expanded")).toBe("true");
		expect(thinkingPanel(thinkingToggle()).textContent).toBe("推理中");
	});

	it("shows an earlier answer's thinking once after loading earlier content", async () => {
		const old = {
			...userMessage("old question"),
			messageId: "message-old",
			executionId: "execution-old",
		};
		const recent = {
			...userMessage("new question"),
			messageId: "message-new",
			executionId: "execution-new",
		};
		const earlier = [
			thought(1, "更早的思考", "execution-old"),
			answerDelta(2, "Old answer", "execution-old"),
		];
		setup((request) => {
			const url = new URL(request.url);
			if (url.pathname !== detailPath) return undefined;
			if (url.searchParams.has("beforeCursor"))
				return detail(earlier, [], "ready", {
					hasEarlier: false,
					beforeCursor: null,
				});
			return detail(
				[answerDelta(3, "Newest answer", "execution-new")],
				[
					old,
					answer("", {
						executionId: "execution-old",
						messageId: "answer-old",
						replyToMessageId: "message-old",
					}),
					recent,
					answer("Newest answer", {
						executionId: "execution-new",
						messageId: "answer-new",
						replyToMessageId: "message-new",
					}),
				],
				"ready",
				{ hasEarlier: true, beforeCursor: "before-cursor" },
			);
		});
		await screen.findByText("Newest answer");
		expect(
			screen.queryByRole("button", { name: "思考过程：old question" }),
		).toBeNull();
		fireEvent.click(
			screen.getByRole("button", { name: "加载更早内容：old question" }),
		);
		expect(await screen.findByText("Old answer")).toBeTruthy();
		const toggle = thinkingToggle("old question");
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		expect(thinkingPanel(toggle).textContent).toBe("更早的思考");
		expect(
			screen.queryByRole("button", { name: "思考过程：new question" }),
		).toBeNull();
	});
});

describe("sandbox: references and result files on the conversation page (#3228)", () => {
	const answerText =
		"结果如下：\n\n![销量图](sandbox:out/chart.png)\n\n请查看[季度报告](sandbox:/out/r.pdf)。\n\n![未发布](sandbox:out/missing.png)";
	function resultFile(
		sequence: number,
		payload: {
			fileId: string;
			name: string;
			mediaType: string;
			sizeBytes: number;
			workspaceReference: string | null;
		},
	) {
		return PersistedConversationEventV2Schema.parse({
			...event(sequence),
			schemaVersion: 2,
			type: "result.file",
			payload,
		});
	}
	const chart = {
		fileId: "chart-1",
		name: "chart.png",
		mediaType: "image/png",
		sizeBytes: 4,
		workspaceReference: "out/chart.png",
	};
	const report = {
		fileId: "report-1",
		name: "r.pdf",
		mediaType: "application/pdf",
		sizeBytes: 2048,
		workspaceReference: "out/r.pdf",
	};
	const detail = ConversationDetailProjectionV2Schema.parse({
		...history("conversation-1", [
			resultFile(2, chart),
			resultFile(3, report),
			PersistedConversationEventV2Schema.parse({
				...event(4),
				type: "execution.status",
				payload: { status: "completed" },
			}),
		]),
		conversation: { ...history().conversation, status: "ready" },
		messages: [
			userMessage("请出图并给出报告"),
			{
				messageId: "answer-1",
				role: "assistant",
				text: answerText,
				status: "completed",
				executionId: "execution-1",
				replyToMessageId: "message-1",
				answerVersion: 1,
				isCurrentAnswer: true,
				error: null,
				createdAt: timestamp,
			},
		],
	});
	function access(fileId: string, token: string) {
		return Response.json({
			schemaVersion: 1,
			accessId: `access-${fileId}`,
			file: { ...fileProjection(), fileId, kind: "result" },
			path: `/api/v1/conversations/conversation-1/files/${fileId}/content`,
			grant: { format: "compact-jws", schemaVersion: 1, token },
			expiresAt: "2027-01-01T00:00:00Z",
		});
	}
	function filesSetup(accessStatus = 200) {
		return setup((request) => {
			const path = new URL(request.url).pathname;
			if (path === "/api/v2/conversations/conversation-1")
				return Response.json(detail);
			const match = path.match(
				/^\/api\/v1\/conversations\/conversation-1\/files\/([^/]+)\/(access|content)$/,
			);
			if (!match) return undefined;
			const [, fileId, operation] = match;
			if (operation === "access" && request.method === "POST")
				return accessStatus === 200
					? access(fileId ?? "", `${fileId}-grant`)
					: Response.json(
							{
								schemaVersion: 1,
								code: "NOT_FOUND",
								message: "Not found",
								retryable: false,
								traceId: "trace-1",
							},
							{ status: accessStatus },
						);
			if (operation === "content" && request.method === "GET")
				return new Response(new Uint8Array([137, 80, 78, 71]), {
					headers: {
						"content-type":
							fileId === "chart-1" ? "image/png" : "application/pdf",
					},
				});
			return undefined;
		});
	}
	const fileRequests = (requests: Request[], fileId?: string) =>
		requests.filter((request) =>
			new URL(request.url).pathname.includes(
				fileId ? `/files/${fileId}/` : "/files/",
			),
		);
	const originalCreateObjectUrl = URL.createObjectURL;
	const originalRevokeObjectUrl = URL.revokeObjectURL;
	function stubObjectUrls() {
		let next = 0;
		const create = vi.fn(() => `blob:result-${++next}`);
		Object.defineProperty(URL, "createObjectURL", {
			configurable: true,
			value: create,
		});
		Object.defineProperty(URL, "revokeObjectURL", {
			configurable: true,
			value: vi.fn(),
		});
		return create;
	}
	afterEach(() => {
		for (const [key, value] of [
			["createObjectURL", originalCreateObjectUrl as unknown],
			["revokeObjectURL", originalRevokeObjectUrl as unknown],
		] as const) {
			if (value) Object.defineProperty(URL, key, { configurable: true, value });
			else delete (URL as Partial<Record<typeof key, unknown>>)[key];
		}
	});

	it("shows the image inline through a fresh read grant and the file as a previewable, downloadable card (AC-1)", async () => {
		const createObjectUrl = stubObjectUrls();
		const { requests } = filesSetup();
		const reply = (await screen.findByText(/结果如下/)).closest("article");
		if (!reply) throw new Error("reply card missing");
		const image = await within(reply).findByRole<HTMLImageElement>("img", {
			name: "销量图",
		});
		expect(image.getAttribute("src")).toMatch(/^blob:result-/);
		const chartRequests = fileRequests(requests, "chart-1");
		expect(
			chartRequests.map((request) => [
				request.method,
				new URL(request.url).pathname,
			]),
		).toEqual([
			["POST", "/api/v1/conversations/conversation-1/files/chart-1/access"],
			["GET", "/api/v1/conversations/conversation-1/files/chart-1/content"],
		]);
		expect(await chartRequests[0]?.json()).toEqual({
			schemaVersion: 1,
			operation: "read",
		});
		// Grant 只在专用 Header 中，不进入 URL。
		expect(chartRequests[1]?.headers.get("X-Platform-File-Grant")).toBe(
			"chart-1-grant",
		);
		expect(requests.some((request) => request.url.includes("grant"))).toBe(
			false,
		);
		// 未发布的引用只是纯文本占位；文件卡在用户操作前不读取内容。
		expect(within(reply).getByText("图片未发送：未发布")).toBeTruthy();
		expect(fileRequests(requests, "report-1")).toHaveLength(0);
		expect(fileRequests(requests)).toHaveLength(2);

		const card = within(reply).getByRole("group", {
			name: "结果文件：r.pdf",
		});
		expect(within(card).getByText("季度报告")).toBeTruthy();
		expect(within(card).getByText("application/pdf · 2 KB")).toBeTruthy();
		// 下方结果文件列表继续列出全部结果文件，每个文件一行；已在回答中显示的只列名称，
		// 不重复预览与下载入口，整张回复卡没有同名控件（N-12）。
		const list = within(reply).getByText("结果文件", { selector: "p" })
			.parentElement as HTMLElement;
		expect(within(list).getAllByText(/chart\.png|r\.pdf/)).toHaveLength(2);
		expect(within(list).getAllByText("已在回答中显示")).toHaveLength(2);
		expect(within(list).queryByRole("button")).toBeNull();
		const names = within(reply)
			.getAllByRole("button")
			.map((button) => button.getAttribute("aria-label") ?? button.textContent);
		expect(new Set(names).size).toBe(names.length);

		fireEvent.click(
			within(reply).getByRole("button", { name: "预览图片：销量图" }),
		);
		const dialog = await screen.findByRole("dialog");
		expect(
			within(dialog).getByRole<HTMLImageElement>("img", { name: "chart.png" }),
		).toBeTruthy();
		// 打开预览与其他预览一样重新签发读取授权，不复用内联 Blob（撤权后预览即被拒绝）。
		expect(
			fileRequests(requests, "chart-1").map((request) => request.method),
		).toEqual(["POST", "GET", "POST", "GET"]);
		fireEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

		fireEvent.click(within(card).getByRole("button", { name: "预览：r.pdf" }));
		const pdfDialog = await screen.findByRole("dialog");
		const pdf = await within(pdfDialog).findByTitle("r.pdf");
		expect(pdf.tagName).toBe("IFRAME");
		expect(pdf.getAttribute("sandbox")).toBe("");
		fireEvent.click(within(pdfDialog).getByRole("button", { name: "关闭" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		const downloads = createObjectUrl.mock.calls.length;
		fireEvent.click(within(card).getByRole("button", { name: "下载：r.pdf" }));
		await waitFor(() =>
			expect(createObjectUrl.mock.calls.length).toBeGreaterThan(downloads),
		);
		// 预览与下载各自签发一次新的读取授权。
		expect(
			fileRequests(requests, "report-1").filter((request) =>
				request.url.endsWith("/access"),
			),
		).toHaveLength(2);
	});

	it.each([401, 403, 404])(
		"refuses a %s inline read like an unsent image without reading content (AC-5)",
		async (status) => {
			stubObjectUrls();
			const { requests } = filesSetup(status);
			const reply = (await screen.findByText(/结果如下/)).closest("article");
			if (!reply) throw new Error("reply card missing");
			await within(reply).findByText("图片未发送：销量图");
			expect(within(reply).queryByRole("img")).toBeNull();
			expect(
				fileRequests(requests, "chart-1").map((request) => request.method),
			).toEqual(["POST"]);
			// 拒绝与未发布显示同一占位，页面不说明文件是否存在。
			expect(within(reply).getByText("图片未发送：未发布")).toBeTruthy();
			// 读取失败的图片不算已显示：下方列表保留它的下载入口；文件卡仍只渲染一次。
			const list = within(reply).getByText("结果文件", { selector: "p" })
				.parentElement as HTMLElement;
			expect(
				within(list).getByRole("button", { name: "下载：chart.png" }),
			).toBeTruthy();
			expect(
				within(list).queryByRole("button", { name: "下载：r.pdf" }),
			).toBeNull();
		},
	);

	it("removes inline images when access is revoked and reads nothing afterwards (AC-5)", async () => {
		stubObjectUrls();
		const { requests, streams } = filesSetup();
		await screen.findByRole("img", { name: "销量图" });
		const before = fileRequests(requests).length;
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
		expect(screen.queryByRole("img", { name: "销量图" })).toBeNull();
		expect(screen.queryByRole("group", { name: "结果文件：r.pdf" })).toBeNull();
		expect(fileRequests(requests)).toHaveLength(before);
	});

	it("accepts non-image files allowed by FileLimits and rejects the rest before uploading, with the reason (AC-3)", async () => {
		const originalCrypto = globalThis.crypto;
		let next = 0;
		vi.stubGlobal("crypto", {
			...(originalCrypto ?? {}),
			randomUUID: () => `upload-local-${++next}`,
			subtle: { digest: async () => new ArrayBuffer(32) },
		});
		try {
			const { requests } = setup((request) => {
				const path = new URL(request.url).pathname;
				if (path === "/api/v2/agents/agent-1/file-limits")
					return Response.json({
						schemaVersion: 1,
						declaration: {
							schemaVersion: 1,
							scope: "agent",
							revision: 2,
							expiresAt: "2027-01-01T00:00:00Z",
							mediaTypes: [
								"application/pdf",
								"text/csv",
								"text/plain",
								"application/zip",
							],
							maxBytes: 1024,
							updatedAt: "2026-01-01T00:00:00Z",
							updatedBy: "user-chat",
						},
					});
				// 本用例只验证上传前的放行与拒绝；创建失败即结束传输。
				if (request.method === "POST" && path.endsWith("/files"))
					return new Response(null, { status: 503 });
				return undefined;
			});
			await screen.findByText(
				"支持 application/pdf, text/csv, text/plain, application/zip，单文件最大 1 KB",
			);
			openFiles();
			const input =
				await screen.findByLabelText<HTMLInputElement>("选择附件文件");
			expect(input.accept).toBe(
				"application/pdf,text/csv,text/plain,application/zip",
			);
			fireEvent.change(input, {
				target: {
					files: [
						new File(["%PDF-1.7"], "report.pdf", { type: "application/pdf" }),
						new File(["a,b\n1,2"], "table.csv", { type: "text/csv" }),
						// #3257：声明 text/csv 却不是 UTF-8 文本的内容在上传前拒绝。
						new File([Uint8Array.from([0xc3, 0xfb, 0x2c, 0x0a])], "gbk.csv", {
							type: "text/csv",
						}),
						new File(["notes"], "notes.txt", { type: "text/plain" }),
						new File(["PK"], "bundle.zip", { type: "application/zip" }),
						new File(["png"], "photo.png", { type: "image/png" }),
						new File(["x".repeat(2048)], "huge.pdf", {
							type: "application/pdf",
						}),
					],
				},
			});
			await screen.findByText("当前 Agent 不支持此文件类型。");
			await screen.findByText("文件超过 1 KB 限制。");
			await screen.findByText(
				"文件内容不是有效的 UTF-8 文本，与文件类型不符。",
			);
			await waitFor(() =>
				expect(
					requests.filter(
						(request) =>
							request.method === "POST" &&
							new URL(request.url).pathname.endsWith("/files"),
					),
				).toHaveLength(4),
			);
			const created = await Promise.all(
				requests
					.filter(
						(request) =>
							request.method === "POST" &&
							new URL(request.url).pathname.endsWith("/files"),
					)
					.map(async (request) => (await request.json()).descriptor),
			);
			expect(
				created
					.map(
						(descriptor: { name: string; mediaType: string }) =>
							`${descriptor.name}:${descriptor.mediaType}`,
					)
					.sort(),
			).toEqual([
				"bundle.zip:application/zip",
				"notes.txt:text/plain",
				"report.pdf:application/pdf",
				"table.csv:text/csv",
			]);
		} finally {
			vi.stubGlobal("crypto", originalCrypto);
		}
	});
});
