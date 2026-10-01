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
import type {
	AgentApplicationCreateRequestV2Writable,
	DeploymentConfigurationProjectionV2,
} from "../src/pilot/generated-v2/types.gen";

const deploymentConfiguration: DeploymentConfigurationProjectionV2 = {
	modelCatalog: {
		endpoints: [
			{
				displayName: "Primary endpoint",
				endpointId: "endpoint-primary",
				models: [
					{
						modelId: "gpt-5",
						reasoningLevels: ["medium", "high"],
					},
				],
			},
		],
		revision: "catalog-browser",
		status: "populated",
	},
	schemaVersion: 2,
	status: "populated",
	templates: [
		{
			allowedEnvironmentKeys: ["LOG_LEVEL"],
			allowedSecretKeys: ["MODEL_API_KEY"],
			connectionEnabled: false,
			displayName: "Codex",
			templateId: "codex",
		},
	],
};

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
	let additionalAgents: (typeof agent)[] = [];
	let deployment = deploymentConfiguration;
	let pendingQueueUnavailable = false;
	let pendingQueueUnauthorized = false;
	let agentListUnavailable = false;
	let agentListUnauthorized = false;
	let ownedAgentListUnauthorized = false;
	let agentDetailUnavailable = false;
	let agentDetailUnauthorized = false;
	let agentDetailMismatched = false;
	let agentListMalformed = false;
	let applicationsUnavailable = false;
	let applicationsUnauthorized = false;
	let applicationDetailUnavailable = false;
	let applicationDetailUnauthorized = false;
	let deploymentUnavailable = false;
	let deploymentUnauthorized = false;
	const retryableReadFailure = {
		schemaVersion: 1 as const,
		code: "DEPENDENCY_UNAVAILABLE" as const,
		message: "Controlled list failure",
		retryable: true,
		traceId: "trace-list-retry",
	};
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
		getDeploymentConfiguration: () =>
			deploymentUnauthorized
				? {
						status: 403,
						body: pilotFakeScenariosV2.unauthorized.response.body,
					}
				: deploymentUnavailable
					? { status: 503, body: retryableReadFailure }
					: {
							status: 200,
							body: deployment,
						},
		listAgents: (request) => {
			const ownerScope =
				new URL(request.url).searchParams.get("scope") === "owner";
			if (!ownerScope && agentListUnauthorized) {
				return {
					status: 403,
					body: pilotFakeScenariosV2.unauthorized.response.body,
				};
			}
			if (ownerScope && ownedAgentListUnauthorized) {
				return {
					status: 403,
					body: pilotFakeScenariosV2.unauthorized.response.body,
				};
			}
			if (agentListUnavailable) {
				return {
					status: 503,
					body: retryableReadFailure,
				};
			}
			return {
				status: 200,
				body: {
					items:
						ownerScope && role !== "owner" ? [] : [agent, ...additionalAgents],
					nextCursor: null,
				},
			};
		},
		getAgent: (request) => {
			const agentId = decodeURIComponent(
				new URL(request.url).pathname.split("/").at(-1) ?? "",
			);
			const selected = [agent, ...additionalAgents].find(
				(item) => item.agentId === agentId,
			);
			return agentDetailUnauthorized
				? {
						status: 403,
						body: pilotFakeScenariosV2.unauthorized.response.body,
					}
				: agentDetailUnavailable
					? {
							status: 503,
							body: retryableReadFailure,
						}
					: selected
						? { status: 200, body: selected }
						: {
								status: 404,
								body: {
									schemaVersion: 1,
									code: "RESOURCE_UNAVAILABLE",
									message: "Controlled unavailable Agent",
									retryable: false,
									traceId: "trace-agent-unavailable",
								},
							};
		},
		listAgentApplications: () =>
			applicationsUnauthorized
				? {
						status: 403,
						body: pilotFakeScenariosV2.unauthorized.response.body,
					}
				: applicationsUnavailable
					? {
							status: 503,
							body: retryableReadFailure,
						}
					: {
							status: 200,
							body: { items: [application], nextCursor: null },
						},
		getAgentApplication: () =>
			applicationDetailUnauthorized
				? {
						status: 403,
						body: pilotFakeScenariosV2.unauthorized.response.body,
					}
				: applicationDetailUnavailable
					? { status: 503, body: retryableReadFailure }
					: { status: 200, body: application },
		createAgentApplication: () => ({ status: 201, body: application }),
		updateAgentApplication: () => ({ status: 200, body: application }),
		withdrawAgentApplication: () => ({ status: 200, body: application }),
		listPendingAgentApplications: () => {
			if (pendingQueueUnauthorized) {
				return {
					status: 403,
					body: pilotFakeScenariosV2.unauthorized.response.body,
				};
			}
			if (pendingQueueUnavailable) {
				return {
					status: 503,
					body: {
						schemaVersion: 1 as const,
						code: "DEPENDENCY_UNAVAILABLE" as const,
						message: "Controlled pending queue failure",
						retryable: true,
						traceId: "trace-pending-queue-retry",
					},
				};
			}
			return {
				status: 200,
				body: {
					items: application.status === "pending_approval" ? [application] : [],
					nextCursor: null,
				},
			};
		},
		decideAgentApplication: () => ({ status: 200, body: application }),
		updateAgentConfiguration: () => ({ status: 200, body: agent }),
		commandAgentLifecycle: () => ({ status: 202, body: agent }),
	});
	let release: (() => void) | undefined;
	let nextGate: Promise<void> | undefined;
	let rejectNextApplication:
		| "DEPENDENCY_UNAVAILABLE"
		| "AUTHORIZATION_REVOKED"
		| undefined;
	let rejectNextWithdrawal = false;
	const commands: { path: string; body: unknown; key: string | undefined }[] =
		[];
	await page.route(/\/api\/v[12]\//, async (route) => {
		const request = route.request();
		const pathname = new URL(request.url()).pathname;
		const body = request.postData() ? request.postDataJSON() : undefined;
		// Deliberately bypass the schema-valid mock server for protocol negatives.
		if (
			request.method() === "GET" &&
			pathname === "/api/v2/agents" &&
			agentListMalformed
		) {
			await route.fulfill({ json: { items: [agent], nextCursor: 42 } });
			return;
		}
		if (
			request.method() === "GET" &&
			/^\/api\/v2\/agents\/[^/]+$/.test(pathname) &&
			agentDetailMismatched
		) {
			await route.fulfill({
				json: { ...agent, agentId: "agent-unrelated", name: "Unrelated Agent" },
			});
			return;
		}
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
			if (pathname.endsWith("/agent-applications") && rejectNextApplication) {
				const code = rejectNextApplication;
				rejectNextApplication = undefined;
				await route.fulfill({
					status: code === "AUTHORIZATION_REVOKED" ? 403 : 503,
					json: {
						schemaVersion: 1,
						code,
						message: "Controlled application rejection",
						retryable: code !== "AUTHORIZATION_REVOKED",
						traceId: "trace-application-retry",
					},
				});
				return;
			}
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
		misbindAgentDetail() {
			agentDetailMismatched = true;
		},
		recoverDetailBinding() {
			agentDetailMismatched = false;
		},
		malformAgentList() {
			agentListMalformed = true;
		},
		recoverListSchema() {
			agentListMalformed = false;
		},
		threeAgents() {
			additionalAgents = [2, 3].map((index) =>
				AgentProjectionV2Schema.parse({
					...agent,
					agentId: `agent-visible-${index}`,
					name: `Visible Agent ${index}`,
				}),
			);
		},
		conversationChoices(
			selfManagedIdentity: "self-managed" | "platform-managed" = "self-managed",
		) {
			agent = AgentProjectionV2Schema.parse({
				...agent,
				serviceAvailability: "ready",
			});
			additionalAgents = [
				AgentProjectionV2Schema.parse({
					...agent,
					agentId: "agent-platform-adapter",
					name: "Platform adapter",
					source: {
						kind: "custom",
						imageReference: "registry.example/agent:v1",
						interactionMode: "platform-adapter",
					},
				}),
				AgentProjectionV2Schema.parse({
					...agent,
					agentId: "agent-self-managed",
					name: "Self managed",
					interactionUrl: "https://agent.example.test",
					source: {
						kind: "custom",
						imageReference: "registry.example/agent:v1",
						interactionMode: "self-managed",
						identityResponsibility: selfManagedIdentity,
					},
				}),
				AgentProjectionV2Schema.parse({
					...agent,
					agentId: "agent-starting",
					name: "Starting Agent",
					serviceAvailability: "starting",
				}),
			];
		},
		longAgentFields() {
			agent = AgentProjectionV2Schema.parse({
				...agent,
				name: `中文 Agent 𠮷 👩🏽‍💻 e\u0301 ${"release_task".repeat(16)}`,
				description: `无空格说明：${"longtoken".repeat(32)}`,
			});
		},

		staleDeployment() {
			deployment = { ...deployment, status: "stale" };
		},
		freshDeployment() {
			deployment = deploymentConfiguration;
		},
		unavailableDeployment() {
			deploymentUnavailable = true;
		},
		recoverDeployment() {
			deploymentUnavailable = false;
		},
		unauthorizedDeployment() {
			deploymentUnauthorized = true;
		},
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
		rejectNextApplication(
			code:
				| "DEPENDENCY_UNAVAILABLE"
				| "AUTHORIZATION_REVOKED" = "DEPENDENCY_UNAVAILABLE",
		) {
			rejectNextApplication = code;
		},
		unavailablePendingQueue() {
			pendingQueueUnavailable = true;
		},
		unauthorizedPendingQueue() {
			pendingQueueUnauthorized = true;
		},
		recoverPendingQueue() {
			pendingQueueUnavailable = false;
		},
		unavailableAgentList() {
			agentListUnavailable = true;
		},
		unauthorizedAgentList() {
			agentListUnauthorized = true;
		},
		recoverAgentList() {
			agentListUnavailable = false;
		},
		unauthorizedOwnedAgentList() {
			ownedAgentListUnauthorized = true;
		},
		unavailableAgentDetail() {
			agentDetailUnavailable = true;
		},
		unauthorizedAgentDetail() {
			agentDetailUnauthorized = true;
		},
		unauthorizedApplications() {
			applicationsUnauthorized = true;
		},
		recoverAgentDetail() {
			agentDetailUnavailable = false;
		},
		unavailableApplications() {
			applicationsUnavailable = true;
		},
		recoverApplications() {
			applicationsUnavailable = false;
		},
		unavailableApplicationDetail() {
			applicationDetailUnavailable = true;
		},
		unauthorizedApplicationDetail() {
			applicationDetailUnauthorized = true;
		},
		recoverApplicationDetail() {
			applicationDetailUnavailable = false;
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
	const source = page.getByRole("combobox", { name: "Agent 来源" });
	await source.click();
	await page
		.getByRole("option", { name: "自定义 Agent · 平台交互入口" })
		.click();
	await source.focus();
	await page.keyboard.press("Tab");
	await expect(page.getByLabel("镜像地址")).toBeFocused();
	await expect(source).toContainText("自定义 Agent · 平台交互入口");
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

test("field errors and transient submission recover on desktop and mobile", async ({
	page,
}, info) => {
	const api = await fixture(page);
	await page.goto("/my-agents/new");
	const name = page.getByLabel("Agent 名称");
	const ownerIds = page.getByLabel("共同 Owner 用户 ID");
	const submit = page.getByRole("button", { name: "提交申请", exact: true });
	await name.fill("中文发布 Agent");
	await page.getByLabel("用途说明", { exact: true }).fill("用于中文发布验收");
	await page.getByRole("combobox", { name: "Agent 来源" }).click();
	await page
		.getByRole("option", { name: "自定义 Agent · 平台交互入口" })
		.click();
	await page.getByLabel("镜像地址").fill("registry.example/agents/release:v1");
	await ownerIds.fill("user-2\nuser-2");
	await page.getByRole("button", { name: "添加 Secret" }).click();
	await page.getByLabel("Secret 名称").fill("TEST_SECRET");
	await page.getByLabel("替换值").fill("synthetic-first-value");
	await submit.focus();
	await page.keyboard.press("Enter");
	await expect(ownerIds).toBeFocused();
	await expect(ownerIds).toHaveAttribute("aria-invalid", "true");
	await expect(page.getByText("共同 Owner 用户 ID不能重复。")).toBeVisible();
	expect(api.commands).toHaveLength(0);

	await ownerIds.fill("user-2");
	await expect(ownerIds).not.toHaveAttribute("aria-invalid", "true");
	api.rejectNextApplication();
	await submit.focus();
	await page.keyboard.press("Enter");
	await expect(page.getByRole("alert")).toContainText("申请提交失败");
	await expect(name).toHaveValue("中文发布 Agent");
	await expect(ownerIds).toHaveValue("user-2");
	await expect(page.getByLabel("替换值")).toHaveCount(0);
	expect(api.commands).toHaveLength(1);
	await capture(page, info, "application-field-recovery");

	await page.getByRole("button", { name: "添加 Secret" }).click();
	await page.getByLabel("Secret 名称").fill("TEST_SECRET");
	await page.getByLabel("替换值").fill("synthetic-retry-value");
	await submit.focus();
	await page.keyboard.press("Enter");
	await expect(page.getByRole("status")).toBeFocused();
	expect(api.commands).toHaveLength(2);
	expect(api.commands[1]?.body).toMatchObject({
		name: "中文发布 Agent",
		coOwnerIds: ["user-2"],
		secrets: [{ name: "TEST_SECRET", value: "synthetic-retry-value" }],
	});
});

test("stale deployment options block submission in the browser", async ({
	page,
}, info) => {
	const api = await fixture(page);
	api.staleDeployment();
	await page.goto("/my-agents/new");
	await page.getByLabel("Agent 名称").fill("中文模板 Agent");
	await page.getByLabel("用途说明", { exact: true }).fill("验证过期部署选项");
	await page.getByRole("button", { name: "提交申请", exact: true }).click();
	await expect(page.locator("#application-template-id-error")).toHaveText(
		"部署选项已过期，请重新加载后再提交。",
	);
	await expect(page.locator("#application-template-id")).toBeFocused();
	expect(api.commands).toHaveLength(0);
	await capture(page, info, "application-stale-options");
	api.freshDeployment();
	await page.getByRole("button", { name: "重新加载部署选项" }).click();
	await expect(page.locator("#application-deployment-status")).toHaveCount(0);
	await expect(page.getByLabel("Agent 名称")).toHaveValue("中文模板 Agent");
	await page.getByRole("combobox", { name: "标准模板 ID" }).click();
	await page.getByRole("option", { name: "Codex" }).click();
	await expect(page.locator("#application-template-id-error")).toHaveCount(0);
});

test("authorization rejection keeps non-sensitive input and clears Secret", async ({
	page,
}, info) => {
	const api = await fixture(page);
	await page.goto("/my-agents/new");
	await page.getByLabel("Agent 名称").fill("中文权限 Agent");
	await page.getByLabel("用途说明", { exact: true }).fill("验证撤权后拒绝");
	await page.getByRole("combobox", { name: "Agent 来源" }).click();
	await page
		.getByRole("option", { name: "自定义 Agent · 平台交互入口" })
		.click();
	await page.getByLabel("镜像地址").fill("registry.example/agents/release:v1");
	await page.getByRole("button", { name: "添加 Secret" }).click();
	await page.getByLabel("Secret 名称").fill("TEST_SECRET");
	await page.getByLabel("替换值").fill("synthetic-rejected-value");
	api.rejectNextApplication("AUTHORIZATION_REVOKED");
	await page.getByRole("button", { name: "提交申请", exact: true }).click();
	await expect(page.getByRole("alert")).toContainText("当前不可用");
	await expect(page.getByLabel("Agent 名称")).toHaveValue("中文权限 Agent");
	await expect(page.getByLabel("替换值")).toHaveCount(0);
	expect(api.commands).toHaveLength(1);
	await capture(page, info, "application-authorization-rejected");
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

test("administrator can recover a temporarily unavailable pending queue", async ({
	page,
}, info) => {
	const api = await fixture(page, "admin");
	api.unavailablePendingQueue();
	await page.goto("/admin/approvals");
	await expect(page.getByRole("alert")).toContainText(
		"审批列表暂时无法读取，请稍后重试。",
		{ timeout: 15_000 },
	);
	const retry = page.getByRole("button", { name: "重新加载审批" });
	await expect(retry).toBeVisible();
	api.recoverPendingQueue();
	await retry.focus();
	await page.keyboard.press("Enter");
	await expect(page.getByRole("button", { name: "审阅申请" })).toBeVisible();
	await capture(page, info, "approvals-recovered");
});

test("administrator authorization failure does not offer a pending-queue retry", async ({
	page,
}) => {
	const api = await fixture(page, "admin");
	api.unauthorizedPendingQueue();
	await page.goto("/admin/approvals");
	await expect(page.getByRole("alert")).toHaveText(
		"审批列表不可用，请联系管理员。",
	);
	await expect(page.getByRole("button", { name: "重新加载审批" })).toHaveCount(
		0,
	);
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

test("retryable management reads recover through explicit browser actions", async ({
	page,
}) => {
	const api = await fixture(page);
	api.unavailableAgentList();
	await page.goto("/agents");
	await expect(page.getByRole("alert")).toContainText(
		"Agent 列表暂时无法读取，请稍后重试。",
	);
	const agentRetry = page.getByRole("button", { name: "重新加载 Agent" });
	api.recoverAgentList();
	await agentRetry.click();
	await expect(
		page.getByRole("heading", { name: "Release assistant" }),
	).toBeVisible();

	api.unavailableApplications();
	await page.goto("/my-agents");
	await expect(page.getByRole("alert")).toContainText(
		"暂时无法读取申请，请稍后重试。",
	);
	api.recoverApplications();
	await page.getByRole("button", { name: "重新加载申请" }).click();
	await expect(page.getByRole("link", { name: "申请详情" })).toBeVisible();
	api.unavailableAgentList();
	await page.reload();
	await page.getByRole("tab", { name: "已创建 Agent" }).click();
	await expect(page.getByRole("alert")).toContainText(
		"暂时无法读取你管理的 Agent，请稍后重试。",
	);
	api.recoverAgentList();
	await page.getByRole("button", { name: "重新加载已创建 Agent" }).click();
	await expect(
		page.getByRole("list", { name: "我管理的 Agent" }),
	).toContainText("Release assistant");

	api.unavailableAgentDetail();
	await page.goto("/agents/agent-pilot-1");
	await expect(page.getByRole("alert")).toContainText(
		"暂时无法读取 Agent 信息，请稍后重试。",
	);
	api.recoverAgentDetail();
	await page.getByRole("button", { name: "重新加载 Agent" }).click();
	await expect(
		page.getByRole("heading", { name: "Release assistant" }),
	).toBeVisible();
});

test("authorization failures do not offer retry actions for Agent reads", async ({
	page,
}) => {
	const api = await fixture(page);
	api.unauthorizedAgentList();
	await page.goto("/agents");
	await expect(page.getByRole("alert")).toHaveText(
		"Agent 列表暂时无法访问，请联系管理员。",
	);
	await expect(
		page.getByRole("button", { name: "重新加载 Agent" }),
	).toHaveCount(0);

	api.unauthorizedAgentDetail();
	await page.goto("/agents/agent-pilot-1");
	await expect(page.getByRole("alert")).toHaveText("此 Agent 暂时无法访问。");
	await expect(
		page.getByRole("button", { name: "重新加载 Agent" }),
	).toHaveCount(0);

	await page.goto("/agents/agent-pilot-1/configuration");
	await expect(
		page.getByRole("heading", { name: "配置暂不可用" }),
	).toBeVisible();
	await expect(page.getByRole("alert")).toHaveText("请联系管理员。");
	await expect(page.getByRole("button", { name: "重新加载配置" })).toHaveCount(
		0,
	);

	api.unauthorizedApplicationDetail();
	await page.goto("/my-agents/application-browser-1/edit");
	await expect(
		page.getByRole("heading", { name: "申请暂不可用" }),
	).toBeVisible();
	await expect(page.getByRole("alert")).toHaveText("请联系管理员。");
	await expect(page.getByRole("button", { name: "重新加载申请" })).toHaveCount(
		0,
	);

	api.unauthorizedApplications();
	await page.goto("/my-agents");
	await expect(page.getByRole("alert")).toHaveText(
		"当前无法查看申请，请联系管理员。",
	);
	await expect(page.getByRole("button", { name: "重新加载申请" })).toHaveCount(
		0,
	);
});

test("configuration reads recover through the explicit browser action", async ({
	page,
}) => {
	const api = await fixture(page);
	api.unavailableAgentDetail();
	await page.goto("/agents/agent-pilot-1/configuration");
	await expect(
		page.getByRole("heading", { name: "配置暂不可用" }),
	).toBeVisible();
	await expect(page.getByRole("alert")).toHaveText("请稍后重试。");
	api.recoverAgentDetail();
	await page.getByRole("button", { name: "重新加载配置" }).click();
	await expect(
		page.getByRole("heading", { name: "配置与生命周期" }),
	).toBeVisible();
});

test("application detail reads recover through the explicit browser action", async ({
	page,
}) => {
	const api = await fixture(page);
	api.unavailableApplicationDetail();
	await page.goto("/my-agents/application-browser-1");
	await expect(
		page.getByRole("heading", { name: "申请详情暂不可用" }),
	).toBeVisible();
	await expect(page.getByRole("alert")).toContainText(
		"暂时无法读取申请，请稍后重试。",
	);
	api.recoverApplicationDetail();
	await page.getByRole("button", { name: "重新加载申请" }).click();
	await expect(page.getByRole("heading", { name: "申请详情" })).toBeVisible();
});

test("editable application reads recover through the explicit browser action", async ({
	page,
}) => {
	const api = await fixture(page);
	api.unavailableApplicationDetail();
	await page.goto("/my-agents/application-browser-1/edit");
	await expect(
		page.getByRole("heading", { name: "申请暂不可用" }),
	).toBeVisible();
	await expect(page.getByRole("alert")).toContainText("请稍后重试。");
	api.recoverApplicationDetail();
	await page.getByRole("button", { name: "重新加载申请" }).click();
	await expect(page.getByRole("heading", { name: "修改申请" })).toBeVisible();
});

test("deployment option reads recover before submitting an application", async ({
	page,
}) => {
	const api = await fixture(page);
	api.unavailableDeployment();
	await page.goto("/my-agents/new");
	await expect(
		page.getByText("部署选项需要刷新后才能提交标准模板申请。", {
			exact: true,
		}),
	).toBeVisible();
	api.recoverDeployment();
	await page.getByRole("button", { name: "重新加载部署选项" }).click();
	await expect(page.locator("#application-deployment-status")).toHaveCount(0);
	await expect(
		page.getByRole("combobox", { name: "标准模板 ID" }),
	).toBeVisible();
});

test("deployment option authorization failures do not offer a retry action", async ({
	page,
}) => {
	const api = await fixture(page);
	api.unauthorizedDeployment();
	await page.goto("/my-agents/new");
	await expect(
		page.locator('div[role="status"]').filter({
			hasText: "部署选项暂不可用，请联系管理员。",
		}),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "重新加载部署选项" }),
	).toHaveCount(0);

	await page.goto("/my-agents/application-browser-1/edit");
	await expect(
		page.locator('div[role="status"]').filter({
			hasText: "部署选项暂不可用，请联系管理员。",
		}),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "重新加载部署选项" }),
	).toHaveCount(0);
});

test("owned Agent authorization failures do not offer a retry action", async ({
	page,
}) => {
	const api = await fixture(page);
	api.unauthorizedOwnedAgentList();
	await page.goto("/my-agents");
	await page.getByRole("tab", { name: "已创建 Agent" }).click();
	await expect(page.getByRole("alert")).toContainText(
		"当前无法查看你管理的 Agent，请联系管理员。",
	);
	await expect(
		page.getByRole("button", { name: "重新加载已创建 Agent" }),
	).toHaveCount(0);
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

test("Agent catalog follows original IA card columns and keeps keyboard detail navigation", async ({
	page,
}, info) => {
	const api = await fixture(page, "employee");
	api.threeAgents();
	await page.goto("/agents");
	const cards = page.locator(".agent-list > li");
	await expect(cards).toHaveCount(3);
	await capture(page, info, "agent-catalog");
	for (const width of [390, 820, 821, 1440]) {
		await page.setViewportSize({ width, height: 1000 });
		const boxes = await cards.evaluateAll((elements) =>
			elements.map((element) => {
				const box = element.getBoundingClientRect();
				return { left: box.left, top: box.top, width: box.width };
			}),
		);
		if (width <= 820) {
			expect(boxes[0]?.left).toBe(boxes[1]?.left);
			expect(boxes[1]?.top).toBeGreaterThan(boxes[0]?.top ?? 0);
		} else {
			expect(boxes[0]?.top).toBe(boxes[1]?.top);
			expect(boxes[1]?.top).toBe(boxes[2]?.top);
			expect(boxes[1]?.left).toBeGreaterThan(boxes[0]?.left ?? 0);
		}
		await capture(page, info, `agent-catalog-${width}px`);
	}
	const search = page.getByRole("searchbox", { name: "搜索 Agent" });
	await search.fill("Visible Agent 2");
	await expect(cards).toHaveCount(1);
	await search.press("Tab");
	const detail = page.getByRole("link", { name: "查看 Visible Agent 2 详情" });
	await expect(detail).toBeFocused();
	await detail.press("Enter");
	await expect(page).toHaveURL(/\/agents\/agent-visible-2$/);
	api.longAgentFields();
	await page.goto("/agents");
	await expect(cards).toHaveCount(3);
	for (const width of [1440, 390, 160]) {
		await page.setViewportSize({ width, height: 844 });
		await capture(page, info, `agent-catalog-long-${width}px`);
	}
});

test("Agent directory guidance preserves independent Connection and application navigation", async ({
	page,
}, info) => {
	await fixture(page, "employee");
	await page.goto("/agents");
	const guidance = page.locator(".directory-guidance");
	await expect(
		guidance.getByRole("heading", { name: "确认你的 Connection 授权" }),
	).toBeVisible();
	await expect(guidance).not.toContainText("Provider/Action");
	const connection = guidance.getByRole("link", {
		name: "查看我的 Connection",
	});
	if (await connection.count()) {
		const connectionHref = await connection.getAttribute("href");
		await expect(connection).toHaveAttribute("target", "_blank");
		await expect(connection).toHaveAttribute("rel", "noreferrer");
		if (info.project.name === "mobile")
			await page.getByRole("button", { name: "打开导航" }).click();
		const navigation =
			info.project.name === "mobile"
				? page.getByRole("dialog", { name: "主导航" })
				: page.locator(".platform-sidebar");
		const sharedConnection = navigation.getByRole("link", {
			name: "我的 Connection",
		});
		expect(connectionHref).toBe(await sharedConnection.getAttribute("href"));
		if (info.project.name === "mobile")
			await navigation.getByRole("button", { name: "关闭导航" }).click();
	} else {
		await expect(guidance).toContainText("请联系管理员");
	}
	for (const width of [160, 390, 820, 821, 1440]) {
		await page.setViewportSize({ width, height: 844 });
		const boxes = await guidance.locator("article").evaluateAll((elements) =>
			elements.map((element) => {
				const box = element.getBoundingClientRect();
				return { left: box.left, top: box.top };
			}),
		);
		expect(boxes).toHaveLength(2);
		if (width <= 820) {
			expect(boxes[0]?.left).toBe(boxes[1]?.left);
			expect(boxes[1]?.top).toBeGreaterThan(boxes[0]?.top ?? 0);
		} else {
			expect(boxes[0]?.top).toBe(boxes[1]?.top);
			expect(boxes[1]?.left).toBeGreaterThan(boxes[0]?.left ?? 0);
		}
		const actions = await guidance.getByRole("link").evaluateAll((elements) =>
			elements.map((element) => {
				const style = getComputedStyle(element);
				return {
					height: element.getBoundingClientRect().height,
					borderWidth: Number.parseFloat(style.borderTopWidth),
					borderColor: style.borderTopColor,
				};
			}),
		);
		for (const action of actions) {
			expect(action.height).toBeGreaterThanOrEqual(44);
			expect(action.borderWidth).toBeGreaterThan(0);
			expect(action.borderColor).not.toBe("rgba(0, 0, 0, 0)");
		}
		await capture(page, info, `agent-guidance-${width}px`);
	}
	await guidance.getByRole("link", { name: "查看我的申请" }).focus();
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(/\/my-agents\/?$/);
	await page.reload();
	await expect(page.getByRole("heading", { name: "我的 Agent" })).toBeVisible();
});

test("directory detail binds the selected Agent and hides a previously visible resource on opaque denial", async ({
	page,
}, info) => {
	const api = await fixture(page, "employee");
	api.threeAgents();
	await page.goto("/agents");
	await page.getByRole("link", { name: "查看 Visible Agent 2 详情" }).click();
	await expect(
		page.getByRole("heading", { name: "Visible Agent 2", exact: true }),
	).toBeVisible();
	await page.reload();
	await expect(
		page.getByRole("heading", { name: "Visible Agent 2", exact: true }),
	).toBeVisible();
	api.misbindAgentDetail();
	await page.reload();
	await expect(
		page.getByRole("heading", { name: "暂时无法访问 Agent" }),
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Visible Agent 2", exact: true }),
	).toHaveCount(0);
	await expect(page.getByText("Unrelated Agent", { exact: true })).toHaveCount(
		0,
	);
	await capture(page, info, "directory-detail-mismatched-response");
	api.recoverDetailBinding();
	await page.reload();
	await expect(
		page.getByRole("heading", { name: "Visible Agent 2", exact: true }),
	).toBeVisible();
	await page.goto("/agents/agent-outside-authorized-collection");
	await expect(
		page.getByRole("heading", { name: "暂时无法访问 Agent" }),
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Visible Agent 2", exact: true }),
	).toHaveCount(0);
	await capture(page, info, "directory-detail-opaque-denial");
	await page.getByRole("link", { name: "返回 Agent 列表" }).click();
	await expect(page.locator(".agent-list > li")).toHaveCount(3);
	expect(api.commands).toHaveLength(0);
});

test("directory rejects a malformed successful collection and reloads after recovery", async ({
	page,
}, info) => {
	const api = await fixture(page, "employee");
	await page.goto("/agents");
	await expect(
		page.getByRole("link", { name: "查看 Release assistant 详情" }),
	).toBeVisible();
	api.malformAgentList();
	await page.reload();
	await expect(
		page.getByText("Agent 列表暂时无法访问，请联系管理员。"),
	).toBeVisible();
	await expect(
		page.getByRole("link", { name: "查看 Release assistant 详情" }),
	).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "重新加载 Agent" }),
	).toHaveCount(0);
	await capture(page, info, "directory-malformed-success-denial");
	api.recoverListSchema();
	await page.reload();
	await expect(
		page.getByRole("link", { name: "查看 Release assistant 详情" }),
	).toBeVisible();
	expect(api.commands).toHaveLength(0);
});

test("directory search and keyboard detail activation remain unobscured in short viewports", async ({
	page,
}, info) => {
	const api = await fixture(page, "employee");
	api.threeAgents();
	for (const width of [160, 390]) {
		await page.setViewportSize({ width, height: 370 });
		await page.goto("/agents");
		const search = page.getByRole("searchbox", { name: "搜索 Agent" });
		await search.click();
		await expect(search).toBeFocused();
		await search.fill("Visible Agent 2");
		await expect(page.locator(".agent-list > li")).toHaveCount(1);
		for (const control of [
			search,
			page.getByRole("link", { name: "查看 Visible Agent 2 详情" }),
		]) {
			if (control !== search) {
				await search.press("Tab");
				await expect(control).toBeFocused();
			}
			const hitTargets = await control.evaluate((element) => {
				const box = element.getBoundingClientRect();
				return [
					[box.left + box.width / 2, box.top + 3],
					[box.left + box.width / 2, box.bottom - 3],
					[box.left + 3, box.top + box.height / 2],
					[box.right - 3, box.top + box.height / 2],
					[box.left + box.width / 2, box.top + box.height / 2],
				].map(([x, y]) => {
					const hit = document.elementFromPoint(x ?? 0, y ?? 0);
					return {
						x,
						y,
						hit: hit?.tagName,
						hitClass: hit?.getAttribute("class"),
						unobscured: hit !== null && element.contains(hit),
					};
				});
			});
			await info.attach(`short-viewport-hits-${width}px`, {
				body: JSON.stringify(hitTargets),
				contentType: "application/json",
			});
			expect(
				hitTargets.every((point) => point.unobscured),
				JSON.stringify(hitTargets),
			).toBe(true);
		}
		await capture(page, info, `directory-short-${width}px`);
		await page.keyboard.press("Enter");
		await expect(page).toHaveURL(/\/agents\/agent-visible-2$/);
		await expect(
			page.getByRole("heading", { name: "Visible Agent 2", exact: true }),
		).toBeVisible();
	}
	expect(api.commands).toHaveLength(0);
});

for (const identityResponsibility of [
	"self-managed",
	"platform-managed",
] as const) {
	test(`self-managed detail omits Platform models across refresh with ${identityResponsibility} identity`, async ({
		page,
	}, info) => {
		const api = await fixture(page, "employee");
		api.conversationChoices(identityResponsibility);
		const detailResponse = page.waitForResponse(
			(response) =>
				new URL(response.url()).pathname ===
					"/api/v2/agents/agent-self-managed" &&
				response.request().method() === "GET",
		);
		await page.goto("/agents/agent-self-managed");
		const projected = AgentProjectionV2Schema.parse(
			await (await detailResponse).json(),
		);
		expect(projected.configuration.modelOptions.length).toBeGreaterThan(0);
		expect(projected.configuration.defaultModelOptionId).toBeTruthy();
		expect(projected.configuration.defaultReasoningLevel).toBeTruthy();
		const main = page.locator("main");
		for (const phase of ["deep-link", "refresh"]) {
			if (phase === "refresh") await page.reload();
			await expect(
				main.getByRole("heading", { name: "Self managed", exact: true }),
			).toBeVisible();
			await expect(main.getByText("模型范围", { exact: true })).toHaveCount(0);
			await expect(main.getByText("默认选项", { exact: true })).toHaveCount(0);
			for (const option of projected.configuration.modelOptions) {
				await expect(
					main.getByText(option.displayName, { exact: false }),
				).toHaveCount(0);
				for (const level of option.reasoningLevels)
					await expect(main.getByText(level, { exact: false })).toHaveCount(0);
			}
			await expect(
				main.getByRole("term").filter({ hasText: /^Owner$/ }),
			).toBeVisible();
			await expect(main.getByText("可用范围", { exact: true })).toBeVisible();
			await expect(main.getByRole("link", { name: "开始对话" })).toHaveCount(0);
			await expect(main.getByRole("button", { name: "开始对话" })).toHaveCount(
				0,
			);
			await expect(main.getByRole("link", { name: "个人历史" })).toHaveCount(0);
			if (identityResponsibility === "self-managed") {
				await expect(
					main.getByRole("link", { name: "打开 Agent" }),
				).toHaveAttribute("href", "https://agent.example.test/");
			} else {
				await expect(
					main.getByRole("link", { name: "打开 Agent" }),
				).toHaveCount(0);
			}
			await capture(
				page,
				info,
				`self-managed-models-${identityResponsibility}-${phase}`,
			);
		}
		await main.getByRole("link", { name: "返回 Agent 列表" }).focus();
		await page.keyboard.press("Enter");
		await expect(page).toHaveURL(/\/agents\/?$/);
		for (const [agentId, name] of [
			["agent-pilot-1", "Release assistant"],
			["agent-platform-adapter", "Platform adapter"],
		]) {
			await page.goto(`/agents/${agentId}`);
			await expect(
				main.getByRole("heading", { name, exact: true }),
			).toBeVisible();
			await expect(main.getByText("模型范围", { exact: true })).toBeVisible();
			await expect(main.getByText("默认选项", { exact: true })).toBeVisible();
			await expect(main.getByText(/Primary model.*medium、high/)).toBeVisible();
		}
		expect(api.commands).toHaveLength(0);
	});
}

test("directory conversation mode restores URL search and chooses only existing eligible routes", async ({
	page,
}, info) => {
	const api = await fixture(page, "employee");
	api.conversationChoices();
	await page.goto("/my-agents");
	await page.goto("/agents?mode=conversation");
	const search = page.getByRole("searchbox", { name: "搜索 Agent" });
	await expect(
		page.getByRole("heading", { name: "选择 Agent 开始对话" }),
	).toBeVisible();
	const historyLength = await page.evaluate(() => window.history.length);
	await search.pressSequentially("Release");
	await expect(search).toHaveValue("Release");
	await expect
		.poll(() => new URL(page.url()).searchParams.get("q"))
		.toBe("Release");
	expect(new URL(page.url()).searchParams.get("mode")).toBe("conversation");
	expect(await page.evaluate(() => window.history.length)).toBe(historyLength);
	await page.reload();
	await expect(search).toHaveValue("Release");
	await expect(
		page.getByRole("heading", { name: "选择 Agent 开始对话" }),
	).toBeVisible();
	await page
		.locator(".agent-list > li")
		.filter({
			has: page.getByRole("heading", {
				name: "Release assistant",
				exact: true,
			}),
		})
		.getByRole("link", { name: "开始对话" })
		.click();
	await expect(page).toHaveURL(/\/chat\/agent-pilot-1$/);
	await page.goBack();
	await expect(search).toHaveValue("Release");
	expect(new URL(page.url()).searchParams.get("mode")).toBe("conversation");
	await search.fill("");
	await expect(page.locator(".agent-list > li")).toHaveCount(4);
	const adapter = page.locator(".agent-list > li").filter({
		has: page.getByRole("heading", { name: "Platform adapter", exact: true }),
	});
	await adapter.getByRole("link", { name: "开始对话" }).click();
	await expect(page).toHaveURL(/\/chat\/agent-platform-adapter$/);
	await page.goBack();
	await expect(search).toHaveValue("");
	for (const [name, id] of [
		["Self managed", "agent-self-managed"],
		["Starting Agent", "agent-starting"],
	]) {
		const card = page.locator(".agent-list > li").filter({
			has: page.getByRole("heading", { name, exact: true }),
		});
		await expect(card.getByRole("link", { name: "开始对话" })).toHaveCount(0);
		await card.getByRole("link", { name: `查看 ${name} 详情` }).click();
		expect(new URL(page.url()).pathname).toBe(`/agents/${id}`);
		await expect(page.getByRole("link", { name: "开始对话" })).toHaveCount(0);
		if (id === "agent-self-managed") {
			await expect(page.getByRole("link", { name: "个人历史" })).toHaveCount(0);
		} else {
			await expect(
				page.getByRole("button", { name: "开始对话" }),
			).toBeDisabled();
			await expect(
				page.getByRole("link", { name: "个人历史" }),
			).toHaveAttribute("href", "/chat/agent-starting?view=history");
		}
		await page.goBack();
		await expect(
			page.getByRole("heading", { name: "选择 Agent 开始对话" }),
		).toBeVisible();
	}
	await capture(page, info, "directory-conversation-mode");
	await page.goBack();
	await expect(page).toHaveURL(/\/my-agents\/?$/);
	expect(api.commands).toHaveLength(0);
});
