import {
	AgentApplicationProjectionV2Schema,
	AgentProjectionV2Schema,
	ConversationDetailProjectionV2Schema,
	ConversationPageV1Schema,
	PilotProtocolErrorV1Schema,
} from "@agent-infra/contracts/pilot";
import { pilotFakeScenariosV2 } from "@agent-infra/test-support/pilot";
import { expect, type Page, test } from "@playwright/test";
import {
	event,
	history,
	timestamp,
} from "../src/features/conversation/conversation-test-fixtures";
import { pendingApplication } from "../src/features/my-agents/test-fixtures";
import type {
	AgentProjectionV2,
	ConversationDetailProjectionV2,
} from "../src/pilot/generated-v2/types.gen";

type ControlledSession = {
	tag: "old" | "new";
	userId: string;
	roles: ("employee" | "system_admin")[];
	generation: string;
};

async function workbenchFixture(
	page: Page,
	{
		managementStatus = "stopped",
		serviceAvailability = null,
		conversationUnavailable = false,
		administrator = false,
		attention = false,
		longNames = false,
		holdRecent,
		substitution,
	}: {
		managementStatus?: AgentProjectionV2["managementStatus"];
		serviceAvailability?: AgentProjectionV2["serviceAvailability"];
		conversationUnavailable?: boolean;
		administrator?: boolean;
		attention?: boolean;
		longNames?: boolean;
		holdRecent?: "first" | "continuation";
		substitution?:
			| "agent-id"
			| "conversation-id"
			| "conversation-agent"
			| "event-conversation";
	} = {},
) {
	const agents = ["agent-b", "agent-a"].map((agentId, index) =>
		AgentProjectionV2Schema.parse({
			...pilotFakeScenariosV2.starting.response.body,
			agentId,
			name: `受控助手 ${agentId}${longNames ? " 中文长名称".repeat(25) : ""}`,
			managementStatus: index === 0 ? "available" : managementStatus,
			serviceAvailability: index === 0 ? "ready" : serviceAvailability,
		}),
	);
	const failedAgent = AgentProjectionV2Schema.parse({
		...agents[0],
		agentId: "controlled-failed-agent",
		name: "受控创建失败助手",
		managementStatus: "creation_failed",
		serviceAvailability: null,
	});
	const applications = attention
		? [
				pendingApplication,
				AgentApplicationProjectionV2Schema.parse({
					...pendingApplication,
					applicationId: "controlled-rejected-application",
					name: "受控驳回申请",
					status: "rejected",
					decision: {
						reason: "受控申请需要缩小可用范围。",
						decidedAt: timestamp,
					},
				}),
			]
		: [];
	const conversations = [
		"conversation-z",
		"conversation-a",
		"conversation-m",
	].map((conversationId, index) => ({
		...history(conversationId, []).conversation,
		agentId: agents[index % 2]?.agentId ?? "agent-b",
		title: `受控最近对话 ${conversationId}${longNames ? " 中文长标题".repeat(30) : ""}`,
		status:
			index === 1 && conversationUnavailable
				? ("unavailable" as const)
				: ("ready" as const),
		updatedAt: `2026-10-01T0${3 - index}:00:00Z`,
	}));
	const currentConversation = {
		...conversations[0],
		conversationId: "conversation-current",
		title: "当前身份的受控对话",
	};
	const detail = (conversation: (typeof conversations)[number]) => {
		const userMessage = `${conversation.conversationId}-user`;
		const executionId = `${conversation.conversationId}-execution`;
		return ConversationDetailProjectionV2Schema.parse({
			...history(conversation.conversationId, []),
			conversation,
			messages: [
				{
					messageId: userMessage,
					role: "user",
					text: `受控原始问题 ${conversation.conversationId}`,
					executionId,
					replyToMessageId: null,
					answerVersion: null,
					isCurrentAnswer: null,
					createdAt: timestamp,
					status: "completed",
					error: null,
				},
				{
					messageId: `${conversation.conversationId}-answer`,
					role: "assistant",
					text: `受控历史正文 ${conversation.conversationId}`,
					executionId,
					replyToMessageId: userMessage,
					answerVersion: 1,
					isCurrentAnswer: true,
					createdAt: timestamp,
					status: "completed",
					error: null,
				},
			],
		});
	};
	const requests: {
		method: string;
		path: string;
		search: string;
		cursor: string | null;
		tag: ControlledSession["tag"];
	}[] = [];
	const unexpected: string[] = [];
	const held: string[] = [];
	let continuationStatus = 200;
	let recovery = false;
	let session: ControlledSession = {
		tag: "old",
		userId: "controlled-employee",
		roles: administrator ? ["employee", "system_admin"] : ["employee"],
		generation: "g".repeat(43),
	};
	let release!: () => void;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	// The late-response fixture deliberately lets network responses complete
	// after abort. Observe the real consumer signal; do not touch its cache.
	await page.addInitScript(
		({ ignoreAbort }) => {
			const observed = { aborted: [] as string[], completed: [] as string[] };
			Object.assign(window, { controlledWorkbenchTransport: observed });
			const fetch = window.fetch.bind(window);
			window.fetch = async (input, init) => {
				const request = new Request(input, init);
				const url = new URL(request.url);
				if (url.pathname.startsWith("/api/"))
					request.signal.addEventListener(
						"abort",
						() => observed.aborted.push(url.pathname + url.search),
						{ once: true },
					);
				const ignoresSignal =
					ignoreAbort &&
					(url.pathname.endsWith("/recent") ||
						url.pathname.startsWith("/api/v2/admin/"));
				const response = await fetch(
					ignoresSignal
						? new Request(request, { signal: new AbortController().signal })
						: request,
				);
				observed.completed.push(url.pathname + url.search);
				if (!url.pathname.endsWith("/events")) return response;
				void response.body?.cancel();
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(
								new TextEncoder().encode(": controlled heartbeat\n\n"),
							);
							if (request.signal.aborted) controller.close();
							else
								request.signal.addEventListener(
									"abort",
									() => controller.close(),
									{ once: true },
								);
						},
					}),
					{ status: response.status, headers: response.headers },
				);
			};
		},
		{ ignoreAbort: Boolean(holdRecent) },
	);
	await page.route("**/api/**", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const actor = session;
		requests.push({
			method: request.method(),
			path: url.pathname,
			search: url.search,
			cursor: url.searchParams.get("cursor"),
			tag: actor.tag,
		});
		if (request.method() !== "GET") {
			unexpected.push(`${request.method()} ${url.pathname}`);
			return route.abort();
		}
		if (url.pathname === "/api/v1/session")
			return route.fulfill({
				json: {
					schemaVersion: 1,
					user: {
						userId: actor.userId,
						displayName: `受控员工 ${actor.userId}`,
						roles: actor.roles,
					},
				},
				headers: { "X-Platform-Session-Generation": actor.generation },
			});
		if (url.pathname === "/api/v2/me/conversations/recent") {
			const more = url.searchParams.has("cursor");
			if (
				actor.tag === "old" &&
				holdRecent === (more ? "continuation" : "first")
			) {
				held.push(url.pathname + url.search);
				await pending;
			}
			if (more && continuationStatus !== 200)
				return route.fulfill({
					status: continuationStatus,
					json: PilotProtocolErrorV1Schema.parse({
						schemaVersion: 1,
						code:
							continuationStatus === 401
								? "AUTHENTICATION_REQUIRED"
								: continuationStatus === 403
									? "AUTHORIZATION_REVOKED"
									: "RESOURCE_UNAVAILABLE",
						message: "Controlled recent failure",
						retryable: continuationStatus >= 500,
						traceId: "controlled-recent-failure",
					}),
				});
			return route.fulfill({
				json: ConversationPageV1Schema.parse({
					items:
						actor.tag === "new"
							? [currentConversation]
							: more
								? conversations.slice(2)
								: recovery
									? [conversations[2]]
									: conversations.slice(0, 2),
					nextCursor:
						actor.tag === "new" || recovery
							? null
							: more
								? holdRecent
									? "late-old-cursor/+?="
									: null
								: "opaque-next/+?=",
				}),
			});
		}
		if (url.pathname.startsWith("/api/v2/admin/")) {
			if (holdRecent === "first" && actor.tag === "old") {
				held.push(url.pathname);
				await pending;
			}
			if (!actor.roles.includes("system_admin")) {
				unexpected.push(`non-admin ${url.pathname}`);
				return route.fulfill({ status: 403 });
			}
			if (url.pathname === "/api/v2/admin/agents")
				return route.fulfill({
					json: { items: attention ? [failedAgent] : [], nextCursor: null },
				});
			if (url.pathname === "/api/v2/admin/agent-applications")
				return route.fulfill({
					json: {
						items: attention ? [pendingApplication] : [],
						nextCursor: null,
					},
				});
		}
		if (url.pathname === "/api/v2/agents")
			return route.fulfill({
				json: {
					items:
						url.searchParams.get("scope") === "owner"
							? attention
								? [failedAgent]
								: []
							: attention
								? [...agents, failedAgent]
								: agents,
					nextCursor: null,
				},
			});
		if (url.pathname === "/api/v2/agent-applications")
			return route.fulfill({ json: { items: applications, nextCursor: null } });
		const agent = agents.find(
			(candidate) => url.pathname === `/api/v2/agents/${candidate.agentId}`,
		);
		if (agent)
			return route.fulfill({
				json:
					substitution === "agent-id"
						? {
								...agent,
								agentId: "substituted-agent",
								name: "不可泄露的替换 Agent",
							}
						: agent,
			});
		for (const agent of agents) {
			if (url.pathname === `/api/v1/agents/${agent.agentId}/conversations`)
				return route.fulfill({
					json: ConversationPageV1Schema.parse({
						items: conversations.filter(
							(conversation) => conversation.agentId === agent.agentId,
						),
						nextCursor: null,
					}),
				});
		}
		const conversation = conversations.find(
			(candidate) =>
				url.pathname === `/api/v2/conversations/${candidate.conversationId}`,
		);
		if (conversation) {
			const response: ConversationDetailProjectionV2 = detail(conversation);
			if (substitution) {
				response.messages = response.messages.map((message, index) =>
					index === 0 ? { ...message, text: "不可泄露的替换历史" } : message,
				);
				if (substitution === "conversation-id")
					response.conversation.conversationId = "substituted-conversation";
				if (substitution === "conversation-agent")
					response.conversation.agentId = "substituted-agent";
				if (substitution === "event-conversation")
					response.events = [event(1, "substituted-conversation")];
			}
			return route.fulfill({ json: response });
		}
		if (url.pathname.endsWith("/events"))
			return route.fulfill({
				contentType: "text/event-stream",
				body: ": controlled heartbeat\n\n",
			});
		unexpected.push(`${request.method()} ${url.pathname}`);
		return route.abort();
	});
	return {
		requests,
		unexpected,
		held,
		release,
		failMore: (status: number) => {
			continuationStatus = status;
		},
		recover: () => {
			recovery = true;
		},
		changeSession: (change: Partial<Omit<ControlledSession, "tag">>) => {
			session = { ...session, ...change, tag: "new" };
		},
	};
}

function recentRegion(page: Page) {
	return page.getByRole("region", { name: "最近的个人对话", exact: true });
}

async function returnViaBrand(page: Page) {
	const menu = page.getByRole("button", { name: "打开导航", exact: true });
	if (await menu.isVisible()) await menu.click();
	await page.locator(".platform-brand:visible").click();
	await expect(page).toHaveURL(/\/$/);
}

async function refreshVisibleSession(page: Page) {
	await page.evaluate(() => {
		let state = "hidden";
		Object.defineProperty(document, "visibilityState", {
			configurable: true,
			get: () => state,
		});
		window.dispatchEvent(new Event("visibilitychange"));
		state = "visible";
		window.dispatchEvent(new Event("visibilitychange"));
		delete (document as unknown as { visibilityState?: string })
			.visibilityState;
	});
}

test("formal root route consumes fixture recent, opens the same Conversation and refreshes without writes", async ({
	page,
}, info) => {
	const fixture = await workbenchFixture(page);
	await page.goto("/");
	await expect(page).toHaveURL(/\/$/);
	await expect(
		page.getByRole("heading", { name: "从可用 Agent 开始今天的工作。" }),
	).toBeVisible();
	await expect(
		page
			.getByRole("region", { name: "可用 Agent", exact: true })
			.getByRole("heading", { name: "受控助手 agent-b", exact: true }),
	).toBeVisible();
	const recent = recentRegion(page);
	await expect(recent.getByRole("heading", { level: 3 })).toHaveText([
		"受控最近对话 conversation-z",
		"受控最近对话 conversation-a",
	]);
	await expect(recent.getByRole("link", { name: "查看历史" })).toHaveAttribute(
		"href",
		"/chat/agent-a/conversation-a",
	);
	await recent.getByRole("button", { name: "加载更多对话" }).click();
	await expect(recent.getByRole("heading", { level: 3 })).toHaveText([
		"受控最近对话 conversation-z",
		"受控最近对话 conversation-a",
		"受控最近对话 conversation-m",
	]);
	expect(
		fixture.requests.some(
			(request) =>
				request.path.startsWith("/api/v1/agents/") &&
				request.path.endsWith("/conversations"),
		),
	).toBe(false);
	await recent.getByRole("link", { name: "继续对话" }).first().click();
	await expect(page).toHaveURL(/\/chat\/agent-b\/conversation-z$/);
	for (const refresh of [false, true]) {
		if (refresh) await page.reload();
		await expect(page.locator("form[data-c02-session-id]")).toHaveAttribute(
			"data-c02-session-id",
			"conversation-z",
		);
		await expect(
			page.getByText("受控历史正文 conversation-z", { exact: true }),
		).toBeVisible();
	}
	await returnViaBrand(page);
	await expect(recent.getByRole("heading", { level: 3 })).toHaveCount(2);
	await info.attach("controlled-root-recent", {
		body: await page.screenshot({ fullPage: true }),
		contentType: "image/png",
	});
	expect(fixture.requests.every((request) => request.method === "GET")).toBe(
		true,
	);
	expect(
		fixture.requests.some((request) =>
			request.path.startsWith("/api/v2/admin/"),
		),
	).toBe(false);
	expect(
		fixture.requests
			.filter((request) => request.path.endsWith("/recent"))
			.every((request) => {
				const query = new URLSearchParams(request.search);
				return (
					query.get("limit") === "50" &&
					[...query.keys()].every((key) => ["limit", "cursor"].includes(key))
				);
			}),
	).toBe(true);
	expect(
		fixture.requests
			.filter((request) => request.path.includes("/conversations/"))
			.every((request) => request.path.includes("/conversation-z")),
	).toBe(true);
	expect(fixture.unexpected).toEqual([]);
});

test("a failed continuation hides old rows and retry uses a new first page", async ({
	page,
}, info) => {
	const fixture = await workbenchFixture(page);
	await page.goto("/");
	const recent = recentRegion(page);
	await expect(recent.getByRole("heading", { level: 3 })).toHaveCount(2);
	fixture.failMore(503);
	await recent.getByRole("button", { name: "加载更多对话" }).click();
	await expect(
		recent.getByText("最近的个人对话暂时无法读取。", { exact: true }),
	).toBeVisible();
	await expect(recent.getByRole("heading", { level: 3 })).toHaveCount(0);
	fixture.recover();
	await recent.getByRole("button", { name: "重新加载最近的个人对话" }).click();
	await expect(recent.getByRole("heading", { level: 3 })).toHaveText([
		"受控最近对话 conversation-m",
	]);
	expect(
		fixture.requests
			.filter((request) => request.path.endsWith("/recent"))
			.at(-1)?.cursor,
	).toBeNull();
	await page.reload();
	await expect(recent.getByRole("heading", { level: 3 })).toHaveText([
		"受控最近对话 conversation-m",
	]);
	await info.attach("controlled-root-recent-recovery", {
		body: await page.screenshot({ fullPage: true }),
		contentType: "image/png",
	});
	expect(fixture.unexpected).toEqual([]);
});

for (const [status, message] of [
	[404, "最近的个人对话读取入口不可用。"],
	[401, "最近的个人对话无法读取，请重新登录。"],
	[403, "当前无权读取最近的个人对话。"],
] as const) {
	test(`recent ${status} removes old rows and continuation without replacing the authenticated root`, async ({
		page,
	}) => {
		const fixture = await workbenchFixture(page);
		await page.goto("/");
		const recent = recentRegion(page);
		await expect(recent.getByRole("heading", { level: 3 })).toHaveCount(2);
		fixture.failMore(status);
		await recent.getByRole("button", { name: "加载更多对话" }).click();
		await expect(recent.getByText(message, { exact: true })).toBeVisible();
		await expect(recent.getByRole("heading", { level: 3 })).toHaveCount(0);
		await expect(
			recent.getByRole("link", { name: /继续对话|查看历史/ }),
		).toHaveCount(0);
		await expect(recent.getByRole("button")).toHaveCount(0);
		await expect(
			page.getByRole("heading", { name: "从可用 Agent 开始今天的工作。" }),
		).toBeVisible();
		await refreshVisibleSession(page);
		await expect
			.poll(
				() =>
					fixture.requests.filter(
						(request) => request.path === "/api/v1/session",
					).length,
			)
			.toBeGreaterThan(1);
		await expect(recent.getByText(message, { exact: true })).toBeVisible();
		expect(
			fixture.requests.filter((request) => request.path.endsWith("/recent")),
		).toHaveLength(2);
		expect(fixture.requests.every((request) => request.method === "GET")).toBe(
			true,
		);
		expect(fixture.unexpected).toEqual([]);
	});
}

for (const state of [
	{ name: "stopped", managementStatus: "stopped", serviceAvailability: null },
	{ name: "disabled", managementStatus: "disabled", serviceAvailability: null },
	{
		name: "starting",
		managementStatus: "available",
		serviceAvailability: "starting",
	},
	{
		name: "updating",
		managementStatus: "available",
		serviceAvailability: "updating",
	},
	{
		name: "service unavailable",
		managementStatus: "available",
		serviceAvailability: "unavailable",
	},
	{
		name: "Conversation unavailable",
		managementStatus: "available",
		serviceAvailability: "ready",
		conversationUnavailable: true,
	},
] as const) {
	test(`root opens and refreshes the original ${state.name} Conversation with readable history and no send`, async ({
		page,
	}, info) => {
		const fixture = await workbenchFixture(page, state);
		await page.goto("/");
		await expect(
			page
				.getByRole("region", { name: "可用 Agent", exact: true })
				.getByRole("heading", { name: "受控助手 agent-b", exact: true }),
		).toBeVisible();
		const recent = recentRegion(page);
		const original = recent.getByRole("link", {
			name: "查看历史",
			exact: true,
		});
		await expect(original).toHaveAttribute(
			"href",
			"/chat/agent-a/conversation-a",
		);
		await original.click();
		for (const refresh of [false, true]) {
			if (refresh) await page.reload();
			await expect(page).toHaveURL(/\/chat\/agent-a\/conversation-a$/);
			await expect(page.locator("form[data-c02-session-id]")).toHaveAttribute(
				"data-c02-session-id",
				"conversation-a",
			);
			await expect(
				page.getByText("受控原始问题 conversation-a", { exact: true }),
			).toBeVisible();
			await expect(
				page.getByText("受控历史正文 conversation-a", { exact: true }),
			).toBeVisible();
			await expect(page.getByLabel("消息", { exact: true })).toBeDisabled();
			await expect(
				page.getByRole("button", { name: "发送", exact: true }),
			).toBeDisabled();
			await expect(
				page.getByRole("button", { name: "创建会话", exact: true }),
			).toHaveCount(0);
		}
		await info.attach(
			`controlled-root-readonly-${state.name.replaceAll(" ", "-")}`,
			{
				body: await page.screenshot({ fullPage: true }),
				contentType: "image/png",
			},
		);
		expect(fixture.requests.every((request) => request.method === "GET")).toBe(
			true,
		);
		expect(
			fixture.requests
				.filter((request) => request.path.startsWith("/api/v2/conversations/"))
				.every((request) =>
					request.path.startsWith("/api/v2/conversations/conversation-a"),
				),
		).toBe(true);
		expect(
			fixture.requests.filter(
				(request) => request.path === "/api/v2/conversations/conversation-a",
			).length,
		).toBeGreaterThanOrEqual(2);
		expect(fixture.unexpected).toEqual([]);
	});
}

for (const boundary of [
	"subject",
	"same-user roles",
	"login generation",
] as const) {
	for (const holdRecent of ["first", "continuation"] as const) {
		test(`${boundary} change cancels the old recent ${holdRecent} page and ignores late success and cursor`, async ({
			page,
		}) => {
			const fixture = await workbenchFixture(page, {
				administrator: true,
				holdRecent,
				attention: true,
			});
			await page.goto("/");
			const recent = recentRegion(page);
			if (holdRecent === "continuation") {
				await expect(recent.getByRole("heading", { level: 3 })).toHaveCount(2);
				await expect(
					page
						.getByRole("region", { name: "需要管理员处理" })
						.getByText("1 项待审批", { exact: true }),
				).toBeVisible();
				await expect(
					page
						.getByRole("region", { name: "需要管理员处理" })
						.getByRole("link", { name: "查看失败清单" }),
				).toBeVisible();
				await recent.getByRole("button", { name: "加载更多对话" }).click();
			}
			await expect
				.poll(
					() =>
						fixture.held.filter((path) =>
							path.startsWith("/api/v2/me/conversations/recent"),
						).length,
				)
				.toBe(1);
			if (holdRecent === "first")
				await expect
					.poll(
						() =>
							fixture.held.filter((path) => path.startsWith("/api/v2/admin/"))
								.length,
					)
					.toBe(2);
			await expect(
				page.getByRole("region", { name: "需要管理员处理" }),
			).toBeVisible();
			fixture.changeSession(
				boundary === "subject"
					? {
							userId: "controlled-other-employee",
							roles: ["employee"],
							generation: "h".repeat(43),
						}
					: boundary === "same-user roles"
						? { roles: ["employee"] }
						: { generation: "h".repeat(43) },
			);
			await refreshVisibleSession(page);
			await expect(recent.getByRole("heading", { level: 3 })).toHaveText([
				"当前身份的受控对话",
			]);
			if (boundary !== "login generation") {
				await expect(
					page.getByRole("region", { name: "需要管理员处理" }),
				).toHaveCount(0);
				await expect(
					page.getByRole("navigation", { name: "系统管理", exact: true }),
				).toHaveCount(0);
			}
			await expect
				.poll(async () =>
					page.evaluate(
						() =>
							(
								window as unknown as {
									controlledWorkbenchTransport: { aborted: string[] };
								}
							).controlledWorkbenchTransport.aborted.filter((path) =>
								path.startsWith("/api/v2/me/conversations/recent"),
							).length,
					),
				)
				.toBe(1);
			if (holdRecent === "first")
				await expect
					.poll(async () =>
						page.evaluate(
							() =>
								new Set(
									(
										window as unknown as {
											controlledWorkbenchTransport: { aborted: string[] };
										}
									).controlledWorkbenchTransport.aborted.filter((path) =>
										path.startsWith("/api/v2/admin/"),
									),
								).size,
						),
					)
					.toBe(2);
			fixture.release();
			await expect
				.poll(async () =>
					page.evaluate(
						() =>
							(
								window as unknown as {
									controlledWorkbenchTransport: { completed: string[] };
								}
							).controlledWorkbenchTransport.completed.filter((path) =>
								path.startsWith("/api/v2/me/conversations/recent"),
							).length,
					),
				)
				.toBe(holdRecent === "first" ? 2 : 3);
			await expect(recent.getByRole("heading", { level: 3 })).toHaveText([
				"当前身份的受控对话",
			]);
			await expect(
				recent.getByRole("button", { name: "加载更多对话" }),
			).toHaveCount(0);
			await expect(
				recent.getByRole("link", { name: "继续对话" }),
			).toHaveAttribute("href", "/chat/agent-b/conversation-current");
			expect(
				fixture.requests
					.filter(
						(request) =>
							request.tag === "new" && request.path.endsWith("/recent"),
					)
					.map((request) => request.cursor),
			).toEqual([null]);
			if (boundary !== "login generation")
				expect(
					fixture.requests.some(
						(request) =>
							request.tag === "new" &&
							request.path.startsWith("/api/v2/admin/"),
					),
				).toBe(false);
			expect(
				fixture.requests.every((request) => request.method === "GET"),
			).toBe(true);
			expect(fixture.unexpected).toEqual([]);
		});
	}
}

for (const substitution of [
	"agent-id",
	"conversation-id",
	"conversation-agent",
	"event-conversation",
] as const) {
	test(`root to canonical chat rejects ${substitution} replacement without displaying the foreign response or writing`, async ({
		page,
	}) => {
		const fixture = await workbenchFixture(page, { substitution });
		await page.goto("/");
		await recentRegion(page)
			.getByRole("link", { name: "继续对话" })
			.first()
			.click();
		await expect(page).toHaveURL(/\/chat\/agent-b\/conversation-z$/);
		await expect(
			page.getByText(
				substitution === "agent-id"
					? "Agent 信息暂时无法读取。"
					: substitution === "conversation-agent"
						? /当前登录或访问权限已失效/
						: /会话连接暂时中断/,
			),
		).toBeVisible();
		await expect(
			page.getByText("不可泄露的替换历史", { exact: true }),
		).toHaveCount(0);
		await expect(
			page.getByRole("heading", { name: "不可泄露的替换 Agent", exact: true }),
		).toHaveCount(0);
		if (
			substitution === "conversation-id" ||
			substitution === "event-conversation"
		) {
			await expect(page.getByLabel("消息", { exact: true })).toBeDisabled();
			await expect(
				page.getByRole("button", { name: "发送", exact: true }),
			).toBeDisabled();
		} else
			await expect(page.getByLabel("消息", { exact: true })).toHaveCount(0);
		expect(fixture.requests.every((request) => request.method === "GET")).toBe(
			true,
		);
		expect(
			fixture.requests.some((request) => request.path.includes("substituted")),
		).toBe(false);
		expect(fixture.unexpected).toEqual([]);
	});
}

test("administrator root exposes the six original blocks and legitimate Owner and approval entrances", async ({
	page,
}, info) => {
	const fixture = await workbenchFixture(page, {
		administrator: true,
		attention: true,
	});
	await page.goto("/");
	await expect(page.getByRole("heading", { level: 1 })).toHaveText(
		"从可用 Agent 开始今天的工作。",
	);
	await expect(page.getByRole("heading", { level: 2 })).toHaveText([
		"最近的个人对话",
		"可用 Agent",
		"创建状态",
		"需要你处理",
		"需要管理员处理",
	]);
	const owner = page.getByRole("region", { name: "需要你处理", exact: true });
	await expect(
		owner.getByRole("link", { name: "修改并重新提交" }),
	).toHaveAttribute("href", "/my-agents/controlled-rejected-application/edit");
	await expect(owner.getByRole("link", { name: "配置与管理" })).toHaveAttribute(
		"href",
		"/agents/controlled-failed-agent/configuration",
	);
	await expect(
		owner.getByText("受控申请需要缩小可用范围。", { exact: true }),
	).toBeVisible();
	const admin = page.getByRole("region", {
		name: "需要管理员处理",
		exact: true,
	});
	await expect(admin.getByRole("link", { name: "进入审批" })).toHaveAttribute(
		"href",
		"/admin/approvals",
	);
	await expect(
		admin.getByRole("link", { name: "查看失败清单" }),
	).toHaveAttribute("href", "/admin/agents?status=creation_failed");
	await expect(admin.getByText("1 项待审批", { exact: true })).toBeVisible();
	await info.attach("controlled-original-ia-six-blocks", {
		body: await page.screenshot({ fullPage: true, animations: "disabled" }),
		contentType: "image/png",
	});
	expect(fixture.requests.every((request) => request.method === "GET")).toBe(
		true,
	);
	expect(fixture.unexpected).toEqual([]);
});

test("320 by 370 workbench long titles keep keyboard navigation and original chat usable without writes", async ({
	page,
}, info) => {
	await page.setViewportSize({ width: 320, height: 370 });
	const fixture = await workbenchFixture(page, { longNames: true });
	await page.goto("/");
	const original = recentRegion(page)
		.getByRole("link", { name: "继续对话" })
		.first();
	await original.scrollIntoViewIfNeeded();
	await original.focus();
	await expect(original).toBeFocused();
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= innerWidth,
		),
	).toBe(true);
	expect(
		await original.evaluate((element) => {
			const box = element.getBoundingClientRect();
			return element.contains(
				document.elementFromPoint(
					box.x + box.width / 2,
					box.y + box.height / 2,
				),
			);
		}),
	).toBe(true);
	await info.attach("controlled-320-low-workbench", {
		body: await page.screenshot({ fullPage: true, animations: "disabled" }),
		contentType: "image/png",
	});
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(/\/chat\/agent-b\/conversation-z$/);
	await expect(
		page.getByText("受控历史正文 conversation-z", { exact: true }),
	).toBeVisible();
	const message = page.getByLabel("消息", { exact: true });
	await message.scrollIntoViewIfNeeded();
	await message.click();
	await expect(message).toBeFocused();
	await message.fill("受控中文草稿，导航不会提交。");
	expect(
		await message.evaluate((element) => {
			const box = element.getBoundingClientRect();
			return element.contains(
				document.elementFromPoint(
					box.x + box.width / 2,
					box.y + box.height / 2,
				),
			);
		}),
	).toBe(true);
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= innerWidth,
		),
	).toBe(true);
	await returnViaBrand(page);
	await expect(
		recentRegion(page).getByRole("heading", { level: 3 }),
	).toHaveCount(2);
	await page.goBack();
	await expect(page).toHaveURL(/\/chat\/agent-b\/conversation-z$/);
	await expect(page.locator("form[data-c02-session-id]")).toHaveAttribute(
		"data-c02-session-id",
		"conversation-z",
	);
	await expect(page.getByLabel("消息", { exact: true })).toHaveValue("");
	expect(fixture.requests.every((request) => request.method === "GET")).toBe(
		true,
	);
	expect(fixture.unexpected).toEqual([]);
});
