import {
	AgentApplicationProjectionV2Schema,
	AgentProjectionV2Schema,
} from "@agent-infra/contracts/pilot";
import {
	createPilotAgentMockServerV2,
	pilotFakeScenariosV2,
} from "@agent-infra/test-support/pilot";
import { expect, type Page, type TestInfo, test } from "@playwright/test";

import { pendingApplication } from "../src/features/my-agents/test-fixtures";
import type {
	AgentLifecycleCommandRequestV1,
	ApprovalDecisionRequestV1,
} from "../src/pilot/generated/types.gen";
import type { AgentApplicationCreateRequestV2Writable } from "../src/pilot/generated-v2/types.gen";

async function fixture(
	page: Page,
	role: "owner" | "admin" | "employee" = "owner",
) {
	let application = AgentApplicationProjectionV2Schema.parse({
		...pendingApplication,
		applicationId: "application-browser-1",
	});
	let agent = AgentProjectionV2Schema.parse(
		pilotFakeScenariosV2.starting.response.body,
	);
	const session = {
		schemaVersion: 1,
		user: {
			userId: role === "owner" ? "user-owner-1" : `user-${role}`,
			displayName: role,
			roles: role === "admin" ? ["employee", "system_admin"] : ["employee"],
		},
	};
	const server = createPilotAgentMockServerV2({
		getCurrentSession: { status: 200, body: session },
		listAgents: (request) => {
			const ownerScope =
				new URL(request.url).searchParams.get("scope") === "owner";
			return {
				status: 200,
				body: {
					items: ownerScope && role !== "owner" ? [] : [agent],
					nextCursor: null,
				},
			};
		},
		getAgent: () => ({ status: 200, body: agent }),
		listAgentApplications: () => ({
			status: 200,
			body: { items: [application], nextCursor: null },
		}),
		getAgentApplication: () => ({ status: 200, body: application }),
		createAgentApplication: () => ({ status: 201, body: application }),
		updateAgentApplication: () => ({ status: 200, body: application }),
		withdrawAgentApplication: () => ({ status: 200, body: application }),
		listPendingAgentApplications: () => ({
			status: 200,
			body: {
				items: application.status === "pending_approval" ? [application] : [],
				nextCursor: null,
			},
		}),
		decideAgentApplication: () => ({ status: 200, body: application }),
		updateAgentConfiguration: () => ({ status: 200, body: agent }),
		commandAgentLifecycle: () => ({ status: 202, body: agent }),
	});
	let release: (() => void) | undefined;
	let nextGate: Promise<void> | undefined;
	let rejectNextWithdrawal = false;
	const commands: { path: string; body: unknown; key: string | undefined }[] =
		[];
	await page.route(/\/api\/v[12]\//, async (route) => {
		const request = route.request();
		const pathname = new URL(request.url()).pathname;
		const body = request.postData() ? request.postDataJSON() : undefined;
		if (pathname.endsWith("/wecom-bot")) {
			await route.fulfill({ json: { status: "not_configured" } });
			return;
		}
		if (request.method() !== "GET") {
			commands.push({
				path: pathname,
				body,
				key: request.headers()["idempotency-key"],
			});
			await nextGate;
			nextGate = undefined;
			if (pathname.endsWith("/withdraw") && rejectNextWithdrawal) {
				rejectNextWithdrawal = false;
				await route.fulfill({
					status: 409,
					json: {
						schemaVersion: 1,
						code: "RESOURCE_UNAVAILABLE",
						message: "Application state changed",
						retryable: false,
						traceId: "trace-withdraw-conflict",
					},
				});
				return;
			}
			if (pathname.endsWith("/decision")) {
				const decision = body as ApprovalDecisionRequestV1;
				application = AgentApplicationProjectionV2Schema.parse({
					...application,
					status: decision.decision === "approve" ? "creating" : "rejected",
					decision: {
						decidedAt: "2026-09-07T00:00:00Z",
						reason: "reason" in decision ? decision.reason : null,
					},
				});
			} else if (pathname.endsWith("/withdraw")) {
				application = { ...application, status: "withdrawn" };
			} else if (pathname.includes("/agent-applications")) {
				const draft = body as AgentApplicationCreateRequestV2Writable;
				application = {
					...application,
					name: draft.name,
					description: draft.description,
					source: draft.source,
					status: "pending_approval",
					decision: null,
				};
			} else if (pathname.endsWith("/lifecycle")) {
				const command = body as AgentLifecycleCommandRequestV1;
				agent = {
					...agent,
					managementStatus:
						command.command === "stop"
							? "stopped"
							: command.command === "disable"
								? "disabled"
								: "available",
					serviceAvailability:
						command.command === "stop" || command.command === "disable"
							? null
							: "starting",
				};
			}
		}
		const response = await server.fetch(
			new Request(request.url(), {
				method: request.method(),
				headers: request.headers(),
				body: request.postData(),
			}),
		);
		await route.fulfill({
			status: response.status,
			contentType: "application/json",
			body: await response.text(),
		});
	});
	return {
		commands,
		holdNextCommand() {
			nextGate = new Promise<void>((resolve) => {
				release = resolve;
			});
		},
		release() {
			release?.();
		},
		rejectApplication() {
			application = {
				...application,
				status: "rejected",
				decision: {
					decidedAt: "2026-09-07T00:00:00Z",
					reason: "Capacity is unavailable",
				},
			};
		},
		rejectNextWithdrawal() {
			rejectNextWithdrawal = true;
		},
		customAgent() {
			agent = {
				...agent,
				source: {
					kind: "custom",
					imageReference: "registry.example/agent:v1",
					interactionMode: "platform-adapter",
				},
			};
		},
	};
}

async function capture(page: Page, info: TestInfo, name: string) {
	expect(
		await page.evaluate(
			() =>
				Math.max(
					document.documentElement.scrollWidth,
					document.body.scrollWidth,
				) <= window.innerWidth,
		),
	).toBe(true);
	const overflow = await page
		.locator(
			"main a, main button, main input:not([type=hidden]):not([aria-hidden=true]), main textarea, main select, main label, main [role=checkbox]",
		)
		.evaluateAll((elements) =>
			elements
				.filter((element) => {
					const box = element.getBoundingClientRect();
					return (
						box.width > 0 &&
						(box.left < 0 ||
							box.right > window.innerWidth + 1 ||
							(element.tagName === "BUTTON" &&
								element.scrollWidth > element.clientWidth + 1))
					);
				})
				.map((element) => element.tagName),
		);
	expect(overflow).toEqual([]);
	const path = info.outputPath(`${name}-${info.project.name}.png`);
	await page.screenshot({ path, fullPage: true });
	await info.attach(`${name} (${info.config.metadata.head})`, {
		path,
		contentType: "image/png",
	});
}

test("create, edit, resubmit and withdraw with native form and pending semantics", async ({
	page,
}, info) => {
	const api = await fixture(page);
	await page.goto("/my-agents/new");
	const create = page.getByRole("button", {
		name: "提交申请",
		exact: true,
	});
	await create.click();
	await expect(page.getByLabel("Agent 名称")).toBeFocused();
	expect(api.commands).toHaveLength(0);
	await page.getByLabel("Agent 名称").fill("Release assistant");
	await page.keyboard.press("Tab");
	await expect(page.getByLabel("用途说明", { exact: true })).toBeFocused();
	expect(
		await page
			.getByLabel("用途说明", { exact: true })
			.evaluate((element) => getComputedStyle(element).boxShadow),
	).not.toBe("none");
	await page
		.getByLabel("用途说明", { exact: true })
		.fill("Helps the release team");
	await page.getByLabel("Agent 来源").focus();
	await page.getByLabel("Agent 来源").selectOption("custom-platform-adapter");
	await page.keyboard.press("Tab");
	await expect(page.getByLabel("镜像地址")).toBeFocused();
	await expect(page.getByLabel("Agent 来源")).toHaveValue(
		"custom-platform-adapter",
	);
	await page.getByLabel("镜像地址").fill("registry.example/agents/release:v1");
	await capture(page, info, "create-application");
	api.holdNextCommand();
	await create.focus();
	await page.keyboard.press("Enter");
	await expect(page.getByRole("button", { name: "正在提交…" })).toBeDisabled();
	await expect(page.getByLabel("Agent 名称")).toBeDisabled();
	await page.keyboard.press("Enter");
	await expect.poll(() => api.commands.length).toBe(1);
	expect(api.commands[0]?.body).toEqual({
		schemaVersion: 2,
		name: "Release assistant",
		description: "Helps the release team",
		source: {
			kind: "custom",
			imageReference: "registry.example/agents/release:v1",
			interactionMode: "platform-adapter",
		},
		coOwnerIds: [],
		availability: [],
		environment: [],
		secrets: [],
	});
	expect(api.commands[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
	await capture(page, info, "application-pending");
	api.release();
	await expect(page.getByRole("status")).toBeFocused();
	await page.getByRole("link", { name: "查看申请" }).click();
	await page.getByRole("link", { name: "修改申请" }).click();
	await expect(page.getByLabel("Agent 来源")).toBeDisabled();
	await page
		.getByLabel("用途说明", { exact: true })
		.fill("Updated release workflow");
	await page.getByRole("button", { name: "修改申请", exact: true }).click();
	await expect(page.getByRole("status")).toContainText("申请已提交");
	api.rejectApplication();
	await page.goto("/my-agents/application-browser-1/edit");
	await page
		.getByRole("button", { name: "修改并重新提交", exact: true })
		.click();
	await expect(page.getByRole("status")).toContainText("待审批");
	await page.getByRole("link", { name: "查看申请" }).click();
	const withdraw = page.getByRole("button", { name: "撤回申请" });
	api.rejectNextWithdrawal();
	await withdraw.focus();
	await page.keyboard.press("Enter");
	await page.getByRole("button", { name: "确认撤回" }).click();
	await expect(page.getByRole("alert")).toHaveText(
		"暂未确认撤回结果，请先查看申请的最新状态。",
	);
	await expect(withdraw).toBeEnabled();
	await expect(withdraw).toBeFocused();
	await capture(page, info, "withdraw-application-error");
	api.holdNextCommand();
	await withdraw.click();
	await page.getByRole("button", { name: "确认撤回" }).click();
	await expect(page.getByRole("button", { name: "正在撤回…" })).toBeDisabled();
	api.release();
	await expect(page.getByText("已撤回", { exact: true })).toBeVisible();
	await expect(page.getByRole("status")).toBeFocused();
	await expect(page.getByRole("status")).toHaveText("撤回请求已提交：已撤回。");
	await expect(page.getByRole("button", { name: "撤回申请" })).toHaveCount(0);
});

test("administrator rejection, approval, empty queue and pending controls", async ({
	page,
}, info) => {
	const api = await fixture(page, "admin");
	await page.goto("/admin/approvals");
	await page.getByRole("button", { name: "审阅申请" }).click();
	await page.getByRole("button", { name: "驳回", exact: true }).click();
	const reject = page.getByRole("button", { name: "确认驳回" });
	await reject.click();
	await expect(page.getByLabel("驳回原因")).toBeFocused();
	await page.getByLabel("驳回原因").fill("  Capacity is unavailable  ");
	await page.keyboard.press("Tab");
	await expect(reject).toBeFocused();
	await capture(page, info, "approvals");
	api.holdNextCommand();
	await page.keyboard.press("Enter");
	await expect(page.getByRole("button", { name: "提交中…" })).toBeDisabled();
	await expect(page.getByRole("button", { name: "返回审阅" })).toBeDisabled();
	api.release();
	await expect(page.getByRole("status")).toBeFocused();
	await expect(page.getByText("暂无待审批申请。")).toBeVisible();
	expect(api.commands[0]?.body).toEqual({
		schemaVersion: 1,
		decision: "reject",
		reason: "Capacity is unavailable",
	});
	await capture(page, info, "approvals-empty");
	await page.goto("/my-agents/application-browser-1/edit");
	await page
		.getByRole("button", { name: "修改并重新提交", exact: true })
		.click();
	await expect(page.getByRole("status")).toBeVisible();
	await page.goto("/admin/approvals");
	await page.getByRole("button", { name: "审阅申请" }).click();
	await page.getByRole("button", { name: "批准并创建" }).click();
	await expect(page.getByRole("status")).toContainText("创建中");
	expect(api.commands.at(-1)?.body).toEqual({
		schemaVersion: 1,
		decision: "approve",
	});
});

test("Owner configuration checkbox, Secret clearing, lifecycle and custom image upgrade", async ({
	page,
}, info) => {
	const api = await fixture(page);
	await page.goto("/agents/agent-pilot-1");
	await page.getByRole("link", { name: "配置与管理" }).click();
	const replaceModels = page.getByRole("checkbox", {
		name: "替换模型配置",
	});
	await replaceModels.focus();
	await page.keyboard.press("Space");
	await expect(replaceModels).toBeChecked();
	await expect(page.getByLabel("新模型凭证")).toHaveValue("");
	await page.keyboard.press("Space");
	await expect(replaceModels).not.toBeChecked();
	await page.getByRole("button", { name: "添加 Secret" }).click();
	await page.getByLabel("Secret 名称").fill("RELEASE_KEY");
	await page.getByLabel("新 Secret 值").fill("synthetic-browser-secret");
	await expect(page.getByLabel("新 Secret 值")).toHaveAttribute(
		"type",
		"password",
	);
	await expect(page.getByText(/群消息和 Agent 回复对群成员可见/)).toBeVisible();
	await page.getByRole("checkbox", { name: "修改自建应用绑定" }).check();
	await page.getByLabel("自建应用配置标识").fill("approved-app-fixture");
	await capture(page, info, "owner-configuration");
	api.holdNextCommand();
	await page.getByRole("button", { name: "校验并保存" }).click();
	await expect(
		page.getByRole("button", { name: "校验并保存中…" }),
	).toBeDisabled();
	await expect(replaceModels).toBeDisabled();
	await expect(page.getByLabel("新 Secret 值")).toHaveCount(0);
	api.release();
	await expect(page.getByRole("status")).toBeFocused();
	await expect(page.locator("body")).not.toContainText(
		"synthetic-browser-secret",
	);
	expect(api.commands[0]?.body).toMatchObject({
		schemaVersion: 2,
		coOwnerIds: ["user-owner-1"],
		secrets: [{ name: "RELEASE_KEY", value: "synthetic-browser-secret" }],
		channels: [
			{
				kind: "wecom_app",
				enabled: true,
				bindingReference: "approved-app-fixture",
			},
		],
	});
	await page.goto("/agents/agent-pilot-1/configuration");
	await capture(page, info, "lifecycle");
	api.holdNextCommand();
	await page.getByRole("button", { name: "停止 Agent" }).focus();
	await page.keyboard.press("Enter");
	await page.getByRole("button", { name: "确认停止" }).click();
	await expect(page.getByRole("button", { name: "停止中…" })).toBeDisabled();
	await expect(page.getByRole("button", { name: "重启 Agent" })).toBeDisabled();
	api.release();
	await expect(page.getByRole("status")).toBeFocused();
	await page.getByRole("button", { name: "重启 Agent" }).click();
	await page.getByRole("button", { name: "确认重启" }).click();
	await expect(page.getByRole("status")).toContainText("可用");
	api.customAgent();
	await page.goto("/agents/agent-pilot-1/configuration");
	await expect(page.getByRole("button", { name: "升级镜像" })).toBeDisabled();
	await page.getByLabel("新镜像引用").fill("registry.example/agent:v2");
	api.holdNextCommand();
	await page.getByRole("button", { name: "升级镜像" }).click();
	await expect(page.getByRole("button", { name: "升级中…" })).toBeDisabled();
	await expect(page.getByLabel("新镜像引用")).toBeDisabled();
	api.release();
	await expect(page.getByRole("status")).toContainText("配置已提交");
	expect(api.commands.at(-1)?.body).toEqual({
		schemaVersion: 1,
		command: "upgrade_custom_image",
		imageReference: "registry.example/agent:v2",
	});
});

test("employee has no Owner or administrator controls, with loading and error states", async ({
	page,
}, info) => {
	await fixture(page, "employee");
	await page.goto("/agents/agent-pilot-1");
	await expect(
		page.getByRole("heading", { name: "Release assistant", exact: true }),
	).toBeVisible();
	await expect(page.getByRole("link", { name: "配置与管理" })).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: /停止 Agent|重启 Agent|停用 Agent/ }),
	).toHaveCount(0);
	await page.goto("/agents/agent-pilot-1/configuration");
	await expect(page.getByRole("alert")).toHaveText("当前无法访问此配置。");
	await page.goto("/admin/approvals");
	await expect(page.getByRole("alert")).toHaveText("当前无法访问审批。");
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route("**/api/v2/agents", async (route) => {
		await gate;
		await route.fulfill({
			status: 403,
			json: pilotFakeScenariosV2.unauthorized.response.body,
		});
	});
	await page.goto("/agents");
	await expect(page.getByText("正在加载 Agent…")).toBeVisible();
	await capture(page, info, "agents-loading");
	release?.();
	await expect(page.getByRole("alert")).toHaveText(
		"Agent 列表暂时无法访问，请联系管理员。",
	);
	await capture(page, info, "agents-unavailable");
});

test("mobile navigation traps focus and returns it on Escape", async ({
	page,
}, info) => {
	test.skip(info.project.name !== "mobile", "Mobile Sheet behavior");
	await fixture(page, "employee");
	await page.goto("/agents");
	const trigger = page.getByRole("button", { name: "打开导航" });
	await trigger.click();
	const dialog = page.getByRole("dialog", { name: "主导航" });
	await expect(dialog).toBeVisible();
	for (let index = 0; index < 8; index++) {
		await page.keyboard.press("Tab");
		await expect
			.poll(() =>
				dialog.evaluate((element) => element.contains(document.activeElement)),
			)
			.toBe(true);
	}
	await page.keyboard.press("Escape");
	await expect(dialog).not.toBeVisible();
	await expect(trigger).toBeFocused();
	await trigger.click();
	await dialog.getByRole("link", { name: "我的 Agent", exact: true }).click();
	await expect(page).toHaveURL(/\/my-agents$/);
	await expect(dialog).not.toBeVisible();
});

test("management pages remain reachable at 200% zoom equivalent widths", async ({
	page,
}, info) => {
	test.skip(info.project.name !== "mobile", "Narrow viewport acceptance");
	await fixture(page, "owner");
	for (const path of [
		"/agents",
		"/agents/agent-pilot-1",
		"/my-agents",
		"/my-agents/new",
		"/my-agents/application-browser-1",
		"/agents/agent-pilot-1/configuration",
	]) {
		await page.goto(path);
		await expect(page.locator(".management-content h1").first()).toBeVisible();
		for (const width of [160, 200, 215, 320, 390, 430, 768, 1024, 1440]) {
			await page.setViewportSize({ width, height: width <= 430 ? 844 : 1000 });
			await expect
				.poll(
					() =>
						page.evaluate(
							() =>
								Math.max(
									document.documentElement.scrollWidth,
									document.body.scrollWidth,
								) <= innerWidth,
						),
					{ message: `${path} at ${width}px` },
				)
				.toBe(true);
			if (width === 160)
				await capture(page, info, `narrow-${path.replaceAll("/", "-")}`);
		}
		await page.setViewportSize({ width: 160, height: 320 });
		await capture(page, info, `short-${path.replaceAll("/", "-")}`);
	}
	await fixture(page, "admin");
	await page.goto("/admin/approvals");
	await expect(page.getByRole("heading", { name: "审批" })).toBeVisible();
	for (const width of [160, 200, 215, 320, 390, 430, 768, 1024, 1440]) {
		await page.setViewportSize({ width, height: width <= 430 ? 844 : 1000 });
		await expect
			.poll(
				() =>
					page.evaluate(
						() =>
							Math.max(
								document.documentElement.scrollWidth,
								document.body.scrollWidth,
							) <= innerWidth,
					),
				{ message: `approvals at ${width}px` },
			)
			.toBe(true);
		if (width === 160) await capture(page, info, "narrow-approvals");
	}
	await page.setViewportSize({ width: 160, height: 320 });
	await capture(page, info, "short-approvals");
});

test("Owner manually configures a bot without exposing its Secret or an internal reference", async ({
	page,
}, info) => {
	await fixture(page);
	const session = {
		sessionId: "fixture-setup",
		agentId: "agent-pilot-1",
		configurationRevision: 1,
		expiresAt: new Date(Date.now() + 300000).toISOString(),
	};
	let active = false;
	let saved: unknown;
	await page.route(/\/api\/v1\/agents\/[^/]+\/wecom-/, async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path.endsWith("/wecom-bot"))
			return route.fulfill({
				json: { status: active ? "connected" : "not_configured" },
			});
		if (path.endsWith("/wecom-setup"))
			return route.fulfill({
				json: {
					...session,
					status: "awaiting_input",
					state: "fixture-state",
					qrAvailable: false,
					qrUnavailableReason: "authorization_correlation_unverified",
				},
			});
		if (path.endsWith("/credentials")) {
			saved = route.request().postDataJSON();
			active = true;
			return route.fulfill({ json: { ...session, status: "verifying" } });
		}
		return route.fulfill({ json: { ...session, status: "active" } });
	});
	await page.goto("/agents/agent-pilot-1");
	await page.getByRole("link", { name: "配置与管理" }).click();
	await page.getByRole("button", { name: "扫码授权" }).click();
	await expect(
		page.getByText("扫码授权暂不可用，请使用下方手动配置。"),
	).toBeVisible();
	await page.getByLabel("Bot ID", { exact: true }).fill("fixture-bot");
	const secret = "synthetic-bot-secret";
	await page.getByLabel("Secret", { exact: true }).fill(secret);
	await page.getByRole("checkbox", { name: /我已知悉/ }).check();
	await page.getByLabel("Secret", { exact: true }).evaluate((element) => {
		(element as HTMLInputElement).value = "";
	});
	await capture(page, info, "wecom-manual");
	await page.getByLabel("Secret", { exact: true }).fill(secret);
	await page.getByRole("button", { name: "验证并绑定" }).click();
	await expect(page.getByLabel("Secret", { exact: true })).toHaveValue("");
	await expect(page.getByText("已连接", { exact: true })).toBeVisible();
	expect(saved).toEqual({
		state: "fixture-state",
		botId: "fixture-bot",
		secret,
		takeoverConfirmed: true,
	});
	await expect(page.getByLabel("智能机器人配置标识")).toHaveCount(0);
	await capture(page, info, "wecom-connected");
});

test("owned Agent tab consumes the authorized collection and supports keyboard navigation", async ({
	page,
}, info) => {
	await fixture(page);
	await page.goto("/my-agents");
	const applications = page.getByRole("tab", { name: "申请", exact: true });
	await applications.focus();
	await page.keyboard.press("ArrowRight");
	await expect(page.getByRole("tab", { name: "已创建 Agent" })).toBeFocused();
	await expect(
		page.getByRole("list", { name: "我管理的 Agent" }),
	).toContainText("Release assistant");
	await capture(page, info, "owned-agents");
	await page.getByRole("link", { name: "配置与管理" }).click();
	await expect(page).toHaveURL(/\/agents\/agent-pilot-1\/configuration$/);
});

test("employee collection is not presented as owned Agents", async ({
	page,
}) => {
	await fixture(page, "employee");
	await page.goto("/my-agents");
	await page.getByRole("tab", { name: "已创建 Agent" }).click();
	await expect(
		page.getByRole("heading", { name: "暂无你管理的 Agent" }),
	).toBeVisible();
	await expect(page.getByRole("link", { name: "配置与管理" })).toHaveCount(0);
});

test("withdraw confirmation traps focus and cancellation sends no request", async ({
	page,
}, info) => {
	const api = await fixture(page);
	await page.goto("/my-agents/application-browser-1");
	const trigger = page.getByRole("button", { name: "撤回申请" });
	await trigger.click();
	const dialog = page.getByRole("dialog", { name: "撤回这项申请？" });
	await expect(dialog).toBeVisible();
	for (let i = 0; i < 6; i++) {
		await page.keyboard.press("Tab");
		await expect
			.poll(() => dialog.evaluate((el) => el.contains(document.activeElement)))
			.toBe(true);
	}
	await capture(page, info, "withdraw-confirmation");
	await page.keyboard.press("Escape");
	await expect(dialog).not.toBeVisible();
	await expect(trigger).toBeFocused();
	expect(api.commands).toHaveLength(0);
});

test("Agent search survives reload and browser back without adding typing history", async ({
	page,
}) => {
	await fixture(page);
	await page.goto("/agents");
	const search = page.getByPlaceholder("按名称或用途搜索");
	await search.fill("Release");
	await expect(page).toHaveURL(/q=Release/);
	await page.reload();
	await expect(search).toHaveValue("Release");
	await page.getByRole("link", { name: "查看 Release assistant 详情" }).click();
	await page.goBack();
	await expect(search).toHaveValue("Release");
	await search.fill("没有匹配的中文");
	await expect(
		page.getByRole("link", { name: "查看 Release assistant 详情" }),
	).toHaveCount(0);
	await page.reload();
	await expect(search).toHaveValue("没有匹配的中文");
});
