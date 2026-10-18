import {
	AgentApplicationProjectionV2Schema,
	AgentProjectionV2Schema,
	ConnectionCapabilityProjectionV1Schema,
	ConversationPageV1Schema,
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
import { captureDesignContract, designViewports } from "./design-contract";
import {
	computed,
	expectCardTable,
	expectDesktopTable,
	expectFieldControl,
	expectFieldLabel,
	expectFormSection,
	expectNoLegendOnBorder,
	resolved,
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
				json: {
					schemaVersion: 1,
					items: items.filter(
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
				},
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
		longApplicationTemplateId(templateId: string) {
			application = AgentApplicationProjectionV2Schema.parse({
				...application,
				source: { kind: "standard", templateId },
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

test("creation header exit supports deep links, refresh, click, keyboard and back", async ({
	page,
}, info) => {
	const api = await fixture(page);
	await page.goto("/my-agents/new");
	const headerExit = page
		.locator("main header.page-heading")
		.getByRole("link", { name: "退出创建", exact: true });
	await expect(headerExit).toBeVisible();
	await expect(headerExit).toHaveAttribute("href", "/my-agents");
	await expect(page.getByRole("link", { name: "退出创建" })).toHaveCount(2);
	const bounds = await headerExit.boundingBox();
	expect(bounds?.height).toBeGreaterThanOrEqual(44);
	await capture(page, info, "create-header-exit");
	await headerExit.click();
	await expect(page).toHaveURL(/\/my-agents$/);
	await expect(
		page.getByRole("heading", { name: "跟进申请，也维护你负责的 Agent。" }),
	).toBeVisible();
	expect(api.commands).toHaveLength(0);

	await page.goBack();
	await expect(page).toHaveURL(/\/my-agents\/new$/);
	await expect(headerExit).toBeVisible();
	await page.reload();
	await expect(headerExit).toBeVisible();
	await expect(headerExit).toHaveAttribute("href", "/my-agents");
	await headerExit.focus();
	await page.keyboard.press("Tab");
	await expect(page.getByLabel("Agent 名称")).toBeFocused();
	await page.keyboard.press("Shift+Tab");
	await expect(headerExit).toBeFocused();
	expect(
		await headerExit.evaluate(
			(element) => getComputedStyle(element).outlineStyle,
		),
	).not.toBe("none");
	await capture(page, info, "create-header-exit-refreshed-focus");
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(/\/my-agents$/);
	await expect(
		page.getByRole("heading", { name: "跟进申请，也维护你负责的 Agent。" }),
	).toBeVisible();
	expect(api.commands).toHaveLength(0);
});

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
	await expect(page.getByRole("link", { name: "退出创建" })).toHaveCount(0);
	const disabledExits = page.getByText("退出创建", { exact: true });
	await expect(disabledExits).toHaveCount(2);
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
	await expect(
		page.getByRole("link", { name: "查看申请详情", exact: true }),
	).toHaveAttribute("href", "/my-agents/application-browser-1");
	await expect(page.getByRole("link", { name: "退出创建" })).toHaveCount(1);
	await capture(page, info, "create-header-exit-success");
	await page
		.locator("main header.page-heading")
		.getByRole("link", { name: "退出创建", exact: true })
		.click();
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
	await expect(pageStatus(page)).toBeFocused();
	await expect(pageStatus(page)).toHaveText("撤回请求已提交：已撤回。");
	await expect(page.getByRole("button", { name: "撤回申请" })).toHaveCount(0);
});

test("directory search and transient submission recover on desktop and mobile", async ({
	page,
}, info) => {
	const api = await fixture(page);
	await page.goto("/my-agents/new");
	const name = page.getByLabel("Agent 名称");
	const ownerInput = page.getByRole("combobox", { name: "共同 Owner 用户" });
	const submit = page.getByRole("button", { name: "提交申请", exact: true });
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
	await page.getByRole("button", { name: "提交申请", exact: true }).click();
	await expect(page.getByRole("alert")).toContainText("当前不可用");
	await expect(page.getByLabel("Agent 名称")).toHaveValue("中文权限 Agent");
	await expect(page.getByLabel("替换值")).toHaveCount(0);
	expect(api.commands).toHaveLength(1);
	await capture(page, info, "application-authorization-rejected");
	const headerExit = page
		.locator("main header.page-heading")
		.getByRole("link", { name: "退出创建", exact: true });
	await expect(headerExit).toHaveAttribute("href", "/my-agents");
	await headerExit.focus();
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(/\/my-agents$/);
	await expect(
		page.getByRole("heading", { name: "跟进申请，也维护你负责的 Agent。" }),
	).toBeVisible();
	expect(api.commands).toHaveLength(1);
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
	// N-18：弹窗（Portal）内的 textarea 与页面字段一致，为 2px、offset 3px 的 outline，不叠加 ring。
	expect(
		await page.getByLabel("驳回原因").evaluate((element) => ({
			style: getComputedStyle(element).outlineStyle,
			width: getComputedStyle(element).outlineWidth,
			offset: getComputedStyle(element).outlineOffset,
			shadow: getComputedStyle(element).boxShadow,
		})),
	).toEqual({ style: "solid", width: "2px", offset: "3px", shadow: "none" });
	await page.getByLabel("驳回原因").fill("  Capacity is unavailable  ");
	await page.keyboard.press("Tab");
	await expect(reject).toBeFocused();
	await capture(page, info, "approvals");
	api.holdNextCommand();
	await page.keyboard.press("Enter");
	await expect(page.getByRole("button", { name: "提交中…" })).toBeDisabled();
	await expect(page.getByRole("button", { name: "返回审阅" })).toBeDisabled();
	api.release();
	await expect(pageStatus(page)).toBeFocused();
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
	await expect(pageStatus(page)).toBeVisible();
	await page.goto("/admin/approvals");
	await page.getByRole("button", { name: "审阅申请" }).click();
	await page.getByRole("button", { name: "批准并创建" }).click();
	await expect(pageStatus(page)).toContainText("创建中");
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

test("Owner configuration, Secret clearing, lifecycle and custom image upgrade", async ({
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
	await expect(page.getByLabel("替换 Agent 默认 Relay Key")).toHaveValue("");
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
	// 企微卡片按设计标题命名区域（O-07）。
	await expect(
		page.getByRole("region", { name: "企微应用", exact: true }),
	).toBeVisible();
	await capture(page, info, "owner-configuration");
	api.holdNextCommand();
	await page.getByRole("button", { name: "校验并保存" }).click();
	await expect(
		page.getByRole("button", { name: "校验并保存中…" }),
	).toBeDisabled();
	await expect(replaceModels).toBeDisabled();
	await expect(page.getByLabel("新 Secret 值")).toHaveCount(0);
	api.release();
	await expect(pageStatus(page)).toBeFocused();
	await expect(page.locator("body")).not.toContainText(
		"synthetic-browser-secret",
	);
	expect(api.commands[0]?.body).toMatchObject({
		schemaVersion: 2,
		coOwnerIds: ["user-owner-1"],
		secrets: [{ name: "RELEASE_KEY", value: "synthetic-browser-secret" }],
	});
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
	await expect(page.getByRole("link", { name: "配置与管理" })).toHaveCount(0);
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
	await expect(
		page.getByRole("heading", { name: "把资源审批做得更快，也更可核对。" }),
	).toBeVisible();
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
	const tab = page.getByRole("tab", { name: "申请", exact: true });
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
			{ path: "/agents/agent-pilot-1", actions: ["开始对话", "配置与管理"] },
			{
				path: "/agents/agent-pilot-1/configuration",
				actions: ["返回 Agent 详情"],
			},
			{ path: "/my-agents/application-browser-1", actions: ["返回我的 Agent"] },
			{ path: "/my-agents/new", actions: ["退出创建"] },
		]) {
			await page.goto(path);
			const heading = page.locator("main .page-heading").first();
			await expect(heading).toBeVisible();
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
					.locator('[data-slot="button"], a[class~="group/button"]')
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
	await expect(
		page.getByRole("heading", { name: "把资源审批做得更快，也更可核对。" }),
	).toBeVisible();
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
		await expect(
			page.getByRole("heading", { name: "把资源审批做得更快，也更可核对。" }),
		).toBeVisible();
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
	await page.route(/\/api\/v1\/agents\/[^/]+\/wecom-/, async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path.endsWith("/wecom-bot"))
			return route.fulfill({
				json: { status: active ? "connected" : "not_configured" },
			});
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
	await page.getByRole("link", { name: "配置与管理" }).click();
	// CK-09：扫码入口不要求先勾选「我已知悉」；O-08：不可用时显示面板，不打开窗口。
	const qrTrigger = page.getByRole("button", { name: "扫码授权" });
	await qrTrigger.click();
	const bot = page.getByRole("region", { name: "企微机器人", exact: true });
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
	expect(
		await page.evaluate(
			() =>
				(window as unknown as { __openedWindows: string[] }).__openedWindows,
		),
	).toEqual([]);
	await expect
		.poll(() => setupRequests)
		.toEqual([
			"POST /api/v1/agents/agent-pilot-1/wecom-setup",
			"POST /api/v1/agents/agent-pilot-1/wecom-setup/fixture-setup/cancel",
		]);
	await bot.getByRole("button", { name: "改用手动配置" }).click();
	await expect(page.getByLabel("Bot ID", { exact: true })).toBeFocused();
	await qrTrigger.click();
	await bot.getByRole("button", { name: "关闭", exact: true }).click();
	await expect(qrTrigger).toBeFocused();
	// 已知扫码不可用后再次打开不再创建 setup session。
	expect(setupRequests).toHaveLength(2);
	await page
		.getByRole("checkbox", {
			name: "我已知悉：连接此机器人可能断开它在其他服务中的现有连接。",
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
	await expect(page.getByLabel(/配置标识/)).toHaveCount(0);
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
	// 空态标题按设计改为 strong（B-11），不再是 heading。
	const empty = page.locator('[data-slot="empty"]', {
		hasText: "暂无你管理的 Agent",
	});
	await expect(empty).toBeVisible();
	await expect(empty.getByRole("heading")).toHaveCount(0);
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
	await expect(page.getByRole("link", { name: "查看申请" })).toBeVisible();
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
	await expect(
		page.getByRole("heading", { name: "申请详情暂不可用" }),
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
			await expect(
				main.getByRole("link", { name: "打开 Agent" }),
			).toHaveAttribute("href", "https://agent.example.test/");
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

test("long application template IDs wrap inside narrow application panels", async ({
	page,
}, info) => {
	const api = await fixture(page);
	const templateId = `template-${"identifier".repeat(11)}`;
	api.longApplicationTemplateId(templateId);
	await page.goto("/my-agents");
	const badge = page.getByText(templateId, { exact: true });
	await expect(badge).toBeVisible();
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
				page.getByRole("button", { name: "校验并保存", exact: true }),
			).toBeVisible();
		else if (route === "/admin/approvals")
			await expect(
				page.getByRole("button", { name: "审阅申请", exact: true }).first(),
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
				await page
					.getByRole("tab", { name: "已创建 Agent", exact: true })
					.click();
				await expect(page.locator(".owned-agent-card").first()).toBeVisible();
				await captureDesignContract(page, info, "my-agents-owned");
				await page.getByRole("tab", { name: "申请", exact: true }).click();
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
	await page.getByRole("link", { name: "配置与管理" }).click();
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
	await page.getByRole("button", { name: "校验并保存" }).click();
	await expect(
		page.getByRole("status").filter({ hasText: "配置已提交" }),
	).toBeVisible();
	expect(api.commands.at(-1)?.body).toMatchObject({
		schemaVersion: 2,
		coOwnerIds: ["user-owner-1", "user-2"],
		availability: [
			{ kind: "user", userId: "user-3" },
			{ kind: "organization", organizationId: "org-platform" },
		],
	});
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
		page.getByRole("button", { name: "审阅申请", exact: true }).first(),
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
		route.fulfill({ json: { schemaVersion: 1, items: [] } }),
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
	await page.getByRole("link", { name: "配置与管理" }).click();
	// 目录不可用时 Owner chip 仍显示 Agent 投影中的显示名，降级说明不进入按钮名称。
	await expect(page.getByText("目录详情暂时无法读取")).toHaveCount(2);
	await expect(page.getByRole("button", { name: "移除 Owner" })).toBeVisible();
	await expect(
		page.getByRole("button", { name: "移除 未识别的组织 1" }),
	).toBeVisible();
	await expect(page.locator("main")).not.toContainText(
		/目录记录不可用|无法读取目录详情|grant\/revoke|推断完整授权列表/,
	);
	await page.getByRole("combobox", { name: "共同 Owner 用户" }).fill("owner");
	await expect(page.getByText("目录暂时无法读取")).toBeVisible();
	await page.keyboard.press("Enter");
	await expect(page.getByRole("option")).toHaveCount(0);
	await page.keyboard.press("Escape");
	await capture(page, info, "directory-configuration-error");
	// 没有任何改动时保存不可用（#2560）：先做一次与 Owner、范围无关的真实改动，
	// 再确认目录读取失败时未解析的选择仍随请求原样提交。
	await expect(page.getByRole("button", { name: "校验并保存" })).toBeDisabled();
	await page.getByRole("button", { name: "添加 Secret" }).click();
	await page.getByLabel("Secret 名称").fill("CHANGED_SECRET");
	await page.getByLabel("新 Secret 值").fill("changed-secret-value");
	await page.getByRole("button", { name: "校验并保存" }).click();
	await expect(
		page.getByRole("status").filter({ hasText: "配置已提交" }),
	).toBeVisible();
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
	for (const name of [
		"共同 Owner",
		"可用范围",
		"企微渠道",
		"模型配置",
		"Secrets",
	])
		await expectFormSection(page, name);
	await expectNoLegendOnBorder(page);

	// B-15：未改动时保存不可用；禁用按钮 not-allowed、半透明，且不靠 pointer-events: none。
	const save = page.getByRole("button", { name: "校验并保存" });
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
	const applications = page.getByRole("tab", { name: "申请", exact: true });
	const owned = page.getByRole("tab", { name: "已创建 Agent" });
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
	const owned = page.getByRole("tab", { name: "已创建 Agent" });
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
	const badge = table.locator('[data-slot="badge"]').first();
	for (const viewport of [
		{ width: 1440, height: 900 },
		{ width: 768, height: 1024 },
	]) {
		await page.setViewportSize(viewport);
		await expectDesktopTable(page, table);
	}
	await page.setViewportSize({ width: 1440, height: 900 });
	const desktopBadgeWidth = (await badge.boundingBox())?.width;
	expect(desktopBadgeWidth).toBeGreaterThan(0);
	for (const viewport of [
		{ width: 390, height: 844 },
		{ width: 320, height: 640 },
	]) {
		await page.setViewportSize(viewport);
		const review = page.getByRole("button", { name: "审阅申请" });
		await expectCardTable(page, table, review);
		// NI-99：状态徽章仍是带圆点的行内块，宽度与桌面一致，右缘与值容器对齐。
		const geometry = await badge.evaluate((element) => {
			const value = element.closest('[data-slot="table-cell-value"]');
			const dot = getComputedStyle(element, "::before");
			return {
				display: getComputedStyle(element).display,
				dot: [dot.width, dot.height, dot.display],
				width: element.getBoundingClientRect().width,
				rightGap: Math.abs(
					(value?.getBoundingClientRect().right ?? 0) -
						element.getBoundingClientRect().right,
				),
			};
		});
		expect(geometry.display).not.toBe("block");
		expect(
			Math.abs(geometry.width - (desktopBadgeWidth ?? 0)),
		).toBeLessThanOrEqual(1);
		expect(geometry.dot).toEqual(["6px", "6px", "block"]);
		expect(geometry.rightGap).toBeLessThanOrEqual(1);
	}
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
	const available = card.locator('[data-slot="badge"]', { hasText: "可用" });
	await expect(available).toHaveCSS(
		"color",
		await resolvedColor(page, "var(--success-ink)"),
	);
	await expect(available).toHaveCSS(
		"background-color",
		await resolvedColor(
			page,
			"color-mix(in oklch, var(--success) 8%, var(--surface))",
		),
	);
	const starting = card.locator('[data-slot="badge"]', { hasText: "启动中" });
	await expect(starting).toHaveCSS(
		"color",
		await resolvedColor(page, "var(--warning-ink)"),
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
	api.unavailableAgentList();
	await page.goto("/agents");
	const notice = page.getByRole("alert");
	await expect(notice).toContainText("Agent 列表暂时无法读取");
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
		notice.getByRole("button", { name: "重新加载 Agent" }),
	).toBeVisible();
});

test("empty states use the design surface and a non-display title", async ({
	page,
}) => {
	await fixture(page, "employee");
	await page.goto("/my-agents");
	await page.getByRole("tab", { name: "已创建 Agent" }).click();
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
	await expect(footer.getByRole("button", { name: "继续保留申请" })).toHaveCSS(
		"background-color",
		"rgba(0, 0, 0, 0)",
	);
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
	expect(await dangerFills(page)).toContain(
		await dialog
			.getByRole("button", { name: "停止 Agent" })
			.evaluate((element) => getComputedStyle(element).backgroundColor),
	);
	await page.keyboard.press("Escape");
	await expect(dialog).not.toBeVisible();
	await page.getByRole("button", { name: "重启 Agent" }).click();
	dialog = page.getByRole("dialog", { name: /^重启.+？$/ });
	await expect(dialog).toBeVisible();
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
	await expect(page.locator("main .page-heading")).toContainText(
		"保存后更新运行实例；Secret 只显示状态和版本。",
	);

	// O-12：返回入口为 ghost sm，图标 16px，href 不变。
	const back = page.getByRole("link", { name: "返回 Agent 详情" });
	await expect(back).toHaveAttribute("href", "/agents/agent-pilot-1");
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
	const save = footer.getByRole("button", { name: "校验并保存" });
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
	await page.getByRole("button", { name: "添加 Secret" }).click();
	await page.getByLabel("Secret 名称").fill("RELEASE_KEY");
	await page.getByLabel("新 Secret 值").fill("synthetic-tab-secret");
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
	await expect(stop.locator("svg")).toHaveAttribute("aria-hidden", "true");
	// R4-14：状态只在页头显示，危险区只有标题、说明和按钮。
	for (const text of ["Agent 状态", "服务状态", "服务已就绪。", "停用"])
		await expect(danger).not.toContainText(text);
	await expect(page.locator("#main-content")).not.toContainText("Agent 状态");
	// Owner（非管理员）不渲染任何仅属于管理员的元素。
	await expect(page.getByRole("button", { name: "停用 Agent" })).toHaveCount(0);
	await expect(page.getByText("管理员操作")).toHaveCount(0);
	await capture(page, info, "owner-lifecycle-layout");

	// 保存结果替换表单期间，重启仍可见可用（O-11）。
	await save.click();
	await expect(pageStatus(page)).toContainText("配置已提交");
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

test("a pure administrator reaches the same configuration page with authorization and administrator actions only", async ({
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
	await expect(
		page.getByRole("region", { name: "Agent 授权控制", exact: true }),
	).toBeVisible();
	const admin = page.getByRole("region", { name: "管理员操作", exact: true });
	await expect(admin.getByRole("button")).toHaveText([
		"重试创建",
		"停用 Agent",
	]);
	await expect(page.locator(".form-aside")).toHaveCount(0);
	await expect(
		page.getByRole("combobox", { name: "共同 Owner 用户" }),
	).toHaveCount(0);
	await expect(page.getByRole("button", { name: "校验并保存" })).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: /停止 Agent|重启 Agent/ }),
	).toHaveCount(0);
	// 卡片嵌套不超过两层：授权控制所在的卡片不包含管理员区。
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
	await page.route(/\/api\/v1\/agents\/[^/]+\/wecom-/, async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path.endsWith("/wecom-bot"))
			return route.fulfill({ json: { status: state.bot } });
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
	await expect(page.getByRole("button", { name: "校验并保存" })).toBeEnabled();
}

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
	await expect(page.getByRole("button", { name: "校验并保存" })).toBeEnabled();
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
	await page.getByRole("link", { name: "配置与管理" }).click();
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
