import {
	AgentProjectionV2Schema,
	ConversationDetailProjectionV2Schema,
	ConversationPageV1Schema,
	ExecutionDetailProjectionV2Schema,
	PersistedConversationEventV2Schema,
} from "@agent-infra/contracts/pilot";
import { pilotFakeScenariosV2 } from "@agent-infra/test-support/pilot";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { keepConversationStreamOpen } from "./conversation-stream";
import { controlledFileLimits, isFileLimitsRequest } from "./file-limits";
import {
	computed,
	expectCleanPage,
	expectDistinctDialogControls,
	resolved,
	trackPageErrors,
} from "./primitive-styles";

// 浏览器卡（BR-01~03、NW-09~11）、浏览器操作记录（NW-01~08）与执行详情弹窗（R4-09、N-08）。
// 事件与响应都是契约校验过的合成 fixture，不代表真实 Runtime 或浏览器接管验收。

const agentId = "agent-1";
const conversationId = "conversation-browser-1";
const executionId = "execution-browser-1";
const occurredAt = "2026-10-11T09:59:00.000Z";
const expiresAt = "2099-01-01T00:00:00.000Z";

const binding = (execution = executionId) => ({
	subjectId: "subject-1",
	agentId,
	conversationId,
	executionId: execution,
	sessionGeneration: 2,
	resourceFence: 7,
	workloadRevision: 4,
	imageDigest: `sha256:${"a".repeat(64)}`,
	capabilityVersion: 1,
	capabilityRevision: 1,
	pageRevision: 4,
});

function envelope(sequence: number, execution = executionId) {
	return {
		schemaVersion: 2,
		kind: "event",
		eventId: `browser-${execution}-${sequence}`,
		conversationId,
		executionId: execution,
		sequence,
		conversationCursor: `browser-cursor-${execution}-${sequence}`,
		occurredAt,
	};
}

const status = (
	sequence: number,
	value: "processing" | "completed",
	execution = executionId,
) =>
	PersistedConversationEventV2Schema.parse({
		...envelope(sequence, execution),
		schemaVersion: 1,
		type: "execution.status",
		payload: { status: value },
	});

const operation = (
	sequence: number,
	phase: "intent" | "started" | "completed",
	{ ref = "operation-1", execution = executionId } = {},
) =>
	PersistedConversationEventV2Schema.parse({
		...envelope(sequence, execution),
		type: "execution.operation",
		payload: {
			kind: "tool",
			operationRef: ref,
			attemptRef: "attempt-1",
			phase,
			toolId: "browser_navigate",
			browser: {
				actionId: `action-${ref}`,
				capabilityVersion: 1,
				pageRevision: 4,
				resourceFence: 7,
				sessionGeneration: 2,
				sideEffect: false,
			},
		},
	});

const handoff = (
	sequence: number,
	value: "requested" | "active" | "completed",
	{ operatorId }: { operatorId?: string } = {},
) =>
	PersistedConversationEventV2Schema.parse({
		...envelope(sequence),
		type: "browser.handoff",
		payload: {
			handoffId: "handoff-1",
			status: value,
			reason: "mfa",
			requestedAt: occurredAt,
			expiresAt,
			...(operatorId ? { operatorId } : {}),
			binding: binding(),
		},
	});

const sideEffect = (sequence: number, value: "pending" | "confirmed") =>
	PersistedConversationEventV2Schema.parse({
		...envelope(sequence),
		type: "browser.side_effect",
		payload: {
			confirmationId: "confirmation-1",
			status: value,
			requestedAt: occurredAt,
			expiresAt,
			operation: "submit",
			targetOrigin: "https://example.test",
			redactedTargetSummary: "提交公开表单（已脱敏）",
			binding: {
				...binding(),
				pageRevision: 5,
				actionId: "action-side-effect",
				confirmationId: "confirmation-1",
				operationRef: "operation-side-effect",
				attemptRef: "attempt-side-effect",
			},
		},
	});

const browserCapability = {
	schemaVersion: 1,
	capabilityVersion: 1,
	status: "available",
	operations: ["navigate", "observe", "interact", "handoff", "side_effects"],
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
		operations: ["navigate", "observe", "interact", "handoff", "side_effects"],
	},
};

type Fixture = {
	posts: Array<{ path: string; body: unknown }>;
	unexpected: string[];
};

async function openBrowserConversation(
	page: Page,
	events: ReturnType<typeof status>[],
	{ detailEvents }: { detailEvents?: ReturnType<typeof status>[] } = {},
): Promise<Fixture> {
	const fixture: Fixture = { posts: [], unexpected: [] };
	await keepConversationStreamOpen(page);
	await page.route("**/api/**", async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		if (request.method() === "POST") {
			fixture.posts.push({ path, body: request.postDataJSON() });
			if (path.endsWith("/browser/commands")) {
				const body = request.postDataJSON() as Record<string, string>;
				return route.fulfill({
					status: 202,
					json: {
						schemaVersion: 1,
						outcome: "accepted",
						command: body.command,
						conversationId,
						executionId,
						...(body.handoffId ? { handoffId: body.handoffId } : {}),
						...(body.confirmationId
							? { confirmationId: body.confirmationId }
							: {}),
					},
				});
			}
			return route.fulfill({
				status: 202,
				json: {
					schemaVersion: 1,
					status: "accepted",
					executionId,
				},
			});
		}
		if (path === "/api/v1/session")
			return route.fulfill({
				json: {
					schemaVersion: 1,
					user: {
						userId: "user-1",
						displayName: "开发测试",
						roles: ["employee"],
					},
				},
			});
		if (path === "/api/v2/me/conversations/recent")
			return route.fulfill({
				json: ConversationPageV1Schema.parse({ items: [], nextCursor: null }),
			});
		if (path === `/api/v2/agents/${agentId}`)
			return route.fulfill({
				json: AgentProjectionV2Schema.parse({
					...pilotFakeScenariosV2.starting.response.body,
					agentId,
					managementStatus: "available",
					serviceAvailability: "ready",
					capabilities: {
						...pilotFakeScenariosV2.starting.response.body.capabilities,
						connection: false,
						browser: browserCapability,
					},
				}),
			});
		if (path === `/api/v2/conversations/${conversationId}`)
			return route.fulfill({
				json: ConversationDetailProjectionV2Schema.parse({
					schemaVersion: 2,
					conversation: {
						schemaVersion: 1,
						conversationId,
						agentId,
						title: "浏览器验收会话",
						status: "active",
						selectedModelOptionId: null,
						selectedReasoningLevel: null,
						lastConversationCursor: events.at(-1)?.conversationCursor ?? null,
						createdAt: occurredAt,
						updatedAt: occurredAt,
					},
					messages: [],
					events,
				}),
			});
		if (path.includes(`/conversations/${conversationId}/executions/`)) {
			const id = path.split("/").at(-1) ?? executionId;
			return route.fulfill({
				json: ExecutionDetailProjectionV2Schema.parse({
					schemaVersion: 2,
					conversationId,
					executionId: id,
					status: "completed",
					error: null,
					startedAt: occurredAt,
					finishedAt: occurredAt,
					processSummary: [],
					events: (detailEvents ?? events).filter(
						(event) => event.executionId === id,
					),
				}),
			});
		}
		if (isFileLimitsRequest(request.method(), path))
			return route.fulfill({ json: controlledFileLimits() });
		if (path.endsWith("/events"))
			return route.fulfill({
				contentType: "text/event-stream",
				body: ": heartbeat\n\n",
			});
		if (path === "/api/v1/connection/capability")
			return route.fulfill({
				json: { schemaVersion: 1, status: "unavailable", reason: "missing" },
			});
		if (path.endsWith("/model-selection") || path.endsWith("/capabilities"))
			return route.fulfill({ status: 404, json: {} });
		fixture.unexpected.push(`${request.method()} ${path}`);
		return route.fulfill({ json: { items: [], nextCursor: null } });
	});
	await page.goto(`/chat/${agentId}/${conversationId}`);
	await expect(page.getByRole("textbox", { name: "消息" })).toBeVisible();
	return fixture;
}

const forbidden =
	/Browser|browser_|origin|页面版本|Session|绑定|receipt|BROWSER_HANDOFF_|\bsubmit\b|https?:\/\/|外部副作用确认|浏览器接管 ·|已阻断/;

// 需要用户处理或进行中的浏览器卡在会话时间线里，不靠展开「会话上下文」才可见（NI-83）；
// 同页只有这一张浏览器卡（BR-01，收起的上下文条里也没有第二张）。用例不替用户展开折叠条。
async function expectCardInTimeline(page: Page, card: Locator) {
	await expect(
		page.getByRole("button", { name: /^会话上下文/ }),
	).toHaveAttribute("aria-expanded", "false");
	await expect(card).toBeVisible();
	await expect(card).toBeInViewport();
	expect(
		await card.evaluate(
			(node) =>
				Boolean(node.closest(".chat-thread .timeline")) &&
				!node.closest(".chat-context"),
		),
	).toBe(true);
	await expect(page.locator("section.browser-capability")).toHaveCount(1);
}

test("renders one design browser card for a pending request and sends only its confirmation id", async ({
	page,
}, info) => {
	const fixture = await openBrowserConversation(page, [
		status(1, "processing"),
		operation(2, "completed"),
		handoff(3, "completed"),
		sideEffect(4, "pending"),
	]);
	const card = page.locator("section.browser-capability");
	await expect(card).toHaveCount(1);
	await expect(card).toHaveAttribute("data-phase", "request");
	const region = page.getByRole("region", { name: "浏览器操作请求" });
	await expectCardInTimeline(page, region);
	await expect(region.getByRole("status")).toContainText("等待确认");
	await expect(region.getByRole("alert")).toHaveCount(0);
	expect(await region.innerText()).not.toMatch(forbidden);
	await expect(
		page.locator('[data-slot="alert"]').filter({ hasText: /浏览器|Browser/ }),
	).toHaveCount(0);
	await expect(region.locator(".browser-capability-meta > div")).toHaveText([
		/域名\s*example\.test/,
		/操作\s*提交/,
		/范围\s*提交公开表单（已脱敏） · 会产生外部操作/,
	]);

	const surfaceRaised = await resolved(
		page,
		"backgroundColor",
		"var(--surface-raised)",
	);
	expect(
		await computed(card, [
			"paddingTop",
			"paddingLeft",
			"borderTopWidth",
			"borderTopLeftRadius",
		]),
	).toEqual({
		paddingTop: "14px",
		paddingLeft: "14px",
		borderTopWidth: "1px",
		borderTopLeftRadius: "12px",
	});
	const icon = card.locator(".browser-capability-icon");
	expect(await icon.boundingBox()).toMatchObject({ width: 30, height: 30 });
	expect(
		await computed(icon, ["borderTopLeftRadius", "backgroundColor", "color"]),
	).toEqual({
		borderTopLeftRadius: "8px",
		backgroundColor: surfaceRaised,
		color: await resolved(page, "color", "var(--accent)"),
	});
	expect(
		await computed(card.locator(".browser-capability-title strong"), [
			"fontSize",
			"fontWeight",
		]),
	).toEqual({ fontSize: "13px", fontWeight: "650" });
	expect(
		await computed(card.locator(".browser-capability-body"), [
			"fontSize",
			"lineHeight",
		]),
	).toEqual({ fontSize: "12px", lineHeight: "18.6px" });
	const chip = card.locator('.browser-capability-status [data-slot="badge"]');
	expect(
		await computed(chip, ["minHeight", "fontSize", "borderTopLeftRadius"]),
	).toEqual({
		minHeight: "24px",
		fontSize: "11px",
		borderTopLeftRadius: "999px",
	});
	const meta = card.locator(".browser-capability-meta");
	const cell = meta.locator("> div").first();
	expect(
		await computed(cell, [
			"paddingTop",
			"borderTopLeftRadius",
			"backgroundColor",
		]),
	).toEqual({
		paddingTop: "9px",
		borderTopLeftRadius: "9px",
		backgroundColor: surfaceRaised,
	});
	expect((await computed(cell.locator("dt"), ["fontSize"])).fontSize).toBe(
		"10px",
	);
	expect((await computed(cell.locator("dd"), ["fontSize"])).fontSize).toBe(
		"12px",
	);
	const actions = card.locator(".browser-capability-actions");
	expect((await computed(actions, ["columnGap"])).columnGap).toBe("8px");
	// Z-09：已有操作记录，但等待确认卡只放本阶段的「允许 / 拒绝」，不放「查看操作记录」。
	await expect(actions.getByRole("button")).toHaveText([
		"允许这次操作",
		"拒绝",
	]);
	const allow = page.getByRole("button", {
		name: "允许这次操作：提交 example.test",
	});
	const reject = page.getByRole("button", { name: "拒绝：提交 example.test" });
	expect((await allow.boundingBox())?.height).toBeGreaterThanOrEqual(40);
	expect(await computed(reject, ["backgroundColor", "color"])).toEqual({
		backgroundColor: "rgba(0, 0, 0, 0)",
		color: await resolved(page, "color", "var(--muted-foreground)"),
	});
	if (info.project.name === "mobile") {
		// ≤767px：元数据单列，状态 chip 排到标题下方，卡片不横向溢出。
		expect(
			(await computed(meta, ["gridTemplateColumns"])).gridTemplateColumns.split(
				" ",
			),
		).toHaveLength(1);
		const titleBox = await card
			.locator(".browser-capability-title")
			.boundingBox();
		const chipBox = await chip.boundingBox();
		expect(chipBox?.y ?? 0).toBeGreaterThanOrEqual(
			(titleBox?.y ?? 0) + (titleBox?.height ?? 0),
		);
		expect(
			await card.evaluate((node) => node.scrollWidth <= node.clientWidth),
		).toBe(true);
	} else {
		const tracks = (
			await computed(meta, ["gridTemplateColumns", "columnGap"])
		).gridTemplateColumns
			.split(" ")
			.map((value) => Number.parseFloat(value));
		expect(tracks).toHaveLength(3);
		expect(Math.max(...tracks) - Math.min(...tracks)).toBeLessThan(1);
	}
	// 键盘顺序：主按钮在前，次要按钮在后；Enter 触发。
	await allow.focus();
	await page.keyboard.press("Tab");
	await expect(reject).toBeFocused();
	await page.keyboard.press("Shift+Tab");
	await page.keyboard.press("Enter");
	await expect.poll(() => fixture.posts.length).toBe(1);
	expect(fixture.posts[0]).toEqual({
		path: `/api/v1/conversations/${conversationId}/browser/commands`,
		body: {
			schemaVersion: 1,
			command: "confirm_side_effect",
			confirmationId: "confirmation-1",
		},
	});
	await expect(page.getByText(/Browser 命令/)).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: /确认执行|取消|暂停 Agent|交回 Agent/ }),
	).toHaveCount(0);
	await info.attach(`browser-card-request-${info.project.name}`, {
		body: await card.screenshot(),
		contentType: "image/png",
	});
});

test("shows the running timeline and stops through the current execution", async ({
	page,
}) => {
	const fixture = await openBrowserConversation(page, [
		status(1, "processing"),
		operation(2, "started"),
	]);
	const card = page.getByRole("region", { name: "浏览器操作进行中" });
	await expectCardInTimeline(page, card);
	await expect(card).toContainText("Agent 正在打开页面。你可以随时停止。");
	const steps = card.locator(".browser-capability-timeline li");
	await expect(steps).toHaveText(["请求已确认", "页面已打开", "结果已回读"]);
	await expect(card.locator("[data-active='true']")).toHaveCount(2);
	expect(
		await computed(steps.first(), [
			"fontSize",
			"paddingTop",
			"paddingLeft",
			"backgroundColor",
		]),
	).toEqual({
		fontSize: "11px",
		paddingTop: "5px",
		paddingLeft: "8px",
		backgroundColor: await resolved(
			page,
			"backgroundColor",
			"var(--accent-soft)",
		),
	});
	const stop = card.getByRole("button", { name: "停止操作" });
	await expect(stop.locator("svg")).toHaveCount(1);
	// Z-09：执行中只有「停止操作」，操作记录从执行详情查看。
	await expect(
		card.locator(".browser-capability-actions").getByRole("button"),
	).toHaveText(["停止操作"]);
	await stop.click();
	await expect.poll(() => fixture.posts.length).toBe(1);
	expect(fixture.posts[0]?.body).toEqual({
		schemaVersion: 1,
		targetExecutionId: executionId,
	});
});

test("offers takeover with a stop instead of allow on a handoff request (NI-94)", async ({
	page,
}) => {
	const fixture = await openBrowserConversation(page, [
		status(1, "processing"),
		handoff(2, "requested"),
		sideEffect(3, "pending"),
	]);
	const card = page.getByRole("region", { name: "需要你接管浏览器" });
	await expectCardInTimeline(page, card);
	await expect(card).toHaveAttribute("data-phase", "handoff");
	await expect(page.getByRole("button", { name: /允许这次操作/ })).toHaveCount(
		0,
	);
	// Z-09：等待接管只有「接管浏览器 / 停止」，没有「查看操作记录」。
	await expect(
		card.locator(".browser-capability-actions").getByRole("button"),
	).toHaveText(["接管浏览器", "停止"]);
	await card.getByRole("button", { name: "接管浏览器" }).click();
	await expect.poll(() => fixture.posts.length).toBe(1);
	await card.getByRole("button", { name: "停止接管" }).click();
	await expect.poll(() => fixture.posts.length).toBe(2);
	expect(fixture.posts.map((post) => post.body)).toEqual([
		{ schemaVersion: 1, command: "take_over", handoffId: "handoff-1" },
		{ schemaVersion: 1, command: "revoke", handoffId: "handoff-1" },
	]);
});

test("keeps a taken-over browser visible in the timeline and returns control (NI-83)", async ({
	page,
}) => {
	const fixture = await openBrowserConversation(page, [
		status(1, "processing"),
		handoff(2, "active"),
	]);
	const card = page.getByRole("region", { name: "需要你接管浏览器" });
	await expectCardInTimeline(page, card);
	await expect(card.getByRole("status")).toContainText("已接管");
	await card.getByRole("button", { name: "交还给 Agent" }).click();
	await expect.poll(() => fixture.posts.length).toBe(1);
	expect(fixture.posts[0]?.body).toEqual({
		schemaVersion: 1,
		command: "return_to_agent",
		handoffId: "handoff-1",
	});
});

test("names the signed-in operator in the browser record facts (NW-01)", async ({
	page,
}) => {
	const fixture = await openBrowserConversation(page, [
		operation(1, "completed"),
		handoff(2, "completed", { operatorId: "user-1" }),
		status(3, "completed"),
	]);
	await page.getByRole("button", { name: "查看操作记录" }).first().click();
	const dialog = page.getByRole("dialog", { name: "浏览器操作记录" });
	await expect(dialog).toBeVisible();
	// 设计「接管人 陈昊 · MFA」：operatorId 是会话主体本人，显示当前登录用户的姓名，不显示 ID。
	await expect(dialog.locator('dt:text-is("接管人") + dd')).toHaveText(
		"开发测试 · MFA 验证",
	);
	await expect(dialog.locator('dt:text-is("凭证") + dd')).toHaveText(
		"不进入模型或平台记录",
	);
	expect(await dialog.innerText()).not.toContain("user-1");
	expect(fixture.posts).toEqual([]);
});

test("keeps the idle browser card inside the collapsed session context (BR-01)", async ({
	page,
}) => {
	await openBrowserConversation(page, []);
	const context = page.getByRole("button", { name: /^会话上下文/ });
	await expect(context).toHaveAttribute("aria-expanded", "false");
	const cards = page.locator("section.browser-capability");
	await expect(cards).toHaveCount(1);
	await expect(cards).toBeHidden();
	await expect(
		page.locator(".chat-thread .timeline .browser-capability"),
	).toHaveCount(0);
	await context.click();
	const idle = page.getByRole("region", { name: "浏览器操作" });
	await expect(idle).toBeVisible();
	await expect(idle.getByRole("status")).toContainText("可请求");
	await expect(idle.getByRole("button")).toHaveCount(0);
	// 条内去掉卡片外框（设计 .chat-context-body .browser-capability）。
	expect((await computed(idle, ["borderTopWidth"])).borderTopWidth).toBe("0px");
});

async function threadGeometry(page: Page) {
	return page.evaluate(() => ({
		timeline:
			document.querySelector(".chat-thread .timeline")?.getBoundingClientRect()
				.height ?? 0,
		composer:
			document.querySelector("form.composer-zone")?.getBoundingClientRect()
				.top ?? 0,
	}));
}

test("keeps browser records in a read-only dialog without squeezing the thread (NW-01~07)", async ({
	page,
}, info) => {
	const pageErrors = trackPageErrors(page);
	const one = [status(1, "completed"), operation(2, "completed")];
	await openBrowserConversation(page, one);
	await expect(
		page.getByRole("region", { name: "浏览器操作已完成" }),
	).toBeVisible();
	const single = await threadGeometry(page);

	const many = [
		...Array.from({ length: 55 }, (_, index) =>
			operation(index + 1, "completed", { ref: `operation-${index + 1}` }),
		),
		status(56, "completed"),
	];
	await page.unrouteAll({ behavior: "ignoreErrors" });
	const fixture = await openBrowserConversation(page, many);
	const card = page.getByRole("region", { name: "浏览器操作已完成" });
	await expect(card).toBeVisible();
	const crowded = await threadGeometry(page);
	expect(Math.abs(crowded.timeline - single.timeline)).toBeLessThanOrEqual(1);
	expect(Math.abs(crowded.composer - single.composer)).toBeLessThanOrEqual(1);
	await expect(
		page.getByRole("heading", { name: "Browser 审计与恢复" }),
	).toHaveCount(0);
	await expect(page.locator("[role='alert']")).toHaveCount(0);

	const trigger = card.getByRole("button", { name: "查看操作记录" });
	expect(
		await trigger.evaluate((node) =>
			node.closest("[aria-live],[role='alert']"),
		),
	).toBeNull();
	const pageScroll = await page.evaluate(() => window.scrollY);
	await trigger.focus();
	await page.keyboard.press("Enter");
	const dialog = page.getByRole("dialog", { name: "浏览器操作记录" });
	await expect(dialog).toBeVisible();
	await expect(dialog.locator("dt")).toHaveText([
		"域名",
		"操作范围",
		"接管人",
		"结果",
		"凭证",
	]);
	await expect(dialog.getByRole("listitem")).toHaveCount(50);
	await expect(dialog).toContainText("仅显示最近 50 条");
	// #3037 X-04：页眉图标钮与页脚主按钮不同名。
	await expectDistinctDialogControls(dialog);
	await expectCleanPage(page, pageErrors);
	await expect(dialog.getByRole("alert")).toHaveCount(0);
	await expect(dialog.getByRole("status")).toHaveText("");
	expect(await dialog.innerText()).not.toMatch(
		/Browser|恢复|服务端|browser_\w+|https?:\/\/|\d{1,2}:\d{2}:\d{2}/,
	);
	const box = await dialog.boundingBox();
	const viewport = page.viewportSize();
	expect((box?.height ?? 0) <= (viewport?.height ?? 0)).toBe(true);
	expect(
		await dialog.evaluate((node) => ({
			scrolls: node.scrollHeight > node.clientHeight,
			fits: node.scrollWidth <= node.clientWidth,
		})),
	).toEqual({ scrolls: true, fits: true });
	if (info.project.name === "mobile")
		expect(
			(
				await computed(dialog.locator("dl"), ["gridTemplateColumns"])
			).gridTemplateColumns.split(" "),
		).toHaveLength(1);
	const close = dialog
		.locator('[data-slot="dialog-footer"]')
		.getByRole("button", { name: "关闭" });
	for (let index = 0; index < 8; index += 1) {
		if (await close.evaluate((node) => node === document.activeElement)) break;
		await page.keyboard.press("Shift+Tab");
	}
	await expect(close).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
	await expect(trigger).toBeFocused();
	expect(await page.evaluate(() => window.scrollY)).toBe(pageScroll);
	expect(fixture.posts).toEqual([]);
});

test("opens execution details as a modal dialog that traps focus (R4-09, N-08, NI-19, NI-106)", async ({
	page,
}, info) => {
	const pageErrors = trackPageErrors(page);
	const fixture = await openBrowserConversation(page, [
		status(1, "completed"),
		operation(2, "completed"),
	]);
	const input = page.getByRole("textbox", { name: "消息" });
	await input.fill("保留的草稿");
	const trigger = page.getByRole("button", { name: /^查看执行详情/ });
	await trigger.click();
	const dialog = page.getByRole("dialog", { name: "执行详情" });
	await expect(dialog).toBeVisible();
	await expect(dialog).toHaveAttribute("aria-modal", "true");
	await expect(dialog).toBeFocused();
	await expect(page.getByRole("region", { name: "执行详情" })).toHaveCount(0);
	await expect(page.locator(".chat-thread")).not.toHaveAttribute("hidden");
	// 弹窗打开时背景从无障碍树移除，用 DOM 定位确认输入框与草稿仍在。
	await expect(page.locator("form.composer-zone textarea")).toHaveValue(
		"保留的草稿",
	);
	await expect(dialog.getByRole("heading", { level: 2 })).toHaveText(
		"执行详情",
	);
	expect(
		await computed(dialog.getByRole("heading", { level: 2 }), [
			"fontSize",
			"fontWeight",
		]),
	).toEqual({ fontSize: "19px", fontWeight: "620" });
	await expect(dialog.locator("dl.conversation-facts > dt").nth(0)).toHaveText(
		"Execution ID",
	);
	await expect(dialog.locator("dl.conversation-facts > dt").nth(3)).toHaveText(
		"Connection",
	);
	// Z-15：工具调用事实按 browser-labels 映射显示「打开页面」，不外露 browser_navigate。
	await expect(dialog).toContainText("工具调用 · 打开页面 · 已完成");
	expect(await dialog.innerText()).not.toContain("browser_");
	await expect(dialog.getByRole("button", { name: "返回对话" })).toHaveCount(0);
	await expect(
		dialog.getByRole("button", { name: "核实原执行状态" }),
	).toHaveCount(0);
	// #3037 X-04：页眉图标钮「关闭弹窗」与页脚主按钮「关闭」不再同名。
	await expectDistinctDialogControls(dialog);
	await expectCleanPage(page, pageErrors);
	const primary = dialog
		.locator('[data-slot="dialog-footer"]')
		.getByRole("button", { name: "关闭" });
	expect((await computed(primary, ["backgroundColor"])).backgroundColor).toBe(
		await resolved(page, "backgroundColor", "var(--accent-ink)"),
	);
	const body = dialog.locator('[data-slot="dialog-body"] > *').first();
	expect(
		Number.parseFloat(
			(await computed(body, ["borderTopWidth"])).borderTopWidth,
		),
	).toBe(0);
	const box = await dialog.boundingBox();
	const padding = (await computed(dialog, ["paddingTop"])).paddingTop;
	if (info.project.name === "mobile") {
		expect(padding).toBe("19px");
		const facts = dialog.locator("dl.conversation-facts");
		const [dt, dd] = await Promise.all([
			facts.locator("dt").first().boundingBox(),
			facts.locator("dd").first().boundingBox(),
		]);
		expect(Math.abs((dt?.x ?? 0) - (dd?.x ?? 1))).toBeLessThan(1);
	} else {
		expect(padding).toBe("24px");
		expect(Math.abs((box?.width ?? 0) - 620)).toBeLessThanOrEqual(1);
	}
	expect(box?.height ?? 0).toBeLessThanOrEqual(760);
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= innerWidth,
		),
	).toBe(true);
	for (const name of ["关闭弹窗", "关闭"]) {
		for (const button of await dialog
			.getByRole("button", { name, exact: true })
			.all()) {
			const hit = await button.boundingBox();
			expect(hit?.width ?? 0).toBeGreaterThanOrEqual(44);
			expect(hit?.height ?? 0).toBeGreaterThanOrEqual(44);
		}
	}

	// 焦点不离开弹窗（NI-106）：Tab / Shift+Tab 各走两圈。Base UI 的焦点守卫只在同一帧内
	// 把焦点转回首尾控件，等守卫交出焦点后，每一步都必须落在 role=dialog 内，
	// 从不落到 BODY、页面跳转链接或背景控件。
	const focusable = await dialog
		.locator("button:not([disabled]), [href], [tabindex]:not([tabindex='-1'])")
		.count();
	expect(focusable).toBeGreaterThanOrEqual(3);
	for (const key of ["Tab", "Shift+Tab"]) {
		for (let index = 0; index < focusable * 2; index += 1) {
			await page.keyboard.press(key);
			await page.waitForFunction(
				() => !document.activeElement?.hasAttribute("data-base-ui-focus-guard"),
			);
			const where = await page.evaluate(() => {
				const active = document.activeElement;
				return {
					inside: Boolean(active?.closest("[role='dialog']")),
					what: `${active?.tagName} ${active?.getAttribute("aria-label") ?? active?.textContent?.slice(0, 20) ?? ""}`,
				};
			});
			expect(where.inside, `${key} #${index + 1} ${where.what}`).toBe(true);
		}
	}
	// 首尾循环：从底部「关闭」按 Tab 回到头部关闭钮，再 Shift+Tab 回到底部「关闭」。
	await primary.focus();
	await page.keyboard.press("Tab");
	await page.waitForFunction(
		() => !document.activeElement?.hasAttribute("data-base-ui-focus-guard"),
	);
	await expect(
		dialog.locator('[data-slot="dialog-header"]').getByRole("button", {
			name: "关闭弹窗",
			exact: true,
		}),
	).toBeFocused();
	await page.keyboard.press("Shift+Tab");
	await page.waitForFunction(
		() => !document.activeElement?.hasAttribute("data-base-ui-focus-guard"),
	);
	await expect(primary).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
	await expect(trigger).toBeFocused();
	await expect(input).toHaveValue("保留的草稿");
	expect(fixture.posts).toEqual([]);
});

test("opens a past execution's browser records from its details and closes only the nested dialog", async ({
	page,
}) => {
	const older = "execution-browser-0";
	const fixture = await openBrowserConversation(page, [
		operation(1, "completed", { ref: "operation-old", execution: older }),
		status(2, "completed", older),
		status(3, "completed"),
		operation(4, "started", { ref: "operation-new" }),
	]);
	await page
		.getByRole("button", { name: /^查看执行详情/ })
		.first()
		.click();
	const details = page.getByRole("dialog", { name: "执行详情" });
	await expect(details).toBeVisible();
	const records = details.getByRole("button", { name: "查看操作记录" });
	await records.click();
	const nested = page.getByRole("dialog", { name: "浏览器操作记录" });
	await expect(nested.getByRole("listitem")).toHaveCount(1);
	await expect(nested.getByRole("listitem")).toContainText("已完成");
	await page.keyboard.press("Escape");
	await expect(nested).toHaveCount(0);
	await expect(details).toBeVisible();
	await expect(records).toBeFocused();
	expect(fixture.posts).toEqual([]);
});
