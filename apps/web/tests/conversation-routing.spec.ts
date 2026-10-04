import {
	AgentProjectionV2Schema,
	ConnectionCapabilityProjectionV1Schema,
	ConversationDetailProjectionV2Schema,
	ConversationPageV1Schema,
	ConversationProjectionV1Schema,
} from "@agent-infra/contracts/pilot";
import { pilotFakeScenariosV2 } from "@agent-infra/test-support/pilot";
import { expect, type Page, test } from "@playwright/test";
import {
	event,
	history,
} from "../src/features/conversation/conversation-test-fixtures";
import { captureDesignContract, designViewports } from "./design-contract";

async function routingFixture(
	page: Page,
	{
		agentId = "agent-1",
		agentName = "受控路由助手",
		conversationId = "conversation-1",
		messageRoles = false,
		stopped = false,
		longTitles = false,
		recentAcrossAgents = false,
		recentFailureStatus,
	}: {
		agentId?: string;
		agentName?: string;
		conversationId?: string;
		messageRoles?: boolean;
		stopped?: boolean;
		longTitles?: boolean;
		recentAcrossAgents?: boolean;
		recentFailureStatus?: number;
	} = {},
) {
	const requests: { method: string; path: string[]; search: string }[] = [];
	const unexpected: string[] = [];
	const agent = AgentProjectionV2Schema.parse({
		...pilotFakeScenariosV2.starting.response.body,
		agentId,
		name: agentName,
		managementStatus: stopped ? "stopped" : "available",
		serviceAvailability: stopped ? null : "ready",
	});
	const ids = [conversationId, "conversation-second", "conversation-created"];
	const metadata = (id: string) =>
		ConversationProjectionV1Schema.parse({
			...history(id, []).conversation,
			agentId,
			title: `受控历史 ${id}${longTitles ? " 中文长标题".repeat(30) : ""}`,
		});
	const detail = (id: string) => {
		const snapshot = history(
			id,
			messageRoles
				? [
						{
							...event(1, id),
							schemaVersion: 1,
							type: "text.delta",
							executionId: "execution-live",
							payload: { text: "受控流式回答" },
						},
					]
				: [],
		);
		const userMessage = {
			messageId: "controlled-question",
			role: "user",
			text: "受控长消息".repeat(50),
			status: "completed",
			executionId: "execution-old",
			replyToMessageId: null,
			answerVersion: null,
			isCurrentAnswer: null,
			error: null,
			createdAt: metadata(id).createdAt,
		};
		return ConversationDetailProjectionV2Schema.parse({
			...snapshot,
			conversation: {
				...metadata(id),
				lastConversationCursor: snapshot.conversation.lastConversationCursor,
			},
			messages: messageRoles
				? [
						userMessage,
						{
							...userMessage,
							role: "assistant",
							messageId: "controlled-answer-old",
							replyToMessageId: userMessage.messageId,
							text: "受控旧版回答",
							answerVersion: 1,
							isCurrentAnswer: false,
						},
						{
							...userMessage,
							role: "assistant",
							messageId: "controlled-answer-current",
							executionId: "execution-current",
							replyToMessageId: userMessage.messageId,
							text: `## 受控新版回答\n\n模型自称别的身份不会改变正式消息标题。\n\n\`\`\`text\n${"controlled-wide-code-".repeat(15)}\n\`\`\``,
							answerVersion: 2,
							isCurrentAnswer: true,
						},
						{
							...userMessage,
							messageId: "controlled-followup",
							text: "受控后续问题",
							executionId: "execution-live",
							status: "submitted",
						},
					]
				: [],
		});
	};
	await page.addInitScript(() => {
		const realFetch = window.fetch.bind(window);
		window.fetch = async (input, init) => {
			const request = new Request(input, init);
			const response = await realFetch(request);
			if (!new URL(request.url).pathname.endsWith("/events")) return response;
			void response.body?.cancel();
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(
						new TextEncoder().encode(": controlled heartbeat\n\n"),
					);
					if (request.signal.aborted) controller.close();
					else
						request.signal.addEventListener("abort", () => controller.close(), {
							once: true,
						});
				},
			});
			return new Response(body, {
				status: response.status,
				headers: response.headers,
			});
		};
	});
	await page.route("**/api/**", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const path = url.pathname.split("/").slice(1).map(decodeURIComponent);
		requests.push({ method: request.method(), path, search: url.search });
		if (url.pathname === "/api/v2/me/conversations/recent")
			return route.fulfill({
				status: recentFailureStatus ?? 200,
				json: recentFailureStatus
					? { message: "Controlled read failure" }
					: ConversationPageV1Schema.parse({
							items: recentAcrossAgents
								? [
										metadata(conversationId),
										{
											...metadata("conversation-other"),
											agentId: "agent-second",
											title: "受控跨 Agent 历史",
											status: "unavailable",
										},
									]
								: [],
							nextCursor: null,
						}),
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
		if (url.pathname === "/api/v1/session")
			return route.fulfill({
				json: {
					schemaVersion: 1,
					user: {
						userId: "controlled-person",
						displayName: "受控员工",
						roles: ["employee"],
					},
				},
				headers: { "X-Platform-Session-Generation": "g".repeat(43) },
			});
		if (
			path[1] === "v2" &&
			path[2] === "agents" &&
			[agentId, "agent-second"].includes(path[3] ?? "") &&
			path.length === 4
		)
			return route.fulfill({ json: { ...agent, agentId: path[3] } });
		if (path[1] === "v2" && path[2] === "agents" && path.length === 3)
			return route.fulfill({ json: { items: [agent], nextCursor: null } });
		if (
			path[1] === "v1" &&
			path[2] === "agents" &&
			path[3] === agentId &&
			path[4] === "conversations"
		) {
			if (request.method() === "POST")
				return route.fulfill({
					status: 201,
					json: metadata("conversation-created"),
				});
			return route.fulfill({
				json: ConversationPageV1Schema.parse({
					items: ids.slice(0, 2).map(metadata),
					nextCursor: null,
				}),
			});
		}
		if (path[1] === "v2" && path[2] === "conversations") {
			if (path[3] === "forbidden")
				return route.fulfill({
					status: 403,
					json: {
						schemaVersion: 1,
						code: "AUTHORIZATION_REVOKED",
						message: "Controlled denial",
						retryable: false,
						traceId: "controlled-route-denied",
					},
				});
			const requestedConversation = path[3];
			if (requestedConversation === "conversation-other") {
				if (path[4] === "events")
					return route.fulfill({
						contentType: "text/event-stream",
						body: ": controlled heartbeat\n\n",
					});
				return route.fulfill({
					json: ConversationDetailProjectionV2Schema.parse({
						...detail(requestedConversation),
						conversation: {
							...metadata(requestedConversation),
							agentId: "agent-second",
							status: "unavailable",
						},
					}),
				});
			}
			if (requestedConversation && ids.includes(requestedConversation)) {
				if (path[4] === "events")
					return route.fulfill({
						contentType: "text/event-stream",
						body: ": controlled heartbeat\n\n",
					});
				if (path.length === 4)
					return route.fulfill({ json: detail(requestedConversation) });
			}
		}
		unexpected.push(`${request.method()} ${url.pathname}`);
		return route.abort();
	});
	return {
		agentId,
		agentName: agent.name,
		conversationId,
		requests,
		unexpected,
	};
}

function canonical(agentId: string, conversationId?: string) {
	return `/chat/${encodeURIComponent(agentId)}${conversationId === undefined ? "" : `/${encodeURIComponent(conversationId)}`}`;
}

async function assertChat(page: Page, agentName = "受控路由助手") {
	await expect(
		page.getByRole("heading", { name: agentName, exact: true }),
	).toBeVisible();
	await expect(page.getByLabel("消息", { exact: true })).toBeVisible();
}

test("keeps the composer in view while a long conversation scrolls", async ({
	page,
}, info) => {
	const fixture = await routingFixture(page, { messageRoles: true });
	await page.goto(canonical(fixture.agentId, fixture.conversationId));
	await assertChat(page);
	const composer = page.getByLabel("消息", { exact: true });
	const send = page.locator('[data-c02-send-button="send"]');
	await info.attach("composer-viewport", {
		body: await page.screenshot({ animations: "disabled" }),
		contentType: "image/png",
	});
	await expect(composer).toBeInViewport({ ratio: 1 });
	await expect(send).toBeInViewport({ ratio: 1 });
	const before = await composer.boundingBox();
	const timeline = page.getByRole("region", { name: "会话时间线" });
	expect(
		await timeline.evaluate(
			(element) => element.scrollHeight > element.clientHeight,
		),
	).toBe(true);
	await timeline.evaluate((element) => {
		element.scrollTop = element.scrollHeight;
	});
	expect(
		await timeline.evaluate((element) => element.scrollTop),
	).toBeGreaterThan(0);
	await expect(composer).toBeInViewport({ ratio: 1 });
	await expect(send).toBeInViewport({ ratio: 1 });
	expect(await composer.boundingBox()).toEqual(before);
	expect(fixture.requests.every((request) => request.method === "GET")).toBe(
		true,
	);
	expect(fixture.unexpected).toEqual([]);
});

for (const compact of [false, true]) {
	test(`keeps the Agent header inside the left conversation column${compact ? " at 320 by 370" : ""}`, async ({
		page,
	}, info) => {
		if (compact) await page.setViewportSize({ width: 320, height: 370 });
		const fixture = await routingFixture(page, {
			agentName: "受控长名称助手".repeat(4),
		});
		await page.goto(canonical(fixture.agentId, fixture.conversationId));
		await assertChat(page, fixture.agentName);
		const header = page.locator(".conversation-header");

		const geometry = await header.evaluate((node) => {
			const workspace = document.querySelector(".chat-workspace");
			const history = document.querySelector(".conversation-history-panel");
			if (!workspace || !history)
				throw new Error("Expected parallel conversation regions");
			return {
				header: node.getBoundingClientRect().toJSON(),
				workspace: workspace.getBoundingClientRect().toJSON(),
				history: history.getBoundingClientRect().toJSON(),
				viewport: { width: innerWidth, height: innerHeight },
			};
		});
		await info.attach("conversation-header-geometry", {
			body: JSON.stringify(geometry),
			contentType: "application/json",
		});
		expect(geometry.header.left).toBe(geometry.workspace.left);
		expect(geometry.header.top).toBe(geometry.workspace.top);
		if (geometry.viewport.width >= 1024) {
			expect(
				Math.abs(geometry.workspace.top - geometry.history.top),
			).toBeLessThan(2);
			expect(geometry.history.left).toBeGreaterThanOrEqual(
				geometry.workspace.right,
			);
			expect(geometry.header.right).toBe(geometry.workspace.right);
		} else {
			await expect(page.locator(".conversation-history-panel")).toBeHidden();
			expect(geometry.header.right).toBe(geometry.workspace.right);
		}
		for (const [index, target] of [
			header.getByRole("heading", { name: fixture.agentName, exact: true }),
			header.getByRole("link", { name: "切换 Agent" }),
			header.getByRole("button", { name: "新建会话" }),
			...(geometry.viewport.width < 1024
				? [header.getByRole("button", { name: "个人历史" })]
				: []),
		].entries()) {
			await target.scrollIntoViewIfNeeded();
			await info.attach(`conversation-header-${index}-geometry`, {
				body: JSON.stringify(
					await target.evaluate((node) => ({
						target: node.getBoundingClientRect().toJSON(),
						viewport: { width: innerWidth, height: innerHeight },
						workspace: node
							.closest(".chat-workspace")
							?.getBoundingClientRect()
							.toJSON(),
						workspaceScrollTop: node.closest(".chat-workspace")?.scrollTop,
						documentScrollY: scrollY,
					})),
				),
				contentType: "application/json",
			});
			await info.attach(`conversation-header-${index}`, {
				body: await page.screenshot({ animations: "disabled" }),
				contentType: "image/png",
			});
			await expect(target).toBeInViewport({ ratio: 1 });
			await target.click({ trial: true });
		}
		expect(
			await page.evaluate(
				() =>
					Math.max(
						document.documentElement.scrollWidth,
						document.body.scrollWidth,
					) <= innerWidth,
			),
		).toBe(true);
		await header.getByRole("link", { name: "切换 Agent" }).focus();
		await page.keyboard.press("Enter");
		await expect(page).toHaveURL(/\/agents\?mode=conversation$/);
		await expect(page.locator('[data-slot="breadcrumb-page"]')).toHaveText(
			"选择 Agent 开始对话",
		);
		expect(fixture.requests.every((request) => request.method === "GET")).toBe(
			true,
		);
		expect(fixture.unexpected).toEqual([]);
	});
}

for (const compact of [false, true]) {
	test(`renders verified Agent message roles and preserves versions after refresh${compact ? " at 320 by 370" : ""}`, async ({
		page,
	}, info) => {
		if (compact) await page.setViewportSize({ width: 320, height: 370 });
		const fixture = await routingFixture(page, {
			agentName: "受控授权工程助手".repeat(7),
			messageRoles: true,
			recentAcrossAgents: true,
		});
		await page.goto(canonical(fixture.agentId, fixture.conversationId));
		await assertChat(page, fixture.agentName);
		const users = page.getByRole("article", { name: "你的消息", exact: true });
		const assistants = page.getByRole("article", {
			name: `${fixture.agentName}的消息`,
			exact: true,
		});
		await expect(users).toHaveCount(2);
		await expect(assistants).toHaveCount(2);
		await expect(
			assistants.first().getByRole("heading", { name: "受控新版回答" }),
		).toBeVisible();
		await expect(
			assistants.last().getByText("受控流式回答", { exact: true }),
		).toBeVisible();
		const input = page.getByLabel("消息", { exact: true });
		await input.fill("受控草稿，不自动发送。");
		expect(
			await users
				.first()
				.locator(".chat-message-body")
				.evaluate((element) =>
					Number.parseFloat(getComputedStyle(element).borderTopLeftRadius),
				),
		).toBeGreaterThan(0);
		for (const [frame, user] of [
			[users.first(), true],
			[assistants.first(), false],
		] as const) {
			const avatar = await frame.locator(".chat-message-avatar").boundingBox();
			const body = await frame.locator(".chat-message-body").boundingBox();
			if (!avatar || !body)
				throw new Error("Message avatar and body must be rendered");
			if (user) {
				expect(avatar.x).toBeGreaterThanOrEqual(
					body.x +
						body.width +
						((page.viewportSize()?.width ?? 0) < 768 ? 8 : 10),
				);
			} else {
				expect(body.x).toBeGreaterThanOrEqual(
					avatar.x +
						avatar.width +
						((page.viewportSize()?.width ?? 0) < 768 ? 8 : 10),
				);
			}
			await expect(frame.locator(".chat-message-avatar")).toHaveAttribute(
				"aria-hidden",
				"true",
			);
		}
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
		).toBe(true);
		for (const { frame, name } of [
			{ frame: users.first(), name: "controlled-user-message-roles" },
			{ frame: assistants.first(), name: "controlled-assistant-message-roles" },
		]) {
			await frame.locator(".message-heading").scrollIntoViewIfNeeded();
			await info.attach(`${name}-geometry`, {
				body: JSON.stringify(
					await frame.evaluate((element) => ({
						avatar: element
							.querySelector(".chat-message-avatar")
							?.getBoundingClientRect()
							.toJSON(),
						heading: element
							.querySelector(".message-heading")
							?.getBoundingClientRect()
							.toJSON(),
						viewport: { width: innerWidth, height: innerHeight },
						scrollBounds: [".timeline", ".chat-workspace"].map((selector) => {
							const node = element.closest(selector);
							return (
								node && {
									selector,
									rectangle: node.getBoundingClientRect().toJSON(),
									scrollTop: node.scrollTop,
									clientHeight: node.clientHeight,
									scrollHeight: node.scrollHeight,
								}
							);
						}),
					})),
				),
				contentType: "application/json",
			});
			await info.attach(name, {
				body: await page.screenshot({ animations: "disabled" }),
				contentType: "image/png",
			});
			await expect(frame.locator(".chat-message-avatar")).toBeInViewport({
				ratio: 1,
			});
			await expect(frame.locator(".message-heading")).toBeInViewport({
				ratio: 1,
			});
		}
		await assistants
			.first()
			.getByRole("button", { name: "上一个回答版本" })
			.click();
		await expect(
			assistants.first().getByText("受控旧版回答", { exact: true }),
		).toBeVisible();
		await expect(input).toHaveValue("受控草稿，不自动发送。");
		await page.reload();
		await assertChat(page, fixture.agentName);
		await expect(
			assistants.first().getByRole("heading", { name: "受控新版回答" }),
		).toBeVisible();
		await expect(
			assistants.last().getByText("受控流式回答", { exact: true }),
		).toHaveCount(1);
		expect(fixture.requests.every((request) => request.method === "GET")).toBe(
			true,
		);
		expect(fixture.unexpected).toEqual([]);
	});
}

test("collapses narrow history while preserving the draft, SSE and original cross-Agent record", async ({
	page,
}, info) => {
	const fixture = await routingFixture(page, {
		recentAcrossAgents: true,
		longTitles: true,
	});
	await page.goto(canonical(fixture.agentId, fixture.conversationId));
	await assertChat(page);
	const panel = page.locator(".conversation-history-panel");
	const workspace = page.locator(".chat-workspace");
	const narrow = (page.viewportSize()?.width ?? 0) < 1024;
	const input = page.getByLabel("消息", { exact: true });
	await input.fill("受控草稿，历史切换不会发送。");
	await expect
		.poll(
			() =>
				fixture.requests.filter((request) => request.path[4] === "events")
					.length,
		)
		.toBe(1);
	if (narrow) await expect(panel).toBeHidden();
	else {
		const chatBox = await workspace.boundingBox();
		const historyBox = await panel.boundingBox();
		if (!chatBox || !historyBox)
			throw new Error("Expected side-by-side conversation regions");
		expect(historyBox.x).toBeGreaterThanOrEqual(chatBox.x + chatBox.width);
		expect(Math.abs(chatBox.y - historyBox.y)).toBeLessThan(2);
	}
	if (narrow)
		await page.getByRole("button", { name: "个人历史", exact: true }).click();
	await panel.getByRole("button", { name: "此 Agent 的全部历史" }).click();
	await expect(panel.getByRole("heading", { name: "个人历史" })).toBeVisible();
	if (narrow) await expect(input).toBeHidden();
	else await expect(input).toBeVisible();
	await expect(input).toHaveValue("受控草稿，历史切换不会发送。");
	await expect(panel).toBeFocused();
	await page.goBack();
	await expect(input).toBeVisible();
	await expect(input).toHaveValue("受控草稿，历史切换不会发送。");
	if (narrow) await expect(panel).toBeHidden();
	await page.goForward();
	await expect(panel).toBeVisible();
	if (narrow) await expect(input).toBeHidden();
	await panel.getByRole("button", { name: "最近对话", exact: true }).click();
	if (narrow)
		await page.getByRole("button", { name: "返回对话", exact: true }).click();
	await expect(input).toBeVisible();
	await expect(input).toHaveValue("受控草稿，历史切换不会发送。");
	expect(
		fixture.requests.filter((request) => request.path[4] === "events"),
	).toHaveLength(1);
	if (narrow) {
		await page.getByRole("button", { name: "个人历史", exact: true }).click();
	}
	const other = panel.getByRole("link", { name: /受控跨 Agent 历史/ });
	await expect(other).toHaveAttribute(
		"href",
		"/chat/agent-second/conversation-other",
	);
	await expect(panel.locator('a[aria-current="page"]')).toHaveCount(1);
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= innerWidth,
		),
	).toBe(true);
	await info.attach("controlled-conversation-history-layout", {
		body: await page.screenshot({ fullPage: true, animations: "disabled" }),
		contentType: "image/png",
	});
	await other.focus();
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(/\/chat\/agent-second\/conversation-other$/);
	await expect(input).toBeVisible();
	await expect(input).toBeDisabled();
	await expect(page.locator("form[data-c02-session-id]")).toHaveAttribute(
		"data-c02-session-id",
		"conversation-other",
	);
	expect(fixture.requests.every((request) => request.method === "GET")).toBe(
		true,
	);
	expect(fixture.unexpected).toEqual([]);
});

test("keeps a missing recent endpoint distinct from logout or empty history", async ({
	page,
}) => {
	const fixture = await routingFixture(page, { recentFailureStatus: 404 });
	await page.goto(canonical(fixture.agentId, fixture.conversationId));
	await assertChat(page);
	if ((page.viewportSize()?.width ?? 0) < 1024) {
		await page.getByRole("button", { name: "个人历史", exact: true }).click();
	}
	await expect(page.getByText("最近对话读取入口不可用。")).toBeVisible();
	await expect(page.getByText("暂无个人对话。")).toHaveCount(0);
	await expect(page.getByText(/当前登录或访问权限已失效/)).toHaveCount(0);
	expect(fixture.requests.every((request) => request.method === "GET")).toBe(
		true,
	);
	expect(fixture.unexpected).toEqual([]);
});

for (const legacy of [false, true]) {
	test(`opens ${legacy ? "legacy" : "canonical"} history with opaque IDs, refresh and browser back without a business write`, async ({
		page,
	}, info) => {
		const fixture = await routingFixture(page, {
			agentId: "agent/?#%+%2F",
			conversationId: "conversation/?#%+%2F",
		});
		const target = canonical(fixture.agentId, fixture.conversationId);
		const entry = legacy
			? `/agents/${encodeURIComponent(fixture.agentId)}/conversations?conversation=${encodeURIComponent(fixture.conversationId)}`
			: target;
		await page.goto(entry);
		await assertChat(page);
		await expect(page).toHaveURL(
			new RegExp(`${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
		);
		await page.reload();
		await assertChat(page);
		if ((page.viewportSize()?.width ?? 0) < 1024)
			await page.getByRole("button", { name: "个人历史", exact: true }).click();
		await page.getByRole("button", { name: "此 Agent 的全部历史" }).click();
		const original = page.getByRole("link", {
			name: new RegExp(
				`^受控历史 ${fixture.conversationId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
			),
		});
		await expect(original).toHaveAttribute("href", target);
		await page
			.getByRole("link", { name: /^受控历史 conversation-second/ })
			.click();
		await expect(page).toHaveURL(/\/chat\/.*\/conversation-second$/);
		await assertChat(page);
		await page.goBack();
		await expect(
			page.getByRole("heading", { name: "个人历史", exact: true, level: 2 }),
		).toBeVisible();
		if ((page.viewportSize()?.width ?? 0) < 1024)
			await page.getByRole("button", { name: "返回对话", exact: true }).click();
		else
			await page.getByRole("button", { name: "最近对话", exact: true }).click();
		await assertChat(page);
		await expect(page.locator("form[data-c02-session-id]")).toHaveAttribute(
			"data-c02-session-id",
			fixture.conversationId,
		);
		expect(fixture.requests.every((request) => request.method === "GET")).toBe(
			true,
		);
		expect(
			fixture.requests
				.filter((request) => request.path[2] === "conversations")
				.every((request) =>
					[fixture.conversationId, "conversation-second"].includes(
						request.path[3] ?? "",
					),
				),
		).toBe(true);
		expect(fixture.unexpected).toEqual([]);
		await info.attach("controlled-canonical-chat", {
			body: await page.screenshot({ fullPage: true }),
			contentType: "image/png",
		});
	});
}

test("clears the selected path ID without POST and only creates on the explicit create action", async ({
	page,
}) => {
	const fixture = await routingFixture(page);
	await page.goto(canonical(fixture.agentId, fixture.conversationId));
	await assertChat(page);
	await page.getByRole("button", { name: "新建会话", exact: true }).click();
	await expect(page).toHaveURL(new RegExp(`${canonical(fixture.agentId)}$`));
	const create = page.getByRole("button", { name: "创建会话", exact: true });
	await expect(create).toBeEnabled();
	await page.reload();
	await expect(create).toBeEnabled();
	expect(fixture.requests.every((request) => request.method === "GET")).toBe(
		true,
	);
	await create.click();
	await expect(page).toHaveURL(/\/chat\/agent-1\/conversation-created$/);
	await assertChat(page);
	expect(
		fixture.requests
			.filter((request) => request.method === "POST")
			.map((request) => request.path),
	).toEqual([["api", "v1", "agents", fixture.agentId, "conversations"]]);
	expect(fixture.unexpected).toEqual([]);
});

test("opens the original stopped Conversation directly and keeps legacy history read-only without creating another conversation", async ({
	page,
}) => {
	const fixture = await routingFixture(page, { stopped: true });
	await page.goto(canonical(fixture.agentId, fixture.conversationId));
	await assertChat(page);
	await expect(page.locator("form[data-c02-session-id]")).toHaveAttribute(
		"data-c02-session-id",
		fixture.conversationId,
	);
	await expect(
		page
			.locator(".chat-workspace")
			.getByText("受控历史 conversation-1", { exact: true }),
	).toBeVisible();
	await expect(page.getByLabel("消息", { exact: true })).toBeDisabled();
	await expect(
		page.getByRole("heading", { name: "个人历史", exact: true, level: 2 }),
	).toHaveCount(0);
	await test.info().attach("controlled-direct-stopped-conversation", {
		body: await page.screenshot({ fullPage: true, animations: "disabled" }),
		contentType: "image/png",
	});
	await page.goto(
		`/agents/${fixture.agentId}/conversations?conversation=${fixture.conversationId}&view=history`,
	);
	await expect(page).toHaveURL(
		/\/chat\/agent-1\/conversation-1\?view=history$/,
	);
	await expect(
		page.getByRole("heading", { name: "个人历史", exact: true, level: 2 }),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "新建会话", exact: true }),
	).toBeDisabled();
	if ((page.viewportSize()?.width ?? 0) < 1024)
		await page.getByRole("button", { name: "返回对话", exact: true }).click();
	else
		await page.getByRole("button", { name: "最近对话", exact: true }).click();
	await assertChat(page);
	await expect(page.getByLabel("消息", { exact: true })).toBeDisabled();
	await page.reload();
	await expect(page.getByLabel("消息", { exact: true })).toBeDisabled();
	expect(fixture.requests.every((request) => request.method === "GET")).toBe(
		true,
	);
	expect(fixture.unexpected).toEqual([]);
});

test("rejects a substituted conversation using the existing consumer authorization boundary", async ({
	page,
}) => {
	const fixture = await routingFixture(page);
	await page.goto(canonical(fixture.agentId, "forbidden"));
	await expect(page.getByText(/当前登录或访问权限已失效/)).toBeVisible();
	await expect(page.getByLabel("消息", { exact: true })).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "创建会话", exact: true }),
	).toHaveCount(0);
	expect(fixture.requests.every((request) => request.method === "GET")).toBe(
		true,
	);
	expect(fixture.unexpected).toEqual([]);
});

test("redirects the legacy no-conversation entry without creating a conversation", async ({
	page,
}) => {
	const fixture = await routingFixture(page);
	await page.goto(`/agents/${fixture.agentId}/conversations`);
	await expect(page).toHaveURL(/\/chat\/agent-1$/);
	await expect(
		page.getByRole("button", { name: "创建会话", exact: true }),
	).toBeVisible();
	await expect(page.locator('[data-slot="breadcrumb-page"]')).toHaveText(
		"对话",
	);
	const menu = page.getByRole("button", { name: "打开导航", exact: true });
	if (await menu.isVisible()) await menu.click();
	await page
		.getByRole("navigation", { name: "工作区", exact: true })
		.getByRole("link", { name: "对话", exact: true })
		.click();
	await expect(page).toHaveURL(/\/agents\?mode=conversation$/);
	await expect(page.locator('[data-slot="breadcrumb-page"]')).toHaveText(
		"选择 Agent 开始对话",
	);
	if (await menu.isVisible()) await menu.click();
	const workspace = page.getByRole("navigation", {
		name: "工作区",
		exact: true,
	});
	await expect(
		workspace.getByRole("link", { name: "对话", exact: true }),
	).toHaveAttribute("aria-current", "page");
	await expect(
		workspace.getByRole("link", { name: "Agent 目录", exact: true }),
	).not.toHaveAttribute("aria-current", "page");
	expect(fixture.requests.every((request) => request.method === "GET")).toBe(
		true,
	);
	expect(fixture.unexpected).toEqual([]);
});

test("keeps canonical chat and long personal-history titles usable at 320 by 370", async ({
	page,
}, info) => {
	await page.setViewportSize({ width: 320, height: 370 });
	const fixture = await routingFixture(page, { longTitles: true });
	await page.goto(canonical(fixture.agentId, fixture.conversationId));
	await assertChat(page);
	const message = page.getByLabel("消息", { exact: true });
	await message.scrollIntoViewIfNeeded();
	await message.click();
	await expect(message).toBeFocused();
	await message.fill("受控中文草稿，导航不会提交。");
	await page.getByRole("button", { name: "个人历史", exact: true }).click();
	await page.getByRole("button", { name: "此 Agent 的全部历史" }).click();
	const original = page.getByRole("link", { name: /^受控历史 conversation-1/ });
	await original.scrollIntoViewIfNeeded();
	await original.focus();
	await expect(original).toBeFocused();
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= innerWidth,
		),
	).toBe(true);
	await page.keyboard.press("Enter");
	await assertChat(page);
	await expect(page.locator("form[data-c02-session-id]")).toHaveAttribute(
		"data-c02-session-id",
		fixture.conversationId,
	);
	expect(fixture.requests.every((request) => request.method === "GET")).toBe(
		true,
	);
	expect(fixture.unexpected).toEqual([]);
	await info.attach("controlled-320-low-chat", {
		body: await page.screenshot({ fullPage: true }),
		contentType: "image/png",
	});
});

for (const status of [503, 403]) {
	test(`conversation loading and ${status} keep the page heading and recovery boundary`, async ({
		page,
	}, info) => {
		const fixture = await routingFixture(page);
		let release = () => {};
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		await page.route("**/api/v2/agents/agent-1", async (route) => {
			await pending;
			await route.fulfill({
				status,
				json: { message: "Controlled Agent read failure" },
			});
		});
		await page.goto(canonical(fixture.agentId, fixture.conversationId));
		await expect(page.getByText("正在读取 Agent…")).toBeVisible();
		const heading = page.getByRole("heading", {
			name: "对话",
			exact: true,
			level: 1,
		});
		await expect(heading).toHaveCSS(
			"font-size",
			info.project.name === "mobile" ? "22px" : "28px",
		);
		const titleBox = await heading.boundingBox();
		const eyebrowBox = await page
			.locator(".conversation-eyebrow")
			.boundingBox();
		if (!titleBox || !eyebrowBox)
			throw new Error("Expected conversation heading");
		expect(titleBox.x).toBe(eyebrowBox.x);
		expect(titleBox.y).toBeGreaterThanOrEqual(eyebrowBox.y + eyebrowBox.height);
		await info.attach("conversation-loading", {
			body: await page.screenshot(),
			contentType: "image/png",
		});
		release();
		await expect(page.getByRole("alert")).toBeVisible();
		await expect(heading).toBeVisible();
		expect(await heading.boundingBox()).toEqual(titleBox);
		await expect(
			page.getByRole("link", { name: "返回 Agent 列表", exact: true }),
		).toBeVisible();
		await expect(page.getByLabel("消息", { exact: true })).toHaveCount(0);
		await info.attach(`conversation-${status}`, {
			body: await page.screenshot(),
			contentType: "image/png",
		});
		if (status === 503) {
			await page.unroute("**/api/v2/agents/agent-1");
			await page.getByRole("button", { name: "重新读取", exact: true }).click();
			await assertChat(page);
		} else {
			await expect(
				page.getByRole("button", { name: "重新读取", exact: true }),
			).toHaveCount(0);
		}
		expect(fixture.requests.every((request) => request.method === "GET")).toBe(
			true,
		);
	});
}

test("exported design viewport matrix conversation", async ({ page }, info) => {
	test.skip(
		info.project.name !== "desktop",
		"The exported nine-viewport matrix runs once.",
	);
	const fixture = await routingFixture(page, { messageRoles: true });
	await page.goto(canonical(fixture.agentId, fixture.conversationId));
	await assertChat(page);
	const input = page.getByLabel("消息", { exact: true });
	await input.fill("验收草稿，切换历史不提交。");
	for (const viewport of designViewports) {
		await page.setViewportSize(viewport);
		await expect(input).toBeInViewport({ ratio: 1 });
		const timeline = page.locator(".timeline");
		const before = await input.boundingBox();
		await timeline.evaluate((node) => {
			node.scrollTop = node.scrollHeight;
		});
		expect(await input.boundingBox()).toEqual(before);
		if (viewport.width <= 430) {
			const heading = await page
				.locator(".conversation-agent-switch")
				.boundingBox();
			const actions = await page
				.locator(".conversation-heading-actions")
				.boundingBox();
			const models = await page.locator(".model-controls").boundingBox();
			if (!heading || !actions || !models)
				throw new Error("Expected compact conversation controls");
			expect(actions.y).toBeLessThan(heading.y + heading.height);
			expect(models.y).toBeLessThanOrEqual(240);
		}
		const panel = page.getByRole("complementary", { name: "对话历史" });
		const toggle = page.getByRole("button", { name: "个人历史", exact: true });
		if (viewport.width >= 1024) {
			await expect(toggle).toBeHidden();
			const chatBox = await page.locator(".chat-workspace").boundingBox();
			const panelBox = await panel.boundingBox();
			if (!chatBox || !panelBox) throw new Error("Missing desktop regions");
			expect(panelBox.width).toBe(270);
			expect(panelBox.x - chatBox.x - chatBox.width).toBeCloseTo(20, 0);
			expect(panelBox.y).toBe(chatBox.y);
		} else await expect(panel).toBeHidden();
		await captureDesignContract(page, info, "conversation");
		if (viewport.width < 1024) {
			await page.getByRole("button", { name: "个人历史", exact: true }).click();
			await expect(input).toBeHidden();
			await expect(
				page.getByRole("complementary", { name: "对话历史" }),
			).toBeFocused();
			await expect(
				panel.getByRole("region", { name: "最近对话" }),
			).toBeVisible();
			await captureDesignContract(page, info, "conversation-recent");
			await panel.getByRole("button", { name: "此 Agent 的全部历史" }).click();
			await expect(page).toHaveURL(/\?view=history$/);
			await captureDesignContract(page, info, "conversation-agent-history");
			await page.getByRole("button", { name: "返回对话", exact: true }).click();
			await expect(input).toBeInViewport({ ratio: 1 });
			await expect(input).toHaveValue("验收草稿，切换历史不提交。");
		}
	}
	expect(fixture.requests.every((request) => request.method === "GET")).toBe(
		true,
	);
	expect(
		fixture.requests.filter((request) => request.path[4] === "events"),
	).toHaveLength(1);
	expect(fixture.unexpected).toEqual([]);
});
