import {
	AgentProjectionV2Schema,
	ConnectionCapabilityProjectionV1Schema,
	ConversationDetailProjectionV2Schema,
	ConversationPageV1Schema,
	ConversationProjectionV1Schema,
} from "@agent-infra/contracts/pilot";
import { pilotFakeScenariosV2 } from "@agent-infra/test-support/pilot";
import { expect, type Page, type TestInfo, test } from "@playwright/test";
import {
	event,
	history,
} from "../src/features/conversation/conversation-test-fixtures";
import { captureDesignContract, designViewports } from "./design-contract";
import { controlledFileLimits, isFileLimitsRequest } from "./file-limits";

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
		owner = false,
		nativeCapabilities,
	}: {
		agentId?: string;
		agentName?: string;
		conversationId?: string;
		messageRoles?: boolean;
		stopped?: boolean;
		longTitles?: boolean;
		recentAcrossAgents?: boolean;
		recentFailureStatus?: number;
		/** 当前登录用户是该 Agent 的 Owner。 */
		owner?: boolean;
		/** 开启原生命令目录，并让命令与 Skill 目录各返回这么多项。 */
		nativeCapabilities?: number;
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
		capabilities: {
			...pilotFakeScenariosV2.starting.response.body.capabilities,
			nativeMetadata: nativeCapabilities !== undefined,
		},
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
		if (isFileLimitsRequest(request.method(), url.pathname))
			return route.fulfill({ json: controlledFileLimits() });
		if (url.pathname === "/api/v1/session")
			return route.fulfill({
				json: {
					schemaVersion: 1,
					user: {
						userId: owner
							? (agent.configuration.owners[0]?.userId ?? "controlled-owner")
							: "controlled-person",
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
			if (
				path[4] === "executions" &&
				path[6] === "native-metadata" &&
				request.method() === "GET"
			) {
				const commands = url.searchParams.get("selector") === "commands";
				const count = Math.ceil((nativeCapabilities ?? 0) / 2);
				return route.fulfill({
					json: {
						selector: commands ? "commands" : "skills",
						revision: (commands ? "c" : "d").repeat(64),
						capabilities: Array.from({ length: count }, (_, index) =>
							commands
								? {
										id: `${index}`.padStart(64, "c"),
										kind: "command",
										name: `受控命令-${index + 1}`,
										description: "读取当前会话状态",
										source: { name: "codex", version: "1.0.0" },
										parameters: [],
										effect: "read_only",
										availability: "available",
									}
								: {
										id: `${index}`.padStart(64, "d"),
										kind: "skill",
										name: `受控 Skill-${index + 1}`,
										description: "梳理工作区变更",
										source: { name: "skillhub", version: "2.1.0" },
										availability: "discovered",
									},
						),
					},
				});
			}
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
	test(`spans the Agent header across the conversation and history columns${compact ? " at 320 by 370" : ""}`, async ({
		page,
	}, info) => {
		if (compact) await page.setViewportSize({ width: 320, height: 370 });
		const fixture = await routingFixture(page, {
			agentName: "受控长名称助手".repeat(4),
		});
		await page.goto(canonical(fixture.agentId, fixture.conversationId));
		await assertChat(page, fixture.agentName);
		const header = page.locator(".conversation-header");
		const heading = header.getByRole("heading", {
			name: fixture.agentName,
			exact: true,
			level: 1,
		});
		const create = header.getByRole("button", { name: "新会话", exact: true });
		const geometry = await header.evaluate((node) => {
			const workspace = document.querySelector(".chat-workspace");
			const history = document.querySelector(".conversation-history-panel");
			const columns = document.querySelector(".conversation-columns");
			const create = [...node.querySelectorAll("button")].find(
				(button) => button.textContent?.trim() === "新会话",
			);
			if (!workspace || !history || !columns || !create)
				throw new Error("Expected conversation regions");
			return {
				insideColumns: Boolean(node.closest(".conversation-columns")),
				header: node.getBoundingClientRect().toJSON(),
				heading: node.querySelector("h1")?.getBoundingClientRect().toJSON(),
				create: create.getBoundingClientRect().toJSON(),
				columns: columns.getBoundingClientRect().toJSON(),
				workspace: workspace.getBoundingClientRect().toJSON(),
				history: history.getBoundingClientRect().toJSON(),
				viewport: { width: innerWidth, height: innerHeight },
			};
		});
		await info.attach("conversation-header-geometry", {
			body: JSON.stringify(geometry),
			contentType: "application/json",
		});
		// CH-04：页头在对话栅格之外，横跨内容区；「新会话」贴右缘。
		expect(geometry.insideColumns).toBe(false);
		expect(geometry.header.left).toBe(geometry.columns.left);
		expect(geometry.header.right).toBe(geometry.columns.right);
		expect(
			Math.abs(geometry.create.right - geometry.header.right),
		).toBeLessThanOrEqual(1);
		expect(geometry.columns.top).toBeGreaterThanOrEqual(geometry.header.bottom);
		if (geometry.viewport.width >= 1024) {
			// 历史面板与对话列同一水平线开始，距页头 16px；面板宽 270、列间距 20。
			expect(
				Math.abs(geometry.workspace.top - geometry.history.top),
			).toBeLessThanOrEqual(1);
			expect(
				geometry.history.top - geometry.header.bottom,
			).toBeGreaterThanOrEqual(16);
			expect(
				Math.abs(geometry.history.right - geometry.create.right),
			).toBeLessThanOrEqual(1);
			expect(geometry.history.width).toBe(270);
			expect(Math.round(geometry.history.left - geometry.workspace.right)).toBe(
				20,
			);
		} else {
			await expect(page.locator(".conversation-history-panel")).toBeHidden();
			const toggle = await header
				.getByRole("button", { name: "个人历史", exact: true })
				.boundingBox();
			// 窄屏「个人历史」「新会话」与标题同行，不挤到第二行。
			if (!toggle || !geometry.heading) throw new Error("Expected header row");
			expect(toggle.y).toBeLessThanOrEqual(geometry.heading.bottom);
			expect(geometry.create.top).toBeLessThanOrEqual(geometry.heading.bottom);
		}
		for (const [index, target] of [
			heading,
			create,
			...(geometry.viewport.width < 1024
				? [header.getByRole("button", { name: "个人历史" })]
				: []),
		].entries()) {
			await info.attach(`conversation-header-${index}`, {
				body: await page.screenshot({ animations: "disabled" }),
				contentType: "image/png",
			});
			await expect(target).toBeInViewport({ ratio: 1 });
			if (index > 0) await target.click({ trial: true });
		}
		// F-08：h1 只是 Agent 名称，不再包在「切换 Agent」链接里，也没有下拉箭头。
		expect(await heading.evaluate((node) => Boolean(node.closest("a")))).toBe(
			false,
		);
		await expect(heading.locator("svg")).toHaveCount(0);
		await expect(page.getByRole("link", { name: "切换 Agent" })).toHaveCount(0);
		await expect(header.getByRole("button", { name: "新建会话" })).toHaveCount(
			0,
		);
		expect(
			await page.evaluate(
				() =>
					Math.max(
						document.documentElement.scrollWidth,
						document.body.scrollWidth,
					) <= innerWidth,
			),
		).toBe(true);
		// 切换 Agent 走侧栏「对话」。
		const menu = page.getByRole("button", { name: "打开导航", exact: true });
		if (await menu.isVisible()) await menu.click();
		const conversations = page
			.getByRole("navigation", { name: "工作区", exact: true })
			.getByRole("link", { name: "对话", exact: true });
		await conversations.focus();
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

async function assertNarrowHistoryPosition(
	page: Page,
	info: TestInfo,
	state: string,
) {
	const header = await page.locator(".conversation-header").boundingBox();
	const panel = await page.locator(".conversation-history-panel").boundingBox();
	if (!header || !panel)
		throw new Error("Expected header and personal history");
	const gap = panel.y - header.y - header.height;
	await info.attach(`history-${state}-${page.viewportSize()?.width}-geometry`, {
		body: JSON.stringify({ header, panel, gap }),
		contentType: "application/json",
	});
	// Only the normal margin and gutter may separate the header from history.
	expect(gap).toBeGreaterThanOrEqual(0);
	expect(gap).toBeLessThanOrEqual(40);
	await expect(
		page.getByRole("button", { name: "返回对话", exact: true }),
	).toBeVisible();
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

test("creates a conversation in one step from the header and keeps the direct entry explicit", async ({
	page,
}) => {
	const fixture = await routingFixture(page);
	await page.goto(canonical(fixture.agentId));
	// 不带会话参数直接进入时不自动创建（导航不产生业务写入），由用户明确创建。
	const create = page.getByRole("button", { name: "创建会话", exact: true });
	await expect(create).toBeEnabled();
	await page.reload();
	await expect(create).toBeEnabled();
	expect(fixture.requests.every((request) => request.method === "GET")).toBe(
		true,
	);
	await page.goto(canonical(fixture.agentId, fixture.conversationId));
	await assertChat(page);
	// CH-10：页头「新会话」一步创建会话并进入可输入的 composer。
	await page.getByRole("button", { name: "新会话", exact: true }).click();
	await expect(page).toHaveURL(/\/chat\/agent-1\/conversation-created$/);
	await assertChat(page);
	await expect(page.locator("form[data-c02-session-id]")).toHaveAttribute(
		"data-c02-session-id",
		"conversation-created",
	);
	await expect(create).toHaveCount(0);
	await expect(page.getByLabel("消息", { exact: true })).toHaveAttribute(
		"placeholder",
		"输入消息，或 / 搜索命令与 Skill…",
	);
	await expect(
		page.getByRole("status").filter({
			hasText: "新会话已创建，已出现在最近对话",
		}),
	).toBeVisible();
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
	// NW-14：已停止横幅位于页头与对话栅格之间，横跨全宽；普通成员没有 Owner 入口。
	const banner = page
		.locator('[data-slot="alert"]')
		.filter({ hasText: "已停止" });
	await expect(banner).toHaveAttribute("role", "status");
	await expect(banner).toContainText("可以查看历史，暂时不能发送消息。");
	await expect(banner.locator("strong")).toHaveCSS("font-weight", "650");
	await expect(banner).toHaveCSS("padding", "13px 14px");
	await expect(banner).toHaveCSS("border-radius", "12px");
	await expect(banner).toHaveCSS("font-size", "13px");
	const icon = banner.locator("svg").first();
	await expect(icon).toHaveAttribute("aria-hidden", "true");
	expect(await icon.boundingBox()).toMatchObject({ width: 17, height: 17 });
	const bannerGeometry = await banner.evaluate((node) => ({
		inColumns: Boolean(node.closest(".conversation-columns")),
		banner: node.getBoundingClientRect().toJSON(),
		header: document
			.querySelector(".conversation-header")
			?.getBoundingClientRect()
			.toJSON(),
		columns: document
			.querySelector(".conversation-columns")
			?.getBoundingClientRect()
			.toJSON(),
	}));
	expect(bannerGeometry.inColumns).toBe(false);
	expect(bannerGeometry.banner.width).toBe(bannerGeometry.header?.width);
	expect(bannerGeometry.banner.top).toBeGreaterThanOrEqual(
		bannerGeometry.header?.bottom ?? 0,
	);
	expect(bannerGeometry.banner.bottom).toBeLessThanOrEqual(
		bannerGeometry.columns?.top ?? 0,
	);
	await expect(page.getByText(/联系 Owner/)).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "刷新 Agent 状态" }),
	).toHaveCount(0);
	await expect(page.getByRole("link", { name: "进入 Owner 操作" })).toHaveCount(
		0,
	);
	await expect(page.getByLabel("消息", { exact: true })).toBeDisabled();
	await expect(
		page.getByRole("region", { name: "个人历史", exact: true }),
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
		page.getByRole("button", { name: "新会话", exact: true }),
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
	await assertNarrowHistoryPosition(page, info, "recent");
	await captureDesignContract(page, info, "compact-history-recent");
	await page.getByRole("button", { name: "此 Agent 的全部历史" }).click();
	await assertNarrowHistoryPosition(page, info, "full");
	await captureDesignContract(page, info, "compact-history-full");
	await expect(message).toHaveValue("受控中文草稿，导航不会提交。");
	await page.reload();
	await expect(page).toHaveURL(/\?view=history$/);
	await expect(page.getByRole("heading", { name: "个人历史" })).toBeVisible();
	await assertNarrowHistoryPosition(page, info, "refreshed");
	await captureDesignContract(page, info, "compact-history-refreshed");
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
			const header = await page.locator(".conversation-header").boundingBox();
			const heading = await page
				.locator(".conversation-header h1")
				.boundingBox();
			const actions = await page
				.locator(".conversation-heading-actions")
				.boundingBox();
			const models = await page
				.locator("form.composer-zone .composer-model-controls")
				.boundingBox();
			const composer = await input.boundingBox();
			if (!header || !heading || !actions || !models || !composer)
				throw new Error("Expected compact conversation controls");
			// CH-04：窄屏页头单行，「个人历史」「新会话」与标题同行。
			expect(actions.y).toBeLessThanOrEqual(heading.y + heading.height);
			expect(header.height).toBeLessThanOrEqual(60);
			// CH-01：模型入口在输入框下方的 composer 工具栏内，不在时间线上方。
			expect(models.y).toBeGreaterThanOrEqual(composer.y + composer.height);
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
			await assertNarrowHistoryPosition(page, info, "recent");
			await captureDesignContract(page, info, "conversation-recent");
			await panel.getByRole("button", { name: "此 Agent 的全部历史" }).click();
			await expect(page).toHaveURL(/\?view=history$/);
			await assertNarrowHistoryPosition(page, info, "full");
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

for (const viewport of [
	{ width: 1366, height: 500 },
	{ width: 820, height: 600 },
	{ width: 390, height: 560 },
	{ width: 320, height: 370 },
]) {
	test(`keeps only the timeline scrolling at ${viewport.width} by ${viewport.height}`, async ({
		page,
	}, info) => {
		test.skip(info.project.name !== "desktop", "The viewport list runs once.");
		await page.setViewportSize(viewport);
		const fixture = await routingFixture(page, { messageRoles: true });
		await page.goto(canonical(fixture.agentId, fixture.conversationId));
		await assertChat(page);
		const input = page.getByLabel("消息", { exact: true });
		const send = page.locator('[data-c02-send-button="send"]');
		const timeline = page.getByRole("region", { name: "会话时间线" });
		// CH-11 / NI-47 / NI-102：文档不滚动，composer 固定在底部，只有时间线一处滚动。
		const scroll = await page.evaluate(() => ({
			document: document.documentElement.scrollHeight,
			viewport: innerHeight,
			scrollers: [...document.querySelectorAll(".chat-workspace *")]
				.filter(
					(node) =>
						node.scrollHeight > node.clientHeight + 1 &&
						["auto", "scroll"].includes(getComputedStyle(node).overflowY),
				)
				.map((node) => node.getAttribute("aria-label") ?? node.className),
			maxHeight: getComputedStyle(
				document.querySelector(".timeline") as Element,
			).maxHeight,
			workspaceOverflow: (() => {
				const workspace = document.querySelector(".chat-workspace");
				return workspace ? workspace.scrollHeight - workspace.clientHeight : 0;
			})(),
		}));
		await info.attach("short-viewport-scroll", {
			body: JSON.stringify(scroll),
			contentType: "application/json",
		});
		expect(scroll.document).toBeLessThanOrEqual(scroll.viewport);
		expect(scroll.scrollers).toEqual(["会话时间线"]);
		expect(scroll.workspaceOverflow).toBeLessThanOrEqual(0);
		expect(scroll.maxHeight).toBe("none");
		await expect(input).toBeInViewport({ ratio: 1 });
		await expect(send).toBeInViewport({ ratio: 1 });
		const before = await input.boundingBox();
		await timeline.evaluate((node) => {
			node.scrollTop = node.scrollHeight;
		});
		expect(await input.boundingBox()).toEqual(before);
		// 时间线至少放得下一条完整的单行消息。
		const last = page.getByRole("article", { name: "你的消息" }).last();
		await last.scrollIntoViewIfNeeded();
		await expect(last.locator(".chat-message-body")).toBeInViewport({
			ratio: 1,
		});
		await expect(last.locator(".chat-message-avatar")).toBeInViewport({
			ratio: 1,
		});
		expect(
			await page.evaluate(() => document.documentElement.scrollHeight),
		).toBeLessThanOrEqual(viewport.height);
		expect(fixture.unexpected).toEqual([]);
	});
}

test("matches the exported composer toolbar and history panel styles", async ({
	page,
}, info) => {
	test.skip(info.project.name !== "desktop", "Desktop geometry runs once.");
	await page.setViewportSize({ width: 1440, height: 900 });
	const fixture = await routingFixture(page, {
		recentAcrossAgents: true,
		longTitles: true,
	});
	await page.goto(canonical(fixture.agentId, fixture.conversationId));
	await assertChat(page);
	const controls = page.locator("form.composer-zone .composer-controls");
	// CH-06：无上边线，padding 6px 8px，gap 4px；没有快捷键提示。
	await expect(controls).toHaveCSS("border-top-width", "0px");
	await expect(controls).toHaveCSS("padding", "6px 8px");
	await expect(controls).toHaveCSS("column-gap", "4px");
	await expect(page.getByText("Enter 发送 · Shift + Enter 换行")).toHaveCount(
		0,
	);
	// 左侧第一个控件是「命令 / Skill」，之后是模型与思考入口。
	const toolbar = controls.locator(".composer-toolbar");
	const capability = toolbar.getByRole("button", { name: "选择命令或 Skill" });
	await expect(capability).toHaveText("命令 / Skill");
	await expect(capability).toHaveCSS("font-weight", "400");
	expect((await capability.boundingBox())?.height).toBeGreaterThanOrEqual(44);
	const model = toolbar.locator(".composer-setting-trigger").first();
	await expect(model).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
	await expect(model).toHaveCSS("border-top-width", "0px");
	await expect(model).toHaveCSS("font-size", "13px");
	const muted = await page.evaluate(() => {
		const probe = document.createElement("span");
		probe.style.color = "var(--muted-foreground)";
		document.body.append(probe);
		const color = getComputedStyle(probe).color;
		probe.remove();
		return color;
	});
	await expect(model).toHaveCSS("color", muted);
	expect((await model.boundingBox())?.height).toBeGreaterThanOrEqual(44);
	expect((await model.locator(".control-face").boundingBox())?.height).toBe(28);
	await expect(toolbar.locator(".composer-setting-trigger")).toHaveCount(2);
	await expect(toolbar.locator(".composer-setting-trigger").nth(1)).toHaveText(
		"均衡",
	);
	// CH-07：发送为 btn-sm（7px 11px、12px）+ 纸飞机图标。
	const send = page.locator('[data-c02-send-button="send"]');
	await expect(send).toHaveCSS("padding", "7px 11px");
	await expect(send).toHaveCSS("font-size", "12px");
	await expect(send.locator("svg.lucide-send")).toHaveCount(1);
	await expect(send.locator("svg.lucide-arrow-up")).toHaveCount(0);
	// CH-09：历史头部与条目。
	const panel = page.getByRole("complementary", { name: "对话历史" });
	await expect(
		panel.getByRole("heading", { name: "个人历史", level: 2 }),
	).toHaveCSS("font-size", "15px");
	await expect(panel.getByText("只显示你的会话")).toHaveCSS(
		"font-size",
		"13px",
	);
	const chip = panel.locator('[data-slot="badge"]');
	await expect(chip).toHaveCSS("font-size", "11px");
	await expect(chip).toHaveCSS("min-height", "24px");
	await expect(chip).toHaveCSS("border-radius", "999px");
	await expect(panel.getByRole("heading", { name: "最近对话" })).toHaveCount(0);
	const items = panel.locator(".conversation-history-item");
	const title = items.first().locator("strong");
	await expect(title).toHaveCSS("white-space", "nowrap");
	await expect(title).toHaveCSS("text-overflow", "ellipsis");
	await expect(title).toHaveCSS("overflow-x", "hidden");
	await expect(items.first()).toHaveAccessibleName(/中文长标题/);
	const heights = await items.evaluateAll((nodes) =>
		nodes.map((node) => node.getBoundingClientRect().height),
	);
	expect(Math.abs((heights[0] ?? 0) - (heights[1] ?? 0))).toBeLessThanOrEqual(
		2,
	);
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= innerWidth,
		),
	).toBe(true);
	expect(fixture.unexpected).toEqual([]);
});

for (const viewport of [
	{ width: 390, height: 844, compact: true },
	{ width: 600, height: 960, compact: false },
]) {
	test(`switches the composer density at ${viewport.width} wide`, async ({
		page,
	}, info) => {
		test.skip(info.project.name !== "desktop", "Viewport list runs once.");
		await page.setViewportSize(viewport);
		const fixture = await routingFixture(page);
		await page.goto(canonical(fixture.agentId, fixture.conversationId));
		await assertChat(page);
		const send = page.locator('[data-c02-send-button="send"]');
		const toolbar = page.locator("form.composer-zone .composer-toolbar");
		await expect(send).toHaveAccessibleName("发送");
		if (viewport.compact) {
			// CK-07 / CH-07：composer 宽 ≤440 时单入口「模型 · 档位」，发送为 44×44 纯图标。
			expect(await send.boundingBox()).toMatchObject({ width: 44, height: 44 });
			await expect(send.locator(".composer-send-label")).toHaveCSS(
				"position",
				"absolute",
			);
			await expect(toolbar.locator(".composer-setting-trigger")).toHaveCount(1);
			const trigger = toolbar.locator(".composer-setting-trigger");
			await expect(trigger).toContainText("Primary model");
			await expect(trigger).toContainText("· 均衡");
			expect(
				await trigger
					.locator(".control-value")
					.evaluate((node) => node.scrollWidth <= node.clientWidth),
			).toBe(true);
			await trigger.click();
			const menu = page.getByRole("menu", { name: "模型与思考设置" });
			await expect(menu.getByText("模型", { exact: true })).toBeVisible();
			await expect(menu.getByText("思考强度", { exact: true })).toBeVisible();
			await expect(
				menu.getByRole("menuitemradio", { name: "均衡" }),
			).toHaveAttribute("aria-checked", "true");
			await expect(menu).toBeInViewport({ ratio: 1 });
			await page.keyboard.press("Escape");
			await expect(menu).toBeHidden();
			await expect(trigger).toBeFocused();
			await expect(
				toolbar.getByRole("button", { name: "选择命令或 Skill" }),
			).toHaveCSS("width", "44px");
		} else {
			await expect(send).toHaveText("发送");
			expect((await send.boundingBox())?.width).toBeGreaterThan(44);
			await expect(toolbar.locator(".composer-setting-trigger")).toHaveCount(2);
		}
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
		).toBe(true);
	});
}

for (const viewport of [
	{ width: 1440, height: 900 },
	{ width: 390, height: 844 },
	{ width: 1366, height: 500 },
]) {
	test(`opens the command menu above the composer at ${viewport.width} by ${viewport.height}`, async ({
		page,
	}, info) => {
		test.skip(info.project.name !== "desktop", "Viewport list runs once.");
		await page.setViewportSize(viewport);
		const fixture = await routingFixture(page, {
			messageRoles: true,
			nativeCapabilities: 4,
		});
		await page.goto(canonical(fixture.agentId, fixture.conversationId));
		await assertChat(page);
		const input = page.getByLabel("消息", { exact: true });
		await input.fill("/");
		const listbox = page.getByRole("listbox", {
			name: "命令与 Skill 搜索结果",
		});
		await expect(listbox.getByRole("option")).toHaveCount(4);
		const menu = page.getByRole("region", { name: "命令与 Skill 选择" });
		await expect(menu).toHaveCSS("position", "fixed");
		await expect(menu).toHaveCSS("border-radius", "12px");
		const geometry = await menu.evaluate((node) => {
			const composer = document.querySelector("form.composer-zone");
			return {
				menu: node.getBoundingClientRect().toJSON(),
				composer: composer?.getBoundingClientRect().toJSON(),
				maxHeight: Number.parseFloat(getComputedStyle(node).maxHeight),
				viewport: { width: innerWidth, height: innerHeight },
			};
		});
		await info.attach("command-menu-geometry", {
			body: JSON.stringify(geometry),
			contentType: "application/json",
		});
		// NI-85：弹层在 composer 上方并完整位于视口内，不覆盖输入框、工具栏与发送按钮。
		expect(geometry.menu.width).toBe(Math.min(320, viewport.width - 32));
		expect(geometry.maxHeight).toBeLessThanOrEqual(248);
		expect(geometry.maxHeight).toBeLessThanOrEqual(viewport.height * 0.4);
		expect(geometry.menu.top).toBeGreaterThanOrEqual(0);
		expect(geometry.menu.bottom).toBeLessThanOrEqual(viewport.height);
		expect(geometry.menu.bottom).toBeLessThanOrEqual(
			(geometry.composer?.top ?? 0) - 8 + 0.5,
		);
		await expect(page.getByText("命令 / Skill · 输入 / 搜索")).toBeVisible();
		await expect(page.getByText("只读命令").first()).toBeVisible();
		await expect(menu.getByText(/^command$|^skill$/)).toHaveCount(0);
		for (const option of await listbox.getByRole("option").all()) {
			await option.scrollIntoViewIfNeeded();
			const box = await option.boundingBox();
			if (!box) throw new Error("Missing option box");
			const hit = await page.evaluate(
				({ x, y }) =>
					document.elementFromPoint(x, y)?.closest('[role="option"]')?.id,
				{ x: box.x + box.width / 2, y: box.y + box.height / 2 },
			);
			expect(hit).toBe(await option.getAttribute("id"));
		}
		await listbox.getByRole("option").nth(3).click();
		await expect(menu).toHaveCount(0);
		await expect(page.getByText("Skill · 受控 Skill-2")).toBeVisible();
		await expect(
			page.getByRole("button", { name: "确认发送", exact: true }),
		).toBeVisible();
		expect(fixture.requests.every((request) => request.method === "GET")).toBe(
			true,
		);
	});
}

test("keeps the active command option visible while moving through a long catalog", async ({
	page,
}, info) => {
	test.skip(info.project.name !== "desktop", "Desktop geometry runs once.");
	await page.setViewportSize({ width: 1440, height: 900 });
	const fixture = await routingFixture(page, {
		messageRoles: true,
		nativeCapabilities: 12,
	});
	await page.goto(canonical(fixture.agentId, fixture.conversationId));
	await assertChat(page);
	const input = page.getByLabel("消息", { exact: true });
	await input.fill("/");
	const options = page.getByRole("option");
	await expect(options).toHaveCount(12);
	for (let index = 0; index < 11; index += 1) await input.press("ArrowDown");
	await input.press("ArrowDown");
	const last = options.last();
	await expect(last).toHaveAttribute("aria-selected", "true");
	await expect(input).toHaveAttribute(
		"aria-activedescendant",
		(await last.getAttribute("id")) ?? "",
	);
	const visible = await last.evaluate((node) => {
		const menu = node.closest("section");
		if (!menu) return false;
		const a = node.getBoundingClientRect();
		const b = menu.getBoundingClientRect();
		return a.top >= b.top && a.bottom <= b.bottom;
	});
	expect(visible).toBe(true);
	await input.press("Escape");
	await expect(page.getByRole("listbox")).toHaveCount(0);
	await expect(input).toBeFocused();
	await expect(input).not.toHaveAttribute("role", "combobox");
	expect(fixture.unexpected).toEqual([]);
});

test("offers Owners the configuration entry from the stopped banner", async ({
	page,
}) => {
	const fixture = await routingFixture(page, { stopped: true, owner: true });
	await page.goto(canonical(fixture.agentId, fixture.conversationId));
	await assertChat(page);
	const banner = page
		.locator('[data-slot="alert"]')
		.filter({ hasText: "已停止" });
	await expect(banner).toContainText(
		"历史会话仍可查看，Owner 可以重启或修改运行配置。",
	);
	const entry = banner.getByRole("link", { name: "进入 Owner 操作" });
	await expect(entry).toHaveAttribute(
		"href",
		`/agents/${fixture.agentId}/configuration`,
	);
	expect((await entry.boundingBox())?.height).toBeGreaterThanOrEqual(44);
	await entry.focus();
	await expect(entry).toBeFocused();
	await page.route(
		`**/api/v2/agents/${fixture.agentId}/configuration**`,
		(route) => route.abort(),
	);
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(
		new RegExp(`/agents/${fixture.agentId}/configuration$`),
	);
});
