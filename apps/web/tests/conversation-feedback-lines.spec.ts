import {
	AgentProjectionV2Schema,
	ConnectionCapabilityProjectionV1Schema,
	ConversationDetailProjectionV2Schema,
	ConversationPageV1Schema,
	PersistedConversationEventV2Schema,
} from "@agent-infra/contracts/pilot";
import { pilotFakeScenariosV2 } from "@agent-infra/test-support/pilot";
import {
	expect,
	type Locator,
	type Page,
	type Route,
	test,
} from "@playwright/test";
import {
	execution,
	history,
	timestamp,
} from "../src/features/conversation/conversation-test-fixtures";
import { keepConversationStreamOpen } from "./conversation-stream";
import { expectFocusSettled, expectNoDuplicateControls } from "./page-health";
import {
	computed,
	expectCleanPage,
	resolved,
	trackPageErrors,
} from "./primitive-styles";

// #3293 N9-1-01：对话页的状态说明行（会话准备中 / 更新中、原执行结果待核实、自动重新连接）与同区
// 「不支持补充指令」说明同为 14px / 20px，不继承正文 15px。导出稿没有这些状态，规格见
// web-ui.md「对话页状态说明行」。受控 fixture 只返回合成数据，不代表真实 Runtime。
const agentId = "agent-1";
const conversationId = "conversation-feedback-1";
const question = "请整理本周工作区变更";
const viewports = [
	{ width: 1440, height: 900 },
	{ width: 390, height: 844 },
] as const;

type Scenario = {
	name: string;
	/** 说明行的文字（「原执行结果待核实」一行之后还有「核实原执行状态」按钮）。 */
	text: string;
	executionStatus: "completed" | "processing" | "unknown";
	sessionAvailability?: "preparing" | "updating";
	supplementaryInstruction?: boolean;
	/** 首次读取事件流返回 503，之后的重连挂起，页面停在「正在自动重新连接」。 */
	streamFailure?: boolean;
	/** 静态说明：不设 role，由发送按钮 aria-describedby 引用，输入草稿后出现。 */
	static?: boolean;
};

const scenarios: readonly Scenario[] = [
	{
		name: "会话准备中",
		text: "会话准备中，完成后即可发送。草稿会保留。",
		executionStatus: "completed",
		sessionAvailability: "preparing",
	},
	{
		name: "会话更新中",
		text: "会话更新中，完成后即可发送。草稿会保留。",
		executionStatus: "completed",
		sessionAvailability: "updating",
	},
	{
		name: "原执行结果待核实",
		text: "原执行结果待核实，同会话暂不能发送下一条消息。",
		executionStatus: "unknown",
	},
	{
		name: "自动重新连接",
		text: "会话连接中断，正在自动重新连接，草稿会保留。",
		executionStatus: "completed",
		streamFailure: true,
	},
	{
		name: "不支持补充指令（同区参照）",
		text: "当前回复仍在处理，不支持补充指令。草稿会保留。",
		executionStatus: "processing",
		supplementaryInstruction: false,
		static: true,
	},
];

async function chatFixture(
	page: Page,
	scenario: Scenario,
	model: {
		/** 覆盖 Agent 的模型清单（默认沿用 starting 场景的单一选项）。 */
		options?: readonly {
			optionId: string;
			displayName: string;
			modelId: string;
			reasoningLevels: string[];
		}[];
		/** 会话已保存的模型选项；不在清单中时页面显示「原模型选项已移除」。 */
		selectedModelOptionId?: string;
		/** 保存模型选择（PUT model-selection）的受控响应。 */
		onSelection?: (route: Route) => Promise<void>;
	} = {},
) {
	const writes: string[] = [];
	let openStream!: () => void;
	const streamGate = new Promise<void>((resolve) => {
		openStream = resolve;
	});
	let streamReads = 0;
	// 事件流失败的场景不包装 fetch：包装后的 503 响应体是不结束的心跳流，读取错误体会一直挂起。
	if (!scenario.streamFailure) await keepConversationStreamOpen(page);
	const agent = AgentProjectionV2Schema.parse({
		...pilotFakeScenariosV2.starting.response.body,
		agentId,
		name: "受控说明行助手",
		managementStatus: "available",
		serviceAvailability: "ready",
		...(model.options
			? {
					configuration: {
						...pilotFakeScenariosV2.starting.response.body.configuration,
						modelOptions: model.options,
						defaultModelOptionId: model.options[0]?.optionId,
					},
				}
			: {}),
		capabilities: {
			...pilotFakeScenariosV2.starting.response.body.capabilities,
			attachments: false,
			supplementaryInstruction: scenario.supplementaryInstruction ?? true,
		},
	});
	const status = PersistedConversationEventV2Schema.parse({
		schemaVersion: 1,
		kind: "event",
		eventId: "feedback-event-1",
		conversationId,
		executionId: "execution-1",
		sequence: 1,
		conversationCursor: "feedback-cursor-1",
		occurredAt: timestamp,
		type: "execution.status",
		payload: { status: scenario.executionStatus },
	});
	const completed = scenario.executionStatus === "completed";
	const detail = ConversationDetailProjectionV2Schema.parse({
		...history(conversationId, [status]),
		conversation: {
			...history(conversationId, []).conversation,
			status: completed ? "ready" : "active",
			...(model.selectedModelOptionId
				? { selectedModelOptionId: model.selectedModelOptionId }
				: {}),
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
			...(completed
				? [
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
					]
				: []),
		],
		...(scenario.sessionAvailability
			? { sessionAvailability: scenario.sessionAvailability }
			: {}),
	});
	await page.route(/\/api\/v[12]\//, async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const path = url.pathname;
		const method = request.method();
		if (method !== "GET") writes.push(`${method} ${path}`);
		if (
			method === "PUT" &&
			path === `/api/v1/conversations/${conversationId}/model-selection` &&
			model.onSelection
		)
			return model.onSelection(route);
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
		if (path.endsWith("/events")) {
			if (scenario.streamFailure) {
				streamReads += 1;
				// 第一次 503 进入自动重连；之后的重连挂起，状态行一直可见，直到用例结束放行。
				if (streamReads > 1) await streamGate;
				return route
					.fulfill({
						status: 503,
						json: { message: "controlled stream failure" },
					})
					.catch(() => undefined);
			}
			return route.fulfill({
				contentType: "text/event-stream",
				body: ": heartbeat\n\n",
			});
		}
		if (method === "GET" && path.includes("/executions/"))
			return route.fulfill({
				json: execution(conversationId, path.split("/").at(-1)),
			});
		return route.fulfill({ json: { items: [], nextCursor: null } });
	});
	await page.goto(`/chat/${agentId}/${conversationId}`);
	await expect(page.getByText(question, { exact: true })).toBeVisible();
	const input = page.getByLabel("消息", { exact: true });
	return {
		input,
		writes,
		streamReads: () => streamReads,
		releaseStream: () => openStream(),
	};
}

/** 说明行的计算样式，与输入框所在表单的左缘之差，以及它是否在 live region 之内。 */
async function measure(line: Locator, form: Locator) {
	const style = await computed(line, [
		"fontSize",
		"lineHeight",
		"fontWeight",
		"color",
	]);
	const formLeft = await form.evaluate(
		(node) => node.getBoundingClientRect().left,
	);
	const box = await line.evaluate((node) => {
		const rect = node.getBoundingClientRect();
		return {
			left: rect.left,
			right: rect.right,
			viewport: document.documentElement.clientWidth,
			role: node.getAttribute("role"),
			live:
				node.parentElement?.closest(
					'[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"], [role="log"]',
				) !== null,
		};
	});
	return { ...style, ...box, dxForm: box.left - formLeft };
}

for (const viewport of viewports)
	for (const scenario of scenarios)
		test(`sizes the ${scenario.name} line like the other composer notes at ${viewport.width} by ${viewport.height} (#3293 N9-1-01)`, async ({
			page,
		}, info) => {
			test.skip(info.project.name !== "desktop", "Viewport list runs once.");
			await page.setViewportSize(viewport);
			const errors = trackPageErrors(page);
			const fixture = await chatFixture(page, scenario);
			const form = fixture.input.locator("xpath=ancestor::form[1]");
			if (scenario.static) await fixture.input.fill("补充一句");
			const line = scenario.static
				? page.getByText(scenario.text, { exact: true })
				: page.getByRole("status").filter({ hasText: scenario.text });
			await expect(line).toBeVisible();
			const measured = await measure(line, form);
			const foreground = await resolved(page, "color", "var(--foreground)");
			// 同区说明（「不支持补充指令」、模型保存提示）为 text-sm：14px / 20px、400、正文前景色。
			expect(
				{
					fontSize: measured.fontSize,
					lineHeight: measured.lineHeight,
					fontWeight: measured.fontWeight,
					color: measured.color,
				},
				`${scenario.name} 说明行字号`,
			).toEqual({
				fontSize: "14px",
				lineHeight: "20px",
				fontWeight: "400",
				color: foreground,
			});
			// 与输入框左缘对齐，不超出视口。
			expect(Math.abs(measured.dxForm)).toBeLessThanOrEqual(0.5);
			expect(measured.right).toBeLessThanOrEqual(measured.viewport);
			if (scenario.static) {
				// 静态说明不是 live region，由发送按钮的 aria-describedby 引用（R4-07）。
				expect(measured.role).toBeNull();
				expect(measured.live).toBe(false);
				const send = page.getByRole("button", { name: "发送", exact: true });
				await expect(send).toBeDisabled();
				const id = await line.getAttribute("id");
				expect(id).toBeTruthy();
				await expect(send).toHaveAttribute("aria-describedby", id ?? "");
			} else {
				// 状态变化时出现的说明行：自身是 role="status"，不嵌在另一个 live region 里。
				expect(measured.role).toBe("status");
				expect(measured.live).toBe(false);
			}
			if (scenario.streamFailure)
				expect(fixture.streamReads()).toBeGreaterThanOrEqual(1);
			await expectNoDuplicateControls(page, `${scenario.name} 说明行`);
			await expectCleanPage(page, errors);
			if (scenario.executionStatus === "unknown") {
				// 行内「核实原执行状态」打开执行详情，焦点到弹窗，不落到 body（D2-59）。
				await line
					.getByRole("button", { name: "核实原执行状态", exact: true })
					.click();
				await expectFocusSettled(
					page.getByRole("dialog", { name: "执行详情" }),
					"核实原执行状态后",
				);
				await expectCleanPage(page, errors);
			}
			fixture.releaseStream();
			expect(fixture.writes).toEqual([]);
		});

// #3327 N10-1-03：会话所选（或 Agent 默认）模型选项不在模型清单时，输入框上方的「原模型选项已移除」
// 是同区静态说明行：与其余说明行同为 14px / 20px、400、正文前景色，左缘与输入框对齐、相距 10px，
// 不设 role、不在 live region 内。导出稿没有这一状态，规格见 web-ui.md「对话页状态说明行」。
const removedModelText =
	"原模型选项已移除；提交消息时，标准模板将使用 Owner 的默认选项。你也可以刷新并重新选择。";
for (const viewport of viewports)
	test(`sizes the removed model option note like the other composer notes at ${viewport.width} by ${viewport.height} (#3327 N10-1-03)`, async ({
		page,
	}, info) => {
		test.skip(info.project.name !== "desktop", "Viewport list runs once.");
		await page.setViewportSize(viewport);
		const errors = trackPageErrors(page);
		const fixture = await chatFixture(
			page,
			{ name: "原模型选项已移除", text: "", executionStatus: "completed" },
			{ selectedModelOptionId: "model-removed" },
		);
		const form = fixture.input.locator("xpath=ancestor::form[1]");
		const line = page.getByText(removedModelText, { exact: true });
		await expect(line).toBeVisible();
		const measured = await measure(line, form);
		expect(
			{
				fontSize: measured.fontSize,
				lineHeight: measured.lineHeight,
				fontWeight: measured.fontWeight,
				color: measured.color,
			},
			"原模型选项已移除说明行字号与颜色",
		).toEqual({
			fontSize: "14px",
			lineHeight: "20px",
			fontWeight: "400",
			color: await resolved(page, "color", "var(--foreground)"),
		});
		expect(Math.abs(measured.dxForm)).toBeLessThanOrEqual(0.5);
		expect(measured.right).toBeLessThanOrEqual(measured.viewport);
		const gap = await line.evaluate((node, formNode) => {
			const bottom = node.getBoundingClientRect().bottom;
			return (formNode as Element).getBoundingClientRect().top - bottom;
		}, await form.elementHandle());
		expect(Math.abs(gap - 10), "说明行与输入框相距 10px").toBeLessThanOrEqual(
			0.5,
		);
		// 静态说明：不设 role，也不嵌在 live region 里。
		expect(measured.role).toBeNull();
		expect(measured.live).toBe(false);
		await expectNoDuplicateControls(page, "原模型选项已移除说明行");
		await expectCleanPage(page, errors);
		await info.attach(`n10-1-03-model-removed-${viewport.width}`, {
			body: await page.screenshot(),
			contentType: "image/png",
		});
		expect(fixture.writes).toEqual([]);
	});

// #3327 N10-1-02：保存模型选择得到不可重试的 409 MODEL_SELECTION_INVALID 后，composer 内的失败行与同
// composer 的错误行（O8-01）同为 12px / 1.6 --danger-ink，左内缩随已选命令卡与错误行：≥768px 12px、
// ≤767px 8px；选择回到已保存值，焦点留在模型入口。导出稿没有这一状态。
for (const viewport of viewports)
	test(`insets the non-retryable model setting failure like the composer error line at ${viewport.width} by ${viewport.height} (#3327 N10-1-02)`, async ({
		page,
	}, info) => {
		test.skip(info.project.name !== "desktop", "Viewport list runs once.");
		await page.setViewportSize(viewport);
		const errors = trackPageErrors(page);
		const fixture = await chatFixture(
			page,
			{ name: "模型设置失败", text: "", executionStatus: "completed" },
			{
				options: [
					{
						optionId: "model-primary",
						displayName: "Primary model",
						modelId: "gpt-5",
						reasoningLevels: ["medium", "high"],
					},
					{
						optionId: "model-secondary",
						displayName: "Secondary model",
						modelId: "claude",
						reasoningLevels: ["high"],
					},
				],
				onSelection: (route) =>
					route.fulfill({
						status: 409,
						json: {
							schemaVersion: 1,
							code: "MODEL_SELECTION_INVALID",
							message: "Controlled model selection rejection",
							retryable: false,
							traceId: "trace-feedback-model-selection",
						},
					}),
			},
		);
		const form = fixture.input.locator("xpath=ancestor::form[1]");
		const trigger = form.locator(".composer-setting-trigger").first();
		await expect(trigger).toHaveAccessibleName(/当前 Primary model/);
		await trigger.click();
		const menu = page.getByRole("menu", { name: "模型与思考设置" });
		await menu.getByRole("menuitemradio", { name: "Secondary model" }).click();
		const failure = form.locator(".model-preference-failure");
		await expect(failure).toHaveText(
			"模型选项已变化，请刷新模型清单后重新选择。",
		);
		await expect(failure).toHaveAttribute("role", "status");
		// 选择回到已保存的值，焦点留在模型入口（D2-59）。
		await expect(trigger).toHaveAccessibleName(/当前 Primary model/);
		await expectFocusSettled(trigger, "模型设置不可重试失败后");
		const style = await computed(failure, ["fontSize", "lineHeight", "color"]);
		expect(style).toEqual({
			fontSize: "12px",
			lineHeight: "19.2px",
			color: await resolved(page, "color", "var(--danger-ink)"),
		});
		const inset = await failure.evaluate((node) => {
			const form = node.closest("form");
			if (!form) throw new Error("Missing composer form");
			const content = form.getBoundingClientRect().left + form.clientLeft;
			const rect = node.getBoundingClientRect();
			return {
				left: rect.left - content,
				right: content + form.clientWidth - rect.right,
			};
		});
		const expected = viewport.width <= 767 ? 8 : 12;
		expect(Math.abs(inset.left - expected), "失败行左内缩").toBeLessThanOrEqual(
			0.5,
		);
		expect(
			Math.abs(inset.right - expected),
			"失败行右内缩",
		).toBeLessThanOrEqual(0.5);
		await expectNoDuplicateControls(page, "模型设置不可重试失败");
		await expectCleanPage(page, errors);
		await info.attach(`n10-1-02-model-failure-${viewport.width}`, {
			body: await page.screenshot(),
			contentType: "image/png",
		});
		expect(fixture.writes).toEqual([
			`PUT /api/v1/conversations/${conversationId}/model-selection`,
		]);
	});
