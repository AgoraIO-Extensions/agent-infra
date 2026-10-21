import {
	AgentApplicationProjectionV2Schema,
	AgentDetailProjectionV1Schema,
	AgentProjectionV2Schema,
	ConnectionCapabilityProjectionV1Schema,
	ConversationPageV1Schema,
} from "@agent-infra/contracts/pilot";
import {
	createPilotAgentMockServerV2,
	pilotAgentDetailFromV2,
	pilotFakeScenariosV2,
} from "@agent-infra/test-support/pilot";
import { expect, type Page, type TestInfo, test } from "@playwright/test";
import { directorySearchResponse } from "../src/features/directory-test-fixtures";
import { pendingApplication } from "../src/features/my-agents/test-fixtures";
import type {
	AgentLifecycleCommandRequestV1,
	ApprovalDecisionRequestV1,
} from "../src/pilot/generated/types.gen";
import type {
	AgentApplicationCreateRequestV2Writable,
	DeploymentConfigurationProjectionV2,
} from "../src/pilot/generated-v2/types.gen";
import { captureDesignContract, designViewports } from "./design-contract";
import { recordApiRequests } from "./generated-client-paths";
import { duplicateControlNames } from "./page-hygiene";
import {
	computed,
	expectCardTable,
	expectCleanPage,
	expectDesktopTable,
	expectFieldControl,
	expectFieldFocus,
	expectFieldLabel,
	expectFormSection,
	expectNativeSelectArrow,
	expectNoLegendOnBorder,
	expectPageHeadTop,
	expectSearchInput,
	resolved,
	trackPageErrors,
} from "./primitive-styles";

// 根布局常驻一个 role="status" 的 Toast 宿主（B-13），页面自身的结果状态只在主内容区内查找。
function pageStatus(page: Page) {
	return page.locator("#main-content").getByRole("status");
}

function toastHost(page: Page) {
	return page.locator('[data-slot="toast"]');
}

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
			// Agent 现有环境变量 WORKSPACE_NAME 必须是模板开放的键，否则服务端不接受整表保存（O-10）。
			allowedEnvironmentKeys: ["LOG_LEVEL", "WORKSPACE_NAME"],
			allowedSecretKeys: ["MODEL_API_KEY"],
			connectionEnabled: false,
			displayName: "Codex",
			templateId: "codex",
		},
	],
};

async function fixture(
	page: Page,
	role: "owner" | "admin" | "employee" | "owner-admin" = "owner",
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
	// 生命周期受理响应只带受理元数据（不带 status），以及延后回读：用于 NW-16。
	let lifecycleAcceptedOnly = false;
	let deferLifecycleReadback = false;
	let pendingLifecycleReadback: (() => void) | undefined;
	let failNextConfigurationUpdate = false;
	const isOwnerSession = role === "owner" || role === "owner-admin";
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
			userId: isOwnerSession ? "user-owner-1" : `user-${role}`,
			displayName: role,
			roles:
				role === "admin" || role === "owner-admin"
					? ["employee", "system_admin"]
					: ["employee"],
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
						ownerScope && !isOwnerSession ? [] : [agent, ...additionalAgents],
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
		commandAgentLifecycle: () => ({
			status: 202,
			body: lifecycleAcceptedOnly
				? {
						schemaVersion: 1,
						accepted: true,
						agentId: agent.agentId,
						replayed: false,
					}
				: agent,
		}),
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
		if (
			request.method() === "GET" &&
			pathname === "/api/v1/connection/capability"
		)
			return route.fulfill({
				json: ConnectionCapabilityProjectionV1Schema.parse({
					schemaVersion: 1,
					status: "unavailable",
					reason: "missing",
				}),
			});
		if (
			request.method() === "GET" &&
			pathname === "/api/v2/me/conversations/recent"
		) {
			await route.fulfill({
				json: ConversationPageV1Schema.parse({ items: [], nextCursor: null }),
			});
			return;
		}
		if (request.method() === "GET" && pathname === "/api/v2/directory/search") {
			const url = new URL(request.url());
			const items = [
				{
					kind: "user",
					canonicalId: "user-owner-1",
					displayName: "当前 Owner",
					email: "owner@example.test",
				},
				{
					kind: "organization",
					canonicalId: "org-platform",
					displayName: "平台工程",
					organizationPath: "研发 / 平台工程",
				},
				{
					kind: "user",
					canonicalId: "user-2",
					displayName: "验收用户二",
					email: "user.two@example.test",
					organizationPath: "平台工程",
				},
				{
					kind: "user",
					canonicalId: "user-3",
					displayName: "验收用户三",
					email: "user.three@example.test",
					organizationPath: "研发基础设施",
				},
			];
			await route.fulfill({
				json: directorySearchResponse(
					url,
					items.filter(
						(item) =>
							item.kind === url.searchParams.get("kind") &&
							(!url.searchParams.has("ids") ||
								url.searchParams
									.get("ids")
									?.split(",")
									.includes(item.canonicalId)) &&
							JSON.stringify(item)
								.toLowerCase()
								.includes((url.searchParams.get("q") ?? "").toLowerCase()),
					),
				),
			});
			return;
		}
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
			/^\/api\/v2\/agents\/[^/]+(?:\/detail)?$/.test(pathname) &&
			agentDetailMismatched
		) {
			const unrelated = {
				...agent,
				agentId: "agent-unrelated",
				name: "Unrelated Agent",
			};
			// 详情页读取带 Owner 状态的详情投影（#2910）；不一致的主体仍按响应无效处理。
			await route.fulfill({
				json: pathname.endsWith("/detail")
					? pilotAgentDetailFromV2(unrelated)
					: unrelated,
			});
			return;
		}
		if (pathname.endsWith("/wecom-bot")) {
			await route.fulfill({ json: { status: "not_configured" } });
			return;
		}
		if (pathname.endsWith("/wecom-app")) {
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
				const applyReadback = () => {
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
				};
				// 延后回读只对下一条命令生效。
				if (deferLifecycleReadback) pendingLifecycleReadback = applyReadback;
				else applyReadback();
				deferLifecycleReadback = false;
			} else if (
				pathname.endsWith("/configuration") &&
				failNextConfigurationUpdate
			) {
				failNextConfigurationUpdate = false;
				await route.fulfill({
					status: 503,
					json: retryableReadFailure,
				});
				return;
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
		longApplicationTemplateId(templateId: string, displayName: string) {
			application = AgentApplicationProjectionV2Schema.parse({
				...application,
				source: { kind: "standard", templateId },
			});
			// 页面只显示部署配置登记的模板显示名（F-02），长显示名同样要在面板内换行。
			deployment = {
				...deployment,
				templates: [
					...deployment.templates,
					{ ...deploymentConfiguration.templates[0], templateId, displayName },
				],
			};
		},
		/** 待审批申请带一个可选模型，用于核对审阅弹窗的「模型」行（F-02）。 */
		applicationModelOptions() {
			application = AgentApplicationProjectionV2Schema.parse({
				...application,
				configuration: {
					...application.configuration,
					modelOptions: [
						{
							optionId: "model-primary",
							modelId: "gpt-5",
							displayName: "Primary model",
							reasoningLevels: ["medium", "high"],
						},
					],
					defaultModelOptionId: "model-primary",
					defaultReasoningLevel: "medium",
				},
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
		agentState(
			managementStatus: (typeof agent)["managementStatus"],
			serviceAvailability: (typeof agent)["serviceAvailability"] = null,
		) {
			agent = { ...agent, managementStatus, serviceAvailability };
		},
		acceptLifecycleWithoutStatus() {
			lifecycleAcceptedOnly = true;
		},
		deferNextLifecycleReadback() {
			deferLifecycleReadback = true;
		},
		applyLifecycleReadback() {
			pendingLifecycleReadback?.();
			pendingLifecycleReadback = undefined;
		},
		failNextConfigurationUpdate() {
			failNextConfigurationUpdate = true;
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
					// The export keeps wide tables in a local horizontal scroller.
					const tableScroller = element.closest(
						'[data-slot="table-container"]',
					);
					if (tableScroller) {
						const scroller = tableScroller.getBoundingClientRect();
						return (
							scroller.left < 0 ||
							scroller.right > innerWidth + 1 ||
							getComputedStyle(tableScroller).overflowX !== "auto"
						);
					}
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

test("creation footer cancel supports deep links, refresh, click, keyboard and back", async ({
	page,
}, info) => {
	const api = await fixture(page);
	await page.goto("/my-agents/new");
	// N-03：页头没有退出操作；全页唯一的取消入口是 footer 左侧的 ghost「取消」。
	const footerCancel = page
		.locator("main form .form-footer")
		.getByRole("link", { name: "取消", exact: true });
	await expect(footerCancel).toBeVisible();
	await expect(footerCancel).toHaveAttribute("href", "/my-agents");
	await expect(page.getByRole("link", { name: "取消" })).toHaveCount(1);
	await expect(page.getByText("退出创建", { exact: true })).toHaveCount(0);
	await expect(
		page.locator("main header.page-heading").locator("a, button"),
	).toHaveCount(0);
	await expect(footerCancel).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
	await expect(footerCancel).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
	const bounds = await footerCancel.boundingBox();
	expect(bounds?.height).toBeGreaterThanOrEqual(44);
	await capture(page, info, "create-footer-cancel");
	await footerCancel.click();
	await expect(page).toHaveURL(/\/my-agents$/);
	await expect(
		page.getByRole("heading", { name: "查看申请，管理名下 Agent。" }),
	).toBeVisible();
	expect(api.commands).toHaveLength(0);

	await page.goBack();
	await expect(page).toHaveURL(/\/my-agents\/new$/);
	await expect(footerCancel).toBeVisible();
	await page.reload();
	await expect(footerCancel).toBeVisible();
	await expect(footerCancel).toHaveAttribute("href", "/my-agents");
	// 键盘：取消之前是收起的高级配置开关；Shift+Tab 到它，再 Tab 回到取消，Enter 离开。
	await footerCancel.focus();
	await page.keyboard.press("Shift+Tab");
	await expect(
		page.getByRole("button", { name: "展开高级配置" }),
	).toBeFocused();
	await page.keyboard.press("Tab");
	await expect(footerCancel).toBeFocused();
	expect(
		await footerCancel.evaluate(
			(element) => getComputedStyle(element).outlineStyle,
		),
	).not.toBe("none");
	await capture(page, info, "create-footer-cancel-refreshed-focus");
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(/\/my-agents$/);
	await expect(
		page.getByRole("heading", { name: "查看申请，管理名下 Agent。" }),
	).toBeVisible();
	expect(api.commands).toHaveLength(0);
});

test("create, edit, resubmit and withdraw with native form and pending semantics", async ({
	page,
}, info) => {
	const api = await fixture(page);
	await page.goto("/my-agents/new");
	const create = page.getByRole("button", {
		name: "提交审批",
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
			.evaluate((element) => getComputedStyle(element).outlineStyle),
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
	await expect(page.getByRole("link", { name: "取消" })).toHaveCount(0);
	const disabledExits = page.getByText("取消", { exact: true });
	await expect(disabledExits).toHaveCount(1);
	for (const exit of await disabledExits.all()) {
		await expect(exit).toHaveAttribute("aria-disabled", "true");
		expect(await exit.evaluate((element) => element.tabIndex)).toBe(-1);
		await exit.click({ force: true });
		await exit.evaluate((element) => element.focus());
		await expect(exit).not.toBeFocused();
		await page.keyboard.press("Enter");
		await expect(page).toHaveURL(/\/my-agents\/new$/);
	}
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
	await expect(pageStatus(page)).toBeFocused();
	// W-08：设计 .notice p 为常规字重，提交结果不再加粗。
	await expect(pageStatus(page)).toHaveCSS("font-weight", "400");
	await expect(
		page.getByRole("link", { name: "查看申请详情", exact: true }),
	).toHaveAttribute("href", "/my-agents/application-browser-1");
	await expect(page.getByText("退出创建", { exact: true })).toHaveCount(0);
	await expect(
		page.locator("main header.page-heading").locator("a, button"),
	).toHaveCount(0);
	await capture(page, info, "create-result-return");
	await page.getByRole("link", { name: "返回我的 Agent", exact: true }).click();
	await expect(page).toHaveURL(/\/my-agents$/);
	await page.getByRole("link", { name: /^查看申请：/ }).click();
	await page.getByRole("link", { name: "修改申请" }).click();
	await expect(page.getByText("退出创建", { exact: true })).toHaveCount(0);
	await expect(
		page.getByRole("link", { name: "取消", exact: true }),
	).toHaveAttribute("href", "/my-agents/application-browser-1");
	await page.getByRole("link", { name: "取消", exact: true }).click();
	await expect(page).toHaveURL(/\/my-agents\/application-browser-1$/);
	await page.getByRole("link", { name: "修改申请" }).click();
	await expect(page.getByLabel("Agent 来源")).toBeDisabled();
	await page
		.getByLabel("用途说明", { exact: true })
		.fill("Updated release workflow");
	await page.getByRole("button", { name: "修改申请", exact: true }).click();
	await expect(pageStatus(page)).toContainText("申请已提交");
	api.rejectApplication();
	await page.goto("/my-agents/application-browser-1/edit");
	await expect(page.getByText("退出创建", { exact: true })).toHaveCount(0);
	await expect(
		page.getByRole("link", { name: "取消", exact: true }),
	).toHaveAttribute("href", "/my-agents/application-browser-1");
	await page.getByRole("link", { name: "取消", exact: true }).click();
	await expect(page).toHaveURL(/\/my-agents\/application-browser-1$/);
	await page.getByRole("link", { name: "修改并重新提交" }).click();
	await page
		.getByRole("button", { name: "修改并重新提交", exact: true })
		.click();
	await expect(pageStatus(page)).toContainText("待审批");
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
	// W-15：设计只用 Toast「申请已撤回」确认，不再内联结果；「撤回申请」消失后焦点落在页面 h1。
	await expect(toastHost(page)).toHaveText("申请已撤回");
	await expect(pageStatus(page)).toHaveCount(0);
	await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
	await expect(page.getByRole("button", { name: "撤回申请" })).toHaveCount(0);
});

test("directory search and transient submission recover on desktop and mobile", async ({
	page,
}, info) => {
	const api = await fixture(page);
	await page.goto("/my-agents/new");
	const name = page.getByLabel("Agent 名称");
	const ownerInput = page.getByRole("combobox", { name: "共同 Owner 用户" });
	const submit = page.getByRole("button", { name: "提交审批", exact: true });
	await name.fill("中文发布 Agent");
	await page.getByLabel("用途说明", { exact: true }).fill("用于中文发布验收");
	await page.getByRole("combobox", { name: "Agent 来源" }).click();
	await page
		.getByRole("option", { name: "自定义 Agent · 平台交互入口" })
		.click();
	await page.getByLabel("镜像地址").fill("registry.example/agents/release:v1");
	await ownerInput.fill("user");
	await page.getByRole("option", { name: "验收用户二" }).click();
	await expect(page.getByText("验收用户二", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "展开高级配置" }).click();
	await page.getByRole("button", { name: "添加 Secret" }).click();
	await page.getByLabel("Secret 名称").fill("TEST_SECRET");
	await page.getByLabel("替换值").fill("synthetic-first-value");
	api.rejectNextApplication();
	await submit.focus();
	await page.keyboard.press("Enter");
	await expect(page.getByRole("alert")).toContainText("申请提交失败");
	await expect(name).toHaveValue("中文发布 Agent");
	await expect(page.getByText("验收用户二", { exact: true })).toBeVisible();
	await expect(page.getByLabel("替换值")).toHaveCount(0);
	expect(api.commands).toHaveLength(1);
	await capture(page, info, "application-field-recovery");

	await expect(
		page.getByRole("button", { name: "收起高级配置" }),
	).toBeVisible();
	await page.getByRole("button", { name: "添加 Secret" }).click();
	await page.getByLabel("Secret 名称").fill("TEST_SECRET");
	await page.getByLabel("替换值").fill("synthetic-retry-value");
	await submit.focus();
	await page.keyboard.press("Enter");
	await expect(pageStatus(page)).toBeFocused();
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
	await page.getByRole("button", { name: "提交审批", exact: true }).click();
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
	await page.getByRole("combobox", { name: "标准模板" }).click();
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
	await page.getByRole("button", { name: "展开高级配置" }).click();
	await page.getByRole("button", { name: "添加 Secret" }).click();
	await page.getByLabel("Secret 名称").fill("TEST_SECRET");
	await page.getByLabel("替换值").fill("synthetic-rejected-value");
	api.rejectNextApplication("AUTHORIZATION_REVOKED");
	await page.getByRole("button", { name: "提交审批", exact: true }).click();
	await expect(page.getByRole("alert")).toContainText("当前不可用");
	await expect(page.getByLabel("Agent 名称")).toHaveValue("中文权限 Agent");
	await expect(page.getByLabel("替换值")).toHaveCount(0);
	expect(api.commands).toHaveLength(1);
	await capture(page, info, "application-authorization-rejected");
	const footerCancel = page
		.locator("main form .form-footer")
		.getByRole("link", { name: "取消", exact: true });
	await expect(footerCancel).toHaveAttribute("href", "/my-agents");
	await footerCancel.focus();
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(/\/my-agents$/);
	await expect(
		page.getByRole("heading", { name: "查看申请，管理名下 Agent。" }),
	).toBeVisible();
	expect(api.commands).toHaveLength(1);
});

test("administrator rejection, approval, empty queue and pending controls", async ({
	page,
}, info) => {
	const api = await fixture(page, "admin");
	await page.goto("/admin/approvals");
	const review = page.getByRole("button", { name: /^审阅：/ });
	await expect(review).toHaveText("审阅");
	// N-06（安全）：键盘打开后焦点在弹窗容器；直接按 Enter、Space 不会提交决定。
	await review.focus();
	await page.keyboard.press("Enter");
	const dialog = page.getByRole("dialog", { name: "审阅创建申请" });
	await expect(dialog).toBeFocused();
	await page.keyboard.press("Enter");
	await page.keyboard.press("Space");
	await page.waitForTimeout(500);
	expect(api.commands).toHaveLength(0);
	await expect(dialog).toBeVisible();
	await page.keyboard.press("Tab");
	await expect(dialog.getByRole("button", { name: "关闭" })).toBeFocused();
	// G-05：「驳回并说明」切到「填写驳回原因」，焦点回到弹窗容器。
	await dialog.getByRole("button", { name: "驳回并说明" }).click();
	const rejectDialog = page.getByRole("dialog", { name: "填写驳回原因" });
	await expect(rejectDialog).toBeFocused();
	const reject = page.getByRole("button", { name: "确认驳回" });
	await reject.click();
	await expect(page.getByLabel("驳回原因", { exact: true })).toBeFocused();
	expect(api.commands).toHaveLength(0);
	const error = rejectDialog.getByRole("alert");
	await expect(error).toHaveText("请填写驳回原因。");
	expect(
		await error.evaluate((element) => ({
			fontSize: getComputedStyle(element).fontSize,
			color: getComputedStyle(element).color,
			marginTop: getComputedStyle(element).marginTop,
		})),
	).toEqual({
		fontSize: "12px",
		color: await resolved(page, "color", "var(--danger-ink)"),
		marginTop: "6px",
	});
	await expect(page.getByLabel("驳回原因", { exact: true })).toHaveAttribute(
		"aria-invalid",
		"true",
	);
	await expect(page.getByText("请输入驳回原因。")).toHaveCount(0);
	// N-18：弹窗（Portal）内的 textarea 与页面字段一致，为 2px、offset 3px 的 outline，不叠加 ring。
	expect(
		await page.getByLabel("驳回原因", { exact: true }).evaluate((element) => ({
			style: getComputedStyle(element).outlineStyle,
			width: getComputedStyle(element).outlineWidth,
			offset: getComputedStyle(element).outlineOffset,
			shadow: getComputedStyle(element).boxShadow,
		})),
	).toEqual({ style: "solid", width: "2px", offset: "3px", shadow: "none" });
	// B-05：弹窗内 textarea 的焦点色与页面字段一致（26% 透明 accent 描边、accent 边框）。
	await expectFieldFocus(page, page.getByLabel("驳回原因", { exact: true }));
	await page
		.getByLabel("驳回原因", { exact: true })
		.fill("  Capacity is unavailable  ");
	// 设计 footer 顺序为 [ghost 取消][primary 确认驳回]。
	await page.keyboard.press("Tab");
	await expect(
		rejectDialog.getByRole("button", { name: "取消" }),
	).toBeFocused();
	await page.keyboard.press("Tab");
	await expect(reject).toBeFocused();
	await capture(page, info, "approvals");
	api.holdNextCommand();
	await page.keyboard.press("Enter");
	await expect(page.getByRole("button", { name: "提交中…" })).toBeDisabled();
	await expect(
		rejectDialog.getByRole("button", { name: "取消" }),
	).toBeDisabled();
	api.release();
	// NI-79 / NI-105：队列清空后焦点落到页面 h1，Toast 只播报不抢焦点；越过 Toast 时长后仍不落到 body。
	const heading = page.getByRole("heading", { level: 1 });
	await expect(heading).toBeFocused();
	await expect(page.getByText("暂无待审批申请。")).toBeVisible();
	const toast = page.locator('[data-slot="toast"]');
	await expect(toast).toHaveText("已驳回，申请人会看到修改原因");
	for (const wait of [1_200, 1_800]) {
		await page.waitForTimeout(wait);
		await expect(heading).toBeFocused();
	}
	await expect(toast).toHaveText("");
	await expect(toast.locator("[tabindex]")).toHaveCount(0);
	await expect(page.getByText(/已提交 .* 的审批结果/)).toHaveCount(0);
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
	await expect(pageStatus(page)).toBeVisible();
	await page.goto("/admin/approvals");
	await page.getByRole("button", { name: /^审阅：/ }).click();
	await page.getByRole("button", { name: "批准申请" }).click();
	await expect(toast).toHaveText("申请已批准，创建任务已进入后台");
	await expect(heading).toBeFocused();
	expect(api.commands.at(-1)?.body).toEqual({
		schemaVersion: 1,
		decision: "approve",
	});
});

test("approvals page head places the h1 at the design height while Owner configuration keeps its back-link spacing", async ({
	page,
}, info) => {
	await fixture(page, "admin");
	await page.goto("/admin/approvals");
	await expect(
		page.getByRole("heading", { level: 1, name: "审批申请" }),
	).toBeVisible();
	// 设计 .page-head-copy .eyebrow 上外边距为 0，h1 与设计同高（±1px）。
	await expectPageHeadTop(page, info.project.name === "mobile");
	await fixture(page, "owner");
	await page.goto("/agents/agent-pilot-1/configuration");
	const heading = page.locator("main .page-heading").first();
	await expect(heading.getByRole("heading", { level: 1 })).toBeVisible();
	// Owner 配置的 eyebrow 前面有返回链接，不属于「第一个子元素」，保留原有上外边距。
	await expect(heading.locator(".page-eyebrow")).toHaveCSS("margin-top", "9px");
});

test("approval review dialog follows the design facts, notice and footer", async ({
	page,
}) => {
	const errors = trackPageErrors(page);
	const api = await fixture(page, "admin");
	api.applicationModelOptions();
	const narrow = test.info().project.name === "mobile";
	await page.goto("/admin/approvals");
	const trigger = page.getByRole("button", { name: /^审阅：/ });
	// AC-2：审批页同页没有同名控件（审阅按钮带申请名）。
	expect(await duplicateControlNames(page)).toEqual([]);
	await trigger.click();
	const dialog = page.getByRole("dialog", { name: "审阅创建申请" });
	await expect(dialog).toBeVisible();
	// AP-03：facts 标签列 150px、gap 10px 18px、13px，dt muted；390 下单列。
	const facts = dialog.locator("dl");
	const style = await facts.evaluate((element) => {
		const css = getComputedStyle(element);
		const dt = element.querySelector("dt") as HTMLElement;
		return {
			columns: css.gridTemplateColumns.split(" "),
			gap: css.gap,
			fontSize: css.fontSize,
			dtColor: getComputedStyle(dt).color,
			terms: [...element.querySelectorAll("dt")].map(
				(node) => node.textContent,
			),
		};
	});
	if (narrow) expect(style.columns).toHaveLength(1);
	else {
		expect(style.columns[0]).toBe("150px");
		expect(style.gap).toBe("10px 18px");
	}
	expect(style.fontSize).toBe("13px");
	expect(style.dtColor).toBe(
		await resolved(page, "color", "var(--muted-foreground)"),
	);
	// V-01：设计审阅弹窗 facts 为「申请 / 申请人 / …」，申请人取申请投影。
	expect(style.terms.slice(0, 3)).toEqual(["申请", "申请人", "说明"]);
	await expect(
		dialog.locator("dt", { hasText: /^申请人$/ }).locator("+ dd"),
	).toHaveText("Applicant");
	expect(style.terms).toEqual(
		expect.arrayContaining(["预设规格", "预计资源占用"]),
	);
	// facts 之后是静态 warn notice「审批判断」（margin-top 18px、17px 图标为 --warning、无 role）。
	const notice = dialog.locator('[data-slot="alert"][data-tone="warn"]');
	await expect(notice).toContainText("审批判断");
	const noticeStyle = await notice.evaluate((element) => {
		const svg = element.querySelector("svg") as SVGElement;
		let role: string | null = null;
		for (
			let node: Element | null = element;
			node && node.getAttribute("role") !== "dialog";
			node = node.parentElement
		)
			role ??= node.getAttribute("role");
		return {
			marginTop: getComputedStyle(element).marginTop,
			icon: [svg.getBoundingClientRect().width, getComputedStyle(svg).color],
			role,
		};
	});
	expect(noticeStyle).toEqual({
		marginTop: "18px",
		icon: [17, await resolved(page, "color", "var(--warning)")],
		role: null,
	});
	// AP-03：footer 右对齐，依次为 outline「驳回并说明」、primary「批准申请」，右缘距弹窗内边 24px（窄屏 19px）。
	const footer = dialog.locator('[data-slot="dialog-footer"]');
	await expect(footer.getByRole("button")).toHaveText([
		"驳回并说明",
		"批准申请",
	]);
	expect(
		await footer.evaluate(
			(element) => getComputedStyle(element).justifyContent,
		),
	).toBe("flex-end");
	const dialogBox = await dialog.boundingBox();
	const approveBox = await footer
		.getByRole("button", { name: "批准申请" })
		.boundingBox();
	expect(
		Math.abs(
			(dialogBox?.x ?? 0) +
				(dialogBox?.width ?? 0) -
				((approveBox?.x ?? 0) + (approveBox?.width ?? 0)) -
				(narrow ? 20 : 25),
		),
	).toBeLessThanOrEqual(1);
	for (const name of ["取消", "批准并创建", "驳回"])
		await expect(dialog.getByRole("button", { name, exact: true })).toHaveCount(
			0,
		);
	// F-02：模型行按设计为「显示名 · 档位」，不显示 modelId；默认模型不出现 optionId 原值。
	await expect(dialog).not.toContainText("gpt-5");
	await expect(dialog).not.toContainText("model-primary");
	const modelRow = dialog.locator("dt", { hasText: /^模型$/ });
	await expect(modelRow.locator("xpath=following-sibling::dd[1]")).toHaveText(
		"Primary model · 均衡、高",
	);
	// 模板写部署配置的显示名，不显示原始 templateId。
	await expect(
		dialog
			.locator("dt", { hasText: /^模板$/ })
			.locator("xpath=following-sibling::dd[1]"),
	).toHaveText("Codex");
	await expect(dialog).not.toContainText("codex");
	// AC-2：弹窗内按钮逐一不同名；Esc 关闭后焦点回到「审阅」，不落到 body。
	const dialogButtons = await dialog
		.getByRole("button")
		.evaluateAll((buttons) =>
			buttons.map(
				(button) =>
					button.getAttribute("aria-label") ?? button.textContent?.trim() ?? "",
			),
		);
	expect(new Set(dialogButtons).size, dialogButtons.join(" / ")).toBe(
		dialogButtons.length,
	);
	await page.keyboard.press("Escape");
	await expect(dialog).toBeHidden();
	await expect(trigger).toBeFocused();
	expect(api.commands).toHaveLength(0);
	await expectCleanPage(page, errors);
});

test("application detail model range matches the review dialog without modelId", async ({
	page,
}) => {
	const api = await fixture(page, "owner");
	api.applicationModelOptions();
	await page.goto("/my-agents/application-browser-1");
	const facts = page.locator(".application-detail-aside .metadata-facts");
	await expect(facts).toBeVisible();
	// 与审批弹窗「模型」行一致：「显示名 · 档位」，不外露 modelId。
	await expect(
		facts
			.locator("dt", { hasText: /^模型范围$/ })
			.locator("xpath=following-sibling::dd[1]"),
	).toHaveText("Primary model · 均衡、高");
	await expect(page.locator("main")).not.toContainText("gpt-5");
});

test("approval table source column and filter use template display names (F-02)", async ({
	page,
}) => {
	const api = await fixture(page, "admin");
	await page.goto("/admin/approvals");
	const row = page
		.getByRole("row")
		.filter({ hasText: pendingApplication.name });
	await expect(row.locator('[data-label="来源 / Owner"]')).toContainText(
		"Codex",
	);
	await expect(page.locator("main table")).not.toContainText("codex");
	const options = await page
		.getByRole("combobox", { name: "来源", exact: true })
		.locator("option")
		.allTextContents();
	expect(options).toEqual(["全部来源", "Codex"]);
	expect(api.commands).toHaveLength(0);
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
	await expect(page.getByRole("button", { name: /^审阅：/ })).toBeVisible();
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

test("Owner configuration save, lifecycle and custom image upgrade", async ({
	page,
}, info) => {
	const api = await fixture(page);
	await page.goto("/agents/agent-pilot-1");
	await page.getByRole("link", { name: "Owner 配置" }).click();
	const replaceModels = page.getByRole("checkbox", {
		name: "替换模型配置",
	});
	await replaceModels.focus();
	await page.keyboard.press("Space");
	await expect(replaceModels).toBeChecked();
	// 默认 Key 不再有页内常驻输入框，替换在弹窗中进行（G-09）。
	await expect(
		page.locator('[data-od-id="owner-default-relay-key"] input'),
	).toHaveCount(0);
	await page.keyboard.press("Space");
	await expect(replaceModels).not.toBeChecked();
	// Secret 只读显示、经只写弹窗单独替换（O-10），整页保存只提交普通值。
	await expect(page.getByLabel("新 Secret 值")).toHaveCount(0);
	await page.getByLabel("值", { exact: true }).fill("synthetic-browser-value");
	await expect(page.getByText(/群消息和 Agent 回复对群成员可见/)).toBeVisible();
	// 企微卡片按设计标题命名区域（O-07）。
	await expect(
		page.getByRole("region", { name: "企微应用", exact: true }),
	).toBeVisible();
	await capture(page, info, "owner-configuration");
	api.holdNextCommand();
	await page.getByRole("button", { name: "保存配置" }).click();
	await expect(page.getByRole("button", { name: "保存中…" })).toBeDisabled();
	await expect(replaceModels).toBeDisabled();
	api.release();
	// RK2-09：保存成功后页面保留并给 Toast，不再用「配置已提交」替换表单。
	await expect(toastHost(page)).toHaveText("配置已保存，Secret 值不会回显");
	await expect(page.locator("#main-content")).not.toContainText("配置已提交");
	await expect(page.getByRole("button", { name: "保存配置" })).toBeVisible();
	expect(api.commands[0]?.body).toMatchObject({
		schemaVersion: 2,
		coOwnerIds: ["user-owner-1"],
		environment: [{ name: "WORKSPACE_NAME", value: "synthetic-browser-value" }],
	});
	expect(api.commands[0]?.body).not.toHaveProperty("secrets");
	await page.goto("/agents/agent-pilot-1/configuration");
	await capture(page, info, "lifecycle");
	api.holdNextCommand();
	await page.getByRole("button", { name: "停止 Agent" }).focus();
	await page.keyboard.press("Enter");
	// 停止确认按钮按设计写明动作「停止 Agent」（N-07），只在弹窗内查找。
	await page
		.getByRole("dialog", { name: "停止这个 Agent？" })
		.getByRole("button", { name: "停止 Agent" })
		.click();
	await expect(page.getByRole("button", { name: "停止中…" })).toBeDisabled();
	await expect(page.getByRole("button", { name: "重启 Agent" })).toBeDisabled();
	api.release();
	// NW-16：受理结果用 Toast，不再内联「操作已提交：{状态}」；回读为已停止后给结束态提示，
	// 危险区随之卸载，焦点落在页面 h1 而不是 body（O-11 AC-10）。
	await expect(toastHost(page)).toHaveText("Agent 已停止，历史会话转为只读");
	await expect(page.getByRole("region", { name: "停止 Agent" })).toHaveCount(0);
	await expect(
		page.getByRole("heading", {
			level: 1,
			name: "配置 Agent 的 Owner、范围和运行方式。",
		}),
	).toBeFocused();
	await expect(page.locator("#main-content")).not.toContainText("操作已提交");
	await page.getByRole("button", { name: "重启 Agent" }).click();
	await page.getByRole("button", { name: "确认重启" }).click();
	await expect(toastHost(page)).toHaveText("Agent 正在重启…");
	api.customAgent();
	await page.goto("/agents/agent-pilot-1/configuration");
	await expect(page.getByRole("button", { name: "升级镜像" })).toBeDisabled();
	await page.getByLabel("新镜像引用").fill("registry.example/agent:v2");
	api.holdNextCommand();
	await page.getByRole("button", { name: "升级镜像" }).click();
	await expect(page.getByRole("button", { name: "升级中…" })).toBeDisabled();
	await expect(page.getByLabel("新镜像引用")).toBeDisabled();
	api.release();
	// NW-16：镜像升级受理只提示「已提交」，不把受理响应当作配置保存结果替换表单。
	await expect(toastHost(page)).toHaveText("已提交镜像升级请求");
	await expect(page.locator("#main-content")).not.toContainText("配置已提交");
	await expect(page.getByLabel("新镜像引用")).toHaveValue("");
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
	await expect(page.getByRole("link", { name: "Owner 配置" })).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: /停止 Agent|重启 Agent|停用 Agent/ }),
	).toHaveCount(0);
	await page.goto("/agents/agent-pilot-1/configuration");
	// 无权访问是首屏静态边界（B-10 角色规则①），显示说明但不再用 role="alert" 打断读屏。
	await expect(page.getByText("当前无法访问此配置。")).toBeVisible();
	await expect(page.getByRole("alert")).toHaveCount(0);
	// N-02 负向：员工仍是不可用页，主内容里没有按钮、输入框、授权控件与权限边界说明。
	await expect(page.getByRole("heading", { level: 1 })).toHaveText(
		"配置不可用",
	);
	await expect(page.locator("main").getByRole("button")).toHaveCount(0);
	await expect(page.locator("main").getByRole("textbox")).toHaveCount(0);
	await expect(page.locator("main")).not.toContainText("Agent 授权控制");
	await expect(page.locator("main")).not.toContainText("权限边界");
	await page.goto("/admin/approvals");
	await expect(page.getByText("当前无法访问审批。")).toBeVisible();
	await expect(page.getByRole("alert")).toHaveCount(0);
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
	// A-03：403 是权限边界，显示「未授权」状态卡与「返回工作台」，不用 role="alert"。
	await expect(
		page.getByRole("heading", { level: 2, name: "未授权", exact: true }),
	).toBeVisible();
	await expect(
		page.locator('#main-content [data-slot="state-card"]').getByRole("link", {
			name: "返回工作台",
		}),
	).toHaveAttribute("href", "/");
	await expect(page.getByRole("alert")).toHaveCount(0);
	await capture(page, info, "agents-unavailable");
});

test("mobile navigation traps focus and returns it on Escape", async ({
	page,
}, info) => {
	test.skip(info.project.name !== "mobile", "Mobile Sheet behavior");
	await fixture(page, "employee");
	await page.goto("/agents");
	const trigger = page.getByRole("button", { name: "打开导航" });
	await expect(trigger).toHaveCSS("border-top-width", "1px");
	await expect(trigger).toHaveCSS("border-radius", "10px");
	await trigger.click();
	const dialog = page.getByRole("dialog", { name: "主导航" });
	await expect(dialog).toBeVisible();
	// 设计稿：开合只平移、不淡入；遮罩为前景色 30% 且不模糊（S-10、N-09）。
	await expect(dialog).toHaveCSS("opacity", "1");
	await expect(dialog).toHaveAttribute("aria-modal", "true");
	// 打开后焦点落在品牌链接（N-09）。
	await expect(dialog.locator(".platform-brand")).toBeFocused();
	// 「关闭导航」与品牌链接的命中区互不重叠，点品牌任意位置都回工作台而不是关闭导航。
	const brandBox = await dialog.locator(".platform-brand").boundingBox();
	const closeBox = await dialog
		.getByRole("button", { name: "关闭导航" })
		.boundingBox();
	expect(brandBox && closeBox).toBeTruthy();
	if (brandBox && closeBox) {
		const overlapX =
			Math.min(brandBox.x + brandBox.width, closeBox.x + closeBox.width) -
			Math.max(brandBox.x, closeBox.x);
		const overlapY =
			Math.min(brandBox.y + brandBox.height, closeBox.y + closeBox.height) -
			Math.max(brandBox.y, closeBox.y);
		expect(overlapX <= 0 || overlapY <= 0).toBe(true);
	}
	await expect(dialog).toHaveCSS("padding", "22px 14px 16px");
	// Tailwind 阴影会带上透明的 ring 层；可见层必须等于设计 --shadow。
	const shadows = (
		await dialog.evaluate((element) => getComputedStyle(element).boxShadow)
	).split(/,\s*(?=(?:rgba|oklch)\()/);
	expect(shadows.at(-1)).toBe("oklch(0.23 0.02 255 / 0.08) 0px 16px 40px 0px");
	for (const layer of shadows.slice(0, -1))
		expect(layer).toBe("rgba(0, 0, 0, 0) 0px 0px 0px 0px");
	await expect(dialog).toHaveCSS("transition-duration", "0.22s");
	expect(
		await dialog.evaluate((element) =>
			getComputedStyle(element).transitionProperty.split(", "),
		),
	).not.toContain("opacity");
	const overlay = page.locator('[data-slot="sheet-overlay"]');
	await expect(overlay).toHaveCSS(
		"background-color",
		"oklch(0.23 0.02 255 / 0.3)",
	);
	await expect(overlay).toHaveCSS("backdrop-filter", "none");
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
	await expect(dialog).toBeVisible();
	await page.setViewportSize({ width: 1024, height: 768 });
	await expect(dialog).not.toBeVisible();
	await expect(trigger).not.toBeVisible();
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(trigger).toBeVisible();
	await expect(dialog).not.toBeVisible();
	await trigger.click();
	await dialog.getByRole("link", { name: "我的 Agent", exact: true }).click();
	await expect(page).toHaveURL(/\/my-agents$/);
	await expect(dialog).not.toBeVisible();
	await capture(page, info, "mobile-navigation-route-recovery");
});

test("administrator shell chrome follows the design values without squeezing the brand", async ({
	page,
}, info) => {
	test.skip(info.project.name !== "desktop", "Desktop sidebar measurements");
	await page.setViewportSize({ width: 1440, height: 900 });
	await fixture(page, "admin");
	await page.goto("/admin/approvals");
	await expect(page.getByRole("heading", { name: "审批申请" })).toBeVisible();
	await expect(page).toHaveTitle("创建审批 · Agora Agent");
	const sidebar = page.locator(".platform-sidebar");
	// S-04/S-05：管理员导航项更多时品牌块仍为设计高度，且不参与 flex 收缩。
	const brand = sidebar.locator(".platform-brand");
	const brandHeight = (await brand.boundingBox())?.height ?? 0;
	expect(Math.abs(brandHeight - 71.7)).toBeLessThanOrEqual(0.5);
	await expect(brand).toHaveCSS("flex-shrink", "0");
	await expect(brand.locator(".platform-brand-mark")).toHaveCSS(
		"border-top-width",
		"0px",
	);
	await expect(brand.locator("strong")).toHaveCSS("line-height", "19.55px");
	await expect(brand.locator("small")).toHaveCSS("margin-top", "3px");
	await expect(brand.locator("small")).toHaveCSS("line-height", "18.15px");
	// H-02：悬停背景为 surface-raised。
	await brand.hover();
	await expect(brand).toHaveCSS("background-color", "oklch(0.993 0.0053 90.5)");
	// S-06：分组标签 11px / 1.4 等宽、字距 .08em。
	const label = sidebar.locator(".platform-nav-label").first();
	await expect(label).toHaveCSS("font-size", "11px");
	await expect(label).toHaveCSS("line-height", "15.4px");
	await expect(label).toHaveCSS("letter-spacing", "0.88px");
	await expect(label).toHaveCSS("padding", "0px 11px 6px");
	await expect(label).toHaveCSS("margin-bottom", "0px");
	expect(
		await label.evaluate((element) => getComputedStyle(element).fontFamily),
	).toMatch(/^ui-monospace/);
	// S-07：选中项字重与未选中项相同。
	const system = sidebar.getByRole("navigation", { name: "系统管理" });
	const current = system.getByRole("link", { name: "创建审批", exact: true });
	await expect(current).toHaveAttribute("aria-current", "page");
	const other = system.getByRole("link", { name: "Agent 管理", exact: true });
	expect(
		await current.evaluate((element) => getComputedStyle(element).fontWeight),
	).toBe(
		await other.evaluate((element) => getComputedStyle(element).fontWeight),
	);
	// S-09：身份卡尺寸。
	const identity = sidebar.locator(".platform-identity");
	await expect(identity).toHaveCSS("padding", "12px 10px");
	const identityAvatar = await identity
		.locator('[data-slot="avatar"]')
		.boundingBox();
	expect([identityAvatar?.width, identityAvatar?.height]).toEqual([34, 34]);
	await expect(identity.locator("strong")).toHaveCSS("font-size", "13px");
	await expect(identity.locator("strong")).toHaveCSS("font-weight", "700");
	await expect(identity.locator("small")).toHaveCSS("font-size", "11px");
	await expect(identity.locator("small")).toHaveCSS("margin-top", "2px");
	await expect(identity.locator("strong")).toHaveCSS("white-space", "nowrap");
	await expect(identity.locator("strong")).toHaveCSS(
		"text-overflow",
		"ellipsis",
	);
	// S-02：顶栏头像。
	const avatar = page.locator(".platform-user");
	const avatarBox = await avatar.boundingBox();
	expect([avatarBox?.width, avatarBox?.height]).toEqual([34, 34]);
	const fallback = avatar.locator('[data-slot="avatar-fallback"]');
	await expect(fallback).toHaveCSS("font-size", "12px");
	await expect(fallback).toHaveCSS("font-weight", "700");
	await expect(fallback).toHaveCSS("background-color", "oklch(0.23 0.02 255)");
	// S-03：面包屑上级 11px，当前页 14px / 700，无额外上距。
	const crumbs = page.locator(
		'.platform-breadcrumb [data-slot="breadcrumb-item"]',
	);
	await expect(crumbs).toHaveText(["系统管理", "创建审批"]);
	await expect(crumbs.first()).toHaveCSS("font-size", "11px");
	await expect(crumbs.first()).toHaveCSS("line-height", "13.75px");
	const crumbPage = page.locator(
		'.platform-breadcrumb [data-slot="breadcrumb-page"]',
	);
	await expect(crumbPage).toHaveCSS("font-size", "14px");
	await expect(crumbPage).toHaveCSS("font-weight", "700");
	await expect(crumbPage).toHaveCSS("line-height", "23.1px");
	await expect(crumbs.last()).toHaveCSS("margin-top", "0px");
	// S-01：没有服务端健康投影时不显示「平台就绪」。
	await expect(page.locator(".platform-topbar")).not.toContainText("平台就绪");
	// S-11/N-18：键盘焦点环统一为 2px、offset 3px。
	await page.locator("body").focus();
	for (const target of [
		page.locator(".platform-skip-link"),
		brand,
		sidebar.getByRole("link", { name: "工作台", exact: true }),
	]) {
		await page.keyboard.press("Tab");
		await expect(target).toBeFocused();
		expect(
			await target.evaluate((element) => ({
				visible: element.matches(":focus-visible"),
				style: getComputedStyle(element).outlineStyle,
				width: getComputedStyle(element).outlineWidth,
				offset: getComputedStyle(element).outlineOffset,
			})),
		).toEqual({ visible: true, style: "solid", width: "2px", offset: "3px" });
	}
	await capture(page, info, "admin-shell-chrome");
});

test("my Agent tabs and their panel show the shared focus ring", async ({
	page,
}, info) => {
	test.skip(info.project.name !== "desktop", "Keyboard focus walk");
	await fixture(page, "owner");
	await page.goto("/my-agents");
	const tab = page.getByRole("tab", { name: "申请 1", exact: true });
	await tab.focus();
	await page.keyboard.press("ArrowRight");
	await page.keyboard.press("ArrowLeft");
	await expect(tab).toBeFocused();
	const ring = (element: Element) => ({
		visible: element.matches(":focus-visible"),
		style: getComputedStyle(element).outlineStyle,
		width: getComputedStyle(element).outlineWidth,
		offset: getComputedStyle(element).outlineOffset,
	});
	// N-18：Tab 不再是 1px、offset 0 的环。
	expect(await tab.evaluate(ring)).toEqual({
		visible: true,
		style: "solid",
		width: "2px",
		offset: "3px",
	});
	// N-17：可聚焦的 Tab 面板有可见焦点环。
	await page.keyboard.press("Tab");
	const panel = page.getByRole("tabpanel", { name: "申请" });
	await expect(panel).toBeFocused();
	expect(await panel.evaluate(ring)).toEqual({
		visible: true,
		style: "solid",
		width: "2px",
		offset: "3px",
	});
});

for (const viewport of [
	{ width: 320, height: 640 },
	{ width: 360, height: 800 },
	{ width: 375, height: 812 },
]) {
	test(`page heading primary actions follow the ≤374px tier at ${viewport.width}px`, async ({
		page,
	}, info) => {
		test.skip(info.project.name !== "mobile", "Narrow viewport tier");
		await page.setViewportSize(viewport);
		await fixture(page, "owner");
		const narrow = viewport.width <= 374;
		const gutter = narrow ? 12 : 16;
		const fullWidth = viewport.width - gutter * 2;
		for (const { path, actions } of [
			{ path: "/agents", actions: ["创建申请"] },
			{ path: "/my-agents", actions: ["新建申请"] },
			{ path: "/agents/agent-pilot-1", actions: ["开始对话", "Owner 配置"] },
			{
				path: "/agents/agent-pilot-1/configuration",
				actions: ["返回 Agent 详情"],
			},
			{
				path: "/my-agents/application-browser-1",
				actions: ["返回我的 Agent", "修改申请", "撤回申请"],
			},
			{ path: "/my-agents/new", actions: [] },
		]) {
			await page.goto(path);
			const heading = page.locator("main .page-heading").first();
			await expect(heading).toBeVisible();
			// N-03：创建申请页头没有任何操作。
			if (actions.length === 0) {
				await expect(page.getByLabel("Agent 名称")).toBeVisible();
				await expect(heading.locator("a, button")).toHaveCount(0);
			}
			await expect(page.locator(".platform-topbar")).toHaveCSS(
				"padding-left",
				narrow ? "12px" : "18px",
			);
			await expect(page.locator(".platform-topbar")).toHaveCSS(
				"padding-right",
				narrow ? "12px" : "18px",
			);
			await expect(page.locator("main.platform-content")).toHaveCSS(
				"padding-left",
				`${gutter}px`,
			);
			for (const name of actions) {
				const action = heading
					// 撤回申请是 ConfirmDialog 触发器（data-slot=dialog-trigger），按按钮类名匹配。
					.locator('[data-slot="button"], [class~="group/button"]')
					.filter({ hasText: name });
				await expect(action).toHaveCount(1);
				const width = (await action.boundingBox())?.width ?? 0;
				if (narrow)
					expect(
						Math.abs(width - fullWidth),
						`${path} ${name}`,
					).toBeLessThanOrEqual(1);
				else expect(width, `${path} ${name}`).toBeLessThan(fullWidth - 1);
			}
			expect(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= innerWidth,
				),
			).toBe(true);
		}
		if (narrow) await capture(page, info, `narrow-tier-${viewport.width}`);
	});
}

const zoomOwnerManagementPaths = [
	"/agents",
	"/agents/agent-pilot-1",
	"/my-agents",
	"/my-agents/new",
	"/my-agents/application-browser-1",
	"/agents/agent-pilot-1/configuration",
] as const;

test("management pages remain reachable at 200% zoom equivalent widths", async ({
	page,
}, info) => {
	test.skip(info.project.name !== "mobile", "Narrow viewport acceptance");
	await fixture(page, "owner");
	for (const path of zoomOwnerManagementPaths) {
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
	}
	await fixture(page, "admin");
	await page.goto("/admin/approvals");
	await expect(page.getByRole("heading", { name: "审批申请" })).toBeVisible();
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
});

test.describe("short management viewport", () => {
	// Create the mobile page at its final size instead of resizing a wide live page.
	test.use({ viewport: { width: 160, height: 320 } });
	test("management pages remain reachable in a short 160px viewport", async ({
		page,
	}, info) => {
		test.skip(info.project.name !== "mobile", "Narrow viewport acceptance");
		await fixture(page, "owner");
		for (const path of zoomOwnerManagementPaths) {
			await page.goto(path);
			await expect(
				page.locator(".management-content h1").first(),
			).toBeVisible();
			await capture(page, info, `short-${path.replaceAll("/", "-")}`);
		}
		await fixture(page, "admin");
		await page.goto("/admin/approvals");
		await expect(page.getByRole("heading", { name: "审批申请" })).toBeVisible();
		await capture(page, info, "short-approvals");
	});
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
	const statusReads: string[] = [];
	await page.route(/\/api\/v[12]\/agents\/[^/]+\/wecom-/, async (route) => {
		const path = new URL(route.request().url()).pathname;
		// 状态 V2 在首次点击前给出扫码不可用（#2911）。
		if (path.endsWith("/wecom-bot")) {
			statusReads.push(path);
			return route.fulfill({
				json: {
					status: active ? "connected" : "not_configured",
					qrAvailable: false,
					qrUnavailableReason: "authorization_correlation_unverified",
				},
			});
		}
		if (path.endsWith("/wecom-app"))
			return route.fulfill({ json: { status: "not_configured" } });
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
	await page.addInitScript(() => {
		const opened: string[] = [];
		Object.assign(window, { __openedWindows: opened });
		window.open = (url?: string | URL) => {
			opened.push(String(url ?? ""));
			return null;
		};
	});
	const setupRequests: string[] = [];
	page.on("request", (request) => {
		if (/\/wecom-setup/.test(request.url()))
			setupRequests.push(
				`${request.method()} ${new URL(request.url()).pathname}`,
			);
	});
	await page.goto("/agents/agent-pilot-1");
	await page.getByRole("link", { name: "Owner 配置" }).click();
	const bot = page.getByRole("region", { name: "企微机器人", exact: true });
	await expect(bot.getByText("未配置", { exact: true })).toBeVisible();
	expect(statusReads).toContain("/api/v2/agents/agent-pilot-1/wecom-bot");
	// CK-09：扫码入口不要求先勾选「我已知悉」；O-08：不可用时显示面板，不打开窗口。
	const qrTrigger = page.getByRole("button", { name: "扫码授权" });
	await qrTrigger.click();
	await expect(
		bot.getByText("扫码授权暂不可用", { exact: true }),
	).toBeVisible();
	await expect(
		bot.getByRole("status").filter({ hasText: "请使用手动配置" }),
	).toContainText("当前平台尚未完成授权关联校验。");
	await expect(page.locator("main")).not.toContainText(
		"authorization_correlation_unverified",
	);
	await expect(page.locator("main")).not.toContainText("请先确认连接影响");
	await expect(bot.getByRole("alert")).toHaveCount(0);
	// W-24 / W-25（待回写）：面板只有底部一个「关闭」；说明不外露 setup session 术语。
	const qrPanel = bot.locator("#wecom-bot-qr-panel");
	await expect(
		qrPanel.getByRole("button", { name: "关闭", exact: true }),
	).toHaveCount(1);
	await expect(qrPanel.locator(".wecom-qr-head p")).toHaveText(
		"扫码能力由服务端按当前部署判定，当前不会伪造绑定成功。",
	);
	await expect(page.locator("main")).not.toContainText("setup session");
	expect(
		await page.evaluate(
			() =>
				(window as unknown as { __openedWindows: string[] }).__openedWindows,
		),
	).toEqual([]);
	// AC-1（#2911）：扫码不可用时打开面板不建立也不取消 setup session。
	await page.waitForTimeout(300);
	expect(setupRequests).toEqual([]);
	await capture(page, info, "wecom-qr-unavailable");
	await bot.getByRole("button", { name: "改用手动配置" }).click();
	await expect(page.getByLabel("Bot ID", { exact: true })).toBeFocused();
	await qrTrigger.click();
	await bot.getByRole("button", { name: "关闭", exact: true }).click();
	await expect(qrTrigger).toBeFocused();
	// 再次打开同样不创建 setup session。
	expect(setupRequests).toEqual([]);
	await page
		.getByRole("checkbox", {
			name: "我已知悉可能断开其他连接",
		})
		.check();
	await page.getByLabel("Bot ID", { exact: true }).fill("fixture-bot");
	const secret = "synthetic-bot-secret";
	await page.getByLabel("Secret", { exact: true }).fill(secret);
	await page.getByLabel("Secret", { exact: true }).evaluate((element) => {
		(element as HTMLInputElement).value = "";
	});
	await capture(page, info, "wecom-manual");
	await page.getByLabel("Secret", { exact: true }).fill(secret);
	await bot.getByRole("button", { name: "验证并绑定：企微机器人" }).click();
	await expect(page.getByLabel("Secret", { exact: true })).toHaveValue("");
	await expect(bot.getByText("已连接", { exact: true })).toBeVisible();
	expect(saved).toEqual({
		state: "fixture-state",
		botId: "fixture-bot",
		secret,
		takeoverConfirmed: true,
	});
	// 只有手动提交才建立 setup session。
	expect(setupRequests.slice(0, 2)).toEqual([
		"POST /api/v1/agents/agent-pilot-1/wecom-setup",
		"POST /api/v1/agents/agent-pilot-1/wecom-setup/fixture-setup/credentials",
	]);
	await expect(page.getByLabel(/配置标识/)).toHaveCount(0);
	await capture(page, info, "wecom-connected");
});

test("Owner opens the bot QR window without the manual acknowledgement and confirms the impact in the panel (CK-09)", async ({
	page,
}) => {
	await fixture(page);
	const session = {
		sessionId: "qr-setup",
		agentId: "agent-pilot-1",
		configurationRevision: 1,
		expiresAt: new Date(Date.now() + 300000).toISOString(),
	};
	const authOrigin = "https://wecom-auth.example.test";
	let active = false;
	const submitted: unknown[] = [];
	await page.route(/\/api\/v[12]\/agents\/[^/]+\/wecom-/, async (route) => {
		const path = new URL(route.request().url()).pathname;
		// 状态 V2 确认扫码可用后，点击才建立 setup session（#2911）。
		if (path.endsWith("/wecom-bot"))
			return route.fulfill({
				json: {
					status: active ? "connected" : "not_configured",
					qrAvailable: true,
				},
			});
		if (path.endsWith("/wecom-app"))
			return route.fulfill({ json: { status: "not_configured" } });
		if (path.endsWith("/wecom-setup"))
			return route.fulfill({
				json: {
					...session,
					status: "awaiting_input",
					state: "qr-state",
					qrAvailable: true,
					qr: {
						authorizationUrl: `${authOrigin}/authorize`,
						authOrigin,
						source: "agent-infra",
						state: "qr-state",
					},
				},
			});
		if (path.endsWith("/credentials")) {
			submitted.push(route.request().postDataJSON());
			active = true;
			return route.fulfill({ json: { ...session, status: "verifying" } });
		}
		if (path.endsWith("/cancel"))
			return route.fulfill({ json: { ...session, status: "cancelled" } });
		return route.fulfill({ json: { ...session, status: "active" } });
	});
	// 受控的授权页：扫码完成后把结果发回打开它的配置页（只含合成凭证）。
	await page.context().route(`${authOrigin}/**`, (route) =>
		route.fulfill({
			contentType: "text/html",
			body: `<script>window.opener.postMessage({source:"agent-infra",state:"qr-state",botId:"qr-bot",secret:"synthetic-qr-secret"},"*");</script>`,
		}),
	);
	const setupRequests: string[] = [];
	page.on("request", (request) => {
		if (/\/wecom-setup/.test(request.url()))
			setupRequests.push(
				`${request.method()} ${new URL(request.url()).pathname}`,
			);
	});
	await page.goto("/agents/agent-pilot-1/configuration");
	const bot = page.getByRole("region", { name: "企微机器人", exact: true });
	const acknowledgement = bot.getByRole("checkbox", {
		name: "我已知悉可能断开其他连接",
	});
	await expect(bot.getByText("未配置", { exact: true })).toBeVisible();
	// AC-2（#2911）：扫码可用时，打开页面不建立 setup session，点击后才建立一次。
	expect(setupRequests).toEqual([]);
	await bot.getByRole("button", { name: "扫码授权" }).click();
	// 扫码前不需要勾选上方「我已知悉」。
	const openWindow = bot.getByRole("button", { name: "打开扫码窗口" });
	await expect(openWindow).toBeEnabled();
	expect(setupRequests).toEqual([
		"POST /api/v1/agents/agent-pilot-1/wecom-setup",
	]);
	await expect(acknowledgement).not.toBeChecked();
	await expect(bot).not.toContainText("请先勾选");
	const popup = page.waitForEvent("popup");
	await openWindow.click();
	await popup;
	// 扫码完成后在面板内就地确认影响；确认前不提交凭证，Secret 不进入页面。
	const confirm = bot.getByRole("button", { name: "确认并绑定" });
	await expect(confirm).toBeFocused();
	await expect(confirm).toHaveAccessibleDescription(
		/^连接此机器人可能断开它在其他服务中的现有连接。/,
	);
	await expect(
		bot.getByRole("button", { name: "验证并绑定：企微机器人" }),
	).toBeDisabled();
	await page.waitForTimeout(300);
	expect(submitted).toEqual([]);
	expect(await page.content()).not.toContain("synthetic-qr-secret");
	await confirm.click();
	await expect(bot.getByText("已连接", { exact: true })).toBeVisible();
	expect(submitted).toEqual([
		{
			state: "qr-state",
			botId: "qr-bot",
			secret: "synthetic-qr-secret",
			takeoverConfirmed: true,
		},
	]);
	await expect(confirm).toHaveCount(0);
	await expect(acknowledgement).not.toBeChecked();
	// W-26：扫码确认后的绑定成功给 Toast「企微机器人已连接」，焦点留在卡片标题，不落到 body。
	await expect(toastHost(page)).toHaveText("企微机器人已连接");
	await expect(bot.getByRole("heading", { name: "企微机器人" })).toBeFocused();
});

test("owned Agent tab consumes the authorized collection and supports keyboard navigation", async ({
	page,
}, info) => {
	await fixture(page);
	await page.goto("/my-agents");
	const applications = page.getByRole("tab", { name: "申请 1", exact: true });
	await applications.focus();
	await page.keyboard.press("ArrowRight");
	await expect(
		page.getByRole("tab", { name: "已创建", exact: true }),
	).toBeFocused();
	await expect(
		page.getByRole("list", { name: "我管理的 Agent" }),
	).toContainText("Release assistant");
	await capture(page, info, "owned-agents");
	await page.getByRole("link", { name: "配置与生命周期" }).click();
	await expect(page).toHaveURL(/\/agents\/agent-pilot-1\/configuration$/);
});

test("employee collection is not presented as owned Agents", async ({
	page,
}) => {
	await fixture(page, "employee");
	await page.goto("/my-agents");
	await page.getByRole("tab", { name: "已创建", exact: true }).click();
	// 空态标题按设计改为 strong（B-11），不再是 heading。
	const empty = page.locator('[data-slot="empty"]', {
		hasText: "暂无你管理的 Agent",
	});
	await expect(empty).toBeVisible();
	await expect(empty.getByRole("heading")).toHaveCount(0);
	await expect(page.getByRole("link", { name: "配置与生命周期" })).toHaveCount(
		0,
	);
});

test("retryable management reads recover through explicit browser actions", async ({
	page,
}) => {
	const api = await fixture(page);
	api.unavailableAgentList();
	await page.goto("/agents");
	await expect(page.getByRole("alert")).toContainText(
		"暂时无法读取 Agent 列表，请稍后重试。",
	);
	await expect(
		page.getByRole("alert").getByRole("heading", { name: "服务暂不可用" }),
	).toBeVisible();
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
	await expect(page.getByRole("link", { name: "查看申请" })).toBeVisible();
	api.unavailableAgentList();
	await page.reload();
	await page.getByRole("tab", { name: "已创建", exact: true }).click();
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
	// P-01：详情读取失败改为公共状态卡，可重试时仍为 role="alert"。
	await expect(page.getByRole("alert")).toContainText(
		"暂时无法读取 Agent，请稍后重试。",
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
	await expect(
		page.getByRole("heading", { level: 2, name: "未授权", exact: true }),
	).toBeVisible();
	await expect(
		page.getByText("Agent 列表暂时无法访问，请联系管理员。"),
	).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "重新加载 Agent" }),
	).toHaveCount(0);

	api.unauthorizedAgentDetail();
	await page.goto("/agents/agent-pilot-1");
	// P-01：403 与 404 为同一张「无法访问」状态卡（静态边界，不设 role），只给返回入口。
	const detailCard = page.locator('#main-content [data-slot="state-card"]');
	await expect(detailCard).toHaveAttribute("data-kind", "unauthorized");
	await expect(detailCard).toHaveText(
		"无法访问Agent 不存在，或你没有访问权限。返回 Agent 目录",
	);
	await expect(
		page.getByRole("button", { name: "重新加载 Agent" }),
	).toHaveCount(0);

	await page.goto("/agents/agent-pilot-1/configuration");
	await expect(
		page.getByRole("heading", { level: 1, name: "Owner 配置" }),
	).toBeVisible();
	await expect(detailCard).toHaveText(
		"无法访问Agent 不存在，或你没有访问权限。返回 Agent 详情",
	);
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
	// P-01：页头保留页面名，失败原因由「服务暂不可用」状态卡说明。
	await expect(
		page.getByRole("heading", { level: 1, name: "Owner 配置" }),
	).toBeVisible();
	await expect(
		page.getByRole("alert").getByRole("heading", { name: "服务暂不可用" }),
	).toBeVisible();
	await expect(page.getByRole("alert")).toContainText(
		"暂时无法读取 Owner 配置，请稍后重试。",
	);
	api.recoverAgentDetail();
	await page.getByRole("button", { name: "重新加载配置" }).click();
	await expect(
		page.getByRole("heading", {
			name: "配置 Agent 的 Owner、范围和运行方式。",
		}),
	).toBeVisible();
});

test("application detail reads recover through the explicit browser action", async ({
	page,
}) => {
	const api = await fixture(page);
	api.unavailableApplicationDetail();
	await page.goto("/my-agents/application-browser-1");
	// P-01：页头保留页面名，失败原因由「服务暂不可用」状态卡说明。
	await expect(
		page.getByRole("heading", { level: 1, name: "申请详情" }),
	).toBeVisible();
	await expect(
		page.getByRole("alert").getByRole("heading", { name: "服务暂不可用" }),
	).toBeVisible();
	await expect(page.getByRole("alert")).toContainText(
		"暂时无法读取申请，请稍后重试。",
	);
	api.recoverApplicationDetail();
	await page.getByRole("button", { name: "重新加载申请" }).click();
	await expect(
		page.getByRole("heading", { name: pendingApplication.name }),
	).toBeVisible();
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
	await expect(page.getByRole("combobox", { name: "标准模板" })).toBeVisible();
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
	await page.getByRole("tab", { name: "已创建", exact: true }).click();
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
	const dialog = page.getByRole("dialog", { name: "撤回这条申请？" });
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
	const search = page.getByRole("searchbox", { name: "搜索 Agent" });
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
	for (const width of [390, 767, 768, 820, 1440]) {
		await page.setViewportSize({ width, height: 1000 });
		const boxes = await cards.evaluateAll((elements) =>
			elements.map((element) => {
				const box = element.getBoundingClientRect();
				return { left: box.left, top: box.top, width: box.width };
			}),
		);
		if (width < 768) {
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
	await expect(
		page.getByRole("combobox", { name: "状态", exact: true }),
	).toBeFocused();
	await page.keyboard.press("Tab");
	await expect(
		page.getByRole("combobox", { name: "模板", exact: true }),
	).toBeFocused();
	await page.keyboard.press("Tab");
	await expect(
		page.getByRole("combobox", { name: "模型", exact: true }),
	).toBeFocused();
	await page.keyboard.press("Tab");
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

for (const available of [true, false]) {
	test(`Agent directory shows Connection available=${available} and keeps creation in the page heading`, async ({
		page,
	}, info) => {
		await fixture(page, "employee");
		if (available)
			await page.route("**/api/v1/connection/capability", (route) =>
				route.fulfill({
					json: ConnectionCapabilityProjectionV1Schema.parse({
						schemaVersion: 1,
						status: "available",
						publicOrigin: "https://connection.example.test",
						mcpPath: "/mcp",
						configFingerprint: "a".repeat(64),
					}),
				}),
			);
		await page.goto("/agents");
		if (info.project.name === "mobile")
			await page.getByRole("button", { name: "打开导航" }).click();
		const nav =
			info.project.name === "mobile"
				? page.getByRole("dialog", { name: "主导航" })
				: page.locator(".platform-sidebar");
		const connection = nav.getByRole("link", { name: "我的 Connection" });
		if (available) {
			await expect(connection).toHaveAttribute("target", "_blank");
			await expect(connection).toHaveAttribute(
				"href",
				"https://connection.example.test/mcp",
			);
		} else {
			await expect(connection).toHaveCount(0);
			// 设计稿：单行名称 + 灰色 chip，原因只给读屏，不用 title、不显示原始 reason（S-08）。
			const unavailable = nav.locator(
				'.platform-nav-item[aria-disabled="true"]',
			);
			await expect(unavailable).toHaveCount(1);
			await expect(unavailable).toContainText("我的 Connection");
			await expect(unavailable).not.toContainText("（暂不可用）");
			const chip = unavailable.getByText("不可用", { exact: true });
			await expect(chip).toBeVisible();
			// 灰色 chip 不带状态圆点（Badge chip 的 ::before 被隐藏）。
			expect(
				await chip.evaluate(
					(node) => getComputedStyle(node, "::before").display,
				),
			).toBe("none");
			await expect(unavailable).not.toHaveAttribute("title");
			const reasonId = await unavailable.getAttribute("aria-describedby");
			expect(reasonId).toBeTruthy();
			await expect(page.locator(`[id="${reasonId}"]`)).toHaveText(
				"Connection 服务当前不可用。",
			);
			const box = await unavailable.boundingBox();
			// 单行：高度保持导航项的 44px 最小高度。
			expect(box?.height).toBeLessThanOrEqual(46);
			await expect(page.locator("body")).not.toContainText("Connection:");
		}
		if (info.project.name === "mobile") await page.keyboard.press("Escape");
		const create = page
			.locator("main .page-heading")
			.getByRole("link", { name: "创建申请" });
		await create.focus();
		await page.keyboard.press("Enter");
		await expect(page).toHaveURL(/\/my-agents\/new$/);
		await expect(page.getByLabel("Agent 名称", { exact: true })).toBeVisible();
	});
}

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
	// P-01：返回了另一个 Agent 视为响应无效，显示「数据无法读取」卡且没有操作。
	await expect(
		page.getByRole("alert").getByRole("heading", { name: "数据无法读取" }),
	).toBeVisible();
	await expect(page.getByRole("alert").getByRole("link")).toHaveCount(0);
	await expect(page.getByRole("alert").getByRole("button")).toHaveCount(0);
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
	// 不在授权集合内（404）与无权访问（403）为同一张「无法访问」卡。
	await expect(
		page.getByRole("heading", { level: 2, name: "无法访问" }),
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Visible Agent 2", exact: true }),
	).toHaveCount(0);
	await capture(page, info, "directory-detail-opaque-denial");
	await page.getByRole("link", { name: "返回 Agent 目录" }).click();
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
	// A-03：响应无效单独成卡，不再与 401/403/404 共用一句文案。
	await expect(
		page.getByRole("alert").getByRole("heading", {
			level: 2,
			name: "目录数据无法读取",
		}),
	).toBeVisible();
	await expect(
		page.getByText("Agent 列表暂时无法访问，请联系管理员。"),
	).toHaveCount(0);
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
				await expect(
					page.getByRole("combobox", { name: "状态", exact: true }),
				).toBeFocused();
				await page.keyboard.press("Tab");
				await expect(
					page.getByRole("combobox", { name: "模板", exact: true }),
				).toBeFocused();
				await page.keyboard.press("Tab");
				await expect(
					page.getByRole("combobox", { name: "模型", exact: true }),
				).toBeFocused();
				await page.keyboard.press("Tab");
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
		// 详情页读取带 Owner 状态的详情投影（#2910）；模型字段与 V2 相同。
		const detailResponse = page.waitForResponse(
			(response) =>
				new URL(response.url()).pathname ===
					"/api/v2/agents/agent-self-managed/detail" &&
				response.request().method() === "GET",
		);
		await page.goto("/agents/agent-self-managed");
		const projected = AgentDetailProjectionV1Schema.parse(
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
			await expect(main.getByText("默认推理档位", { exact: true })).toHaveCount(
				0,
			);
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
			await expect(
				main.getByRole("link", { name: "查看对话历史" }),
			).toHaveCount(0);
			await expect(
				main.getByRole("link", { name: "打开 Agent" }),
			).toHaveAttribute("href", "https://agent.example.test/");
			await capture(
				page,
				info,
				`self-managed-models-${identityResponsibility}-${phase}`,
			);
		}
		await main.getByRole("link", { name: "返回 Agent 目录" }).focus();
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
			await expect(
				main.getByText("默认推理档位", { exact: true }),
			).toBeVisible();
			await expect(main.getByText(/Primary model.*均衡、高/)).toBeVisible();
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
			await expect(
				page.getByRole("link", { name: "查看对话历史" }),
			).toHaveCount(0);
		} else {
			await expect(
				page.getByRole("button", { name: "开始对话" }),
			).toBeDisabled();
			await expect(
				page.getByRole("link", { name: "查看对话历史" }),
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

test("long template display names wrap inside narrow application panels", async ({
	page,
}, info) => {
	const api = await fixture(page);
	const templateId = `template-${"identifier".repeat(11)}`;
	const displayName = `Template-${"Identifier".repeat(11)}`;
	api.longApplicationTemplateId(templateId, displayName);
	await page.goto("/my-agents");
	const badge = page.getByText(displayName, { exact: true });
	await expect(badge).toBeVisible();
	// F-02：只显示模板显示名，原始 templateId 不进入页面（区分大小写）。
	await expect(page.locator("main")).not.toContainText(templateId);
	for (const width of [360, 390, 820]) {
		await page.setViewportSize({ width, height: 844 });
		expect(
			await badge.evaluate((element) => {
				const panel = element.closest(".application-row");
				if (!panel) return false;
				const box = element.getBoundingClientRect();
				const bounds = panel.getBoundingClientRect();
				return (
					box.left >= bounds.left &&
					box.right <= bounds.right &&
					element.scrollWidth <= element.clientWidth + 1
				);
			}),
		).toBe(true);
		await capture(page, info, `application-long-template-${width}px`);
	}
	expect(api.commands).toHaveLength(0);
});

for (const route of [
	"/agents",
	"/agents/agent-pilot-1",
	"/my-agents",
	"/my-agents/new",
	"/my-agents/application-browser-1",
	"/my-agents/application-browser-1/edit",
	"/agents/agent-pilot-1/configuration",
	"/admin/approvals",
]) {
	test(`exported design viewport matrix ${route}`, async ({ page }, info) => {
		test.skip(
			info.project.name !== "desktop",
			"The exported nine-viewport matrix runs once.",
		);
		const api = await fixture(
			page,
			route.startsWith("/admin") ? "admin" : "owner",
		);
		api.threeAgents();
		await page.goto(route);
		await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
		if (route === "/my-agents/new" || route.endsWith("/edit"))
			await expect(
				page.getByLabel("Agent 名称", { exact: true }),
			).toBeVisible();
		else if (route.endsWith("/configuration"))
			await expect(
				page.getByRole("button", { name: "保存配置", exact: true }),
			).toBeVisible();
		else if (route === "/admin/approvals")
			await expect(
				page.getByRole("button", { name: /^审阅：/ }).first(),
			).toBeVisible();
		else if (route === "/my-agents")
			await expect(
				page.getByRole("link", { name: /^查看申请：/ }).first(),
			).toBeVisible();
		else if (route === "/agents")
			await expect(page.locator(".directory-card")).toHaveCount(3);
		else
			await expect(page.getByRole("heading", { level: 1 })).toContainText(
				"Release assistant",
			);
		if (route.includes("application-browser-1"))
			await expect(page.locator('[data-slot="breadcrumb-page"]')).toHaveText(
				route.endsWith("/edit") ? "编辑申请" : "申请详情",
			);
		for (const viewport of designViewports) {
			await page.setViewportSize(viewport);
			await captureDesignContract(
				page,
				info,
				route.replaceAll("/", "-") || "workbench",
			);
			if (route === "/my-agents") {
				await page.getByRole("tab", { name: "已创建", exact: true }).click();
				await expect(page.locator(".owned-agent-card").first()).toBeVisible();
				await captureDesignContract(page, info, "my-agents-owned");
				await page.getByRole("tab", { name: "申请 1", exact: true }).click();
			}
		}
	});
}

test("Agent detail and configuration use readable directory records with canonical submissions", async ({
	page,
}, info) => {
	const api = await fixture(page);
	await page.goto("/agents/agent-pilot-1");
	await expect(page.getByText("平台工程", { exact: true })).toBeVisible();
	await expect(
		page.getByText("研发 / 平台工程", { exact: true }),
	).toBeVisible();
	await expect(page.locator("main")).not.toContainText("org-platform");
	await capture(page, info, "directory-detail-readable");
	await page.getByRole("link", { name: "Owner 配置" }).click();
	const owner = page.getByRole("combobox", { name: "共同 Owner 用户" });
	await expect(
		page.getByRole("button", { name: "移除 当前 Owner" }),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "移除 平台工程" }),
	).toBeVisible();
	await owner.fill("user.two");
	await expect(page.getByRole("option", { name: /验收用户二/ })).toBeVisible();
	await page.keyboard.press("Enter");
	await expect(
		page.getByRole("button", { name: "移除 验收用户二" }),
	).toBeVisible();
	// 设计 directorySelect：选中后清空查询、保持展开、焦点回到输入框，已选项不再作为候选。
	await expect(owner).toHaveAttribute("aria-expanded", "true");
	await expect(owner).toBeFocused();
	await expect(owner).toHaveValue("");
	await expect(page.getByRole("option", { name: /验收用户二/ })).toHaveCount(0);
	await page.keyboard.press("Escape");
	await expect(owner).toHaveAttribute("aria-expanded", "false");
	const user = page.getByRole("combobox", { name: "可使用的用户" });
	await user.fill("user.three");
	await page.getByRole("option", { name: /验收用户三/ }).click();
	await capture(page, info, "directory-configuration-readable");
	const width = await page.evaluate(() => ({
		viewport: innerWidth,
		content: document.documentElement.scrollWidth,
	}));
	expect(width.content).toBeLessThanOrEqual(width.viewport);
	await page.getByRole("button", { name: "保存配置" }).click();
	await expect(toastHost(page)).toHaveText("配置已保存，Secret 值不会回显");
	expect(api.commands.at(-1)?.body).toMatchObject({
		schemaVersion: 2,
		coOwnerIds: ["user-owner-1", "user-2"],
		availability: [
			{ kind: "user", userId: "user-3" },
			{ kind: "organization", organizationId: "org-platform" },
		],
	});
});

test("application form and Owner configuration read the directory only through the generated client (#3035)", async ({
	page,
}) => {
	await fixture(page);
	const api = recordApiRequests(page);
	await page.goto("/my-agents/new");
	const owner = page.getByRole("combobox", { name: "共同 Owner 用户" });
	await owner.fill("user.two");
	await expect(page.getByRole("option", { name: /验收用户二/ })).toBeVisible();
	await page.goto("/agents/agent-pilot-1/configuration");
	await expect(
		page.getByRole("button", { name: "移除 平台工程" }),
	).toBeVisible();
	await page.getByRole("combobox", { name: "可使用的用户" }).fill("user.three");
	await expect(page.getByRole("option", { name: /验收用户三/ })).toBeVisible();
	// 关键词搜索与按 ID 回显都发生过，且全部请求都能匹配生成 Client 的路径模板。
	expect(
		api.requests.filter((entry) => entry === "GET /api/v2/directory/search")
			.length,
	).toBeGreaterThanOrEqual(2);
	api.expectGenerated("申请表单与 Owner 配置");
});

test("Agent detail shows each Owner's server-projected status chip (D-04, #2910)", async ({
	page,
}, info) => {
	await fixture(page);
	const base = pilotAgentDetailFromV2(
		pilotFakeScenariosV2.starting.response.body,
	);
	// 服务端投影四种 Owner 状态；页面不得自行推断「有效」。
	const detail = AgentDetailProjectionV1Schema.parse({
		...base,
		serviceAvailability: "ready",
		configuration: {
			...base.configuration,
			owners: [
				{ userId: "user-owner-1", displayName: "当前 Owner", status: "active" },
				{ userId: "user-2", displayName: "验收用户二", status: "disabled" },
				{ userId: "user-3", displayName: null, status: "departed" },
				{
					userId: "user-departed-0123456789",
					displayName: null,
					status: "unavailable",
				},
			],
		},
	});
	const detailReads: string[] = [];
	await page.route("**/api/v2/agents/agent-pilot-1/detail", async (route) => {
		detailReads.push(route.request().method());
		await route.fulfill({
			json: detail,
			headers: { "cache-control": "no-store" },
		});
	});
	await page.goto("/agents/agent-pilot-1");
	const owners = page.getByRole("region", { name: "Owner" });
	await expect(owners.getByRole("listitem")).toHaveCount(4);
	// 没有服务端显示名时取目录名称；目录也没有时只显示「用户」与 ID 短形式。
	await expect(owners.getByText("验收用户三", { exact: true })).toBeVisible();
	const rows = await owners.getByRole("listitem").evaluateAll((items) =>
		items.map((item) => {
			const chip = item.querySelector(
				'[data-slot="badge"][data-variant="chip"]',
			);
			return [
				item.querySelector("strong")?.textContent,
				chip?.textContent,
				chip?.getAttribute("data-tone"),
				chip?.getAttribute("role"),
			];
		}),
	);
	expect(rows).toEqual([
		["当前 Owner", "有效", "green", null],
		["验收用户二", "已禁用", "amber", null],
		["验收用户三", "已离职", "gray", null],
		["用户 user-dep…", "状态未知", "gray", null],
	]);
	await expect(owners.getByText("有效", { exact: true })).toHaveCount(1);
	await expect(owners).not.toContainText(
		/active|disabled|departed|unavailable|主要 Owner|共同 Owner/,
	);
	await expect(
		owners.locator('code[title="user-departed-0123456789"]'),
	).toBeVisible();
	// 不同状态的 chip 色调可区分（有效 green，其余 amber / gray）。
	const colors = await owners
		.locator('[data-slot="badge"][data-variant="chip"]')
		.evaluateAll((chips) => chips.map((chip) => getComputedStyle(chip).color));
	expect(new Set(colors).size).toBe(3);
	expect(colors[2]).toBe(colors[3]);
	expect(detailReads).toEqual(["GET"]);
	const width = await page.evaluate(() => ({
		viewport: innerWidth,
		content: document.documentElement.scrollWidth,
	}));
	expect(width.content).toBeLessThanOrEqual(width.viewport);
	await capture(page, info, "agent-detail-owner-status");
});

test("Agent detail shows the real WeCom binding status without a visibility scope (D-04, #2910)", async ({
	page,
}, info) => {
	await fixture(page);
	const base = pilotAgentDetailFromV2(
		pilotFakeScenariosV2.starting.response.body,
	);
	let status: "bound" | "binding" | "failed" = "bound";
	await page.route("**/api/v2/agents/agent-pilot-1/detail", async (route) => {
		await route.fulfill({
			json: AgentDetailProjectionV1Schema.parse({
				...base,
				serviceAvailability: "ready",
				configuration: {
					...base.configuration,
					channels: [
						{ kind: "web", status: "available" },
						{ kind: "wecom_bot", status },
					],
				},
			}),
			headers: { "cache-control": "no-store" },
		});
	});
	const runtime = page.getByRole("region", { name: "运行与渠道" });
	const wecom = runtime
		.getByRole("listitem")
		.filter({ has: page.getByText("企微机器人", { exact: true }) });
	const chip = wecom.locator('[data-slot="badge"][data-variant="chip"]');
	// 服务端投影的真实状态逐一映射为中文文案与色调；渠道行不显示可见范围。
	for (const [projected, label, tone] of [
		["bound", "已绑定", "green"],
		["binding", "绑定中", "amber"],
		["failed", "连接异常", "red"],
	] as const) {
		status = projected;
		await page.goto("/agents/agent-pilot-1");
		await expect(chip).toHaveText(label);
		await expect(chip).toHaveAttribute("data-tone", tone);
		await expect(wecom).toHaveText(`企微机器人${label}`);
		await expect(runtime).not.toContainText(
			/组织内|可见范围|not_configured|binding|bound|failed/,
		);
		if (projected === "bound")
			await capture(page, info, "agent-detail-wecom-bound");
	}
});

test("directory pickers support consecutive picks, keyboard focus and 44px chip targets", async ({
	page,
}, info) => {
	await fixture(page);
	await page.goto("/my-agents/new");
	const owner = page.getByRole("combobox", { name: "共同 Owner 用户" });
	const users = page.getByRole("combobox", { name: "可使用的用户" });
	const organizations = page.getByRole("combobox", { name: "可使用的组织" });
	await owner.fill("验收");
	await page.getByRole("option", { name: /验收用户二/ }).click();
	await expect(owner).toBeFocused();
	await expect(owner).toHaveAttribute("aria-expanded", "true");
	await expect(owner).toHaveValue("");
	await expect(page.getByRole("option", { name: /验收用户二/ })).toHaveCount(0);
	// 不按其他键即可点选第二项。
	await page.getByRole("option", { name: /验收用户三/ }).click();
	await expect(
		page.getByRole("button", { name: "移除 验收用户二" }),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "移除 验收用户三" }),
	).toBeVisible();
	await expect(owner).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(owner).toHaveAttribute("aria-expanded", "false");
	await expect(owner).toBeFocused();
	await owner.click();
	await expect(owner).toHaveAttribute("aria-expanded", "true");
	await page.getByRole("button", { name: "移除 验收用户三" }).click();
	await expect(
		page.getByRole("button", { name: "移除 验收用户三" }),
	).toHaveCount(0);
	await expect(owner).toBeFocused();
	await expect(owner).toHaveAttribute("aria-expanded", "true");

	await owner.fill("不存在的人");
	await expect(page.getByText("没有匹配结果")).toBeVisible();
	await expect(page.getByRole("listbox")).toHaveCount(0);
	const clear = page.getByRole("button", { name: "清空搜索" });
	const clearBox = await clear.boundingBox();
	expect(clearBox?.height).toBeGreaterThanOrEqual(44);
	expect(clearBox?.width).toBeGreaterThanOrEqual(44);
	await clear.click();
	await expect(owner).toHaveValue("");
	await expect(owner).toBeFocused();
	await expect(owner).toHaveAttribute("aria-expanded", "true");
	await expect(
		page.getByRole("listbox", { name: "共同 Owner 用户搜索结果" }),
	).toBeVisible();
	await expect(clear).toHaveCount(0);
	await capture(page, info, "directory-picker-open");

	// Tab 依次穿过三个选择器：不经过候选或「清空搜索」，同一时刻最多一个结果层。
	const focusState = () =>
		page.evaluate(() => {
			const active = document.activeElement as HTMLElement | null;
			const box = active?.getBoundingClientRect();
			const hit =
				box &&
				document.elementFromPoint(
					box.left + box.width / 2,
					box.top + box.height / 2,
				);
			const controls = active?.getAttribute("aria-controls");
			return {
				label: active?.getAttribute("aria-label"),
				role: active?.getAttribute("role"),
				hitSelf: hit === active,
				listboxes: [...document.querySelectorAll('[role="listbox"]')].filter(
					(node) => node.getBoundingClientRect().height > 0,
				).length,
				optionTabIndexes: [
					...document.querySelectorAll<HTMLElement>('[role="option"]'),
				].map((node) => node.tabIndex),
				controlsExists: Boolean(controls && document.getElementById(controls)),
			};
		});
	for (const [field, label] of [
		[users, "可使用的用户"],
		[organizations, "可使用的组织"],
	] as const) {
		await page.keyboard.press("Tab");
		await expect(field).toBeFocused();
		await expect(field).toHaveAttribute("aria-expanded", "true");
		// 等结果层真正出现后再取状态，避免在加载中得到空集合。
		await expect(
			page.getByRole("listbox", { name: `${label}搜索结果` }),
		).toBeVisible();
		const state = await focusState();
		expect(state.optionTabIndexes.length).toBeGreaterThan(0);
		expect(state).toMatchObject({
			label,
			role: "combobox",
			hitSelf: true,
			controlsExists: true,
		});
		expect(state.listboxes).toBe(1);
		expect(state.optionTabIndexes.every((index) => index === -1)).toBe(true);
	}
	await expect(owner).toHaveAttribute("aria-expanded", "false");

	const geometry = await page.evaluate(() => ({
		input: document.querySelector(".directory-input")?.getBoundingClientRect()
			.height,
		chip: document.querySelector(".directory-chip")?.getBoundingClientRect()
			.height,
		remove: [...document.querySelectorAll(".directory-chip-remove")].map(
			(node) => {
				const box = node.getBoundingClientRect();
				return [box.width, box.height];
			},
		),
	}));
	expect(geometry.input).toBe(30);
	// 设计稿 #owner-config 同视口实测 chip 高 36px（移除钮负外边距抵消 44px 命中区）。
	expect(Math.abs((geometry.chip ?? 0) - 36)).toBeLessThanOrEqual(0.5);
	expect(geometry.remove).toEqual([[44, 44]]);
});

async function expectLocalTimes(page: Page) {
	const times = page.locator("main time");
	await expect(times.first()).toBeVisible();
	const values = await times.evaluateAll((nodes) =>
		nodes.map((node) => ({
			dateTime: node.getAttribute("datetime"),
			title: node.getAttribute("title"),
			text: node.textContent ?? "",
		})),
	);
	expect(values.length).toBeGreaterThan(0);
	for (const value of values) {
		expect(value.dateTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(value.title).toMatch(
			/^\d{4} 年 \d{1,2} 月 \d{1,2} 日 \d{2}:\d{2}:\d{2}$/,
		);
		expect(value.text).toMatch(
			/^(刚刚|今天 \d{2}:\d{2}|昨天 \d{2}:\d{2}|\d{1,2} 月 \d{1,2} 日|\d{4} 年 \d{1,2} 月 \d{1,2} 日( \d{2}:\d{2})?)$/,
		);
	}
	await expect(page.locator("main")).not.toContainText(
		/\d{4}-\d{2}-\d{2}T\d{2}:/,
	);
}

test("my Agents and application detail show local times with full titles", async ({
	page,
}) => {
	await fixture(page);
	await page.goto("/my-agents");
	await expectLocalTimes(page);
	await page.goto("/my-agents/application-browser-1");
	await expectLocalTimes(page);
});

test("approvals show local submitted times with full titles", async ({
	page,
}) => {
	await fixture(page, "admin");
	await page.goto("/admin/approvals");
	await expect(
		page.getByRole("button", { name: /^审阅：/ }).first(),
	).toBeVisible();
	await expectLocalTimes(page);
});

test("editing an application keeps 44px chip remove targets", async ({
	page,
}) => {
	await fixture(page);
	await page.goto("/my-agents/application-browser-1/edit");
	await expect(
		page.getByRole("button", { name: /^移除 / }).first(),
	).toBeVisible();
	const sizes = await page
		.locator(".directory-chip-remove")
		.evaluateAll((nodes) =>
			nodes.map((node) => {
				const box = node.getBoundingClientRect();
				return `${box.width}x${box.height}`;
			}),
		);
	expect(sizes.length).toBeGreaterThan(0);
	expect(new Set(sizes)).toEqual(new Set(["44x44"]));
	await expect(page.locator("main")).not.toContainText(
		/目录记录不可用|无法读取目录详情|user-applicant-1/,
	);
});

test("Owner configuration keeps the co-Owner picker within 720px and scopes in columns", async ({
	page,
}) => {
	await fixture(page);
	await page.goto("/agents/agent-pilot-1/configuration");
	await expect(
		page.getByRole("button", { name: "移除 当前 Owner" }),
	).toBeVisible();
	const layout = await page.evaluate(() => {
		const box = (id: string) =>
			document
				.getElementById(id)
				?.closest(".directory-field")
				?.getBoundingClientRect();
		const owner = box("configuration-owner-ids");
		const users = box("configuration-user-availability");
		const organizations = box("configuration-organization-availability");
		return {
			viewport: innerWidth,
			owner: owner?.width ?? 0,
			sameRow:
				Boolean(users && organizations) && users?.top === organizations?.top,
			remove: [...document.querySelectorAll(".directory-chip-remove")].map(
				(node) => {
					const rect = node.getBoundingClientRect();
					return `${rect.width}x${rect.height}`;
				},
			),
		};
	});
	expect(layout.owner).toBeGreaterThan(0);
	expect(layout.owner).toBeLessThanOrEqual(720);
	// 1440 桌面「可使用的用户 / 组织」两列；390 窄屏单列。
	expect(layout.sameRow).toBe(layout.viewport > 767);
	expect(layout.remove.length).toBeGreaterThan(0);
	expect(new Set(layout.remove)).toEqual(new Set(["44x44"]));
	await expect(page.locator("main")).not.toContainText(
		/grant\/revoke|推断完整授权列表/,
	);
});

test("Owner configuration names records missing from the directory with the Agent projection", async ({
	page,
}) => {
	await fixture(page);
	await page.route("**/api/v2/directory/search?**", (route) =>
		route.fulfill({
			json: directorySearchResponse(new URL(route.request().url()), []),
		}),
	);
	await page.goto("/agents/agent-pilot-1/configuration");
	await expect(page.getByRole("button", { name: "移除 Owner" })).toBeVisible();
	await expect(page.getByText("目录中暂未找到该记录")).toHaveCount(2);
	await expect(
		page.getByRole("button", { name: "移除 未识别的组织 1" }),
	).toBeVisible();
	await expect(page.locator("main")).not.toContainText(
		/目录记录不可用|无法读取目录详情|user-owner-1|org-platform/,
	);
});

test("Agent detail directory failure stays readable and configuration preserves existing IDs", async ({
	page,
}, info) => {
	const api = await fixture(page);
	await page.route("**/api/v2/directory/search?**", (route) =>
		route.fulfill({ status: 503, json: {} }),
	);
	await page.goto("/agents/agent-pilot-1");
	await expect(page.getByText("目录暂时无法读取")).toBeVisible();
	await expect(page.getByRole("alert")).toHaveCount(1);
	await expect(
		page.getByRole("button", { name: "重新读取目录" }),
	).toBeVisible();
	await expect(page.locator("main")).not.toContainText("org-platform");
	await capture(page, info, "directory-detail-error");
	await page.getByRole("link", { name: "Owner 配置" }).click();
	// 目录不可用时 Owner chip 仍显示 Agent 投影中的显示名，降级说明不进入按钮名称。
	await expect(page.getByText("目录详情暂时无法读取")).toHaveCount(2);
	await expect(page.getByRole("button", { name: "移除 Owner" })).toBeVisible();
	// 读取失败不等于记录不存在：组织用中性占位，不说「未识别」（acc-3 新问题 3）。
	await expect(
		page.getByRole("button", { name: "移除 组织 1", exact: true }),
	).toBeVisible();
	await expect(page.locator("main")).not.toContainText("未识别");
	await expect(page.locator("main")).not.toContainText(
		/目录记录不可用|无法读取目录详情|grant\/revoke|推断完整授权列表/,
	);
	await page.getByRole("combobox", { name: "共同 Owner 用户" }).fill("owner");
	await expect(page.getByText("目录暂时无法读取")).toBeVisible();
	await page.keyboard.press("Enter");
	// 只看目录选择器的候选；环境变量名下拉的原生 option 不属于这里（O-10）。
	await expect(page.getByRole("listbox").getByRole("option")).toHaveCount(0);
	await page.keyboard.press("Escape");
	await capture(page, info, "directory-configuration-error");
	// 没有任何改动时保存不可用（#2560）：先做一次与 Owner、范围无关的真实改动，
	// 再确认目录读取失败时未解析的选择仍随请求原样提交。
	await expect(page.getByRole("button", { name: "保存配置" })).toBeDisabled();
	await page.getByLabel("值", { exact: true }).fill("changed-value");
	await page.getByRole("button", { name: "保存配置" }).click();
	await expect(toastHost(page)).toHaveText("配置已保存，Secret 值不会回显");
	expect(api.commands.at(-1)?.body).toMatchObject({
		coOwnerIds: ["user-owner-1"],
		availability: [{ kind: "organization", organizationId: "org-platform" }],
	});
});

test("application form fields, selects, sections and small actions follow the exported design", async ({
	page,
}) => {
	await fixture(page);
	await page.goto("/my-agents/new");
	const name = page.getByLabel("Agent 名称");
	await expect(name).toBeVisible();
	// B-04 字段标签、B-05 输入框与 Textarea。
	await expectFieldLabel(
		page,
		page.locator("label", { hasText: "Agent 名称" }),
	);
	await expectFieldControl(page, name);
	// B-05 焦点：输入框与 Textarea 都是 26% 透明 accent 描边加 accent 边框。
	await expectFieldFocus(page, name);
	await expectFieldFocus(page, page.getByLabel("用途说明", { exact: true }));
	expect(
		await computed(page.getByLabel("用途说明", { exact: true }), [
			"minHeight",
			"padding",
			"borderTopLeftRadius",
		]),
	).toEqual({
		minHeight: "110px",
		padding: "10px 12px",
		borderTopLeftRadius: "10px",
	});

	// B-06 下拉：触发器与输入框同尺寸，右侧 40px 给箭头；弹层在触发器下方、无动画。
	const source = page.getByRole("combobox", { name: "Agent 来源" });
	await expectFieldControl(page, source);
	// 同一行右侧字段带说明文字更高时，标签与控件仍保持 7px 间距（Field 不拉伸行高）。
	const [sourceLabel, sourceTrigger] = await Promise.all([
		page.locator("label", { hasText: "来源" }).first().boundingBox(),
		source.boundingBox(),
	]);
	if (!sourceLabel || !sourceTrigger) throw new Error("Missing source field");
	expect(
		Math.abs(sourceTrigger.y - (sourceLabel.y + sourceLabel.height) - 7),
	).toBeLessThanOrEqual(1);
	expect((await computed(source, ["paddingRight"])).paddingRight).toBe("40px");
	// 触发器在视口中部时下方空间足够，弹层应从触发器下方弹出。
	await source.evaluate((element) =>
		element.scrollIntoView({ block: "center" }),
	);
	await source.click();
	const popup = page.locator('[data-slot="select-content"]');
	await expect(popup).toBeVisible();
	expect(
		await computed(popup, [
			"borderTopLeftRadius",
			"boxShadow",
			"animationName",
		]),
	).toEqual({
		borderTopLeftRadius: "12px",
		boxShadow: await resolved(page, "boxShadow", "var(--surface-shadow)"),
		animationName: "none",
	});
	const [trigger, menu] = await Promise.all([
		source.boundingBox(),
		popup.boundingBox(),
	]);
	expect(menu?.y ?? 0).toBeGreaterThanOrEqual(
		(trigger?.y ?? 0) + (trigger?.height ?? 0),
	);
	const option = page.getByRole("option").first();
	const optionStyle = await computed(option, [
		"fontSize",
		"borderTopLeftRadius",
	]);
	expect(optionStyle).toEqual({ fontSize: "13px", borderTopLeftRadius: "8px" });
	const optionBox = await option.boundingBox();
	if (!optionBox) throw new Error("Missing option geometry");
	expect(optionBox.height).toBeGreaterThanOrEqual(44);
	await page.keyboard.press("ArrowDown");
	const highlighted = popup.locator(
		'[data-slot="select-item"][data-highlighted]',
	);
	await expect(highlighted).toHaveCount(1);
	expect(
		(await computed(highlighted, ["backgroundColor"])).backgroundColor,
	).toBe(await resolved(page, "backgroundColor", "var(--muted)"));
	await page.keyboard.press("Escape");
	await expect(popup).toBeHidden();

	// N-10 分区：section + h2，分隔线在标题上方，没有压线的 legend。
	await expectFormSection(page, "基本信息", { first: true });
	await expectFormSection(page, "共同 Owner 与使用范围");
	await expectNoLegendOnBorder(page);

	// B-15 / N-14：sm 尺寸至少 44px，内边距与字号按 .btn-sm；按下下移 1px 且有 60ms 过渡。
	const toggle = page.getByRole("button", { name: "展开高级配置" });
	expect(
		await computed(toggle, [
			"minHeight",
			"minWidth",
			"paddingTop",
			"paddingLeft",
			"fontSize",
		]),
	).toEqual({
		minHeight: "44px",
		// 纯图标的 sm 按钮也保持 44px 命中宽度（原全局 min-width 规则已删除）。
		minWidth: "44px",
		paddingTop: "7px",
		paddingLeft: "11px",
		fontSize: "12px",
	});
	expect((await toggle.boundingBox())?.height).toBe(44);
	expect(
		(await computed(toggle, ["transitionDuration"])).transitionDuration,
	).toContain("0.06s");
	await toggle.scrollIntoViewIfNeeded();
	const box = await toggle.boundingBox();
	if (!box) throw new Error("Missing toggle geometry");
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.down();
	// 按下后经 60ms 过渡下移 1px。
	await expect
		.poll(async () => (await computed(toggle, ["transform"])).transform)
		.toBe("matrix(1, 0, 0, 1, 0, 1)");
	await page.mouse.up();
	await expect(
		page.getByRole("button", { name: "收起高级配置" }),
	).toHaveAttribute("aria-expanded", "true");
});

test("Owner configuration sections, option checkboxes, back link and disabled save follow the exported design", async ({
	page,
}) => {
	await fixture(page);
	await page.goto("/agents/agent-pilot-1/configuration");
	// O-03：表单卡首节是「Agent 授权控制」（无上边线与上内边距）；共同 Owner、可用范围按设计命名。
	await expect(
		page.getByRole("region", { name: "共同 Owner", exact: true }),
	).toBeVisible();
	await expectFormSection(page, "Agent 授权控制", { first: true });
	// 模型与凭证、Agent 默认 Relay Key、Skill、环境变量与 Secret 按设计命名（G-08、O-02、O-10）。
	// 分区按设计 #owner-config 的顺序：模型与凭证、Agent 默认 Relay Key 在渠道之前（acc-5 新问题 5）。
	const sectionOrder = [
		"共同 Owner",
		"可用范围",
		"模型与凭证",
		"Agent 默认 Relay Key",
		// W-17：设计 #owner-config 分区标题为「渠道」。
		"渠道",
		"Skill",
		"环境变量与 Secret",
	];
	for (const name of sectionOrder) await expectFormSection(page, name);
	await expect(
		page.locator(
			'.configuration-form-card form [data-slot="form-section-title"]',
		),
	).toHaveText(sectionOrder);
	await expectNoLegendOnBorder(page);

	// B-15：未改动时保存不可用；禁用按钮 not-allowed、半透明，且不靠 pointer-events: none。
	const save = page.getByRole("button", { name: "保存配置" });
	await expect(save).toBeDisabled();
	expect(await computed(save, ["cursor", "opacity", "pointerEvents"])).toEqual({
		cursor: "not-allowed",
		opacity: "0.48",
		pointerEvents: "auto",
	});

	// B-07：复选框 18×18、圆角 4px、命中区 44×44；选项文字 13px / 400 / 前景色、行高 ≥44px。
	const replaceModels = page.getByRole("checkbox", { name: "替换模型配置" });
	const optionLabel = page.locator('label[data-variant="option"]', {
		hasText: "替换模型配置",
	});
	expect(
		await computed(optionLabel, ["fontSize", "fontWeight", "color"]),
	).toEqual({
		fontSize: "13px",
		fontWeight: "400",
		color: await resolved(page, "color", "var(--foreground)"),
	});
	expect((await optionLabel.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(
		44,
	);
	const checkbox = await replaceModels.boundingBox();
	expect([checkbox?.width, checkbox?.height]).toEqual([18, 18]);
	expect(
		(await computed(replaceModels, ["borderTopLeftRadius"]))
			.borderTopLeftRadius,
	).toBe("4px");
	const hitArea = await computed(
		replaceModels,
		["top", "left", "position"],
		"::after",
	);
	expect(hitArea).toEqual({
		top: "-13px",
		left: "-13px",
		position: "absolute",
	});
	await replaceModels.click();
	await expect(replaceModels).toBeChecked();
	// 复选框底色带颜色过渡，等过渡结束再读取。
	await expect
		.poll(
			async () =>
				(await computed(replaceModels, ["backgroundColor"])).backgroundColor,
		)
		.toBe(await resolved(page, "backgroundColor", "var(--primary)"));

	// B-15：返回入口是 ghost sm（与同尺寸按钮同高），不是带下划线的 link 变体。
	const back = page.getByRole("link", { name: "返回 Agent 详情" });
	expect(
		await computed(back, [
			"minHeight",
			"paddingLeft",
			"fontSize",
			"textDecorationLine",
		]),
	).toEqual({
		minHeight: "44px",
		paddingLeft: "11px",
		fontSize: "12px",
		textDecorationLine: "none",
	});
});

test("my Agent tabs use one underline style with pointer cursor and body-size panels", async ({
	page,
}) => {
	await fixture(page);
	await page.goto("/my-agents");
	const applications = page.getByRole("tab", { name: "申请 1", exact: true });
	const owned = page.getByRole("tab", { name: "已创建", exact: true });
	await expect(applications).toHaveAttribute("aria-selected", "true");
	for (const tab of [applications, owned]) {
		expect(await computed(tab, ["fontSize", "fontWeight", "cursor"])).toEqual({
			fontSize: "13px",
			fontWeight: "650",
			cursor: "pointer",
		});
		const tabBox = await tab.boundingBox();
		if (!tabBox) throw new Error("Missing tab geometry");
		expect(tabBox.height).toBeGreaterThanOrEqual(44);
		expect((await computed(tab, ["content"], "::after")).content).toBe("none");
	}
	expect(
		await computed(applications, [
			"borderBottomWidth",
			"borderBottomColor",
			"color",
		]),
	).toEqual({
		borderBottomWidth: "2px",
		borderBottomColor: await resolved(page, "color", "var(--accent-ink)"),
		color: await resolved(page, "color", "var(--foreground)"),
	});
	expect(await computed(owned, ["borderBottomColor", "color"])).toEqual({
		borderBottomColor: "rgba(0, 0, 0, 0)",
		color: await resolved(page, "color", "var(--muted-foreground)"),
	});
	expect(
		(await computed(page.getByRole("tabpanel"), ["fontSize"])).fontSize,
	).toBe("15px");
	// N-14：申请标题不再是 23px 高的链接，详情入口「查看申请」至少 44px。
	const detail = page.getByRole("link", { name: "查看申请" }).first();
	const detailBox = await detail.boundingBox();
	expect(detailBox).not.toBeNull();
	expect(detailBox?.height).toBeGreaterThanOrEqual(44);
});

test("an unselected my Agent tab turns foreground on hover", async ({
	page,
}, info) => {
	// 触屏项目没有悬停能力（Tailwind hover 只在 hover: hover 媒体下生效）。
	test.skip(info.project.name !== "desktop", "Hover needs a pointer device");
	await fixture(page);
	await page.goto("/my-agents");
	const owned = page.getByRole("tab", { name: "已创建", exact: true });
	await owned.hover();
	await expect
		.poll(async () => (await computed(owned, ["color"])).color)
		.toBe(await resolved(page, "color", "var(--foreground)"));
});

test("approval table becomes readable cards on narrow screens with the review action in view", async ({
	page,
}) => {
	await fixture(page, "admin");
	await page.goto("/admin/approvals");
	const table = page.getByRole("table", { name: "创建审批" });
	await expect(table).toBeVisible();
	// F-05：首列只有申请名称，没有状态徽章（NI-99 的徽章几何断言随之迁到 admin-agents.spec.ts 的状态 chip）。
	await expect(
		table.locator("tbody td:first-child [data-slot=badge]"),
	).toHaveCount(0);
	for (const viewport of [
		{ width: 1440, height: 900 },
		{ width: 768, height: 1024 },
	]) {
		await page.setViewportSize(viewport);
		await expectDesktopTable(page, table);
	}
	for (const viewport of [
		{ width: 390, height: 844 },
		{ width: 320, height: 640 },
	]) {
		await page.setViewportSize(viewport);
		const review = page.getByRole("button", { name: /^审阅：/ });
		// 页头改为设计稿单行标题「审批申请」后，320 宽下按钮纵向落在 .25px 的位置；
		// scrollIntoViewIfNeeded 按整数像素贴底会裁掉 0.25px。先把按钮滚到视口中部，
		// 下面仍断言无横向滚动且按钮完整可见。
		await review.evaluate((element) =>
			element.scrollIntoView({ block: "center" }),
		);
		await expectCardTable(page, table, review);
	}
});

test("approval filters, columns and page chrome follow the exported design", async ({
	page,
}) => {
	const pageErrors = trackPageErrors(page);
	await fixture(page, "admin");
	await page.goto("/admin/approvals");
	const table = page.getByRole("table", { name: "创建审批" });
	await expect(table).toBeVisible();
	const main = page.locator("main");
	const narrow = test.info().project.name === "mobile";
	// AP-01：四轨 466/204/204/204、gap 10、mb 20；搜索框 18px 图标、无可见 label、底边与「来源」对齐；窄屏单列。
	const filters = main.locator(".approval-filters");
	const grid = await filters.evaluate((element) => {
		const css = getComputedStyle(element);
		return {
			columns: css.gridTemplateColumns
				.split(" ")
				.map((value) => Math.round(Number.parseFloat(value))),
			gap: css.columnGap,
			marginBottom: css.marginBottom,
		};
	});
	if (narrow) expect(grid.columns).toHaveLength(1);
	else {
		expect(grid.columns).toHaveLength(4);
		for (const [index, width] of [466, 204, 204, 204].entries())
			expect(Math.abs((grid.columns[index] ?? 0) - width)).toBeLessThanOrEqual(
				1,
			);
	}
	expect(grid.gap).toBe("10px");
	expect(grid.marginBottom).toBe("20px");
	const search = page.getByRole("searchbox", { name: "搜索申请" });
	await expectSearchInput(search);
	// F-05：设计 placeholder「搜索申请名称或申请人」，申请人来自申请投影 applicant。
	await expect(search).toHaveAttribute("placeholder", "搜索申请名称或申请人");
	// #3037 X-09：「来源」下拉的箭头是设计 .select 的背景小三角。
	await expectNativeSelectArrow(page, page.getByLabel("来源"));
	await expectCleanPage(page, pageErrors);
	if (!narrow) {
		const searchBox = await search.boundingBox();
		const sourceBox = await page.getByLabel("来源").boundingBox();
		expect(
			Math.abs(
				(searchBox?.y ?? 0) +
					(searchBox?.height ?? 0) -
					((sourceBox?.y ?? 0) + (sourceBox?.height ?? 0)),
			),
		).toBeLessThanOrEqual(1);
	}
	// 风险字段尚无数据来源，页面不出现「风险」（AP-01 / AP-02 风险部分待接口）。
	await expect(main.getByText(/风险/)).toHaveCount(0);
	// AP-02：表头、模型只有显示名、提交时间为 time 元素；「审阅」带 16px 图标。
	await expect(table.locator("thead th")).toHaveText([
		"申请",
		"来源 / Owner",
		"可用范围",
		"模型",
		"提交时间",
		"操作",
	]);
	await expect(table).not.toContainText("gpt-5");
	const time = table.locator("tbody time").first();
	expect(await time.getAttribute("datetime")).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	await expect(table).not.toContainText(/\d+\/\d+\/\d{4}/);
	const review = table.getByRole("button", { name: /^审阅：/ }).first();
	expect(
		await review.locator("svg").evaluate((svg) => {
			const box = svg.getBoundingClientRect();
			return [box.width, box.height];
		}),
	).toEqual([16, 16]);
	await expect(page.getByText("审阅申请")).toHaveCount(0);
	// F-05：首列 strong 13px / 700，且没有说明文字。
	const name = table.locator("tbody td:first-child strong").first();
	expect(
		await name.evaluate((element) => [
			getComputedStyle(element).fontSize,
			getComputedStyle(element).fontWeight,
		]),
	).toEqual(["13px", "700"]);
	// F-05：名称下 small 只有「申请人 · 姓名」（设计「编号 · 申请人」，可读编号尚无契约字段），没有说明文字；
	// 样式取设计 td small：块级 11px、muted、上外边距 3px。
	const applicant = table.locator("tbody td:first-child small");
	await expect(applicant).toHaveText(["申请人 · Applicant"]);
	expect(
		await applicant.first().evaluate((element) => {
			const css = getComputedStyle(element);
			return [css.display, css.fontSize, css.marginTop];
		}),
	).toEqual(["block", "11px", "3px"]);
	await expect(applicant.first()).toHaveCSS(
		"color",
		await resolved(page, "color", "var(--muted-foreground)"),
	);
	await expect(table.locator("tbody td:first-child")).not.toContainText(
		"Helps the release team",
	);
	await expect(main.getByText("申请人由当前会话确定")).toHaveCount(0);
	await expect(main.getByText(/application-/)).toHaveCount(0);
	// AP-04 / NI-42：先 amber chip，再 tag（radius 7、透明底、11px、无圆点）。
	const header = main.locator("header.page-heading");
	const badges = header.locator('[data-slot="badge"]');
	await expect(badges).toHaveText(["1 项待处理", "系统管理员 · 只读审计"]);
	await expect(badges.first()).toHaveAttribute("data-tone", "amber");
	const tag = badges.nth(1);
	await expect(tag).toHaveAttribute("data-variant", "tag");
	expect(
		await tag.evaluate((element) => ({
			radius: getComputedStyle(element).borderTopLeftRadius,
			background: getComputedStyle(element).backgroundColor,
			fontSize: getComputedStyle(element).fontSize,
			dot: getComputedStyle(element, "::before").content,
		})),
	).toEqual({
		radius: "7px",
		background: "rgba(0, 0, 0, 0)",
		fontSize: "11px",
		dot: "none",
	});
	// AP-04：page-note 在表格之后，12px、--muted-ink、margin-top 16px、无 role。
	const note = main.getByText(
		"审批只决定平台资源与准入，Connection 授权仍由使用者独立完成。",
	);
	expect(
		await note.evaluate((element) => ({
			fontSize: getComputedStyle(element).fontSize,
			color: getComputedStyle(element).color,
			marginTop: getComputedStyle(element).marginTop,
			role: element.getAttribute("role"),
		})),
	).toEqual({
		fontSize: "12px",
		color: await resolved(page, "color", "var(--muted-ink)"),
		marginTop: "16px",
		role: null,
	});
});

// 设计基础组件（chip / tag / notice / empty / card / Agent 标识 / 加载态 / 弹窗）的计算样式。
async function resolvedColor(page: Page, expression: string) {
	return page.evaluate((value) => {
		const probe = document.createElement("span");
		probe.style.color = value;
		document.body.append(probe);
		const color = getComputedStyle(probe).color;
		probe.remove();
		return color;
	}, expression);
}

// 危险确认按钮的底色：当前为 --destructive，tokens 流合并后为 --danger-ink。
async function dangerFills(page: Page) {
	return [
		await resolvedColor(page, "var(--destructive)"),
		await resolvedColor(page, "var(--danger-ink)"),
	];
}

test("status chips, tags, Agent marks and catalog cards follow the design primitives", async ({
	page,
}, info) => {
	test.skip(
		info.project.name !== "desktop",
		"Hover geometry is measured at 1440",
	);
	await page.setViewportSize({ width: 1440, height: 900 });
	await fixture(page, "employee");
	await page.goto("/agents");
	const card = page.locator('[data-slot="card"].directory-card').first();
	await expect(card).toBeVisible();
	const chips = page.locator('main [data-slot="badge"][data-variant="chip"]');
	expect(await chips.count()).toBeGreaterThan(0);
	for (const chip of await chips.all()) {
		const style = await chip.evaluate((element) => {
			const computed = getComputedStyle(element);
			const dot = getComputedStyle(element, "::before");
			return {
				fontSize: computed.fontSize,
				fontWeight: computed.fontWeight,
				lineHeight: computed.lineHeight,
				minHeight: computed.minHeight,
				height: element.getBoundingClientRect().height,
				padding: computed.padding,
				radius: Number.parseFloat(computed.borderTopLeftRadius),
				color: computed.color,
				dotWidth: dot.width,
				dotHeight: dot.height,
				dotColor: dot.backgroundColor,
			};
		});
		expect(style).toMatchObject({
			fontSize: "11px",
			fontWeight: "400",
			lineHeight: "18.15px",
			minHeight: "24px",
			padding: "3px 9px",
			dotWidth: "6px",
			dotHeight: "6px",
		});
		expect(Math.abs(style.height - 26.15)).toBeLessThanOrEqual(0.5);
		expect(style.radius).toBeGreaterThanOrEqual(999);
		expect(style.dotColor).toBe(style.color);
	}
	// A-02：目录卡只有一个派生可用性 chip（可用 + 启动中 → 「启动中」amber）；
	// green tone 的颜色在 catalog-search.spec 的状态矩阵中验证。
	const cardChips = card.locator('[data-slot="badge"][data-variant="chip"]');
	await expect(cardChips).toHaveText(["启动中"]);
	await expect(cardChips).toHaveCSS(
		"color",
		await resolvedColor(page, "var(--warning-ink)"),
	);
	await expect(cardChips).toHaveCSS(
		"background-color",
		await resolvedColor(
			page,
			"color-mix(in oklch, var(--warning) 10%, var(--surface))",
		),
	);
	const tags = card.locator('[data-slot="badge"][data-variant="tag"]');
	expect(await tags.count()).toBeGreaterThan(0);
	for (const tag of await tags.all()) {
		await expect(tag).toHaveCSS("border-top-left-radius", "7px");
		await expect(tag).toHaveCSS("padding", "3px 8px");
		await expect(tag).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
		await expect(tag).toHaveCSS(
			"color",
			await resolvedColor(page, "var(--muted-foreground)"),
		);
		expect(
			await tag.evaluate(
				(element) => getComputedStyle(element, "::before").content,
			),
		).toBe("none");
	}
	// 设计没有实心主色徽章，也没有 oklch(0.205 0 0) 文字（检测器 R8）。
	const filled = await page.evaluate(() => {
		const probe = document.createElement("span");
		probe.style.color = "var(--accent)";
		document.body.append(probe);
		const accent = getComputedStyle(probe).color;
		probe.style.color = "oklch(0.205 0 0)";
		const darkInk = getComputedStyle(probe).color;
		probe.remove();
		return Array.from(document.querySelectorAll('[data-slot="badge"]')).filter(
			(element) => {
				const style = getComputedStyle(element);
				return style.backgroundColor === accent || style.color === darkInk;
			},
		).length;
	});
	expect(filled).toBe(0);

	const mark = card.locator('[data-slot="agent-mark"]');
	await expect(mark).toHaveAttribute("aria-hidden", "true");
	await expect(mark).toHaveCSS("width", "42px");
	await expect(mark).toHaveCSS("height", "42px");
	await expect(mark).toHaveCSS("border-top-left-radius", "12px");
	await expect(mark).toHaveCSS("font-size", "19px");
	await expect(mark).toHaveCSS("font-weight", "400");
	await expect(mark).toHaveCSS("font-family", /Iowan Old Style/);
	await expect(mark.locator("svg")).toHaveCount(0);
	await expect(mark).toHaveText(/^\S$/u);

	await expect(card).toHaveCSS("padding", "18px");
	await expect(card).toHaveCSS("border-top-left-radius", "14px");
	await expect(card).toHaveCSS("box-shadow", "none");
	await expect(card).toHaveCSS(
		"border-top-color",
		await resolvedColor(page, "var(--border)"),
	);
	expect(
		await card.evaluate((element) => {
			const style = getComputedStyle(element);
			// 时长列表按属性列表循环取值。
			const durations = style.transitionDuration.split(",");
			return Object.fromEntries(
				style.transitionProperty
					.split(",")
					.map((property, index) => [
						property.trim(),
						durations[index % durations.length]?.trim(),
					]),
			);
		}),
	).toMatchObject({ "border-color": "0.18s", "box-shadow": "0.18s" });
	await card.hover();
	await expect(card).toHaveCSS(
		"border-top-color",
		await resolvedColor(
			page,
			"color-mix(in oklch, var(--accent) 30%, var(--border))",
		),
	);
	await expect(card).toHaveCSS("box-shadow", /0px 8px 24px 0px$/);
	await capture(page, info, "design-primitives-directory");
});

test("workbench Agent cards hover while panel rows stay flat", async ({
	page,
}, info) => {
	test.skip(
		info.project.name !== "desktop",
		"Hover geometry is measured at 1440",
	);
	await page.setViewportSize({ width: 1440, height: 900 });
	await fixture(page, "owner");
	await page.goto("/");
	const card = page.locator('[data-slot="card"].workbench-card').first();
	await expect(card).toBeVisible();
	await card.hover();
	await expect(card).toHaveCSS("box-shadow", /0px 8px 24px 0px$/);
	await expect(card.locator('[data-slot="agent-mark"]')).toHaveCount(1);
	const row = page.locator(".workbench-application-row").first();
	await expect(row).toBeVisible();
	await expect(row).not.toHaveAttribute("data-slot", "card");
	const before = await row.evaluate((element) => {
		const style = getComputedStyle(element);
		return [style.borderTopColor, style.boxShadow];
	});
	await row.hover();
	expect(
		await row.evaluate((element) => {
			const style = getComputedStyle(element);
			return [style.borderTopColor, style.boxShadow];
		}),
	).toEqual(before);
	expect(before[1]).toBe("none");
});

test("loading lines show the design spinner while reads are pending", async ({
	page,
}) => {
	await fixture(page, "employee");
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route(/\/api\/v2\/agents(\?.*)?$/, async (route) => {
		await gate;
		await route.fallback();
	});
	await page.goto("/agents");
	const line = page.locator('[data-slot="loading-line"]', {
		hasText: "正在加载 Agent…",
	});
	await expect(line).toBeVisible();
	await expect(line).toHaveAttribute("role", "status");
	await expect(line).toHaveCSS("display", "flex");
	await expect(line).toHaveCSS("column-gap", "9px");
	await expect(line).toHaveCSS("font-size", "13px");
	await expect(line).toHaveCSS(
		"color",
		await resolvedColor(page, "var(--muted-foreground)"),
	);
	const spinner = line.locator('[data-slot="spinner"]');
	await expect(spinner).toHaveAttribute("aria-hidden", "true");
	await expect(spinner).toHaveCSS("width", "15px");
	await expect(spinner).toHaveCSS("height", "15px");
	await expect(spinner).toHaveCSS("border-top-width", "2px");
	await expect(spinner).toHaveCSS(
		"border-top-color",
		await resolvedColor(page, "var(--accent-ink)"),
	);
	await expect(spinner).toHaveCSS(
		"border-right-color",
		await resolvedColor(page, "var(--border)"),
	);
	await expect(spinner).toHaveCSS("animation-duration", "0.8s");
	await expect(spinner).toHaveCSS("animation-iteration-count", "infinite");
	release?.();
	await expect(line).toHaveCount(0);
});

test("read failures use a danger notice with role=alert and muted text", async ({
	page,
}) => {
	const api = await fixture(page, "employee");
	// Agent 目录改用设计 state-card（A-03），notice 原语在「我的 Agent」申请读取失败上验证。
	api.unavailableApplications();
	await page.goto("/my-agents");
	const notice = page.getByRole("alert");
	await expect(notice).toContainText("暂时无法读取申请");
	await expect(notice).toHaveCSS("display", "flex");
	await expect(notice).toHaveCSS("column-gap", "10px");
	await expect(notice).toHaveCSS("padding", "13px 14px");
	await expect(notice).toHaveCSS("border-top-left-radius", "12px");
	await expect(notice).toHaveCSS("font-size", "13px");
	await expect(notice).toHaveCSS(
		"background-color",
		await resolvedColor(page, "var(--surface)"),
	);
	const icon = notice.locator(":scope > svg");
	await expect(icon).toHaveCSS("width", "17px");
	await expect(icon).toHaveCSS("margin-top", "2px");
	await expect(icon).toHaveCSS(
		"color",
		await resolvedColor(page, "var(--danger)"),
	);
	const description = notice.locator('[data-slot="alert-description"]');
	await expect(description).toHaveCSS("font-size", "13px");
	await expect(description).toHaveCSS("line-height", "21.45px");
	await expect(description).toHaveCSS(
		"color",
		await resolvedColor(page, "var(--muted-foreground)"),
	);
	await expect(
		notice.getByRole("button", { name: "重新加载申请" }),
	).toBeVisible();
});

test("empty states use the design surface and a non-display title", async ({
	page,
}) => {
	await fixture(page, "employee");
	await page.goto("/my-agents");
	await page.getByRole("tab", { name: "已创建", exact: true }).click();
	const empty = page.locator('[data-slot="empty"]', {
		hasText: "暂无你管理的 Agent",
	});
	await expect(empty).toBeVisible();
	await expect(empty).toHaveCSS("display", "grid");
	await expect(empty).toHaveCSS("min-height", "220px");
	await expect(empty).toHaveCSS("padding", "28px");
	await expect(empty).toHaveCSS("border-top-style", "dashed");
	await expect(empty).toHaveCSS("border-top-width", "1px");
	await expect(empty).toHaveCSS("border-top-left-radius", "14px");
	const title = empty.locator('[data-slot="empty-title"]');
	expect(await title.evaluate((element) => element.tagName)).toBe("STRONG");
	await expect(title).toHaveCSS("font-size", "15px");
	await expect(title).toHaveCSS("font-weight", "700");
	await expect(title).not.toHaveCSS("font-family", /Iowan Old Style/);
	await expect(title).toHaveCSS(
		"color",
		await resolvedColor(page, "var(--foreground)"),
	);
	await expect(empty.locator('[data-slot="empty-description"]')).toHaveCSS(
		"font-size",
		"13px",
	);
});

test("confirmation dialogs follow the design modal geometry and focus contract", async ({
	page,
}, info) => {
	const api = await fixture(page);
	const mobile = info.project.name === "mobile";
	await page.goto("/my-agents/application-browser-1");
	const trigger = page.getByRole("button", { name: "撤回申请" });
	await trigger.click();
	const dialog = page.getByRole("dialog", { name: "撤回这条申请？" });
	await expect(dialog).toBeVisible();
	await expect(dialog).toHaveAttribute("aria-modal", "true");
	await expect(dialog).toBeFocused();
	await page.keyboard.press("Enter");
	expect(api.commands).toHaveLength(0);
	const viewport = page.viewportSize();
	const box = await dialog.boundingBox();
	expect(box).not.toBeNull();
	expect(
		Math.abs((box?.width ?? 0) - Math.min((viewport?.width ?? 0) - 40, 620)),
	).toBeLessThanOrEqual(1);
	const padding = mobile ? "19px" : "24px";
	await expect(dialog).toHaveCSS("padding", padding);
	await expect(dialog).toHaveCSS("border-top-left-radius", "16px");
	await expect(dialog).toHaveCSS("border-top-width", "1px");
	await expect(dialog).toHaveCSS(
		"border-top-color",
		await resolvedColor(page, "var(--border)"),
	);
	await expect(dialog).toHaveCSS("box-shadow", /0px 24px 80px 0px$/);
	const backdrop = page.locator('[data-slot="dialog-overlay"]');
	await expect(backdrop).toHaveCSS("z-index", "80");
	await expect(backdrop).toHaveCSS("backdrop-filter", "none");
	await expect(backdrop).toHaveCSS(
		"background-color",
		await resolvedColor(
			page,
			"color-mix(in oklch, var(--foreground) 36%, transparent)",
		),
	);
	const title = dialog.getByRole("heading", { name: "撤回这条申请？" });
	await expect(title).toHaveCSS("font-size", "19px");
	await expect(title).toHaveCSS("font-weight", "620");
	await expect(title).toHaveCSS("line-height", "25.65px");
	await expect(title).not.toHaveCSS("font-family", /Iowan Old Style/);
	const close = dialog.getByRole("button", { name: "关闭" });
	await expect(close).toHaveCount(1);
	await expect(close).toHaveCSS("position", "static");
	const closeBox = await close.boundingBox();
	expect(closeBox?.width).toBe(44);
	expect(closeBox?.height).toBe(44);
	if (!mobile) {
		expect(
			Math.abs((closeBox?.x ?? 0) - (box?.x ?? 0) - 551),
		).toBeLessThanOrEqual(1);
		expect(
			Math.abs((closeBox?.y ?? 0) - (box?.y ?? 0) - 25),
		).toBeLessThanOrEqual(1);
	}
	expect(
		await close.evaluate(
			(element) => element.closest('[data-slot="dialog-header"]') !== null,
		),
	).toBe(true);
	const footer = dialog.locator('[data-slot="dialog-footer"]');
	await expect(footer).toHaveCSS("justify-content", "flex-end");
	await expect(footer).toHaveCSS("column-gap", "8px");
	await expect(footer).toHaveCSS("margin-top", "24px");
	const confirm = footer.getByRole("button", { name: "确认撤回" });
	const confirmBox = await confirm.boundingBox();
	expect(
		Math.abs(
			(box?.x ?? 0) +
				(box?.width ?? 0) -
				1 -
				Number.parseFloat(padding) -
				((confirmBox?.x ?? 0) + (confirmBox?.width ?? 0)),
		),
	).toBeLessThanOrEqual(1);
	expect(await dangerFills(page)).toContain(
		await confirm.evaluate(
			(element) => getComputedStyle(element).backgroundColor,
		),
	);
	// 设计稿的撤回弹窗页脚只有「确认撤回」；关闭由页眉的关闭钮承担。
	await expect(footer.getByRole("button")).toHaveCount(1);
	await expect(
		dialog.locator('[data-slot="dialog-header"]').getByRole("button", {
			name: "关闭",
		}),
	).toBeVisible();
	for (const key of ["Tab", "Shift+Tab"]) {
		for (let index = 0; index < 20; index++) {
			await page.keyboard.press(key);
			await expect
				.poll(() =>
					dialog.evaluate((element) =>
						element.contains(document.activeElement),
					),
				)
				.toBe(true);
		}
	}
	await page.keyboard.press("Escape");
	await expect(dialog).not.toBeVisible();
	await expect(trigger).toBeFocused();
	expect(api.commands).toHaveLength(0);
	await capture(page, info, "design-confirmation-dialog");
});

test("lifecycle confirmations use the design titles and button variants", async ({
	page,
}) => {
	await fixture(page);
	await page.goto("/agents/agent-pilot-1/configuration");
	await page.getByRole("button", { name: "停止 Agent" }).click();
	let dialog = page.getByRole("dialog", { name: "停止这个 Agent？" });
	await expect(dialog).toBeVisible();
	await expect(dialog).toHaveAttribute("aria-modal", "true");
	// 正文按设计原文；设计的停止 / 重启弹窗没有对象名行。
	await expect(dialog.locator('[data-slot="dialog-description"]')).toHaveText(
		"停止会释放运行资源，但保留配置、渠道绑定、平台会话历史与用户数据。",
	);
	await expect(
		dialog.locator('[data-slot="confirm-dialog-subject"]'),
	).toHaveCount(0);
	expect(await dangerFills(page)).toContain(
		await dialog
			.getByRole("button", { name: "停止 Agent" })
			.evaluate((element) => getComputedStyle(element).backgroundColor),
	);
	await page.keyboard.press("Escape");
	await expect(dialog).not.toBeVisible();
	await page.getByRole("button", { name: "重启 Agent" }).click();
	// Agent 名以拉丁字母开头时与「重启」之间有一个空格。
	dialog = page.getByRole("dialog", {
		name: "重启 Release assistant？",
		exact: true,
	});
	await expect(dialog).toBeVisible();
	await expect(dialog.locator('[data-slot="dialog-description"]')).toHaveText(
		"重启会短暂释放并重新建立运行实例。历史会话保留，完成后状态会自动回到“就绪”。",
	);
	await expect(
		dialog.locator('[data-slot="confirm-dialog-subject"]'),
	).toHaveCount(0);
	const restartFill = await dialog
		.getByRole("button", { name: "确认重启" })
		.evaluate((element) => getComputedStyle(element).backgroundColor);
	expect([
		await resolvedColor(page, "var(--primary)"),
		await resolvedColor(page, "var(--accent-ink)"),
	]).toContain(restartFill);
});

// ---------------------------------------------------------------------------
// Owner 配置设计对齐（O-03、O-04、O-05、O-11、O-12、N-01、N-02、R4-14、NW-16）。
// ---------------------------------------------------------------------------

const configurationTitle = "配置 Agent 的 Owner、范围和运行方式。";

async function bodyFontFamily(page: Page) {
	return page.evaluate(() => getComputedStyle(document.body).fontFamily);
}

test("Owner configuration follows the design heading, boundary notice and section skeleton", async ({
	page,
}) => {
	await fixture(page);
	await page.goto("/agents/agent-pilot-1/configuration");
	const heading = page.getByRole("heading", { level: 1 });
	await expect(heading).toHaveText(configurationTitle);
	// O-12：设计原文「由 Worker」按 PRD §6.4 / §8.2 写作「由平台」，与 Secret 分区「等待平台激活」一致。
	await expect(page.locator("main .page-heading")).toContainText(
		"保存后由平台更新实例；Secret 只显示状态和版本。",
	);
	// 设计 tag-row：一个可用性 chip（Agent 可用、服务启动中 → 启动中）加一个「Owner · 名称」tag。
	const tagRow = page.locator("main .page-heading .tag-row");
	await expect(
		tagRow.locator('[data-slot="badge"][data-variant="chip"]'),
	).toHaveText(["启动中"]);
	await expect(
		tagRow.locator('[data-slot="badge"][data-variant="tag"]'),
	).toHaveText(["Owner · Owner"]);

	// O-12：返回入口为 ghost sm，图标 16px，href 不变；不被前缀匹配标成当前页。
	const back = page.getByRole("link", { name: "返回 Agent 详情" });
	await expect(back).toHaveAttribute("href", "/agents/agent-pilot-1");
	await expect(back).not.toHaveAttribute("aria-current", /.*/);
	expect(
		await computed(back, [
			"fontSize",
			"paddingTop",
			"paddingLeft",
			"minHeight",
		]),
	).toEqual({
		fontSize: "12px",
		paddingTop: "7px",
		paddingLeft: "11px",
		minHeight: "44px",
	});
	const backIcon = await back.locator("svg").boundingBox();
	expect([backIcon?.width, backIcon?.height]).toEqual([16, 16]);

	// O-05：页头之后紧跟一个权限边界 notice。
	const notice = page.locator('.configuration-notices > [data-slot="alert"]');
	await expect(notice).toHaveCount(1);
	expect(
		await computed(notice, [
			"paddingTop",
			"paddingLeft",
			"borderTopLeftRadius",
			"fontSize",
		]),
	).toEqual({
		paddingTop: "13px",
		paddingLeft: "14px",
		borderTopLeftRadius: "12px",
		fontSize: "13px",
	});
	const noticeIcon = notice.locator("svg");
	await expect(noticeIcon).toHaveAttribute("aria-hidden", "true");
	const iconBox = await noticeIcon.boundingBox();
	expect([iconBox?.width, iconBox?.height]).toEqual([17, 17]);
	expect((await computed(noticeIcon, ["color"])).color).toBe(
		await resolvedColor(page, "var(--accent)"),
	);
	const title = notice.locator('[data-slot="alert-title"]');
	await expect(title).toHaveText("权限边界");
	expect((await computed(title, ["fontWeight"])).fontWeight).toBe("650");
	await expect(notice).toContainText("Connection 授权由使用者自己完成。");
	await expect(page.locator("main")).not.toContainText(
		"配置变更不需要重新审批",
	);

	// O-03：一张表单卡，分区为 section + h2；首节无上边线，相邻分区内容到标题为 22 + 1 + 22。
	const card = page.locator(".configuration-form-card");
	await expect(card).toHaveCount(1);
	// 分区标题不再是 legend；授权控制里「目标类型」的字段组标题仍是 FieldLegend。
	await expect(
		card.locator('legend:not([data-slot="field-legend"])'),
	).toHaveCount(0);
	await expect(page.locator(".form-aside, .lifecycle-panel")).toHaveCount(0);
	const sections = await card.locator('[data-slot="form-section"]').all();
	expect(sections.length).toBeGreaterThanOrEqual(6);
	for (const [index, section] of sections.entries()) {
		expect(
			await computed(section, [
				"paddingTop",
				"paddingBottom",
				"borderTopWidth",
				"borderBottomWidth",
			]),
		).toEqual({
			paddingTop: index === 0 ? "0px" : "22px",
			paddingBottom: "22px",
			borderTopWidth: index === 0 ? "0px" : "1px",
			borderBottomWidth: "0px",
		});
		if (index === 0) continue;
		const gap = await page.evaluate(
			([previous, current]) => {
				const last = previous?.lastElementChild?.getBoundingClientRect();
				const title = current
					?.querySelector('[data-slot="form-section-title"]')
					?.getBoundingClientRect();
				return last && title ? title.top - last.bottom : Number.NaN;
			},
			[
				await sections[index - 1]?.elementHandle(),
				await section.elementHandle(),
			],
		);
		expect(Math.abs(gap - 45), `section ${index}`).toBeLessThanOrEqual(1);
	}
	const fieldset = page.locator('fieldset[aria-label="Agent 配置"]');
	expect(
		await computed(fieldset, ["borderTopWidth", "paddingTop", "paddingLeft"]),
	).toEqual({ borderTopWidth: "0px", paddingTop: "0px", paddingLeft: "0px" });

	// O-03 / O-04：前两个配置分区按设计命名；主内容里所有 h2 都是正文字体 16px / 620、字距 0。
	await expect(
		card.locator('[data-slot="form-section-title"]').nth(1),
	).toHaveText("共同 Owner");
	await expect(
		card.locator('[data-slot="form-section-title"]').nth(2),
	).toHaveText("可用范围");
	const description = card
		.getByRole("region", { name: "共同 Owner", exact: true })
		.locator('[data-slot="form-section-description"]');
	await expect(description).toHaveText(
		"从目录选择共同 Owner；页面不显示内部 ID，提交时保存服务端 ID。",
	);
	expect(await computed(description, ["fontSize", "marginTop"])).toEqual({
		fontSize: "13px",
		marginTop: "5px",
	});
	const bodyFont = await bodyFontFamily(page);
	for (const h2 of await page.locator("#main-content h2").all())
		expect(
			await computed(h2, [
				"fontSize",
				"fontWeight",
				"fontFamily",
				"letterSpacing",
			]),
			await h2.innerText(),
		).toEqual({
			fontSize: "16px",
			fontWeight: "620",
			fontFamily: bodyFont,
			letterSpacing: "normal",
		});
	await expect(page.locator("#main-content")).not.toContainText("生命周期");

	// O-12：授权控制未填写目标时，全部操作都是 outline，不出现浅蓝实心的禁用主按钮。
	const authorization = page.getByRole("region", {
		name: "Agent 授权控制",
		exact: true,
	});
	const outlineFill = await resolved(page, "backgroundColor", "var(--surface)");
	for (const target of ["应用", "用户"]) {
		await authorization
			.getByRole("button", { name: target, exact: true })
			.click();
		const actions = authorization.getByRole("button", { name: /^(授权|撤销)/ });
		await expect(actions).toHaveCount(4);
		for (const action of await actions.all()) {
			await expect(action).toBeDisabled();
			expect(
				(await computed(action, ["backgroundColor"])).backgroundColor,
				await action.innerText(),
			).toBe(outlineFill);
		}
	}
	// 说明动词与手填控件一致，不出现实现用语（NI-26）。
	await expect(authorization).toContainText("填写需要授权的用户或应用标识");
	for (const term of [
		"选择明确的用户或应用",
		"SDK",
		"revoke",
		"grant",
		"revision",
	])
		await expect(page.locator("#main-content")).not.toContainText(term);
});

test("Owner configuration puts restart in the footer and stop in a standalone danger zone", async ({
	page,
}, info) => {
	const api = await fixture(page);
	api.agentState("available", "ready");
	await page.goto("/agents/agent-pilot-1/configuration");
	const card = page.locator(".configuration-form-card");
	const footer = card.locator(".configuration-form-footer");
	const save = footer.getByRole("button", { name: "保存配置" });
	const restart = footer.getByRole("button", { name: "重启 Agent" });
	await expect(restart).toBeVisible();
	await expect(restart.locator("svg")).toHaveAttribute("aria-hidden", "true");
	expect((await computed(restart, ["backgroundColor"])).backgroundColor).toBe(
		await resolved(page, "backgroundColor", "var(--surface)"),
	);
	if (info.project.name === "desktop") {
		const [saveBox, restartBox] = [
			await save.boundingBox(),
			await restart.boundingBox(),
		];
		expect(restartBox?.y).toBe(saveBox?.y);
		expect(
			Math.round(
				(restartBox?.x ?? 0) - ((saveBox?.x ?? 0) + (saveBox?.width ?? 0)),
			),
		).toBe(8);
	}
	// 保存可用时，Tab 从保存移到重启；重启只打开确认，不发配置保存请求。
	await page.getByLabel("值", { exact: true }).fill("synthetic-tab-value");
	await save.focus();
	await page.keyboard.press("Tab");
	await expect(restart).toBeFocused();
	await page.keyboard.press("Enter");
	const restartDialog = page.getByRole("dialog", { name: /^重启.+？$/ });
	await expect(restartDialog).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(restartDialog).toBeHidden();
	expect(api.commands).toEqual([]);

	// 表单卡之后、不在卡内只有一个危险区：设计几何、正文字体 16px 标题、带图标的实心危险按钮。
	const danger = page.getByRole("region", { name: "停止 Agent", exact: true });
	await expect(danger).toHaveCount(1);
	expect(
		await danger.evaluate(
			(element) => element.closest(".configuration-form-card") === null,
		),
	).toBe(true);
	expect(
		await computed(danger, [
			"marginTop",
			"paddingTop",
			"paddingLeft",
			"borderTopLeftRadius",
		]),
	).toEqual({
		marginTop: "16px",
		paddingTop: "18px",
		paddingLeft: "18px",
		borderTopLeftRadius: "14px",
	});
	const dangerTitle = danger.getByRole("heading", { level: 2 });
	expect(await computed(dangerTitle, ["fontSize", "fontFamily"])).toEqual({
		fontSize: "16px",
		fontFamily: await bodyFontFamily(page),
	});
	const dangerCopy = danger.locator("p");
	await expect(dangerCopy).toHaveText(
		"停止会释放运行资源，但保留配置、渠道绑定、平台会话历史与用户数据。停止后历史只读。",
	);
	expect((await computed(dangerCopy, ["fontSize"])).fontSize).toBe("13px");
	const stop = danger.getByRole("button", { name: "停止 Agent" });
	expect(await dangerFills(page)).toContain(
		(await computed(stop, ["backgroundColor"])).backgroundColor,
	);
	// 设计 .card-actions .btn：卡片内操作为 40px 档，不是表单主操作的 44px。
	expect((await computed(stop, ["minHeight"])).minHeight).toBe("40px");
	await expect(stop.locator("svg")).toHaveAttribute("aria-hidden", "true");
	// R4-14：状态只在页头显示，危险区只有标题、说明和按钮。
	for (const text of ["Agent 状态", "服务状态", "服务已就绪。", "停用"])
		await expect(danger).not.toContainText(text);
	await expect(page.locator("#main-content")).not.toContainText("Agent 状态");
	// Owner（非管理员）不渲染任何仅属于管理员的元素。
	await expect(page.getByRole("button", { name: "停用 Agent" })).toHaveCount(0);
	await expect(page.getByText("管理员操作")).toHaveCount(0);
	await capture(page, info, "owner-lifecycle-layout");

	// 保存成功后页面保留（RK2-09），重启仍可见可用（O-11）。
	await save.click();
	await expect(toastHost(page)).toHaveText("配置已保存，Secret 值不会回显");
	await expect(page.getByRole("button", { name: "重启 Agent" })).toBeEnabled();

	// 已停止：页脚仍有重启，页面没有危险区。
	api.agentState("stopped");
	await page.goto("/agents/agent-pilot-1/configuration");
	await expect(
		page.locator(".configuration-form-footer").getByRole("button", {
			name: "重启 Agent",
		}),
	).toBeVisible();
	await expect(page.getByRole("region", { name: "停止 Agent" })).toHaveCount(0);
	// 创建失败：页脚是「重试创建」。
	api.agentState("creation_failed");
	await page.goto("/agents/agent-pilot-1/configuration");
	await expect(
		page.locator(".configuration-form-footer").getByRole("button", {
			name: "重试创建",
		}),
	).toBeVisible();
	await expect(page.getByRole("button", { name: "重试创建" })).toHaveCount(1);
});

test("an Owner administrator gets one danger zone and a neutral administrator action in every available service state", async ({
	page,
}, info) => {
	const api = await fixture(page, "owner-admin");
	for (const service of [
		"ready",
		"starting",
		"updating",
		"unavailable",
	] as const) {
		api.agentState("available", service);
		await page.goto("/agents/agent-pilot-1/configuration");
		const admin = page.getByRole("region", { name: "管理员操作", exact: true });
		await expect(admin).toBeVisible();
		const surface = await resolved(page, "backgroundColor", "var(--surface)");
		await expect(admin).toBeVisible();
		await expect(page.locator(".lifecycle-danger-zone")).toHaveCount(1);
		expect(
			await admin.evaluate(
				(element) => element.closest(".lifecycle-danger-zone") === null,
			),
		).toBe(true);
		expect(
			await computed(admin, ["backgroundColor", "borderTopColor"]),
		).toEqual({
			backgroundColor: surface,
			borderTopColor: await resolvedColor(page, "var(--border)"),
		});
		// 页面上只有一个实心危险按钮；两个「停…Agent」按钮名称不同、图标不同。
		const fills = await dangerFills(page);
		const solid = await page
			.locator("#main-content button")
			.evaluateAll(
				(buttons, fills) =>
					buttons
						.filter((button) =>
							fills.includes(getComputedStyle(button).backgroundColor),
						)
						.map((button) => button.textContent),
				fills,
			);
		expect(solid, service).toEqual(["停止 Agent"]);
		const disable = admin.getByRole("button", { name: "停用 Agent" });
		expect((await computed(disable, ["backgroundColor"])).backgroundColor).toBe(
			await resolved(page, "backgroundColor", "var(--surface)"),
		);
		// 管理员操作区与危险区一样是卡片内操作，40px 档（设计 .card-actions .btn）。
		expect((await computed(disable, ["minHeight"])).minHeight).toBe("40px");
		const icons = await page
			.getByRole("button", { name: /^停(止|用) Agent$/ })
			.evaluateAll((buttons) =>
				buttons.map((button) => button.querySelector("svg")?.outerHTML),
			);
		expect(icons).toHaveLength(2);
		expect(icons[0]).not.toBe(icons[1]);
		await expect(admin).toContainText("以下操作仅对系统管理员显示。");
		await expect(page.locator("#main-content")).not.toContainText(
			"停用将撤销运行资格。Owner 不能恢复，个人历史仍保留。",
		);
		await expect(page.locator("#main-content")).not.toContainText("服务状态");
	}
	await capture(page, info, "owner-admin-lifecycle");
	// 已停用：没有可用的管理员操作，也不渲染管理员区。
	api.agentState("disabled");
	await page.goto("/agents/agent-pilot-1/configuration");
	await expect(page.getByRole("heading", { level: 1 })).toHaveText(
		configurationTitle,
	);
	await expect(page.getByText("管理员操作")).toHaveCount(0);
	await expect(
		page.locator('.configuration-notices > [data-slot="alert"]').first(),
	).toContainText("运行资格已撤销，Owner 无法恢复。");
});

test("an Owner administrator can disable in every eligible state and a pending stop blocks every other command", async ({
	page,
}) => {
	const api = await fixture(page, "owner-admin");
	for (const status of [
		"creating",
		"available",
		"stopped",
		"creation_failed",
	] as const) {
		api.agentState(status, status === "available" ? "ready" : null);
		await page.goto("/agents/agent-pilot-1/configuration");
		await expect(page.getByRole("button", { name: "停用 Agent" })).toHaveCount(
			1,
		);
		await expect(
			page.getByRole("button", { name: "停用 Agent" }),
		).toBeEnabled();
		await expect(page.getByRole("button", { name: "重试创建" })).toHaveCount(
			status === "creation_failed" ? 1 : 0,
		);
	}
	await page.getByRole("button", { name: "停用 Agent" }).click();
	await page
		.getByRole("dialog", { name: "停用 Agent？" })
		.getByRole("button", { name: "确认停用" })
		.click();
	await expect(toastHost(page)).toHaveText(/已提交停用请求|Agent 已停用/);
	expect(api.commands.map((command) => command.body)).toEqual([
		{ schemaVersion: 1, command: "disable" },
	]);

	// NI-88：停止挂起期间，停止 / 重启 / 停用全部禁用，只发出一条 stop。
	api.agentState("available", "ready");
	api.commands.length = 0;
	await page.goto("/agents/agent-pilot-1/configuration");
	api.holdNextCommand();
	await page.getByRole("button", { name: "停止 Agent" }).click();
	await page
		.getByRole("dialog", { name: "停止这个 Agent？" })
		.getByRole("button", { name: "停止 Agent" })
		.click();
	for (const name of ["停止中…", "重启 Agent", "停用 Agent"])
		await expect(page.getByRole("button", { name })).toBeDisabled();
	expect(api.commands.map((command) => command.body)).toEqual([
		{ schemaVersion: 1, command: "stop" },
	]);
	api.release();
	await expect(toastHost(page)).toHaveText("Agent 已停止，历史会话转为只读");
	expect(api.commands).toHaveLength(1);
	await expect(page.locator("#main-content")).not.toContainText("操作已提交");
});

test("a pure administrator reaches the same configuration page with administrator actions only", async ({
	page,
}, info) => {
	const api = await fixture(page, "admin");
	api.agentState("creation_failed");
	await page.goto("/agents/agent-pilot-1/configuration");
	await expect(page.getByRole("heading", { level: 1 })).toHaveText(
		configurationTitle,
	);
	await expect(page.locator("main")).not.toContainText("配置不可用");
	await expect(page.locator("main")).not.toContainText("当前无法访问此配置。");
	await expect(
		page.locator('.configuration-notices > [data-slot="alert"]'),
	).toContainText("权限边界");
	// API 与应用授权只由当前 Owner 治理，服务端拒绝纯管理员：页面不显示授权控制（#3033 AC-2）。
	await expect(
		page.getByRole("region", { name: "Agent 授权控制", exact: true }),
	).toHaveCount(0);
	const admin = page.getByRole("region", { name: "管理员操作", exact: true });
	await expect(admin.getByRole("button")).toHaveText([
		"重试创建",
		"停用 Agent",
	]);
	await expect(page.locator(".form-aside")).toHaveCount(0);
	await expect(
		page.getByRole("combobox", { name: "共同 Owner 用户" }),
	).toHaveCount(0);
	await expect(page.getByRole("button", { name: "保存配置" })).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: /停止 Agent|重启 Agent/ }),
	).toHaveCount(0);
	// 卡片嵌套不超过两层：管理员区不在表单卡内。
	expect(
		await admin.evaluate(
			(element) => element.closest(".configuration-form-card") === null,
		),
	).toBe(true);
	for (const h2 of await page.locator("#main-content h2").all())
		expect(
			(await computed(h2, ["fontSize", "fontFamily"])).fontFamily,
			await h2.innerText(),
		).toBe(await bodyFontFamily(page));
	await capture(page, info, "administrator-configuration");

	// 挂起重试创建时停用也禁用（共享进行中状态）。
	api.holdNextCommand();
	await admin.getByRole("button", { name: "重试创建" }).click();
	await page
		.getByRole("dialog", { name: "重试创建 Agent？" })
		.getByRole("button", { name: "确认重试创建" })
		.click();
	await expect(
		admin.getByRole("button", { name: "停用 Agent" }),
	).toBeDisabled();
	api.release();
	await expect(toastHost(page)).toHaveText("已提交重试创建请求");
	expect(api.commands.map((command) => command.body)).toEqual([
		{ schemaVersion: 1, command: "retry_creation" },
	]);
});

test("lifecycle feedback follows the command and the detail read-back, not the accepted response", async ({
	page,
}) => {
	// 默认 Agent 服务为 starting，详情每 2 秒回读一次。
	const api = await fixture(page);
	api.acceptLifecycleWithoutStatus();
	api.deferNextLifecycleReadback();
	await page.goto("/agents/agent-pilot-1/configuration");
	await page.getByRole("button", { name: "停止 Agent" }).click();
	await page
		.getByRole("dialog", { name: "停止这个 Agent？" })
		.getByRole("button", { name: "停止 Agent" })
		.click();
	const toast = toastHost(page);
	// 受理响应不带 status：只说明已提交停止请求，不出现「操作已提交：可用」。
	await expect(toast).toHaveText("已提交停止请求");
	await expect(toast).toHaveAttribute("role", "status");
	await expect(toast).toHaveAttribute("aria-live", "polite");
	expect(
		await page.evaluate(
			() =>
				document
					.querySelector('[data-slot="toast"]')
					?.contains(document.activeElement) ?? false,
		),
	).toBe(false);
	await expect(page.locator("#main-content")).not.toContainText("操作已提交");
	await expect(pageStatus(page)).toHaveCount(0);
	// 回读为已停止后才给结束态提示。
	api.applyLifecycleReadback();
	await expect(toast).toHaveText("Agent 已停止，历史会话转为只读", {
		timeout: 6000,
	});
	await expect(page.getByRole("region", { name: "停止 Agent" })).toHaveCount(0);

	// 重启：受理 → 回读 starting → ready 后才提示完成。
	api.agentState("available", "ready");
	await page.goto("/agents/agent-pilot-1/configuration");
	await page.getByRole("button", { name: "重启 Agent" }).click();
	await page.getByRole("button", { name: "确认重启" }).click();
	await expect(toast).toHaveText("Agent 正在重启…");
	await expect(page.locator("main .page-heading")).toContainText("启动中");
	api.agentState("available", "ready");
	await expect(toast).toHaveText("重启完成，Agent 已就绪", { timeout: 6000 });
});

// 企微渠道（O-01、O-07、O-09）：两张卡片的状态由各自的连接接口提供。
async function wecomStatuses(
	page: Page,
	initial: { bot: string; app: string; callbackUrl?: string },
) {
	const state = { ...initial };
	const setupRequests: string[] = [];
	// 机器人卡片读取带扫码能力的状态 V2（#2911），自建应用仍读 V1。
	await page.route(/\/api\/v[12]\/agents\/[^/]+\/wecom-/, async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path.endsWith("/wecom-bot"))
			return route.fulfill({
				json: {
					status: state.bot,
					qrAvailable: false,
					qrUnavailableReason: "authorization_correlation_unverified",
				},
			});
		if (path.endsWith("/wecom-app"))
			return route.fulfill({
				json: {
					status: state.app,
					...(state.app === "connected" && state.callbackUrl
						? { callbackUrl: state.callbackUrl }
						: {}),
				},
			});
		setupRequests.push(`${route.request().method()} ${path}`);
		return route.fulfill({ status: 503, json: {} });
	});
	return { setupRequests, state };
}

// 先移除一个组织范围 chip（不保存），制造一处未保存的修改。
async function removeOrganizationChip(page: Page) {
	await page.getByRole("button", { name: "移除 平台工程" }).click();
	await expect(page.getByRole("button", { name: "移除 平台工程" })).toHaveCount(
		0,
	);
	// 焦点在下一帧回到该选择器的输入框；等它落定，后续 fill 才不会与之竞争。
	await expect(
		page.getByRole("combobox", { name: "可使用的组织", exact: true }),
	).toBeFocused();
	await expect(page.getByRole("button", { name: "保存配置" })).toBeEnabled();
}

// W-17～W-23、W-28：渠道分区、企微卡片字段、可用范围栅格与页脚状态按设计 #owner-config。
test("Owner configuration channels, WeCom fields, scope grid and footer status follow the design (W-17 / W-23)", async ({
	page,
}) => {
	await fixture(page);
	await wecomStatuses(page, {
		bot: "not_configured",
		app: "connected",
		callbackUrl: "https://callback.example.test/wecom",
	});
	await page.goto("/agents/agent-pilot-1/configuration");
	const channels = page.getByRole("region", { name: "渠道", exact: true });
	await expect(channels).toBeVisible();
	// W-17：标题与说明按导出稿，说明走分区说明样式；PRD §10.3 的群聊可见性提示保留。
	const description = channels.locator(
		':scope > [data-slot="form-section-description"]',
	);
	await expect(description).toHaveText(
		"Web 对话默认可用；企微入口需要分别绑定，状态会在这里更新。",
	);
	expect(
		await computed(description, ["fontSize", "marginTop", "lineHeight"]),
	).toEqual({ fontSize: "13px", marginTop: "5px", lineHeight: "21.45px" });
	await expect(channels).toHaveAccessibleDescription(
		/Agent 可用范围只限制谁能触发/,
	);
	await expect(channels).not.toContainText("自建应用和智能机器人");
	await expect(page.getByRole("heading", { name: "企微渠道" })).toHaveCount(0);

	const bot = page.getByRole("region", { name: "企微机器人", exact: true });
	const app = page.getByRole("region", { name: "企微应用", exact: true });
	// W-21：卡片说明与确认勾选按导出稿。
	await expect(bot.locator(".wecom-channel-copy")).toHaveText(
		"支持单聊与群聊，群消息和回复对群成员可见；不同发送者的会话上下文独立。Secret 只提交一次，页面不回显。",
	);
	await expect(app.locator(".wecom-channel-copy")).toHaveText(
		"配置企业 ID、应用 ID 和回调材料。验证期间保留原绑定，Secret 类字段只保存密文状态。",
	);
	// W-19：输入框占位符。
	for (const [card, field, placeholder] of [
		[bot, "#wecom-bot-id", "输入 Bot ID"],
		[bot, "#wecom-bot-secret", "仅本次提交使用"],
		[app, "#wecom-app-corporation-id", "输入企业 ID"],
		[app, "#wecom-app-application-id", "输入应用 ID"],
		[app, "#wecom-app-secret", "仅本次提交使用"],
		[app, "#wecom-app-token", "输入回调 Token"],
		[app, "#wecom-app-encoding-aes-key", "输入 43 位密钥"],
	] as const)
		await expect(card.locator(field)).toHaveAttribute(
			"placeholder",
			placeholder,
		);
	for (const [card, acknowledgement] of [
		[bot, "我已知悉可能断开其他连接"],
		[app, "我已知悉可能影响现有回调"],
	] as const) {
		// W-18：字段标签 11px（行高 18.15px），输入 13px。
		for (const label of await card
			.locator('.wecom-channel-fields [data-slot="label"]')
			.all())
			expect(await computed(label, ["fontSize", "lineHeight"])).toEqual({
				fontSize: "11px",
				lineHeight: "18.15px",
			});
		for (const input of await card
			.locator('.wecom-channel-fields [data-slot="input"]')
			.all())
			await expect(input).toHaveCSS("font-size", "13px");
		// W-20：确认勾选行紧接字段，44px 行内垂直居中。
		const checkbox = card.getByRole("checkbox", {
			name: acknowledgement,
			exact: true,
		});
		const row = card.locator(':scope > [data-slot="label"]');
		expect(
			await computed(row, ["marginTop", "alignItems", "minHeight"]),
		).toEqual({ marginTop: "0px", alignItems: "center", minHeight: "44px" });
		const [fields, rowBox, box] = await Promise.all([
			card.locator(".wecom-channel-fields").boundingBox(),
			row.boundingBox(),
			checkbox.boundingBox(),
		]);
		expect(
			Math.abs((rowBox?.y ?? 0) - ((fields?.y ?? 0) + (fields?.height ?? 0))),
		).toBeLessThanOrEqual(0.5);
		expect(
			Math.abs(
				(box?.y ?? 0) +
					(box?.height ?? 0) / 2 -
					((rowBox?.y ?? 0) + (rowBox?.height ?? 0) / 2),
			),
		).toBeLessThanOrEqual(1);
	}
	// W-27：回调 URL 块保留操作提示（待回写）。
	await expect(app.locator(".wecom-channel-callback strong")).toHaveText(
		"请在企微后台配置回调 URL",
	);
	// W-22：可用范围两列间距 14px（与 .form-grid 一致）。
	const scope = page
		.getByRole("region", { name: "可用范围", exact: true })
		.locator(":scope > div.grid");
	expect(await computed(scope, ["rowGap", "columnGap"])).toEqual({
		rowGap: "14px",
		columnGap: "14px",
	});
	// W-23：页脚状态文字走 .field-help：11px、--muted-ink。
	const status = page.locator("#agent-configuration-unchanged");
	await expect(status).toHaveText("没有需要保存的变更。");
	expect(await computed(status, ["fontSize", "color"])).toEqual({
		fontSize: "11px",
		color: await resolved(page, "color", "var(--muted-ink)"),
	});
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= innerWidth,
		),
	).toBe(true);
});

test("WeCom unbind asks for confirmation and sends only its own channel request", async ({
	page,
}, info) => {
	const api = await fixture(page);
	const wecom = await wecomStatuses(page, {
		bot: "connected",
		app: "connected",
		callbackUrl: "https://callback.example.test/wecom",
	});
	await page.goto("/agents/agent-pilot-1/configuration");
	await removeOrganizationChip(page);

	const bot = page.getByRole("region", { name: "企微机器人", exact: true });
	const trigger = bot.getByRole("button", { name: "解除绑定：企微机器人" });
	await expect(trigger).toHaveText("解除绑定");
	expect((await computed(trigger, ["backgroundColor"])).backgroundColor).toBe(
		"rgba(0, 0, 0, 0)",
	);
	// 取消、Esc、点遮罩都不发请求，焦点回到触发按钮。
	for (const dismiss of ["cancel", "escape", "backdrop"] as const) {
		await trigger.click();
		const dialog = page.getByRole("dialog", { name: "解除企微机器人绑定？" });
		await expect(dialog).toBeVisible();
		await expect(dialog).toHaveAttribute("aria-modal", "true");
		await expect(dialog).toContainText(
			"解除后平台停止向该入口投递新消息；已有会话和历史保留。",
		);
		const footer = dialog.locator('[data-slot="dialog-footer"]');
		await expect(footer.getByRole("button")).toHaveText(["取消", "确认解除"]);
		expect(await dangerFills(page)).toContain(
			(
				await computed(footer.getByRole("button", { name: "确认解除" }), [
					"backgroundColor",
				])
			).backgroundColor,
		);
		if (dismiss === "cancel")
			await footer.getByRole("button", { name: "取消" }).click();
		else if (dismiss === "escape") await page.keyboard.press("Escape");
		else await page.mouse.click(5, 5);
		await expect(dialog).toBeHidden();
		await expect(trigger).toBeFocused();
	}
	expect(api.commands).toEqual([]);

	await trigger.click();
	// 服务端解除后，连接状态回读为未配置。
	wecom.state.bot = "not_configured";
	await page
		.getByRole("dialog", { name: "解除企微机器人绑定？" })
		.getByRole("button", { name: "确认解除" })
		.click();
	await expect(toastHost(page)).toHaveText("企微机器人已解除绑定");
	expect(api.commands.map(({ path, body }) => ({ path, body }))).toEqual([
		{
			path: "/api/v2/agents/agent-pilot-1/configuration",
			body: {
				schemaVersion: 2,
				channels: [{ kind: "wecom_bot", enabled: false }],
			},
		},
	]);
	await expect(bot.getByText("未配置", { exact: true })).toBeVisible();
	await expect(bot.getByRole("button", { name: /^解除绑定/ })).toHaveCount(0);
	await expect(bot.getByRole("heading", { name: "企微机器人" })).toBeFocused();
	// 页面其余内容不变：表单仍在，未保存的范围修改保留，保存仍可用。
	await expect(page.locator("#main-content")).not.toContainText("配置已提交");
	await expect(page.getByRole("button", { name: "保存配置" })).toBeEnabled();
	await expect(page.getByRole("button", { name: "移除 平台工程" })).toHaveCount(
		0,
	);

	// 应用卡：标题对应对象；确认前 chip 与回调 URL 不变。
	const app = page.getByRole("region", { name: "企微应用", exact: true });
	await expect(app).toContainText("https://callback.example.test/wecom");
	await app.getByRole("button", { name: "解除绑定：企微应用" }).click();
	const appDialog = page.getByRole("dialog", { name: "解除企微应用绑定？" });
	await expect(appDialog).toBeVisible();
	await expect(page.getByText("解除企微机器人绑定？")).toHaveCount(0);
	await expect(app.getByText("已连接", { exact: true })).toBeVisible();
	await expect(app).toContainText("https://callback.example.test/wecom");
	await capture(page, info, "wecom-unbind-dialog");
	api.failNextConfigurationUpdate();
	await appDialog.getByRole("button", { name: "确认解除" }).click();
	// 失败时状态保持原值，卡内提示，不写页面级错误，也没有 Toast。
	await expect(app.getByRole("alert")).toHaveText("解除绑定未完成，请重试。");
	await expect(app.getByText("已连接", { exact: true })).toBeVisible();
	await expect(page.locator("#main-content")).not.toContainText("配置未能保存");
	expect(api.commands.at(-1)?.body).toEqual({
		schemaVersion: 2,
		channels: [{ kind: "wecom_app", enabled: false }],
	});
	expect(wecom.setupRequests).toEqual([]);
});

test("WeCom channel cards follow the design grid, chip and status border", async ({
	page,
}, info) => {
	await fixture(page);
	await wecomStatuses(page, { bot: "connected", app: "auth_failed" });
	await page.goto("/agents/agent-pilot-1/configuration");
	const grid = page.locator(".wecom-channel-grid");
	const bot = page.getByRole("region", { name: "企微机器人", exact: true });
	const app = page.getByRole("region", { name: "企微应用", exact: true });
	await expect(bot.getByText("已连接", { exact: true })).toBeVisible();
	const mobile = info.project.name === "mobile";
	const gridStyle = await computed(grid, ["display", "columnGap"]);
	expect(gridStyle).toEqual({ display: "grid", columnGap: "14px" });
	const [botBox, appBox] = [await bot.boundingBox(), await app.boundingBox()];
	if (mobile) expect(appBox?.y).toBeGreaterThan(botBox?.y ?? 0);
	else {
		expect(appBox?.y).toBe(botBox?.y);
		expect(
			Math.abs((appBox?.width ?? 0) - (botBox?.width ?? 0)),
		).toBeLessThanOrEqual(1);
	}
	for (const card of [bot, app])
		expect(
			await computed(card, [
				"borderTopLeftRadius",
				"paddingTop",
				"paddingLeft",
			]),
		).toEqual({
			borderTopLeftRadius: "12px",
			paddingTop: mobile ? "14px" : "16px",
			paddingLeft: mobile ? "14px" : "16px",
		});
	const icon = bot.locator(".wecom-channel-icon");
	const iconBox = await icon.boundingBox();
	expect([iconBox?.width, iconBox?.height]).toEqual([32, 32]);
	const title = bot.getByRole("heading", { level: 3, name: "企微机器人" });
	expect(await computed(title, ["fontSize", "fontWeight"])).toEqual({
		fontSize: "14px",
		fontWeight: "650",
	});
	const subtitle = bot.getByText("智能机器人 · 长连接", { exact: true });
	expect(await computed(subtitle, ["fontSize", "color"])).toEqual({
		fontSize: "11px",
		color: await resolvedColor(page, "var(--muted-foreground)"),
	});
	const botChip = bot.locator('[data-slot="badge"][data-variant="chip"]');
	await expect(botChip).toHaveAttribute("data-tone", "green");
	await expect(
		app.locator('[data-slot="badge"][data-variant="chip"]'),
	).toHaveAttribute("data-tone", "red");
	expect((await computed(bot, ["borderTopColor"])).borderTopColor).toBe(
		await resolvedColor(
			page,
			"color-mix(in oklch, var(--success) 28%, var(--border))",
		),
	);
	expect((await computed(app, ["borderTopColor"])).borderTopColor).toBe(
		await resolvedColor(
			page,
			"color-mix(in oklch, var(--danger) 32%, var(--border))",
		),
	);
	// 区分同名控件的名称以可见文字开头，输入框仍以 <label> 为名（NI-107）。
	for (const [card, name] of [
		[bot, "企微机器人"],
		[app, "企微应用"],
	] as const)
		for (const visible of ["验证并绑定", "刷新状态"])
			await expect(
				card.getByRole("button", { name: `${visible}：${name}` }),
			).toHaveText(visible);
	await expect(page.getByLabel("Bot ID", { exact: true })).toHaveCount(1);
	await expect(page.getByLabel("Secret", { exact: true })).toHaveCount(1);
	await capture(page, info, "wecom-cards");
});

test("Enter inside WeCom card fields never submits the page configuration", async ({
	page,
}) => {
	const api = await fixture(page);
	const wecom = await wecomStatuses(page, {
		bot: "not_configured",
		app: "not_configured",
	});
	await page.goto("/agents/agent-pilot-1/configuration");
	await removeOrganizationChip(page);
	for (const label of ["Bot ID", "Secret", "企业 ID", "应用 Secret"]) {
		const input = page.getByLabel(label, { exact: true });
		await input.fill("fixture-value");
		await input.press("Enter");
		await expect(input).toBeFocused();
	}
	await page.waitForTimeout(300);
	expect(api.commands).toEqual([]);
	expect(wecom.setupRequests).toEqual([]);
	await expect(page.locator("#main-content")).not.toContainText("配置已提交");
});

test("a pending stop on one Agent does not leak into another Agent's configuration", async ({
	page,
}, info) => {
	test.skip(info.project.name !== "desktop", "In-app navigation flow");
	const api = await fixture(page);
	api.agentState("available", "ready");
	api.threeAgents();
	await page.goto("/agents/agent-pilot-1/configuration");
	api.holdNextCommand();
	await page.getByRole("button", { name: "停止 Agent" }).click();
	await page
		.getByRole("dialog", { name: "停止这个 Agent？" })
		.getByRole("button", { name: "停止 Agent" })
		.click();
	await expect(page.getByRole("button", { name: "停止中…" })).toBeDisabled();
	// 应用内导航到另一个 Agent 的配置页，A 的停止仍挂起。
	await page.getByRole("link", { name: "Agent 目录" }).click();
	await page.getByRole("link", { name: "查看 Visible Agent 2 详情" }).click();
	await page.getByRole("link", { name: "Owner 配置" }).click();
	await expect(page).toHaveURL(/\/agents\/agent-visible-2\/configuration$/);
	await expect(page.locator("main .page-eyebrow")).toContainText(
		"Visible Agent 2",
	);
	for (const name of ["停止 Agent", "重启 Agent"])
		await expect(page.getByRole("button", { name })).toBeEnabled();
	api.release();
	await expect.poll(() => api.commands.length).toBe(1);
	await page.waitForTimeout(300);
	// A 的受理结果不显示在 B 的页面上。
	await expect(toastHost(page)).toHaveText("");
	await expect(page.locator("#main-content")).not.toContainText("操作已提交");
	await expect(page.getByRole("button", { name: "停止 Agent" })).toBeEnabled();
});

const connectionOrigin = "https://connection.example.test";

/** 直接返回原始 capability JSON（不经契约解析），用来覆盖不合规的入口值。 */
async function stubConnectionCapability(
	page: Page,
	value: "fail" | "timeout" | Record<string, unknown>,
) {
	await page.route("**/api/v1/connection/capability", async (route) => {
		if (value === "fail") return route.fulfill({ status: 503, json: {} });
		if (value === "timeout") {
			// 浏览器会话读取 capability 的上限是 3s，超过即视为没有入口。
			await new Promise((resolve) => setTimeout(resolve, 3_500));
			return route.fulfill({ status: 503, json: {} }).catch(() => undefined);
		}
		return route.fulfill({ json: value });
	});
}

const availableCapability = (
	publicOrigin: string = connectionOrigin,
	mcpPath = "/mcp",
) => ({
	schemaVersion: 1,
	status: "available",
	publicOrigin,
	mcpPath,
	configFingerprint: "a".repeat(64),
});

function connectorSection(page: Page) {
	return page.getByRole("region", { name: "连接器", exact: true });
}

test.describe("Agent detail design alignment", () => {
	test("Connection notice moves from needs-auth to handoff only after opening it", async ({
		page,
	}, info) => {
		await fixture(page, "employee");
		await stubConnectionCapability(page, availableCapability());
		const mainRequests: string[] = [];
		page.on("request", (request) => {
			const url = new URL(request.url());
			if (request.method() !== "GET" || url.origin === connectionOrigin)
				mainRequests.push(`${request.method()} ${request.url()}`);
		});
		await page
			.context()
			.route(`${connectionOrigin}/**`, (route) =>
				route.fulfill({ contentType: "text/html", body: "<p>Connection</p>" }),
			);
		await page.goto("/agents/agent-pilot-1");
		const section = connectorSection(page);
		await expect(section.getByRole("heading", { level: 2 })).toHaveText(
			"连接器",
		);
		const notice = section.locator(".connection-notice");
		await expect(notice).toHaveAttribute("data-state", "needs-auth");
		await expect(notice.getByText("需要 Connection 授权")).toBeVisible();
		for (const text of [
			"Action 范围",
			"在 Connection 中确认",
			"按当前主体 / Consumer / Actor 生效",
		])
			await expect(notice.getByText(text, { exact: true })).toBeVisible();
		const open = notice.getByRole("link", { name: "打开 Connection" });
		await expect(open).toHaveAttribute("href", `${connectionOrigin}/mcp`);
		await expect(open).toHaveAttribute("target", "_blank");
		await expect(open).toHaveAttribute("rel", /noopener/);
		await expect(open).toHaveAttribute("rel", /noreferrer/);
		const copy = notice.locator(".connection-notice-copy");
		if (info.project.name === "desktop") {
			await expect(notice).toHaveCSS("padding", "13px 14px");
			await expect(notice).toHaveCSS("border-radius", "12px");
			const openBox = await open.boundingBox();
			const copyBox = await copy.boundingBox();
			if (!openBox || !copyBox) throw new Error("Expected notice geometry");
			// D-01（#3052）：与对话页 Z-11 一致为 44px 触达高度，不沿用导出稿桌面的 40px。
			await expect(open).toHaveCSS("min-height", "44px");
			expect(openBox.height).toBeGreaterThanOrEqual(44);
			expect(openBox.x).toBeGreaterThanOrEqual(copyBox.x + copyBox.width);
		} else {
			// D-01：≤767px 卡片纵向，按钮整宽、上间距 10px、触控高度 ≥ 44px。
			await expect(notice).toHaveCSS("display", "block");
			const noticeBox = await notice.boundingBox();
			const openBox = await open.boundingBox();
			const copyBox = await copy.boundingBox();
			if (!noticeBox || !openBox || !copyBox)
				throw new Error("Expected notice geometry");
			expect(
				Math.abs(openBox.width - (noticeBox.width - 30)),
			).toBeLessThanOrEqual(1);
			await expect(notice.locator(".connection-notice-action")).toHaveCSS(
				"margin-top",
				"10px",
			);
			expect(openBox.height).toBeGreaterThanOrEqual(44);
			expect(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= innerWidth,
				),
			).toBe(true);
		}
		await capture(page, info, "agent-detail-connection-needs-auth");
		const popup = page.waitForEvent("popup");
		await open.click();
		await (await popup).close();
		await expect(notice).toHaveAttribute("data-state", "handoff");
		await expect(notice.getByText("等待 Connection 授权返回")).toBeVisible();
		await expect(
			notice.getByRole("link", { name: "返回查看授权状态" }),
		).toHaveAttribute("href", `${connectionOrigin}/mcp`);
		await capture(page, info, "agent-detail-connection-handoff");
		// Platform 不读取 Connection 的授权结果，也不发写请求。
		expect(mainRequests).toEqual([]);
		await page.reload();
		await expect(notice).toHaveAttribute("data-state", "needs-auth");
	});

	// D-01（#3052 AC-2）：1440×900 与 390×844 下「打开 Connection」与对话页 Z-11 同为 44px，页面无横向溢出。
	test("Connection notice keeps 打开 Connection at the 44px touch height at 1440 by 900 and 390 by 844 (D-01)", async ({
		page,
	}, info) => {
		const viewport =
			info.project.name === "mobile"
				? { width: 390, height: 844 }
				: { width: 1440, height: 900 };
		await page.setViewportSize(viewport);
		await fixture(page, "employee");
		await stubConnectionCapability(page, availableCapability());
		await page.goto("/agents/agent-pilot-1");
		const notice = connectorSection(page).locator(".connection-notice");
		await expect(notice).toHaveAttribute("data-state", "needs-auth");
		const open = notice.getByRole("link", { name: "打开 Connection" });
		await expect(open).toBeVisible();
		await expect(open).toHaveCSS("min-height", "44px");
		const openBox = await open.boundingBox();
		const noticeBox = await notice.boundingBox();
		if (!openBox || !noticeBox) throw new Error("Expected notice geometry");
		expect(openBox.height).toBeGreaterThanOrEqual(44);
		// 按钮与提示卡都留在视口内，页面没有横向滚动。
		expect(openBox.x + openBox.width).toBeLessThanOrEqual(
			noticeBox.x + noticeBox.width,
		);
		expect(noticeBox.x + noticeBox.width).toBeLessThanOrEqual(viewport.width);
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
		).toBe(true);
	});

	test("an Agent without the Connection capability shows no notice or link", async ({
		page,
	}) => {
		await fixture(page, "employee");
		await stubConnectionCapability(page, availableCapability());
		// 详情页读取带 Owner 状态的详情投影（#2910），能力字段与 V2 相同。
		await page.route("**/api/v2/agents/agent-pilot-1/detail", (route) =>
			route.fulfill({
				json: AgentDetailProjectionV1Schema.parse(
					pilotAgentDetailFromV2({
						...pilotFakeScenariosV2.starting.response.body,
						serviceAvailability: "ready",
						capabilities: {
							...pilotFakeScenariosV2.starting.response.body.capabilities,
							connection: false,
						},
					}),
				),
			}),
		);
		await page.goto("/agents/agent-pilot-1");
		const section = connectorSection(page);
		await expect(
			section.getByText("当前 Agent 未提供 Connection 能力。"),
		).toBeVisible();
		await expect(section.locator(".connection-notice")).toHaveCount(0);
		await expect(section.getByRole("link")).toHaveCount(0);
		await expect(
			page.getByText("支持 Connection", { exact: true }),
		).toHaveCount(0);
	});

	for (const capability of [
		{
			name: "unavailable",
			value: { schemaVersion: 1, status: "unavailable", reason: "missing" },
		},
		{ name: "request failure", value: "fail" as const },
		{ name: "timeout", value: "timeout" as const },
	]) {
		test(`Connection ${capability.name} keeps the notice unavailable in the page and the sidebar`, async ({
			page,
		}, info) => {
			await fixture(page, "employee");
			await stubConnectionCapability(page, capability.value);
			await page.goto("/agents/agent-pilot-1");
			const section = connectorSection(page);
			const notice = section.locator(".connection-notice");
			await expect(notice).toHaveAttribute("data-state", "unavailable");
			await expect(notice.getByText("Connection 暂不可用")).toBeVisible();
			await expect(section.getByRole("link")).toHaveCount(0);
			await expect(
				page.getByText(/等待 Connection 授权返回|返回查看授权状态/),
			).toHaveCount(0);
			if (info.project.name === "mobile")
				await page.getByRole("button", { name: "打开导航" }).click();
			const nav =
				info.project.name === "mobile"
					? page.getByRole("dialog", { name: "主导航" })
					: page.locator(".platform-sidebar");
			await expect(
				nav.locator('.platform-nav-item[aria-disabled="true"]', {
					hasText: "我的 Connection",
				}),
			).toHaveCount(1);
			await expect(
				nav.getByRole("link", { name: "我的 Connection" }),
			).toHaveCount(0);
		});
	}

	test("the sidebar and the detail page link the same controlled Connection URL or neither", async ({
		page,
	}, info) => {
		test.skip(
			info.project.name !== "desktop",
			"The sidebar is visible at 1440",
		);
		test.setTimeout(120_000);
		await fixture(page, "employee");
		const inputs: [string, string][] = [
			[connectionOrigin, "/mcp"],
			[connectionOrigin, "//evil.example/mcp"],
			[connectionOrigin, "/\\evil.example/mcp"],
			[connectionOrigin, "\\\\evil.example\\mcp"],
			[`${connectionOrigin}\n`, "/mcp"],
			[`${connectionOrigin}/`, "/mcp"],
			["http://connection.example.test", "/mcp"],
			["https://user:pass@connection.example.test", "/mcp"],
			[connectionOrigin, "/mcp\n"],
			[connectionOrigin, "/m\tcp"],
			[connectionOrigin, ".evil.example/mcp"],
			[connectionOrigin, "@evil.example/mcp"],
			[connectionOrigin, "/mcp?next=x"],
			[connectionOrigin, "/mcp#x"],
			[connectionOrigin, "/%2e%2e/mcp"],
			[connectionOrigin, "/%2Fevil.example/mcp"],
			[connectionOrigin, "/%5cevil.example/mcp"],
			[connectionOrigin, "/./mcp"],
			[connectionOrigin, "/a/../mcp"],
		];
		let current = availableCapability();
		await page.route("**/api/v1/connection/capability", (route) =>
			route.fulfill({ json: current }),
		);
		const results: {
			input: [string, string];
			nav?: string;
			detail?: string;
		}[] = [];
		for (const input of inputs) {
			current = availableCapability(...input);
			await page.goto("/agents/agent-pilot-1");
			await expect(
				connectorSection(page).locator(".connection-notice"),
			).toBeVisible();
			const nav = await page
				.locator(".platform-sidebar a.platform-nav-external")
				.getAttribute("href", { timeout: 200 })
				.catch(() => undefined);
			const detail = await connectorSection(page)
				.getByRole("link")
				.first()
				.getAttribute("href", { timeout: 200 })
				.catch(() => undefined);
			results.push({
				input,
				nav: nav ?? undefined,
				detail: detail ?? undefined,
			});
		}
		await info.attach("connection-entry-matrix", {
			body: JSON.stringify(results, null, 2),
			contentType: "application/json",
		});
		// 合法输入两处都给出同一地址；其余每组两处都没有链接。
		expect(results[0]).toMatchObject({
			nav: `${connectionOrigin}/mcp`,
			detail: `${connectionOrigin}/mcp`,
		});
		for (const result of results.slice(1))
			expect(result, JSON.stringify(result.input)).toEqual({
				input: result.input,
				nav: undefined,
				detail: undefined,
			});
		for (const result of results)
			for (const href of [result.nav, result.detail])
				if (href) expect(new URL(href).origin).toBe(connectionOrigin);
	});

	test("heading back link, actions, status tags and sidebar rows follow the design", async ({
		page,
	}, info) => {
		const api = await fixture(page, "owner");
		api.conversationChoices();
		await page.route("**/api/v2/directory/search?**", async (route) => {
			const url = new URL(route.request().url());
			return route.fulfill({
				json: directorySearchResponse(
					url,
					url.searchParams.get("kind") === "user"
						? [
								{
									kind: "user",
									canonicalId: "user-owner-1",
									displayName: "当前 Owner",
									organizationPath: "研发 / 平台工程",
								},
							]
						: [],
				),
			});
		});
		await page.goto("/agents/agent-pilot-1");
		const heading = page.locator("main .page-heading");
		const back = heading.getByRole("link", { name: "返回 Agent 目录" });
		await expect(back).toHaveCSS("font-size", "12px");
		await expect(back).toHaveCSS("padding", "7px 11px");
		await expect(back).toHaveCSS("column-gap", "8px");
		await expect(back).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
		await expect(back).toHaveCSS(
			"color",
			await resolved(page, "color", "var(--muted-foreground)"),
		);
		expect((await back.boundingBox())?.height).toBe(44);
		const backBox = await back.boundingBox();
		const identity = await heading
			.locator(".agent-detail-heading")
			.boundingBox();
		if (!backBox || !identity) throw new Error("Expected heading geometry");
		expect(
			Math.abs(identity.y - (backBox.y + backBox.height) - 16),
		).toBeLessThanOrEqual(1);
		// 设计 #agent-detail .eyebrow margin 0 0 9px：eyebrow 顶部与标识行顶部对齐（不继承
		// .page-heading p 的 9px 上外边距），h1 在 eyebrow 下 9px。导出稿已按 B-15 回写 44px 的
		// sm 返回按钮（#2863），设计 1440 下 h1 y=190.39、390 下 197.39（窄屏返回链接保留 16px 上外边距）。
		const eyebrowGeometry = await heading
			.locator(".agent-detail-heading")
			.evaluate((element) => {
				const eyebrow = element.querySelector(".page-eyebrow");
				const h1 = element.querySelector("h1");
				if (!eyebrow || !h1) throw new Error("Expected eyebrow and h1");
				return {
					marginTop: getComputedStyle(eyebrow).marginTop,
					identityTop: element.getBoundingClientRect().top,
					eyebrowTop: eyebrow.getBoundingClientRect().top,
					eyebrowBottom: eyebrow.getBoundingClientRect().bottom,
					h1Top: h1.getBoundingClientRect().top,
				};
			});
		expect(eyebrowGeometry.marginTop).toBe("0px");
		expect(
			Math.abs(eyebrowGeometry.eyebrowTop - eyebrowGeometry.identityTop),
		).toBeLessThanOrEqual(0.5);
		expect(
			Math.abs(eyebrowGeometry.h1Top - (eyebrowGeometry.eyebrowBottom + 9)),
		).toBeLessThanOrEqual(0.5);
		const designH1 = info.project.name === "mobile" ? 197.39 : 190.39;
		expect(Math.abs(eyebrowGeometry.h1Top - designH1)).toBeLessThanOrEqual(1);
		await back.hover();
		await expect(back).toHaveCSS("text-decoration-line", "none");
		await expect(
			page.getByRole("link", { name: "返回 Agent 列表" }),
		).toHaveCount(0);
		// D-03 / F-07：primary「开始对话」、outline「Owner 配置」、ghost「可用 Skill」（Owner 可见），没有「配置与管理」。
		const actions = heading.locator(".agent-detail-actions > a");
		await expect(actions).toHaveText(["开始对话", "Owner 配置", "可用 Skill"]);
		await expect(actions.nth(1)).toHaveAttribute(
			"href",
			"/agents/agent-pilot-1/configuration",
		);
		await expect(actions.nth(2)).toHaveAttribute(
			"href",
			"/agents/agent-pilot-1/skills",
		);
		// 设计 .btn-ghost：透明底与边框、muted 文字、无图标。
		await expect(actions.nth(2)).toHaveCSS(
			"background-color",
			"rgba(0, 0, 0, 0)",
		);
		await expect(actions.nth(2)).toHaveCSS(
			"color",
			await resolved(page, "color", "var(--muted-foreground)"),
		);
		await expect(actions.nth(2).locator("svg")).toHaveCount(0);
		await expect(page.getByRole("link", { name: "配置与管理" })).toHaveCount(0);
		const status = page.locator(".agent-detail-status");
		await expect(
			status.locator('[data-slot="badge"][data-variant="chip"]'),
		).toHaveText(["就绪"]);
		const tags = status.locator('[data-slot="badge"][data-variant="tag"]');
		await expect(tags).toHaveText(["每个用户都有独立会话", "支持 Connection"]);
		for (const tag of await tags.all()) {
			await expect(tag).toHaveCSS("border-top-left-radius", "7px");
			await expect(tag).toHaveCSS("font-size", "11px");
			await expect(tag).toHaveCSS("padding", "3px 8px");
		}
		// F-07：默认推理档位只有中文档位名；历史入口不与区块标题同名。
		const level = page.getByRole("term").filter({ hasText: /^默认推理档位$/ });
		await expect(level).toBeVisible();
		await expect(level.locator("xpath=following-sibling::dd[1]")).toHaveText(
			"均衡",
		);
		await expect(page.getByText("默认选项", { exact: true })).toHaveCount(0);
		await expect(
			page.getByRole("link", { name: "查看对话历史" }),
		).toHaveAttribute("href", "/chat/agent-pilot-1?view=history");
		await expect(
			page.locator("main").getByRole("link", { name: "个人历史", exact: true }),
		).toHaveCount(0);
		// D-04：侧栏行名称 + 12px 说明，chip 在行右侧。
		const owners = page.getByRole("region", { name: "Owner", exact: true });
		await expect(owners.getByText("研发 / 平台工程")).toHaveCSS(
			"font-size",
			"12px",
		);
		const runtime = page.getByRole("region", { name: "运行与渠道" });
		await expect(runtime.getByText("可以发送消息并获得回复")).toHaveCSS(
			"font-size",
			"12px",
		);
		await expect(runtime.getByText("平台对话入口")).toHaveCSS(
			"font-size",
			"12px",
		);
		for (const row of await page
			.locator(".agent-detail-aside .detail-list li")
			.all()) {
			if (info.project.name === "mobile") {
				await expect(row).toHaveCSS("display", "block");
				continue;
			}
			await expect(row).toHaveCSS("align-items", "flex-start");
			const chip = row.locator(':scope > [data-slot="badge"]');
			if (!(await chip.count())) continue;
			const rowBox = await row.boundingBox();
			const chipBox = await chip.boundingBox();
			if (!rowBox || !chipBox) throw new Error("Expected row geometry");
			expect(
				Math.abs(chipBox.x + chipBox.width - (rowBox.x + rowBox.width)),
			).toBeLessThanOrEqual(1);
		}
		await capture(page, info, "agent-detail-design");
		await page.goto("/agents/agent-self-managed");
		await expect(page.getByRole("link", { name: "打开 Agent" })).toBeVisible();
		await expect(page.getByRole("link", { name: "开始对话" })).toHaveCount(0);
		await expect(page.getByRole("button", { name: "开始对话" })).toHaveCount(0);
		await expect(page.getByText("每个用户都有独立会话")).toHaveCount(0);
		await page.goto("/agents/agent-outside-authorized-collection");
		await expect(
			page.getByRole("link", { name: "返回 Agent 目录" }),
		).toBeVisible();
		await expect(
			page.getByRole("link", { name: "返回 Agent 列表" }),
		).toHaveCount(0);
		expect(api.commands).toHaveLength(0);
	});

	test("employee detail has no Owner settings entry and the service row follows availability", async ({
		page,
	}) => {
		await fixture(page, "employee");
		await page.goto("/agents/agent-pilot-1");
		await expect(page.getByRole("link", { name: "Owner 配置" })).toHaveCount(0);
		// D-03：「可用 Skill」指向只对 Owner 开放的 Agent Skill 页，员工看不到入口。
		await expect(page.getByRole("link", { name: "可用 Skill" })).toHaveCount(0);
		await expect(
			page
				.getByRole("region", { name: "运行与渠道" })
				.getByText("历史只读，暂时不能发送消息"),
		).toBeVisible();
		await expect(
			page.locator(
				".agent-detail-status [data-slot='badge'][data-variant='chip']",
			),
		).toHaveText(["启动中"]);
	});

	test("a system administrator who is not an Owner gets Owner 配置 but no「可用 Skill」(D-03)", async ({
		page,
	}) => {
		await fixture(page, "admin");
		await page.goto("/agents/agent-pilot-1");
		await expect(page.getByRole("link", { name: "Owner 配置" })).toBeVisible();
		await expect(page.getByRole("link", { name: "可用 Skill" })).toHaveCount(0);
	});

	// #2830 终验 Y：1440×900 与 390×844 下对照导出稿 #agent-detail（Y-13–Y-18）。
	test("final acceptance Y detail facts, section notes and panel heads follow the design", async ({
		page,
	}, info) => {
		const errors = trackPageErrors(page);
		const mobile = info.project.name === "mobile";
		await page.setViewportSize(
			mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
		);
		const api = await fixture(page, "owner");
		await stubConnectionCapability(page, availableCapability());
		const base = pilotAgentDetailFromV2(
			pilotFakeScenariosV2.starting.response.body,
		);
		await page.route("**/api/v2/agents/agent-pilot-1/detail", (route) =>
			route.fulfill({
				json: AgentDetailProjectionV1Schema.parse({
					...base,
					serviceAvailability: "ready",
					configuration: {
						...base.configuration,
						channels: [
							{ kind: "web", status: "available" },
							{ kind: "wecom_bot", status: "bound" },
						],
					},
				}),
			}),
		);
		await page.goto("/agents/agent-pilot-1");
		// Y-13：左栏首个区块标题「Agent 信息」。
		const about = page.getByRole("region", { name: "Agent 信息", exact: true });
		await expect(about.getByRole("heading", { level: 2 })).toHaveText(
			"Agent 信息",
		);
		await expect(page.getByText("关于此 Agent")).toHaveCount(0);
		// Y-14：「可用范围」后是「渠道 Web · 企微机器人」。
		const terms = await about.locator("dt").allTextContents();
		expect(
			terms.slice(terms.indexOf("可用范围"), terms.indexOf("可用范围") + 2),
		).toEqual(["可用范围", "渠道"]);
		await expect(
			about
				.getByRole("term")
				.filter({ hasText: /^渠道$/ })
				.locator("xpath=following-sibling::dd[1]"),
		).toHaveText("Web · 企微机器人");
		// Y-17：页头副标题 14px / 23.1px（设计 .page-head-copy p）。
		const subtitle = page.locator(
			"main .page-heading .agent-detail-heading h1 + p",
		);
		await expect(subtitle).toHaveCSS("font-size", "14px");
		await expect(subtitle).toHaveCSS("line-height", "23.1px");
		// Y-15 / Y-16：两段说明 13px / 21.45px muted，h2 下 8px；历史操作上距 16px。
		const muted = await resolved(page, "color", "var(--muted-foreground)");
		const history = page.locator("main .detail-section").filter({
			has: page.getByRole("heading", { level: 2, name: "个人历史" }),
		});
		const connector = connectorSection(page);
		for (const [section, text] of [
			[history, "这里只显示你提交的消息和执行状态，Agent Owner 看不到正文。"],
			[
				connector,
				"此 Agent 支持独立 Connection 直连，使用前需由当前主体完成授权。",
			],
		] as const) {
			const note = section.getByText(text, { exact: true });
			await expect(note).toHaveCSS("font-size", "13px");
			await expect(note).toHaveCSS("line-height", "21.45px");
			await expect(note).toHaveCSS("color", muted);
			const [heading, noteBox] = await Promise.all([
				section.getByRole("heading", { level: 2 }).boundingBox(),
				note.boundingBox(),
			]);
			if (!heading || !noteBox) throw new Error("Expected note geometry");
			expect(
				Math.abs(noteBox.y - (heading.y + heading.height) - 8),
			).toBeLessThanOrEqual(0.5);
		}
		const historyNote = await history
			.getByText("这里只显示你提交的消息和执行状态，Agent Owner 看不到正文。")
			.boundingBox();
		const historyLink = await history
			.getByRole("link", { name: "查看对话历史" })
			.boundingBox();
		if (!historyNote || !historyLink)
			throw new Error("Expected history geometry");
		expect(
			Math.abs(historyLink.y - (historyNote.y + historyNote.height) - 16),
		).toBeLessThanOrEqual(0.5);
		// Y-18：右栏区块头副标题与 18px 图标；桌面图标与区块头底边对齐，≤767px 顶对齐。
		for (const [name, description] of [
			["Owner", "Owner 和运行状态"],
			["运行与渠道", "当前状态"],
		] as const) {
			const header = page
				.getByRole("region", { name, exact: true })
				.locator("header");
			await expect(header.locator("p")).toHaveText(description);
			const icon = header.locator(':scope > svg[aria-hidden="true"]');
			await expect(icon).toHaveCount(1);
			const [headerBox, iconBox] = await Promise.all([
				header.boundingBox(),
				icon.boundingBox(),
			]);
			if (!headerBox || !iconBox) throw new Error("Expected header geometry");
			expect([iconBox.width, iconBox.height]).toEqual([18, 18]);
			expect(
				Math.abs(iconBox.x + iconBox.width - (headerBox.x + headerBox.width)),
			).toBeLessThanOrEqual(0.5);
			if (mobile)
				expect(Math.abs(iconBox.y - headerBox.y)).toBeLessThanOrEqual(0.5);
			else
				expect(
					Math.abs(
						iconBox.y + iconBox.height - (headerBox.y + headerBox.height),
					),
				).toBeLessThanOrEqual(0.5);
		}
		await expect(page.getByText(/负责范围与运行状态|平台当前观测/)).toHaveCount(
			0,
		);
		// AC-2：无横向溢出、无控制台错误、同页没有同名控件。
		await expectCleanPage(page, errors);
		expect(await duplicateControlNames(page)).toEqual([]);
		await capture(page, info, "final-acceptance-y-agent-detail");
		expect(api.commands).toHaveLength(0);
	});
});

// #2830 终验 Y：壳层、/agents 在 1440×900 与 390×844 下对照导出稿（Y-01–Y-03、Y-12）。
test.describe("final acceptance Y shell and directory", () => {
	test("the Connection entry icons are 17px and the narrow topbar keeps a 12px menu gap", async ({
		page,
	}, info) => {
		const mobile = info.project.name === "mobile";
		await page.setViewportSize(
			mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
		);
		await fixture(page, "employee");
		await stubConnectionCapability(page, availableCapability());
		await page.goto("/agents");
		if (mobile) {
			// Y-02：菜单按钮右缘与面包屑左缘相距 12px，标题 x=74（设计 .topbar-left gap）。
			const menu = await page
				.getByRole("button", { name: "打开导航" })
				.boundingBox();
			const crumbs = await page.locator(".platform-breadcrumb").boundingBox();
			if (!menu || !crumbs) throw new Error("Expected topbar geometry");
			expect(
				Math.abs(crumbs.x - (menu.x + menu.width) - 12),
			).toBeLessThanOrEqual(0.5);
			expect(Math.abs(crumbs.x - 74)).toBeLessThanOrEqual(0.5);
			await page.getByRole("button", { name: "打开导航" }).click();
		}
		const nav = mobile
			? page.getByRole("dialog", { name: "主导航" })
			: page.locator(".platform-sidebar");
		// Y-01：key 与外链图标都是 17×17。
		const icons = nav.locator("a.platform-nav-external svg");
		await expect(icons).toHaveCount(2);
		for (const icon of await icons.all()) {
			const box = await icon.boundingBox();
			expect([box?.width, box?.height]).toEqual([17, 17]);
		}
	});

	test("closing the narrow navigation with its close button returns focus to the trigger", async ({
		page,
	}, info) => {
		test.skip(info.project.name !== "mobile", "Mobile Sheet behavior");
		const errors = trackPageErrors(page);
		await fixture(page, "employee");
		await page.goto("/");
		const trigger = page.getByRole("button", { name: "打开导航" });
		await trigger.click();
		const dialog = page.getByRole("dialog", { name: "主导航" });
		await expect(dialog).toBeVisible();
		// Y-03：保留「关闭导航」（待回写设计稿），点击后焦点回到「打开导航」而不是 body。
		const close = dialog.getByRole("button", { name: "关闭导航" });
		const closeBox = await close.boundingBox();
		expect([closeBox?.width, closeBox?.height]).toEqual([44, 44]);
		await close.click();
		await expect(dialog).not.toBeVisible();
		await expect(trigger).toBeFocused();
		expect(
			await page.evaluate(() => document.activeElement === document.body),
		).toBe(false);
		// 键盘打开后用 Enter 激活关闭钮，焦点同样回到触发按钮。
		await trigger.press("Enter");
		await expect(dialog).toBeVisible();
		await dialog.getByRole("button", { name: "关闭导航" }).focus();
		await page.keyboard.press("Enter");
		await expect(dialog).not.toBeVisible();
		await expect(trigger).toBeFocused();
		expect(errors).toEqual([]);
	});

	for (const mode of ["directory", "conversation"] as const) {
		test(`Agent ${mode} cards put the arrow first and the page has no overflow or duplicate controls`, async ({
			page,
		}, info) => {
			const errors = trackPageErrors(page);
			await page.setViewportSize(
				info.project.name === "mobile"
					? { width: 390, height: 844 }
					: { width: 1440, height: 900 },
			);
			const api = await fixture(page, "employee");
			api.conversationChoices();
			await page.goto(
				mode === "conversation" ? "/agents?mode=conversation" : "/agents",
			);
			const label = mode === "conversation" ? "开始对话" : "查看详情";
			const actions = page.locator(".directory-card-foot-side a", {
				hasText: label,
			});
			await expect(actions.first()).toBeVisible();
			expect(await actions.count()).toBeGreaterThan(1);
			// Y-12：箭头在文字前。
			for (const action of await actions.all())
				expect(
					await action.evaluate(
						(element) => element.firstElementChild?.tagName.toLowerCase() ?? "",
					),
				).toBe("svg");
			// AC-2：无横向溢出、无控制台错误、同页没有同名控件。
			await expectCleanPage(page, errors);
			expect(await duplicateControlNames(page)).toEqual([]);
			await capture(page, info, `final-acceptance-y-agents-${mode}`);
		});
	}
});
