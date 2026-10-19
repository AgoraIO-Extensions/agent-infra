import {
	AgentApplicationProjectionV2Schema,
	AgentProjectionV2Schema,
	ConnectionCapabilityProjectionV1Schema,
	ConversationDetailProjectionV2Schema,
	ConversationPageV1Schema,
	DeploymentConfigurationProjectionV2Schema,
	PilotProtocolErrorV1Schema,
} from "@agent-infra/contracts/pilot";
import { pilotFakeScenariosV2 } from "@agent-infra/test-support/pilot";
import { expect, type Page, test } from "@playwright/test";
import {
	event,
	history,
	timestamp,
} from "../src/features/conversation/conversation-test-fixtures";
import {
	deploymentConfiguration,
	pendingApplication,
} from "../src/features/my-agents/test-fixtures";
import type {
	AgentProjectionV2,
	ConversationDetailProjectionV2,
} from "../src/pilot/generated-v2/types.gen";
import { captureDesignContract, designViewports } from "./design-contract";
import { controlledFileLimits, isFileLimitsRequest } from "./file-limits";

type ControlledSession = {
	tag: "old" | "new";
	userId: string;
	roles: ("employee" | "system_admin")[];
	generation: string;
};

type ControlledTransport = {
	aborted: string[];
	completed: string[];
	started: {
		path: string;
		acknowledged: boolean;
		status: number | null;
	}[];
	sessionReads: {
		userId: string;
		roles: string[];
		generation: string | null;
	}[];
	acknowledged: boolean;
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
		agentCollection,
		substitution,
		recentStatus = 200,
		recentCount,
		recentTimes,
		recentTitle,
		collectionStatus,
	}: {
		managementStatus?: AgentProjectionV2["managementStatus"];
		serviceAvailability?: AgentProjectionV2["serviceAvailability"];
		conversationUnavailable?: boolean;
		administrator?: boolean;
		attention?: boolean;
		longNames?: boolean;
		holdRecent?: "first" | "continuation";
		agentCollection?: "held" | "unavailable";
		substitution?:
			| "agent-id"
			| "conversation-id"
			| "conversation-agent"
			| "event-conversation";
		/** 最近对话首页的 HTTP 状态（工作台只读首页）。 */
		recentStatus?: number;
		/** 改为按请求的 limit 分页返回这么多条历史（用于工作台截断与空态）。 */
		recentCount?: number;
		/** 覆盖默认三条会话的 updatedAt。 */
		recentTimes?: string[];
		/** 覆盖 recentCount 生成的会话标题（null 表示服务端尚未生成标题）。 */
		recentTitle?: string | null;
		/** 工作台全部分区（Agent、申请、管理员与最近对话）统一返回的失败状态。 */
		collectionStatus?: number;
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
				AgentApplicationProjectionV2Schema.parse({
					...pendingApplication,
					applicationId: "controlled-failed-application",
					name: "受控创建失败申请",
					status: "creation_failed",
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
		updatedAt: recentTimes?.[index] ?? `2026-10-01T0${3 - index}:00:00Z`,
	}));
	const generated = Array.from({ length: recentCount ?? 0 }, (_, index) => ({
		...conversations[index % conversations.length],
		conversationId: `conversation-generated-${index}`,
		title: recentTitle === undefined ? `受控历史 ${index}` : recentTitle,
		updatedAt: new Date(Date.UTC(2026, 9, 1, 3, 0, -index)).toISOString(),
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
	let firstStatus = recentStatus;
	let sessionExpired = false;
	let recovery = false;
	const protocolError = (status: number, traceId: string) =>
		PilotProtocolErrorV1Schema.parse({
			schemaVersion: 1,
			code:
				status === 401
					? "AUTHENTICATION_REQUIRED"
					: status === 403
						? "AUTHORIZATION_REVOKED"
						: status >= 500
							? "DEPENDENCY_UNAVAILABLE"
							: status === 429
								? "PROVIDER_RATE_LIMITED"
								: "RESOURCE_UNAVAILABLE",
			message: "Controlled workbench failure",
			retryable: status === 429 || status >= 500,
			traceId,
		});
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
			const observed: ControlledTransport = {
				aborted: [],
				completed: [],
				started: [],
				sessionReads: [],
				acknowledged: false,
			};
			Object.assign(window, { controlledWorkbenchTransport: observed });
			const fetch = window.fetch.bind(window);
			window.fetch = async (input, init) => {
				const request = new Request(input, init);
				const url = new URL(request.url);
				const started = {
					path: url.pathname,
					acknowledged: observed.acknowledged,
					status: null as number | null,
				};
				observed.started.push(started);
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
				started.status = response.status;
				observed.completed.push(url.pathname + url.search);
				if (url.pathname === "/api/v1/session" && response.ok) {
					// The current generated client reads text before JSON.parse.
					// Observe that read and return its exact bytes to the consumer.
					const text = response.text.bind(response);
					response.text = async () => {
						const body = await text();
						const data = JSON.parse(body);
						observed.sessionReads.push({
							userId: data.user.userId,
							roles: data.user.roles,
							generation: response.headers.get("X-Platform-Session-Generation"),
						});
						return body;
					};
				}
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
		if (isFileLimitsRequest(request.method(), url.pathname))
			return route.fulfill({ json: controlledFileLimits() });
		// 模板显示名来自部署配置（F-02）。
		if (url.pathname === "/api/v2/deployment/configuration")
			return route.fulfill({
				json: DeploymentConfigurationProjectionV2Schema.parse(
					deploymentConfiguration,
				),
			});
		if (
			request.method() === "GET" &&
			url.pathname === "/api/v1/connection/capability"
		)
			return route.fulfill({
				json: ConnectionCapabilityProjectionV1Schema.parse({
					schemaVersion: 1,
					status: "unavailable",
					reason: "missing",
				}),
			});
		if (url.pathname === "/api/v1/session" && sessionExpired)
			return route.fulfill({
				status: 401,
				json: protocolError(401, "controlled-session-expired"),
			});
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
		if (
			collectionStatus !== undefined &&
			(url.pathname === "/api/v2/me/conversations/recent" ||
				url.pathname === "/api/v2/agents" ||
				url.pathname === "/api/v2/agent-applications" ||
				url.pathname.startsWith("/api/v2/admin/"))
		)
			return route.fulfill({
				status: collectionStatus,
				json: protocolError(collectionStatus, "controlled-collection-failure"),
			});
		if (url.pathname === "/api/v2/me/conversations/recent") {
			const more = url.searchParams.has("cursor");
			if (!more && firstStatus !== 200)
				return route.fulfill({
					status: firstStatus,
					json: protocolError(firstStatus, "controlled-recent-first-failure"),
				});
			if (recentCount !== undefined && actor.tag === "old") {
				const limit = Number(url.searchParams.get("limit"));
				const offset = more
					? Number(url.searchParams.get("cursor")?.split(":")[1])
					: 0;
				const end = offset + limit;
				return route.fulfill({
					json: ConversationPageV1Schema.parse({
						items: generated.slice(offset, end),
						nextCursor: end < generated.length ? `generated:${end}` : null,
					}),
				});
			}
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
									: continuationStatus >= 500
										? "DEPENDENCY_UNAVAILABLE"
										: continuationStatus === 429
											? "PROVIDER_RATE_LIMITED"
											: "RESOURCE_UNAVAILABLE",
						message: "Controlled recent failure",
						retryable: continuationStatus === 429 || continuationStatus >= 500,
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
		if (request.method() === "GET" && url.pathname.endsWith("/native-metadata"))
			return route.fulfill({
				json: {
					selector:
						url.searchParams.get("selector") === "commands"
							? "commands"
							: "skills",
					revision: "a".repeat(64),
					capabilities: [],
				},
			});
		if (url.pathname.startsWith("/api/v2/admin/")) {
			if (
				url.pathname !== "/api/v2/admin/agents" &&
				url.pathname !== "/api/v2/admin/agent-applications"
			) {
				unexpected.push(`${request.method()} ${url.pathname}`);
				return route.abort();
			}
			if (holdRecent === "first" && actor.tag === "old") {
				held.push(url.pathname);
				await pending;
			}
			if (!actor.roles.includes("system_admin")) {
				// Focus can revalidate an old mounted administrator query before
				// the new session reaches the UI. The server still rejects it.
				return route.fulfill({
					status: 403,
					json: PilotProtocolErrorV1Schema.parse({
						schemaVersion: 1,
						code: "AUTHORIZATION_REVOKED",
						message: "Controlled administrator authorization revoked",
						retryable: false,
						traceId: "controlled-admin-revalidation-denied",
					}),
				});
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
		if (url.pathname === "/api/v2/agents") {
			if (url.searchParams.get("scope") !== "owner") {
				if (agentCollection === "held") {
					held.push(url.pathname);
					await pending;
				}
				if (agentCollection === "unavailable")
					return route.fulfill({
						status: 503,
						json: PilotProtocolErrorV1Schema.parse({
							schemaVersion: 1,
							code: "DEPENDENCY_UNAVAILABLE",
							message: "Controlled collection failure",
							retryable: true,
							traceId: "controlled-agent-collection-failure",
						}),
					});
			}
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
		}
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
		failFirst: (status: number) => {
			firstStatus = status;
		},
		expireSession: () => {
			sessionExpired = true;
		},
		/** 之后的分区读取恢复正常（collectionStatus 不再生效）。 */
		restoreCollections: () => {
			collectionStatus = undefined;
		},
		recover: () => {
			recovery = true;
		},
		changeSession: (change: Partial<Omit<ControlledSession, "tag">>) => {
			session = { ...session, ...change, tag: "new" };
		},
		sessionReceipt: () => ({
			userId: session.userId,
			roles: session.roles,
			generation: session.generation,
		}),
	};
}

function recentRegion(page: Page) {
	return page.getByRole("region", { name: "最近对话", exact: true });
}

for (const agentCollection of ["held", "unavailable"] as const) {
	test(`unknown Agent availability (${agentCollection}) opens the original Conversation without asserting read-only`, async ({
		page,
	}, info) => {
		const fixture = await workbenchFixture(page, { agentCollection });
		try {
			await page.goto("/");
			if (agentCollection === "held")
				await expect.poll(() => fixture.held).toContain("/api/v2/agents");
			else {
				const agents = page.getByRole("region", {
					name: "可用 Agent",
					exact: true,
				});
				await expect(
					agents.getByText("可用 Agent 暂时无法读取。", { exact: true }),
				).toBeVisible();
				await expect(
					agents.getByRole("button", {
						name: "重新加载可用 Agent",
						exact: true,
					}),
				).toBeEnabled();
			}
			const recent = recentRegion(page);
			await expect(recent.getByRole("heading", { level: 3 })).toHaveCount(2);
			// R4-03：Agent 列表仍在读取时不显示失败文案；只有列表确认失败才显示。
			await expect(
				recent.getByText("状态暂时无法确认", { exact: true }),
			).toHaveCount(agentCollection === "held" ? 0 : 2);
			await expect(recent.getByText(/所属 Agent 暂时无法读取/)).toHaveCount(
				agentCollection === "held" ? 0 : 2,
			);
			if (agentCollection === "held")
				// 加载期元信息只有时间（NI-28）。
				for (const meta of await recent.locator("small").all())
					expect(await meta.textContent()).toBe(
						await meta.locator("time").textContent(),
					);
			await expect(recent.getByText(/历史只读/)).toHaveCount(0);
			await expect(
				recent.getByRole("link", { name: /^查看历史(：|$)/ }),
			).toHaveCount(0);
			await expect(
				recent.getByRole("link", { name: /^继续对话(：|$)/ }),
			).toHaveCount(0);
			const original = recent
				.getByRole("link", { name: /^打开对话：/ })
				.first();
			await expect(original).toHaveAttribute(
				"href",
				"/chat/agent-b/conversation-z",
			);
			await info.attach(`controlled-unknown-availability-${agentCollection}`, {
				body: await page.screenshot({ fullPage: true }),
				contentType: "image/png",
			});
			await original.click();
			await expect(page).toHaveURL(/\/chat\/agent-b\/conversation-z$/);
			await expect(page.locator("form[data-c02-session-id]")).toHaveAttribute(
				"data-c02-session-id",
				"conversation-z",
			);
			await expect(
				page.getByText("受控历史正文 conversation-z", { exact: true }),
			).toBeVisible();
			await expect(page.getByLabel("消息", { exact: true })).toBeEnabled();
			expect(
				fixture.requests.every((request) => request.method === "GET"),
			).toBe(true);
			expect(fixture.unexpected).toEqual([]);
		} finally {
			fixture.release();
		}
	});
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
		page.getByRole("heading", { name: "选择一个 Agent 开始工作。" }),
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
	// 最近对话时间按本地时区显示，悬停 title 为完整时间，不出现 ISO 原文或秒。
	const times = recent.locator("time");
	await expect(times).toHaveCount(2);
	for (const time of await times.all()) {
		await expect(time).toHaveAttribute("datetime", /^\d{4}-\d{2}-\d{2}T.*Z$/);
		await expect(time).toHaveAttribute(
			"title",
			/^\d{4} 年 \d{1,2} 月 \d{1,2} 日 \d{2}:\d{2}:\d{2}$/,
		);
		await expect(time).not.toHaveText(/T\d\d:|:\d\d:\d\d/);
	}
	await expect(recent.getByRole("link", { name: "查看历史" })).toHaveAttribute(
		"href",
		"/chat/agent-a/conversation-a",
	);
	// R4-04：工作台不分页；「查看全部」进入最近一条会话的对话页「最近对话」面板。
	await expect(
		recent.getByRole("button", { name: "加载更多对话" }),
	).toHaveCount(0);
	await expect(
		recent.getByRole("link", { name: "查看全部", exact: true }),
	).toHaveAttribute("href", "/chat/agent-b/conversation-z");
	// 工作台只读首页 3 条；对话页「最近对话」面板仍按 50 条分页（NI-32）。
	expect(
		fixture.requests
			.filter((request) => request.path.endsWith("/recent"))
			.map((request) => request.search),
	).toEqual(["?limit=3"]);
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
					["3", "50"].includes(query.get("limit") ?? "") &&
					[...query.keys()].every((key) => ["limit", "cursor"].includes(key))
				);
			}),
	).toBe(true);
	expect(
		fixture.requests
			.filter((request) => request.path.startsWith("/api/v2/conversations/"))
			.every(
				(request) =>
					[
						"/api/v2/conversations/conversation-z",
						"/api/v2/conversations/conversation-z/events",
					].includes(request.path) || request.path.endsWith("/native-metadata"),
			),
	).toBe(true);
	expect(fixture.unexpected).toEqual([]);
});

function historyPanel(page: Page) {
	return page.getByRole("complementary", { name: "对话历史" });
}

/** 打开对话页「最近对话」面板：窄屏按真实入口点「个人历史」，宽屏面板常驻。 */
async function openRecentPanel(page: Page) {
	await expect(page.locator("form[data-c02-session-id]")).toBeVisible();
	if ((page.viewportSize()?.width ?? 0) < 1024)
		await page.getByRole("button", { name: "个人历史", exact: true }).click();
	const panel = historyPanel(page).getByRole("region", { name: "最近对话" });
	await expect(panel).toBeVisible();
	return panel;
}

function panelTitles(panel: ReturnType<Page["getByRole"]>) {
	return panel.locator("a.conversation-history-item strong");
}

test("a failed workbench first page shows a notice and retry reads a new first page", async ({
	page,
}, info) => {
	const fixture = await workbenchFixture(page, { recentStatus: 503 });
	await page.goto("/");
	const recent = recentRegion(page);
	const title = recent.getByText("最近对话暂时无法读取。", {
		exact: true,
	});
	await expect(title).toBeVisible();
	await expect(recent.getByRole("heading", { level: 3 })).toHaveCount(0);
	// W-03：设计 .notice（flex、gap 10、padding 13/14、圆角 12、13px）+ 17px 图标 + strong 标题。
	const notice = recent.locator('[data-slot="alert"]');
	await expect(notice).toHaveCSS("display", "flex");
	await expect(notice).toHaveCSS("column-gap", "10px");
	await expect(notice).toHaveCSS("padding", "13px 14px");
	await expect(notice).toHaveCSS("border-radius", "12px");
	await expect(notice).toHaveCSS("font-size", "13px");
	const icon = notice.locator(':scope > svg[aria-hidden="true"]');
	await expect(icon).toHaveCSS("width", "17px");
	await expect(icon).toHaveCSS("height", "17px");
	expect(await title.evaluate((node) => node.tagName)).toBe("STRONG");
	await expect(recent.getByRole("button")).toHaveCount(1);
	const reads = () =>
		fixture.requests.filter((request) => request.path.endsWith("/recent"))
			.length;
	const before = reads();
	fixture.failFirst(200);
	await recent.getByRole("button", { name: "重新加载最近对话" }).click();
	await expect(recent.getByRole("heading", { level: 3 })).toHaveText([
		"受控最近对话 conversation-z",
		"受控最近对话 conversation-a",
	]);
	expect(reads()).toBe(before + 1);
	expect(
		fixture.requests
			.filter((request) => request.path.endsWith("/recent"))
			.at(-1)?.cursor,
	).toBeNull();
	await info.attach("controlled-root-recent-recovery", {
		body: await page.screenshot({ fullPage: true }),
		contentType: "image/png",
	});
	expect(fixture.requests.every((request) => request.method === "GET")).toBe(
		true,
	);
	expect(fixture.unexpected).toEqual([]);
});

for (const [status, message] of [
	[404, "最近对话读取入口不可用。"],
	[401, "最近对话无法读取，请重新登录。"],
	[403, "当前无权读取最近对话。"],
] as const) {
	test(`recent ${status} keeps the failure in the region without replacing the authenticated root`, async ({
		page,
	}) => {
		const fixture = await workbenchFixture(page, { recentStatus: status });
		await page.goto("/");
		const recent = recentRegion(page);
		await expect(recent.getByText(message, { exact: true })).toBeVisible();
		await expect(recent.getByRole("heading", { level: 3 })).toHaveCount(0);
		await expect(
			recent.getByRole("link", { name: /继续对话|查看历史|查看全部/ }),
		).toHaveCount(0);
		// NI-114：区块内没有任何按钮，页面也没有「重新加载…」；401 只在页面级给一个「重新登录」。
		await expect(recent.getByRole("button")).toHaveCount(0);
		await expect(
			page.locator("main").getByRole("button", { name: /重新加载/ }),
		).toHaveCount(0);
		await expect(
			page.getByRole("button", { name: "重新登录", exact: true }),
		).toHaveCount(status === 401 ? 1 : 0);
		await expect(
			page.getByRole("heading", { name: "选择一个 Agent 开始工作。" }),
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
		).toHaveLength(1);
		expect(fixture.requests.every((request) => request.method === "GET")).toBe(
			true,
		);
		expect(fixture.unexpected).toEqual([]);
	});
}

test("401 across the workbench offers one re-login that rechecks the session without reloading", async ({
	page,
}) => {
	const fixture = await workbenchFixture(page, {
		administrator: true,
		collectionStatus: 401,
	});
	await page.goto("/");
	await page.evaluate(() => {
		Object.assign(window, { controlledNoReload: "kept" });
	});
	const main = page.locator("main");
	await expect(
		main.getByText("最近对话无法读取，请重新登录。", { exact: true }),
	).toBeVisible();
	const relogin = main.getByRole("button", { name: "重新登录", exact: true });
	// W-03：全页只有一个主操作，各分区 notice 内没有按钮。
	await expect(relogin).toHaveCount(1);
	await expect(main.getByRole("button")).toHaveCount(1);
	await expect(relogin).toHaveCSS(
		"background-color",
		await page.evaluate(() => {
			const probe = document.createElement("span");
			probe.style.color = "var(--accent-ink)";
			document.body.append(probe);
			const color = getComputedStyle(probe).color;
			probe.remove();
			return color;
		}),
	);
	for (const name of ["最近对话", "可用 Agent", "我的申请"])
		await expect(
			page.getByRole("region", { name, exact: true }).getByRole("button"),
		).toHaveCount(0);
	const count = (path: string) =>
		fixture.requests.filter((request) => request.path === path).length;
	const sessions = count("/api/v1/session");
	const recentReads = count("/api/v2/me/conversations/recent");
	// 会话仍有效：重读一次会话，再把失败分区重读一次，仍停留在工作台。
	await relogin.click();
	await expect.poll(() => count("/api/v1/session")).toBe(sessions + 1);
	await expect
		.poll(() => count("/api/v2/me/conversations/recent"))
		.toBe(recentReads + 1);
	await expect(relogin).toBeVisible();
	// 会话已失效：壳层换成登录入口，不整页刷新。
	fixture.expireSession();
	await relogin.click();
	await expect(
		page.getByRole("heading", { level: 1, name: "登录工作区" }),
	).toBeVisible();
	expect(
		await page.evaluate(
			() =>
				(window as unknown as { controlledNoReload?: string })
					.controlledNoReload,
		),
	).toBe("kept");
	expect(fixture.requests.every((request) => request.method === "GET")).toBe(
		true,
	);
	expect(fixture.unexpected).toEqual([]);
});

test("401 re-login with a still-valid session re-reads every failed section and recovers (W-03)", async ({
	page,
}) => {
	const fixture = await workbenchFixture(page, {
		administrator: true,
		attention: true,
		collectionStatus: 401,
	});
	await page.goto("/");
	const main = page.locator("main");
	const relogin = main.getByRole("button", { name: "重新登录", exact: true });
	await expect(relogin).toHaveCount(1);
	await expect(main.getByText(/无法读取，请重新登录。$/)).not.toHaveCount(0);
	const count = (path: string) =>
		fixture.requests.filter((request) => request.path === path).length;
	const before = {
		agents: count("/api/v2/agents"),
		applications: count("/api/v2/agent-applications"),
		adminAgents: count("/api/v2/admin/agents"),
		pending: count("/api/v2/admin/agent-applications"),
		recent: count("/api/v2/me/conversations/recent"),
	};
	// 会话仍有效、服务端恢复：点击后各分区越过不可重试的 401 重读一次并显示内容。
	fixture.restoreCollections();
	await relogin.click();
	await expect(
		recentRegion(page).getByRole("heading", { level: 3 }),
	).toHaveText(["受控最近对话 conversation-z", "受控最近对话 conversation-a"]);
	await expect(
		page
			.getByRole("region", { name: "可用 Agent", exact: true })
			.getByRole("heading", { level: 3 }),
	).toHaveCount(3);
	await expect(
		page
			.getByRole("region", { name: "我的申请", exact: true })
			.getByRole("heading", { level: 3 }),
	).toHaveCount(3);
	await expect(
		page.getByRole("region", { name: "需要管理员处理", exact: true }),
	).toContainText("1 项申请等待系统管理员审阅");
	await expect(main.getByText(/无法读取，请重新登录。$/)).toHaveCount(0);
	await expect(relogin).toHaveCount(0);
	expect(count("/api/v2/agents")).toBe(before.agents + 2);
	expect(count("/api/v2/agent-applications")).toBe(before.applications + 1);
	expect(count("/api/v2/admin/agents")).toBe(before.adminAgents + 1);
	expect(count("/api/v2/admin/agent-applications")).toBe(before.pending + 1);
	expect(count("/api/v2/me/conversations/recent")).toBe(before.recent + 1);
	expect(
		await page.evaluate(
			() => performance.getEntriesByType("navigation").length,
		),
	).toBe(1);
	expect(fixture.requests.every((request) => request.method === "GET")).toBe(
		true,
	);
	expect(fixture.unexpected).toEqual([]);
});

test("keyboard recovery from the 401 re-login moves focus to the workbench h1, not body", async ({
	page,
}) => {
	const fixture = await workbenchFixture(page, {
		administrator: true,
		attention: true,
		collectionStatus: 401,
	});
	await page.goto("/");
	const main = page.locator("main");
	// 工作台统一落到页面 h1：401「重新登录」一次恢复多个分区，没有唯一的恢复分区。
	const heading = main.getByRole("heading", {
		level: 1,
		name: "选择一个 Agent 开始工作。",
	});
	const relogin = main.getByRole("button", { name: "重新登录", exact: true });
	await relogin.focus();
	await expect(relogin).toBeFocused();
	fixture.restoreCollections();
	await page.keyboard.press("Enter");
	await expect(relogin).toHaveCount(0);
	await expect(main.getByText(/无法读取，请重新登录。$/)).toHaveCount(0);
	await expect(heading).toBeFocused();
	await expect(heading).toHaveAttribute("tabindex", "-1");
	expect(
		await page.evaluate(() => document.activeElement === document.body),
	).toBe(false);
	expect(fixture.unexpected).toEqual([]);
});

test("keyboard reload of a failed recent section moves focus to the workbench h1, not body", async ({
	page,
}) => {
	const fixture = await workbenchFixture(page, { recentStatus: 503 });
	await page.goto("/");
	const recent = recentRegion(page);
	const reload = recent.getByRole("button", { name: "重新加载最近对话" });
	await reload.focus();
	await expect(reload).toBeFocused();
	fixture.failFirst(200);
	await page.keyboard.press("Enter");
	await expect(recent.getByRole("heading", { level: 3 })).toHaveCount(2);
	await expect(reload).toHaveCount(0);
	await expect(
		page.getByRole("heading", { level: 1, name: "选择一个 Agent 开始工作。" }),
	).toBeFocused();
	expect(
		await page.evaluate(() => document.activeElement === document.body),
	).toBe(false);
	expect(fixture.unexpected).toEqual([]);
});

test("untitled recent conversations keep distinct continue link names (N-12)", async ({
	page,
}) => {
	const fixture = await workbenchFixture(page, {
		managementStatus: "available",
		serviceAvailability: "ready",
		recentCount: 6,
		recentTitle: null,
	});
	await page.goto("/");
	const recent = recentRegion(page);
	await expect(recent.getByRole("heading", { level: 3 })).toHaveText([
		"未命名对话",
		"未命名对话",
		"未命名对话",
	]);
	const links = recent.getByRole("link", { name: /^继续对话：/ });
	await expect(links).toHaveCount(3);
	const names = await links.evaluateAll((items) =>
		items.map((item) => item.getAttribute("aria-label")),
	);
	expect(names).toEqual([
		"继续对话：未命名对话（第 1 次）",
		"继续对话：未命名对话（第 2 次）",
		"继续对话：未命名对话（第 3 次）",
	]);
	expect(fixture.unexpected).toEqual([]);
});

test("workbench page head eyebrow keeps the designed margin and the available Agent tag shows the template name", async ({
	page,
}, info) => {
	const fixture = await workbenchFixture(page);
	await page.goto("/");
	const heading = page.locator("main .page-heading").first();
	const eyebrow = heading.locator(".workbench-eyebrow");
	const h1 = heading.getByRole("heading", { level: 1 });
	await expect(eyebrow).toHaveCSS("margin", "0px 0px 9px");
	const [eyebrowBox, h1Box, copyBox] = await Promise.all([
		eyebrow.boundingBox(),
		h1.boundingBox(),
		eyebrow.locator("xpath=..").boundingBox(),
	]);
	if (!eyebrowBox || !h1Box || !copyBox)
		throw new Error("Expected page head geometry");
	// 设计 #workbench：eyebrow 贴页头顶部，h1 在其下 9px（1440 下 y=130.4，390 下 y=121.4）。
	expect(Math.abs(eyebrowBox.y - copyBox.y)).toBeLessThanOrEqual(0.5);
	expect(
		Math.abs(h1Box.y - (eyebrowBox.y + eyebrowBox.height + 9)),
	).toBeLessThanOrEqual(0.5);
	expect(
		Math.abs(h1Box.y - (info.project.name === "mobile" ? 121.4 : 130.4)),
	).toBeLessThanOrEqual(1);
	// 设计 #workbench 可用 Agent 卡 tag 为模板显示名「Codex」，不是原始 templateId（F-02）。
	const agents = page.getByRole("region", { name: "可用 Agent", exact: true });
	const tags = agents.locator('[data-slot="badge"][data-variant="tag"]');
	await expect(tags.first()).toHaveText("Codex");
	await expect(agents).not.toContainText("codex");
	// 品牌链接不是导航项：工作台上只有导航「工作台」带 aria-current（N-21）。
	await expect(page.locator("a.platform-brand")).not.toHaveCount(0);
	await expect(page.locator("a.platform-brand[aria-current]")).toHaveCount(0);
	await expect(page.locator('a[aria-current="page"]')).toHaveText(["工作台"]);
	expect(fixture.unexpected).toEqual([]);
});

test("chat recent panel continuation failure hides old rows and retry uses a new first page", async ({
	page,
}, info) => {
	const fixture = await workbenchFixture(page);
	await page.goto("/chat/agent-b/conversation-z");
	const panel = await openRecentPanel(page);
	await expect(panelTitles(panel)).toHaveText([
		"受控最近对话 conversation-z",
		"受控最近对话 conversation-a",
	]);
	fixture.failMore(503);
	await panel.getByRole("button", { name: "加载更多对话" }).click();
	await expect(
		panel.getByText("最近对话暂时无法读取。", { exact: true }),
	).toBeVisible();
	await expect(panelTitles(panel)).toHaveCount(0);
	fixture.recover();
	await panel.getByRole("button", { name: "重试读取最近对话" }).click();
	await expect(panelTitles(panel)).toHaveText(["受控最近对话 conversation-m"]);
	const recentReads = fixture.requests.filter((request) =>
		request.path.endsWith("/recent"),
	);
	expect(recentReads.at(-1)?.cursor).toBeNull();
	expect(
		recentReads.every(
			(request) => new URLSearchParams(request.search).get("limit") === "50",
		),
	).toBe(true);
	await info.attach("controlled-chat-recent-recovery", {
		body: await page.screenshot({ fullPage: true }),
		contentType: "image/png",
	});
	expect(fixture.requests.every((request) => request.method === "GET")).toBe(
		true,
	);
	expect(fixture.unexpected).toEqual([]);
});

for (const [status, message] of [
	[404, "最近对话读取入口不可用。"],
	[401, "最近对话无法读取，请重新登录。"],
	[403, "当前无权读取最近对话。"],
] as const) {
	test(`chat recent panel continuation ${status} removes old rows and the cursor`, async ({
		page,
	}) => {
		const fixture = await workbenchFixture(page);
		await page.goto("/chat/agent-b/conversation-z");
		const panel = await openRecentPanel(page);
		await expect(panelTitles(panel)).toHaveCount(2);
		fixture.failMore(status);
		await panel.getByRole("button", { name: "加载更多对话" }).click();
		await expect(panel.getByText(message, { exact: true })).toBeVisible();
		await expect(panelTitles(panel)).toHaveCount(0);
		await expect(panel.getByRole("button")).toHaveCount(0);
		await refreshVisibleSession(page);
		await expect
			.poll(
				() =>
					fixture.requests.filter(
						(request) => request.path === "/api/v1/session",
					).length,
			)
			.toBeGreaterThan(1);
		await expect(panel.getByText(message, { exact: true })).toBeVisible();
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
			name: /^查看历史：/,
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
			const messageInput = page.getByLabel("消息", { exact: true });
			if (state.name === "starting" || state.name === "updating") {
				await expect(messageInput).toBeEnabled();
			} else {
				await expect(messageInput).toBeDisabled();
			}
			await expect(
				page.getByRole("button", { name: "发送", exact: true }),
			).toBeDisabled();
			// 打开的是原会话，不是新会话页（CH-10 之后新会话页直接显示 composer）。
			await expect(page.locator("form[data-new-conversation]")).toHaveCount(0);
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

type TransportWindow = Window & {
	controlledWorkbenchTransport: ControlledTransport;
};

const boundaryChanges = {
	subject: {
		userId: "controlled-other-employee",
		roles: ["employee"],
		generation: "h".repeat(43),
	},
	"same-user roles": { roles: ["employee"] },
	"login generation": { generation: "h".repeat(43) },
} satisfies Record<string, Partial<Omit<ControlledSession, "tag">>>;

/** 在观测到新身份的界面之后确认：后续会话重读只会再发生一次，且不触碰查询缓存。 */
async function acknowledgeNewSession(page: Page) {
	const sessionReadsAtAcknowledgement = await page.evaluate(() => {
		const transport = (window as unknown as TransportWindow)
			.controlledWorkbenchTransport;
		transport.acknowledged = true;
		return transport.sessionReads.length;
	});
	await refreshVisibleSession(page);
	await expect
		.poll(async () =>
			page.evaluate(
				() =>
					(window as unknown as TransportWindow).controlledWorkbenchTransport
						.sessionReads.length,
			),
		)
		.toBe(sessionReadsAtAcknowledgement + 1);
}

const transportCount = (
	page: Page,
	kind: "aborted" | "completed",
	prefix: string,
) =>
	page.evaluate(
		({ kind, prefix }) =>
			(window as unknown as TransportWindow).controlledWorkbenchTransport[
				kind
			].filter((path) => path.startsWith(prefix)).length,
		{ kind, prefix },
	);

for (const boundary of [
	"subject",
	"same-user roles",
	"login generation",
] as const) {
	test(`${boundary} change cancels the old recent first page and ignores late success and cursor`, async ({
		page,
	}) => {
		const fixture = await workbenchFixture(page, {
			administrator: true,
			holdRecent: "first",
			attention: true,
		});
		await page.goto("/");
		const recent = recentRegion(page);
		await expect
			.poll(
				() =>
					fixture.held.filter((path) =>
						path.startsWith("/api/v2/me/conversations/recent"),
					).length,
			)
			.toBe(1);
		await expect
			.poll(
				() =>
					fixture.held.filter((path) => path.startsWith("/api/v2/admin/"))
						.length,
			)
			.toBe(2);
		const heldOldAdminStarts = await page.evaluate(() =>
			(
				window as unknown as TransportWindow
			).controlledWorkbenchTransport.started.flatMap((request, index) =>
				request.path.startsWith("/api/v2/admin/") && request.status === null
					? [{ index, path: request.path }]
					: [],
			),
		);
		expect(heldOldAdminStarts.map((request) => request.path).sort()).toEqual(
			fixture.held.filter((path) => path.startsWith("/api/v2/admin/")).sort(),
		);
		await expect(
			page.getByRole("region", { name: "需要管理员处理" }),
		).toBeVisible();
		fixture.changeSession(boundaryChanges[boundary]);
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
		expect(
			await page.evaluate(() =>
				(
					window as unknown as TransportWindow
				).controlledWorkbenchTransport.sessionReads.at(-1),
			),
		).toEqual(fixture.sessionReceipt());
		await acknowledgeNewSession(page);
		await expect
			.poll(() =>
				transportCount(page, "aborted", "/api/v2/me/conversations/recent"),
			)
			.toBe(1);
		await expect
			.poll(async () =>
				page.evaluate(
					() =>
						new Set(
							(
								window as unknown as TransportWindow
							).controlledWorkbenchTransport.aborted.filter((path) =>
								path.startsWith("/api/v2/admin/"),
							),
						).size,
				),
			)
			.toBe(2);
		fixture.release();
		await expect
			.poll(() =>
				transportCount(page, "completed", "/api/v2/me/conversations/recent"),
			)
			.toBe(2);
		await expect
			.poll(async () =>
				page.evaluate(
					(indices) =>
						indices.map(
							(index) =>
								(window as unknown as TransportWindow)
									.controlledWorkbenchTransport.started[index]?.status,
						),
					heldOldAdminStarts.map((request) => request.index),
				),
			)
			.toEqual([200, 200]);
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
		if (boundary !== "login generation") {
			const administratorReads = await page.evaluate(() =>
				(
					window as unknown as TransportWindow
				).controlledWorkbenchTransport.started.filter((request) =>
					request.path.startsWith("/api/v2/admin/"),
				),
			);
			expect(
				administratorReads.filter((request) => request.acknowledged),
			).toEqual([]);
			const revalidationReads = fixture.requests.filter(
				(request) =>
					request.tag === "new" && request.path.startsWith("/api/v2/admin/"),
			);
			expect(
				administratorReads.filter((request) => request.status === 403),
			).toHaveLength(revalidationReads.length);
			await expect(
				page.getByRole("region", { name: "需要管理员处理" }),
			).toHaveCount(0);
			await expect(
				page.getByRole("navigation", { name: "系统管理", exact: true }),
			).toHaveCount(0);
		}
		expect(fixture.requests.every((request) => request.method === "GET")).toBe(
			true,
		);
		expect(fixture.unexpected).toEqual([]);
	});

	// NI-81：续页只在对话页「最近对话」面板，身份边界的续页用例随之迁到这里。
	test(`${boundary} change cancels the old chat recent continuation and ignores late success and cursor`, async ({
		page,
	}) => {
		const fixture = await workbenchFixture(page, {
			administrator: true,
			holdRecent: "continuation",
		});
		await page.goto("/chat/agent-b/conversation-z");
		let panel = await openRecentPanel(page);
		await expect(panelTitles(panel)).toHaveText([
			"受控最近对话 conversation-z",
			"受控最近对话 conversation-a",
		]);
		await panel.getByRole("button", { name: "加载更多对话" }).click();
		await expect
			.poll(
				() =>
					fixture.held.filter(
						(path) =>
							path.startsWith("/api/v2/me/conversations/recent") &&
							path.includes("cursor="),
					).length,
			)
			.toBe(1);
		fixture.changeSession(boundaryChanges[boundary]);
		await refreshVisibleSession(page);
		await expect(page.locator("form[data-c02-session-id]")).toHaveAttribute(
			"data-c02-session-id",
			"conversation-z",
		);
		panel = await openRecentPanel(page);
		await expect(panelTitles(panel)).toHaveText(["当前身份的受控对话"]);
		expect(
			await page.evaluate(() =>
				(
					window as unknown as TransportWindow
				).controlledWorkbenchTransport.sessionReads.at(-1),
			),
		).toEqual(fixture.sessionReceipt());
		await acknowledgeNewSession(page);
		await expect
			.poll(() =>
				transportCount(page, "aborted", "/api/v2/me/conversations/recent"),
			)
			.toBe(1);
		fixture.release();
		await expect
			.poll(() =>
				transportCount(page, "completed", "/api/v2/me/conversations/recent"),
			)
			.toBe(3);
		await expect(panelTitles(panel)).toHaveText(["当前身份的受控对话"]);
		await expect(
			panel.getByRole("button", { name: "加载更多对话" }),
		).toHaveCount(0);
		const newReads = fixture.requests.filter(
			(request) => request.tag === "new" && request.path.endsWith("/recent"),
		);
		expect(newReads.map((request) => request.cursor)).toEqual([null]);
		expect(
			newReads.map((request) =>
				new URLSearchParams(request.search).get("limit"),
			),
		).toEqual(["50"]);
		expect(fixture.requests.every((request) => request.method === "GET")).toBe(
			true,
		);
		expect(fixture.unexpected).toEqual([]);
	});
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
					? "服务返回的数据无法识别，请联系管理员。"
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
		"选择一个 Agent 开始工作。",
	);
	await expect(page.getByRole("heading", { level: 2 })).toHaveText([
		"最近对话",
		"待处理",
		"可用 Agent",
		"我的申请",
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
	// F-06：可见文字「进入」，可访问名称带对象名。
	const approvals = admin.getByRole("link", {
		name: "进入：创建审批",
		exact: true,
	});
	await expect(approvals).toHaveText("进入");
	await expect(approvals).toHaveAttribute("href", "/admin/approvals");
	await expect(page.getByRole("link", { name: /进入审批/ })).toHaveCount(0);
	await expect(
		page
			.getByRole("complementary", { name: "待处理" })
			.getByRole("link", { name: "查看失败清单" }),
	).toHaveAttribute("href", "/admin/agents?status=creation_failed");
	await expect(
		admin.getByText("1 项申请等待系统管理员审阅", { exact: true }),
	).toBeVisible();
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

test("exported design viewport matrix workbench", async ({ page }, info) => {
	test.skip(
		info.project.name !== "desktop",
		"The exported nine-viewport matrix runs once.",
	);
	const fixture = await workbenchFixture(page, {
		administrator: true,
		attention: true,
	});
	await page.goto("/");
	await expect(
		page.getByRole("link", { name: "进入：创建审批", exact: true }),
	).toBeVisible();
	for (const viewport of designViewports) {
		await page.setViewportSize(viewport);
		await captureDesignContract(page, info, "workbench");
	}
	expect(fixture.requests.every((request) => request.method === "GET")).toBe(
		true,
	);
	expect(fixture.unexpected).toEqual([]);
});

for (const viewport of [
	{ width: 320, height: 640 },
	{ width: 360, height: 800 },
	{ width: 375, height: 812 },
]) {
	test(`workbench new conversation follows the ≤374px tier at ${viewport.width}px`, async ({
		page,
	}, info) => {
		test.skip(info.project.name !== "mobile", "Narrow viewport tier");
		await page.setViewportSize(viewport);
		const fixture = await workbenchFixture(page);
		await page.goto("/");
		const narrow = viewport.width <= 374;
		const gutter = narrow ? 12 : 16;
		// G-03：320–374px 顶栏与内容区左右 12px，页头主操作通栏。
		await expect(page.locator(".platform-topbar")).toHaveCSS(
			"padding-left",
			narrow ? "12px" : "18px",
		);
		await expect(page.locator(".ia-workbench")).toHaveCSS(
			"padding-left",
			`${gutter}px`,
		);
		await expect(page.locator(".ia-workbench")).toHaveCSS(
			"padding-right",
			`${gutter}px`,
		);
		const action = page
			.locator("main .page-heading")
			.getByRole("link", { name: "新建对话" });
		const width = (await action.boundingBox())?.width ?? 0;
		if (narrow)
			expect(Math.abs(width - (viewport.width - 24))).toBeLessThanOrEqual(1);
		else expect(width).toBeLessThan(viewport.width - 33);
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
		).toBe(true);
		expect(fixture.unexpected).toEqual([]);
	});
}

/** 把 CSS 变量解析成浏览器计算后的颜色字符串，便于与计算样式比较。 */
async function resolvedColor(page: Page, value: string) {
	return page.evaluate((color) => {
		const probe = document.createElement("span");
		probe.style.color = color;
		document.body.append(probe);
		const resolved = getComputedStyle(probe).color;
		probe.remove();
		return resolved;
	}, value);
}

type Box = { x: number; y: number; width: number; height: number };
async function box(locator: ReturnType<Page["locator"]>): Promise<Box> {
	const value = await locator.boundingBox();
	if (!value) throw new Error("Expected a rendered element");
	return value;
}

test.describe("workbench design alignment", () => {
	test("Agent list arrival keeps each recent action in place and only then shows names", async ({
		page,
	}) => {
		const fixture = await workbenchFixture(page, { agentCollection: "held" });
		try {
			await page.goto("/");
			await expect.poll(() => fixture.held).toContain("/api/v2/agents");
			const recent = recentRegion(page);
			const actions = recent.locator(".workbench-list-side a");
			await expect(actions).toHaveCount(2);
			// NI-28：加载期每行「状态待确认」的可见文字至多 1 处（这里为 0），元信息只有时间。
			await expect(recent.getByText(/状态暂时无法确认|正在确认/)).toHaveCount(
				0,
			);
			await expect(
				recent.locator('[data-slot="chip-placeholder"][aria-hidden="true"]'),
			).toHaveCount(2);
			const before = [await box(actions.nth(0)), await box(actions.nth(1))];
			fixture.release();
			await expect(
				recent.getByRole("link", { name: /^继续对话：/ }),
			).toHaveCount(1);
			await expect(
				recent.getByRole("link", { name: /^查看历史：/ }),
			).toHaveCount(1);
			await expect(recent.locator("small").first()).toContainText(
				"受控助手 agent-b · ",
			);
			const after = [await box(actions.nth(0)), await box(actions.nth(1))];
			for (const [index, previous] of before.entries()) {
				expect(
					Math.abs((after[index]?.x ?? 0) - previous.x),
				).toBeLessThanOrEqual(1);
				expect(
					Math.abs((after[index]?.width ?? 0) - previous.width),
				).toBeLessThanOrEqual(1);
			}
			await expect(recent.getByText(/状态暂时无法确认/)).toHaveCount(0);
			expect(fixture.unexpected).toEqual([]);
		} finally {
			fixture.release();
		}
	});

	test("workbench keeps three rows and the same height for 3 and 60 histories", async ({
		page,
	}, info) => {
		test.skip(info.project.name !== "desktop", "Measured at 1440 by 900");
		const heights: number[] = [];
		for (const recentCount of [3, 60]) {
			const target = recentCount === 3 ? page : await page.context().newPage();
			await target.setViewportSize({ width: 1440, height: 900 });
			const fixture = await workbenchFixture(target, { recentCount });
			await target.goto("/");
			const recent = recentRegion(target);
			await expect(recent.getByRole("heading", { level: 3 })).toHaveText([
				"受控历史 0",
				"受控历史 1",
				"受控历史 2",
			]);
			await expect(
				recent.getByRole("button", { name: "加载更多对话" }),
			).toHaveCount(0);
			await expect(
				target
					.getByRole("region", { name: "可用 Agent", exact: true })
					.getByRole("heading", { level: 3 }),
			).toHaveCount(2);
			heights.push(
				await target.evaluate(() => document.documentElement.scrollHeight),
			);
			expect(
				fixture.requests
					.filter((request) => request.path.endsWith("/recent"))
					.map((request) => request.search),
			).toEqual(["?limit=3"]);
			expect(fixture.unexpected).toEqual([]);
		}
		expect(Math.abs((heights[0] ?? 0) - (heights[1] ?? 0))).toBeLessThanOrEqual(
			1,
		);
	});

	test("empty recent conversations use the design empty state and keep the heading outline", async ({
		page,
	}) => {
		const fixture = await workbenchFixture(page, { recentCount: 0 });
		await page.goto("/");
		const recent = recentRegion(page);
		const empty = recent.locator('[data-slot="empty"]');
		await expect(empty).toBeVisible();
		await expect(empty).toHaveCSS("border-top-style", "dashed");
		await expect(empty).toHaveCSS("border-radius", "14px");
		expect((await box(empty)).height).toBeGreaterThanOrEqual(220);
		const icon = empty.locator('svg[aria-hidden="true"]');
		await expect(icon).toHaveCSS("width", "28px");
		await expect(icon).toHaveCSS("height", "28px");
		const title = empty.getByText("暂无个人对话", { exact: true });
		await expect(title).toHaveCSS("font-size", "15px");
		await expect(title).toHaveCSS("font-weight", "700");
		await expect(
			empty.getByText("选择一个 Agent 开始新的个人对话。", { exact: true }),
		).toHaveCSS("font-size", "13px");
		await expect(page.getByRole("heading", { level: 2 })).toHaveText([
			"最近对话",
			"待处理",
			"可用 Agent",
			"我的申请",
		]);
		await expect(recent.getByRole("link", { name: "查看全部" })).toHaveCount(0);
		expect(fixture.unexpected).toEqual([]);
	});

	test("view-all is a ghost link with an arrow and a different target than new conversation", async ({
		page,
	}) => {
		const fixture = await workbenchFixture(page);
		await page.goto("/");
		const recent = recentRegion(page);
		const all = recent.getByRole("link", { name: "查看全部", exact: true });
		await expect(all).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
		await expect(all.locator('svg[aria-hidden="true"]')).toHaveCount(1);
		expect((await box(all)).height).toBeGreaterThanOrEqual(44);
		const create = page
			.locator("main .page-heading")
			.getByRole("link", { name: "新建对话" });
		expect(await all.getAttribute("href")).not.toBe(
			await create.getAttribute("href"),
		);
		await expect(all).toHaveAttribute("href", "/chat/agent-b/conversation-z");
		await expect(recent.getByRole("link", { name: "新对话" })).toHaveCount(0);
		expect(fixture.unexpected).toEqual([]);
	});

	test("recent, attention and application lists use the design list rows", async ({
		page,
	}, info) => {
		test.skip(info.project.name !== "desktop", "Both widths measured once");
		const fixture = await workbenchFixture(page, {
			administrator: true,
			attention: true,
		});
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.goto("/");
		await expect(
			page.getByRole("link", { name: "查看失败清单" }),
		).toBeVisible();
		const lists = page.locator(".ia-workbench .workbench-list");
		// 最近对话、待处理两组、我的申请。
		await expect(lists).toHaveCount(4);
		for (const list of await lists.all()) {
			const rows = list.locator(":scope > .workbench-list-row");
			const count = await rows.count();
			expect(count).toBeGreaterThan(0);
			await expect(rows.first()).toHaveCSS("padding-top", "0px");
			await expect(rows.last()).toHaveCSS("padding-bottom", "0px");
			await expect(rows.last()).toHaveCSS("border-bottom-width", "0px");
			for (const row of await rows.all()) {
				await expect(row).toHaveCSS("display", "flex");
				await expect(row).toHaveCSS("align-items", "flex-start");
				await expect(row).toHaveCSS("column-gap", "16px");
				const meta = row.locator(".workbench-list-main > small");
				if (await meta.count()) {
					await expect(meta).toHaveCSS("font-size", "12px");
					await expect(meta).toHaveCSS("margin-top", "3px");
				}
				const side = row.locator(".workbench-list-side");
				if (!(await side.count())) continue;
				const rowBox = await box(row);
				const paddingTop = Number.parseFloat(
					await row.evaluate((node) => getComputedStyle(node).paddingTop),
				);
				const action = await box(side.locator("a").first());
				const main = await box(row.locator(".workbench-list-main"));
				expect(
					Math.abs(action.x + action.width - (rowBox.x + rowBox.width)),
				).toBeLessThanOrEqual(1);
				expect(action.y - (rowBox.y + paddingTop)).toBeLessThanOrEqual(2);
				expect(action.x).toBeGreaterThanOrEqual(main.x + main.width);
			}
		}
		const recent = recentRegion(page);
		// 只读会话的说明并入元信息（agent-a 已停止）。
		await expect(recent.locator("small").nth(1)).toHaveText(/ · 历史只读$/);
		await expect(
			page.getByText("历史仍可查看，当前不能继续发送消息。"),
		).toHaveCount(0);
		await page.setViewportSize({ width: 390, height: 844 });
		for (const name of ["修改并重新提交", "配置与管理", "查看失败清单"]) {
			const action = page
				.getByRole("complementary", { name: "待处理" })
				.getByRole("link", { name: new RegExp(`^${name}`) })
				.first();
			const row = action.locator(
				"xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' workbench-list-row ')][1]",
			);
			await expect(row).toHaveCSS("display", "block");
			const main = await box(row.locator(".workbench-list-main"));
			const actionBox = await box(action);
			const rowBox = await box(row);
			expect(
				Math.abs(actionBox.y - (main.y + main.height + 10)),
			).toBeLessThanOrEqual(1);
			expect(Math.abs(actionBox.x - rowBox.x)).toBeLessThanOrEqual(1);
		}
		expect(fixture.unexpected).toEqual([]);
	});

	test("page heading stays in one row until 767px", async ({ page }, info) => {
		test.skip(info.project.name !== "desktop", "The viewport list runs once.");
		const fixture = await workbenchFixture(page);
		for (const viewport of [
			{ width: 820, height: 1180 },
			{ width: 1023, height: 800 },
			{ width: 767, height: 1024 },
			{ width: 390, height: 844 },
		]) {
			await page.setViewportSize(viewport);
			await page.goto("/");
			const heading = page.locator("main .page-heading");
			const copy = heading.locator(":scope > div").first();
			const action = heading.getByRole("link", { name: "新建对话" });
			await expect(action).toBeVisible();
			const copyBox = await box(copy);
			const actionBox = await box(action);
			if (viewport.width >= 768) {
				await expect(heading).toHaveCSS("flex-direction", "row");
				await expect(heading).toHaveCSS("flex-wrap", "nowrap");
				const headingBox = await box(heading);
				expect(
					Math.abs(
						actionBox.y + actionBox.height - (copyBox.y + copyBox.height),
					),
				).toBeLessThanOrEqual(2);
				expect(
					Math.abs(
						actionBox.x + actionBox.width - (headingBox.x + headingBox.width),
					),
				).toBeLessThanOrEqual(1);
			} else {
				await expect(action).toHaveCSS("margin-top", "16px");
				expect(actionBox.y).toBeGreaterThanOrEqual(copyBox.y + copyBox.height);
			}
		}
		expect(fixture.unexpected).toEqual([]);
	});

	test("application chips, row actions and section links follow the design", async ({
		page,
	}) => {
		const fixture = await workbenchFixture(page, {
			administrator: true,
			attention: true,
		});
		await page.goto("/");
		const applications = page.getByRole("region", {
			name: "我的申请",
			exact: true,
		});
		const red = await resolvedColor(page, "var(--danger-ink)");
		const amber = await resolvedColor(page, "var(--warning-ink)");
		for (const [name, label, color] of [
			["受控创建失败申请", "创建失败", red],
			["受控驳回申请", "已驳回", red],
			["Release assistant request", "待审批", amber],
		] as const) {
			const row = applications.locator(".workbench-list-row").filter({
				has: page.getByRole("heading", { level: 3, name, exact: true }),
			});
			const chip = row.locator('[data-slot="badge"]', { hasText: label });
			await expect(chip).toHaveCSS("color", color);
			expect(
				await chip.evaluate((node) => {
					const dot = getComputedStyle(node, "::before");
					return [dot.width, dot.height];
				}),
			).toEqual(["6px", "6px"]);
		}
		const recent = recentRegion(page);
		const history = recent.getByRole("link", { name: /^查看历史：/ });
		await expect(history).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
		await expect(history).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
		await expect(recent.getByRole("link", { name: /^继续对话：/ })).toHaveCSS(
			"border-top-color",
			await resolvedColor(page, "var(--border)"),
		);
		const directory = page
			.getByRole("region", { name: "可用 Agent", exact: true })
			.getByRole("link", { name: "查看目录", exact: true });
		await expect(directory).toHaveAttribute("href", "/agents");
		await expect(directory.locator('svg[aria-hidden="true"]')).toHaveCount(1);
		await expect(
			page.getByRole("link", { name: "查看全部 Agent" }),
		).toHaveCount(0);
		const create = applications.getByRole("link", {
			name: "创建申请",
			exact: true,
		});
		await expect(create).toHaveAttribute("href", "/my-agents/new");
		await expect(create.locator('svg[aria-hidden="true"]')).toHaveCount(1);
		const enter = page.getByRole("link", { name: /创建审批/ }).filter({
			hasText: "进入",
		});
		await expect(enter).toHaveText("进入");
		await expect(enter).toHaveAttribute("href", "/admin/approvals");
		expect(fixture.unexpected).toEqual([]);
	});

	test.describe("in Asia/Shanghai", () => {
		test.use({ timezoneId: "Asia/Shanghai" });
		test("recent times use the shared relative format inside time elements", async ({
			page,
		}) => {
			await page.clock.setFixedTime(new Date("2026-10-18T02:40:00Z"));
			const fixture = await workbenchFixture(page, {
				recentTimes: ["2026-10-18T02:33:00Z", "2026-07-27T02:00:00Z"],
			});
			await page.goto("/");
			const times = recentRegion(page).locator("small time");
			await expect(times).toHaveText(["今天 10:33", "7 月 27 日"]);
			expect(
				await times.evaluateAll((nodes) =>
					nodes.map((node) => node.getAttribute("datetime")),
				),
			).toEqual(["2026-10-18T02:33:00Z", "2026-07-27T02:00:00Z"]);
			expect(fixture.unexpected).toEqual([]);
		});
	});
});
