import {
	AgentProjectionV2Schema,
	ConnectionCapabilityProjectionV1Schema,
	ConversationDetailProjectionV2Schema,
	ConversationPageV1Schema,
	PersistedConversationEventV2Schema,
	PilotProtocolErrorV1Schema,
} from "@agent-infra/contracts/pilot";
import { pilotFakeScenariosV2 } from "@agent-infra/test-support/pilot";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
	execution,
	history,
	timestamp,
} from "../src/features/conversation/conversation-test-fixtures";
import { keepConversationStreamOpen } from "./conversation-stream";
import {
	expectFocusableBusy,
	expectFocusSettled,
	expectNoDuplicateControls,
	holdRequests,
	pinElement,
} from "./page-health";
import { expectCleanPage, trackPageErrors } from "./primitive-styles";

// #3267：对话页动作进行中与完成后的焦点（D2-59）及命令菜单「目录读取失败」的排版。
// 受控 fixture 只返回合成数据，不代表真实 Runtime。
const agentId = "agent-1";
const conversationId = "conversation-focus-1";
const question = "请整理本周工作区变更";
const viewports = [
	{ width: 1440, height: 900 },
	{ width: 390, height: 844 },
] as const;

type FixtureOptions = {
	/** 命令与 Skill 目录读取失败（503）。 */
	catalogError?: boolean;
	/** 发送消息返回 404（RESOURCE_UNAVAILABLE），Agent 仍然可用：确实失去访问权限。 */
	messages404?: boolean;
};

async function chatFixture(page: Page, options: FixtureOptions = {}) {
	const writes: string[] = [];
	await keepConversationStreamOpen(page);
	const agent = AgentProjectionV2Schema.parse({
		...pilotFakeScenariosV2.starting.response.body,
		agentId,
		name: "受控焦点助手",
		managementStatus: "available",
		serviceAvailability: "ready",
		capabilities: {
			...pilotFakeScenariosV2.starting.response.body.capabilities,
			attachments: false,
			nativeMetadata: true,
		},
	});
	const completed = PersistedConversationEventV2Schema.parse({
		schemaVersion: 1,
		kind: "event",
		eventId: "focus-event-1",
		conversationId,
		executionId: "execution-1",
		sequence: 1,
		conversationCursor: "focus-cursor-1",
		occurredAt: timestamp,
		type: "execution.status",
		payload: { status: "completed" },
	});
	const detail = ConversationDetailProjectionV2Schema.parse({
		...history(conversationId, [completed]),
		conversation: {
			...history(conversationId, []).conversation,
			status: "ready",
		},
		messages: [
			{
				messageId: "question-1",
				role: "user",
				text: question,
				status: "completed",
				executionId: "execution-1",
				replyToMessageId: null,
				answerVersion: null,
				isCurrentAnswer: null,
				error: null,
				createdAt: timestamp,
			},
			{
				messageId: "answer-1",
				role: "assistant",
				text: "已整理完成。",
				status: "completed",
				executionId: "execution-1",
				replyToMessageId: "question-1",
				answerVersion: 1,
				isCurrentAnswer: true,
				error: null,
				createdAt: timestamp,
			},
		],
	});
	await page.route(/\/api\/v[12]\//, async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const path = url.pathname;
		const method = request.method();
		if (method !== "GET") writes.push(`${method} ${path}`);
		if (path === "/api/v1/session")
			return route.fulfill({
				json: {
					schemaVersion: 1,
					user: {
						userId: "controlled-person",
						displayName: "受控员工",
						roles: ["employee"],
					},
				},
			});
		if (path === "/api/v1/connection/capability")
			return route.fulfill({
				json: ConnectionCapabilityProjectionV1Schema.parse({
					schemaVersion: 1,
					status: "unavailable",
					reason: "missing",
				}),
			});
		if (path === "/api/v2/me/conversations/recent")
			return route.fulfill({
				json: ConversationPageV1Schema.parse({ items: [], nextCursor: null }),
			});
		if (path === `/api/v2/agents/${agentId}`)
			return route.fulfill({ json: agent });
		if (path === `/api/v2/conversations/${conversationId}`)
			return route.fulfill({ json: detail });
		if (path.endsWith("/events"))
			return route.fulfill({
				contentType: "text/event-stream",
				body: ": heartbeat\n\n",
			});
		if (method === "GET" && path.endsWith("/native-metadata")) {
			if (options.catalogError)
				return route.fulfill({
					status: 503,
					json: { message: "controlled catalog failure" },
				});
			const commands = url.searchParams.get("selector") === "commands";
			return route.fulfill({
				json: {
					selector: commands ? "commands" : "skills",
					revision: (commands ? "c" : "d").repeat(64),
					capabilities: [],
				},
			});
		}
		if (method === "GET" && path.includes("/executions/"))
			return route.fulfill({
				json: execution(conversationId, path.split("/").at(-1)),
			});
		if (method === "POST" && path.endsWith("/messages"))
			return options.messages404
				? route.fulfill({
						status: 404,
						json: PilotProtocolErrorV1Schema.parse({
							schemaVersion: 1,
							code: "RESOURCE_UNAVAILABLE",
							message: "controlled",
							retryable: false,
							traceId: "trace-focus-404",
						}),
					})
				: route.fulfill({
						status: 202,
						json: {
							schemaVersion: 1,
							status: "submitted",
							messageId: "question-2",
							executionId: "execution-2",
						},
					});
		if (method === "POST" && path.endsWith("/regenerations"))
			return route.fulfill({
				status: 202,
				json: {
					schemaVersion: 1,
					status: "submitted",
					messageId: null,
					executionId: "execution-2",
				},
			});
		return route.fulfill({ json: { items: [], nextCursor: null } });
	});
	await page.goto(`/chat/${agentId}/${conversationId}`);
	await expect(page.getByText("已整理完成。", { exact: true })).toBeVisible();
	const input = page.getByLabel("消息", { exact: true });
	await expect(input).toBeEnabled();
	return { input, writes };
}

async function rect(locator: Locator) {
	return locator.evaluate((node) => {
		const box = node.getBoundingClientRect();
		const style = getComputedStyle(node);
		return {
			left: box.left,
			top: box.top,
			bottom: box.bottom,
			contentLeft:
				box.left + node.clientLeft + Number.parseFloat(style.paddingLeft),
		};
	});
}

for (const viewport of viewports) {
	test(`places the catalog retry after the failure line and keeps focus off body at ${viewport.width} by ${viewport.height} (#3267 N8-1-02)`, async ({
		page,
	}, info) => {
		test.skip(info.project.name !== "desktop", "Viewport list runs once.");
		await page.setViewportSize(viewport);
		const errors = trackPageErrors(page);
		const { input } = await chatFixture(page, { catalogError: true });
		await input.fill("/");
		const menu = page.getByRole("region", { name: "命令与 Skill 选择" });
		const failure = menu.getByRole("alert");
		await expect(failure).toHaveText("目录读取失败");
		const retry = menu.getByRole("button", { name: "重试", exact: true });
		await expect(retry).toBeVisible();
		// 设计 .cap-picker-state 之后是独立的 ghost「重试」：不在状态行内，左缘对齐菜单内容区，
		// 紧接状态行下方。
		const state = failure.locator("xpath=..");
		expect(
			await state.evaluate((node, label) => {
				const buttons = [...node.querySelectorAll("button")];
				return buttons.some((button) => button.textContent?.trim() === label);
			}, "重试"),
		).toBe(false);
		const menuBox = await rect(menu);
		const stateBox = await rect(state);
		const retryBox = await rect(retry);
		expect(Math.abs(retryBox.left - menuBox.contentLeft)).toBeLessThanOrEqual(
			0.5,
		);
		expect(Math.abs(retryBox.top - stateBox.bottom)).toBeLessThanOrEqual(0.5);
		expect(
			await retry.evaluate((node) => node.getBoundingClientRect().height),
		).toBe(44);
		// 键盘触发「重试」：按钮随读取中卸载，焦点回到输入框，不落到 body。
		const metadata = await holdRequests(page, "GET", /\/native-metadata$/);
		await retry.focus();
		await page.keyboard.press("Enter");
		await expectFocusSettled(input, "目录重试", [50, 300]);
		metadata.release();
		await expect(failure).toHaveText("目录读取失败");
		await expectCleanPage(page, errors);
	});

	for (const via of ["click", "keyboard"] as const)
		test(`keeps 重新生成 focusable while the request is pending and hands focus to 停止回复 (${via}) at ${viewport.width} by ${viewport.height} (#3267 N8-1-09)`, async ({
			page,
		}, info) => {
			test.skip(info.project.name !== "desktop", "Viewport list runs once.");
			await page.setViewportSize(viewport);
			const errors = trackPageErrors(page);
			const fixture = await chatFixture(page);
			const regenerate = await pinElement(
				page.getByRole("button", { name: `重新生成：${question}` }),
				"regenerate",
			);
			const pending = await holdRequests(page, "POST", /\/regenerations$/);
			if (via === "click") await regenerate.click();
			else {
				await regenerate.focus();
				await page.keyboard.press("Enter");
			}
			await expect.poll(() => pending.held()).toBe(1);
			// 请求进行中：同一个「重新生成」保持可聚焦的禁用，焦点一直在它上面。
			await expectFocusableBusy(regenerate, `重新生成（${via}）`);
			pending.release();
			// 受理后在原回答的位置显示处理中的回复卡，焦点交给它的「停止回复」（导出稿 focusAfterRender）。
			const stop = page.locator('[data-stop-execution="execution-2"]');
			await expect(stop).toHaveText("停止回复");
			await expectFocusSettled(stop, `重新生成受理（${via}）`);
			await expectNoDuplicateControls(page, "重新生成受理");
			await expectCleanPage(page, errors);
			expect(fixture.writes).toEqual([
				`POST /api/v1/conversations/${conversationId}/regenerations`,
			]);
		});

	test(`moves focus to the h1 when sending turns into lost access at ${viewport.width} by ${viewport.height} (#3267 N8-1-10)`, async ({
		page,
	}, info) => {
		test.skip(info.project.name !== "desktop", "Viewport list runs once.");
		await page.setViewportSize(viewport);
		const errors = trackPageErrors(page);
		const { input } = await chatFixture(page, { messages404: true });
		await input.fill("继续整理");
		await input.press("Enter");
		const alert = page.getByRole("alert").filter({
			hasText: "当前登录或访问权限已失效，请重新登录或返回 Agent 目录。",
		});
		await expect(alert).toBeVisible();
		await expect(
			alert.getByRole("link", { name: "返回 Agent 目录" }),
		).toBeVisible();
		await expectFocusSettled(
			page.getByRole("heading", { level: 1, name: "对话" }),
			"访问失效后",
		);
		await expectCleanPage(page, errors);
	});
}
