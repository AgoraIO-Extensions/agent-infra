import {
	AgentProjectionV2Schema,
	ConnectionCapabilityProjectionV1Schema,
	ConversationPageV1Schema,
	SkillHubAgentBindingCommandV1Schema,
	SkillHubAgentBindingResultV1Schema,
	SkillHubAgentBindingStatusResponseV1Schema,
	SkillHubAgentCurrentVersionV1Schema,
	SkillHubDirectoryPageV1Schema,
	SkillHubVersionMetadataV1Schema,
} from "@agent-infra/contracts/pilot";
import {
	createPilotAgentMockServerV2,
	pilotFakeScenariosV2,
} from "@agent-infra/test-support/pilot";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { directorySearchResponse } from "../src/features/directory-test-fixtures";
import type {
	AgentCreationFailureCategoryV1,
	DeploymentConfigurationProjectionV2,
	SkillHubAgentBindingStatusV1,
} from "../src/pilot/generated-v2/types.gen";
import { expectNoDuplicateControls } from "./page-health";
import {
	computed,
	expectCleanPage,
	expectPointerButtons,
	expectSkillDialog,
	resolved,
	trackPageErrors,
} from "./primitive-styles";

// Owner 配置的 Secret 与环境变量（O-10、N-08）、模型与默认 Relay Key（G-08、G-09、RK2-01～09）、
// Skill 绑定入口与绑定页（O-02、#2903）。契约 Fake API；页面级状态只在 #main-content 内查找（Toast 宿主是 role=status）。

type Role = "owner" | "admin" | "employee";
type CandidateMode = "same" | "subset" | "empty" | "error" | "forbidden";

const deploymentConfiguration: DeploymentConfigurationProjectionV2 = {
	modelCatalog: {
		endpoints: [
			{
				displayName: "Relay · Internal",
				endpointId: "endpoint-primary",
				models: [
					{ modelId: "gpt-5", reasoningLevels: ["medium", "high"] },
					{ modelId: "gpt-5-mini", reasoningLevels: ["medium"] },
				],
			},
		],
		revision: "catalog-owner-config",
		status: "populated",
	},
	schemaVersion: 2,
	status: "populated",
	templates: [
		{
			allowedEnvironmentKeys: ["AGENT_WORKSPACE", "LOG_LEVEL"],
			allowedSecretKeys: ["RELEASE_KEY", "MODEL_API_KEY"],
			connectionEnabled: false,
			displayName: "Codex",
			templateId: "codex",
		},
	],
};

const candidates = {
	gpt5: {
		endpointId: "endpoint-primary",
		modelId: "gpt-5",
		reasoningLevels: ["medium", "high"],
	},
	mini: {
		endpointId: "endpoint-primary",
		modelId: "gpt-5-mini",
		reasoningLevels: ["medium"],
	},
};

test("renders trusted candidate names and saves only the original model identifiers", async ({
	page,
}) => {
	const api = await ownerConfigFixture(page, { keySet: true });
	api.modelNames({ "gpt-5": "可信模型甲", "gpt-5-mini": "可信模型乙" });
	await page.goto("/agents/agent-pilot-1/configuration");
	await expect(
		page.getByRole("checkbox", {
			name: "Relay · Internal · 可信模型甲",
			exact: true,
		}),
	).toBeVisible();
	const keySection = page.getByRole("region", {
		name: "Agent 默认 Relay Key",
		exact: true,
	});
	await expect(
		keySection.getByText("可信模型甲 · 均衡/高", { exact: true }),
	).toBeVisible();
	await expect(keySection).not.toContainText("gpt-5");
	await page
		.getByRole("checkbox", {
			name: "Relay · Internal · 可信模型乙",
			exact: true,
		})
		.click();
	await page.getByRole("button", { name: "保存配置", exact: true }).click();
	await expect
		.poll(
			() =>
				api.commands.filter(({ path }) =>
					path.endsWith("/configuration/saved-model"),
				).length,
		)
		.toBe(1);
	const saved = api.commands.find(({ path }) =>
		path.endsWith("/configuration/saved-model"),
	);
	const payload = saved?.body as {
		modelConfiguration: {
			options: { optionId: string; endpointId: string; modelId: string }[];
		};
	};
	expect(
		payload.modelConfiguration.options.map(
			({ endpointId, modelId, optionId }) => ({
				endpointId,
				modelId,
				optionId,
			}),
		),
	).toEqual([
		{
			endpointId: "endpoint-primary",
			modelId: "gpt-5",
			optionId: "endpoint-primary:gpt-5",
		},
		{
			endpointId: "endpoint-primary",
			modelId: "gpt-5-mini",
			optionId: "endpoint-primary:gpt-5-mini",
		},
	]);
	expect(JSON.stringify(payload)).not.toMatch(/可信模型|displayName/);
});

// Skill 绑定页的目录：同一 Skill 的两个版本与另一个 Skill（#2903）。
const skillVersion = (name: string, version: string, id: string) =>
	SkillHubVersionMetadataV1Schema.parse({
		schemaVersion: 1,
		skillId: `${name}-skill`,
		skillVersionId: id,
		name,
		version,
		provider: "my_library",
		visibility: "PRIVATE",
		state: "published",
		packageDigest: "a".repeat(64),
		manifestDigest: "b".repeat(64),
		signatureDigest: "c".repeat(64),
	});
const skillDirectory = [
	skillVersion("workspace-summary", "1.0.0", "workspace-summary-v1"),
	skillVersion("workspace-summary", "1.1.0", "workspace-summary-v2"),
	skillVersion("code-review", "1.0.0", "code-review-v1"),
];

const unavailable = (status: number, retryable: boolean) => ({
	status,
	json: {
		schemaVersion: 1,
		code: retryable ? "DEPENDENCY_UNAVAILABLE" : "RESOURCE_UNAVAILABLE",
		message: "Controlled failure",
		retryable,
		traceId: "trace-owner-config",
	},
});

async function ownerConfigFixture(
	page: Page,
	{
		role = "owner",
		keySet = false,
		saved = "same",
		agentVersion = null,
		creationFailure,
	}: {
		role?: Role;
		keySet?: boolean;
		saved?: CandidateMode;
		/** 部署级 Agent Version；null 表示部署未配置（#2903）。 */
		agentVersion?: string | null;
		/** 设置时 Agent 处于创建失败，服务端给出该失败类别（#3034）。 */
		creationFailure?: AgentCreationFailureCategoryV1;
	} = {},
) {
	const base = AgentProjectionV2Schema.parse(
		pilotFakeScenariosV2.starting.response.body,
	);
	let agent = AgentProjectionV2Schema.parse({
		...base,
		...(creationFailure
			? { managementStatus: "creation_failed", serviceAvailability: null }
			: {}),
		configuration: {
			...base.configuration,
			environment: [{ name: "AGENT_WORKSPACE", value: "platform" }],
			secrets: [{ name: "RELEASE_KEY", isSet: true, version: 3 }],
		},
	});
	let keyVersion = 3;
	let configurationRevision = 7;
	let savedMode = saved;
	let checkCandidates = [candidates.gpt5, candidates.mini];
	let modelNames: Readonly<Record<string, string>> = {};
	const withName = (candidate: typeof candidates.gpt5) => ({
		...candidate,
		displayName: modelNames[candidate.modelId] ?? candidate.modelId,
	});
	const failures = new Set<string>();
	const gates = new Map<string, Promise<void>>();
	const releases = new Map<string, () => void>();
	const commands: { method: string; path: string; body: unknown }[] = [];
	const reads: string[] = [];
	let skillBindings: SkillHubAgentBindingStatusV1[] = [];
	const userId =
		role === "owner"
			? "user-owner-1"
			: role === "admin"
				? "user-admin-1"
				: "user-employee-1";
	const server = createPilotAgentMockServerV2({
		getCurrentSession: {
			status: 200,
			body: {
				schemaVersion: 1,
				user: {
					userId,
					displayName: role,
					roles: role === "admin" ? ["employee", "system_admin"] : ["employee"],
				},
			},
		},
		getDeploymentConfiguration: () => ({
			status: 200,
			body: deploymentConfiguration,
		}),
		listAgents: () => ({
			status: 200,
			body: { items: [agent], nextCursor: null },
		}),
		getAgent: () => ({ status: 200, body: agent }),
		getAgentDefaultRelayKey: () => ({
			status: 200,
			body: keySet
				? { schemaVersion: 1, isSet: true, keyVersion, configurationRevision }
				: {
						schemaVersion: 1,
						isSet: false,
						keyVersion: null,
						configurationRevision,
					},
		}),
		updateAgentConfiguration: () => ({ status: 200, body: agent }),
		getAgentCreationFailure: (_request, agentId) =>
			creationFailure
				? {
						status: 200,
						body: { schemaVersion: 1, agentId, category: creationFailure },
					}
				: { status: 404, body: unavailable(404, false).json },
	});
	const gate = async (name: string) => {
		await gates.get(name);
		gates.delete(name);
	};
	await page.route(/\/api\/v[12]\//, async (route) => {
		const request = route.request();
		const method = request.method();
		const pathname = new URL(request.url()).pathname;
		const body = request.postData() ? request.postDataJSON() : undefined;
		if (method === "GET") reads.push(pathname);
		if (method === "GET" && pathname === "/api/v1/connection/capability")
			return route.fulfill({
				json: ConnectionCapabilityProjectionV1Schema.parse({
					schemaVersion: 1,
					status: "unavailable",
					reason: "missing",
				}),
			});
		if (method === "GET" && pathname === "/api/v2/me/conversations/recent")
			return route.fulfill({
				json: ConversationPageV1Schema.parse({ items: [], nextCursor: null }),
			});
		if (method === "GET" && pathname === "/api/v2/directory/search") {
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
			];
			return route.fulfill({
				json: directorySearchResponse(
					url,
					items.filter(
						(item) =>
							item.kind === url.searchParams.get("kind") &&
							(!url.searchParams.has("ids") ||
								url.searchParams
									.get("ids")
									?.split(",")
									.includes(item.canonicalId)),
					),
				),
			});
		}
		if (/\/wecom-(bot|app)$/.test(pathname))
			return route.fulfill({ json: { status: "not_configured" } });
		if (method !== "GET") commands.push({ method, path: pathname, body });
		// Skill 绑定（#2903）：当前版本与绑定读写只对当前 Owner 开放，部署未配置时不可用。
		if (method === "GET" && pathname === "/api/v2/skills")
			return route.fulfill({
				json: SkillHubDirectoryPageV1Schema.parse({
					items: skillDirectory,
					nextCursor: null,
				}),
			});
		if (pathname === "/api/v2/agents/agent-pilot-1/skills/current-version") {
			if (role !== "owner" || agentVersion === null)
				return route.fulfill(unavailable(404, false));
			return route.fulfill({
				json: SkillHubAgentCurrentVersionV1Schema.parse({
					schemaVersion: 1,
					agentId: "agent-pilot-1",
					agentVersion,
					configurationRevision,
				}),
			});
		}
		const bindingPath =
			/^\/api\/v2\/agents\/agent-pilot-1\/versions\/([^/]+)\/skills$/.exec(
				pathname,
			);
		if (bindingPath) {
			if (role !== "owner" || agentVersion === null)
				return route.fulfill(unavailable(404, false));
			if (decodeURIComponent(bindingPath[1] ?? "") !== agentVersion)
				return route.fulfill(unavailable(409, false));
			if (method === "GET")
				return route.fulfill({
					json: SkillHubAgentBindingStatusResponseV1Schema.parse({
						schemaVersion: 1,
						agentId: "agent-pilot-1",
						agentVersion,
						configurationRevision,
						bindings: skillBindings,
					}),
				});
			const command = SkillHubAgentBindingCommandV1Schema.parse(body);
			if (command.expectedConfigurationRevision !== configurationRevision)
				return route.fulfill(unavailable(409, false));
			configurationRevision += 1;
			// 完整集合替换：每项按目录版本进入等待同步。
			skillBindings = command.bindings.map((binding) => {
				const metadata = skillDirectory.find(
					(item) => item.skillVersionId === binding.skillVersionId,
				);
				if (!metadata) throw new Error("Unknown Skill version in fixture");
				return {
					schemaVersion: 1,
					agentId: "agent-pilot-1",
					agentVersion,
					skillName: metadata.name,
					skillVersion: {
						schemaVersion: 1,
						skillId: metadata.skillId,
						skillVersionId: metadata.skillVersionId,
						provider: metadata.provider,
						version: metadata.version,
						packageDigest: metadata.packageDigest,
						manifestDigest: metadata.manifestDigest,
						signatureDigest: metadata.signatureDigest,
					},
					grant: binding.grant,
					configurationRevision,
					syncRevision: 1,
					state: "pending_sync",
					failureReason: null,
					appliedReceipt: null,
				};
			});
			return route.fulfill({
				status: 201,
				json: SkillHubAgentBindingResultV1Schema.parse({
					schemaVersion: 1,
					agentId: "agent-pilot-1",
					agentVersion,
					configurationRevision,
					changedFields: ["skills"],
					replayed: false,
				}),
			});
		}
		if (pathname.endsWith("/default-relay-key/display-candidates")) {
			if (method === "GET") {
				await gate("saved-candidates");
				if (savedMode === "error") return route.fulfill(unavailable(503, true));
				if (savedMode === "forbidden")
					return route.fulfill(unavailable(403, false));
				return route.fulfill({
					json: {
						schemaVersion: 2,
						configurationRevision,
						keyVersion,
						candidates: (savedMode === "empty"
							? []
							: savedMode === "subset"
								? [candidates.mini]
								: [candidates.gpt5, candidates.mini]
						).map(withName),
					},
				});
			}
			await gate("check");
			return route.fulfill({
				json: {
					schemaVersion: 2,
					configurationRevision,
					candidates: checkCandidates.map(withName),
				},
			});
		}
		if (method === "PUT" && pathname.endsWith("/default-relay-key")) {
			await gate("replace-key");
			if (failures.delete("replace-key"))
				return route.fulfill(unavailable(503, true));
			keyVersion += 1;
			configurationRevision += 1;
			return route.fulfill({
				json: {
					schemaVersion: 1,
					isSet: true,
					keyVersion,
					configurationRevision,
				},
			});
		}
		if (method === "PUT" && pathname.endsWith("/configuration")) {
			await gate("configuration");
			if (failures.delete("configuration"))
				return route.fulfill(unavailable(503, true));
			// Fake 按请求更新投影：Secret 版本递增，环境变量整表替换。
			const update = body as {
				secrets?: { name: string }[];
				environment?: { name: string; value: string }[];
			};
			const secrets = [...agent.configuration.secrets];
			for (const { name } of update.secrets ?? []) {
				const index = secrets.findIndex((secret) => secret.name === name);
				const previous = index >= 0 ? (secrets[index]?.version ?? 0) : 0;
				const next = { name, isSet: true, version: previous + 1 };
				if (index >= 0) secrets[index] = next;
				else secrets.push(next);
			}
			agent = AgentProjectionV2Schema.parse({
				...agent,
				configuration: {
					...agent.configuration,
					secrets,
					...(update.environment ? { environment: update.environment } : {}),
				},
			});
			configurationRevision += 1;
		}
		if (method === "PUT" && pathname.endsWith("/configuration/saved-model"))
			return route.fulfill({ json: agent });
		const response = await server.fetch(
			new Request(request.url(), {
				method,
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
		reads,
		modelNames(names: Readonly<Record<string, string>>) {
			modelNames = names;
		},
		hold(name: "saved-candidates" | "check" | "replace-key" | "configuration") {
			gates.set(
				name,
				new Promise<void>((resolve) => {
					releases.set(name, resolve);
				}),
			);
		},
		release(name: string) {
			releases.get(name)?.();
			releases.delete(name);
		},
		fail(name: "replace-key" | "configuration") {
			failures.add(name);
		},
		checkReturns(next: typeof checkCandidates) {
			checkCandidates = next;
		},
		savedMode(next: CandidateMode) {
			savedMode = next;
		},
	};
}

const toast = (page: Page) => page.locator('[data-slot="toast"]');
const main = (page: Page) => page.locator("#main-content");

async function noHorizontalOverflow(page: Page) {
	const width = await page.evaluate(() => ({
		viewport: innerWidth,
		content: document.documentElement.scrollWidth,
	}));
	expect(width.content).toBeLessThanOrEqual(width.viewport);
}

async function height(locator: Locator) {
	return (await locator.boundingBox())?.height ?? 0;
}

/**
 * #3075：绑定确认弹窗显示 Agent、文件范围、脚本、生效条件四项事实，事实列表不是 <p> 的后代。
 * CI 的生产构建不打 React DOM 嵌套告警，所以这里直接断言结构。
 */
async function expectBindingFacts(dialog: Locator) {
	const facts = dialog.locator("dl.skill-binding-facts");
	await expect(facts).toBeVisible();
	await expect(facts.locator("dt")).toHaveText([
		"Agent",
		"文件范围",
		"脚本",
		"生效条件",
	]);
	await expect(facts.locator("dd")).toHaveText([
		AgentProjectionV2Schema.parse(pilotFakeScenariosV2.starting.response.body)
			.name,
		"不额外授予文件或网络权限",
		"禁用",
		"同步完成且装配确认",
	]);
	await expect(dialog.locator("p dl, p dt, p dd")).toHaveCount(0);
	expect(await facts.evaluate((element) => element.closest("p") === null)).toBe(
		true,
	);
	// 事实列表仍是弹窗的可访问描述。
	await expect(dialog).toHaveAccessibleDescription(/同步完成且装配确认/);
}

/** 在窗口上放一个探针并记录之后的文档请求：整页刷新会丢掉探针并发出文档请求。 */
async function markSinglePageNavigation(page: Page) {
	await page.evaluate(() => {
		Object.assign(window, { __ownerConfigProbe: "kept" });
	});
	const documents: string[] = [];
	page.on("request", (request) => {
		if (request.resourceType() === "document") documents.push(request.url());
	});
	return documents;
}

async function expectNoDocumentNavigation(page: Page, documents: string[]) {
	expect(
		await page.evaluate(
			() =>
				(window as unknown as { __ownerConfigProbe?: string })
					.__ownerConfigProbe,
		),
	).toBe("kept");
	expect(documents).toEqual([]);
}

async function expectDangerInkFieldError(page: Page, error: Locator) {
	expect(
		await computed(error, ["fontSize", "color", "borderTopWidth"]),
	).toEqual({
		fontSize: "12px",
		color: await resolved(page, "color", "var(--danger-ink)"),
		borderTopWidth: "0px",
	});
	expect(
		await error.evaluate((element) =>
			Boolean(element.closest('[data-slot="alert"]')),
		),
	).toBe(false);
}

test("Secrets are read-only rows replaced through a write-only modal (O-10, N-08)", async ({
	page,
}, info) => {
	const api = await ownerConfigFixture(page);
	const probe = "probe-secret-value";
	const pageHasProbe = async () => (await page.content()).includes(probe);
	await page.goto("/agents/agent-pilot-1/configuration");
	const section = page.getByRole("region", {
		name: "环境变量与 Secret",
		exact: true,
	});
	await expect(
		section.getByText("Secret 只显示名称、版本和状态；替换后生成新版本。"),
	).toBeVisible();
	const name = section.getByLabel("Secret 名称", { exact: true });
	const status = section.getByLabel("当前状态", { exact: true });
	await expect(name).toHaveValue("RELEASE_KEY");
	await expect(name).toHaveAttribute("readonly", "");
	await expect(status).toHaveValue("已设置 · version 3");
	const trigger = section.getByRole("button", {
		name: "替换 Secret：RELEASE_KEY",
	});
	await expect(trigger.locator("svg")).toHaveCount(1);
	await expect(section.locator('input[type="password"]')).toHaveCount(0);
	// 申请表单的「移除 Secret」已补中英文空格；两种写法都不得出现。
	await expect(main(page)).not.toContainText(/移除\s?Secret/);
	// NI-78：三个入口都是默认尺寸 44px。
	for (const button of [
		trigger,
		section.getByRole("button", { name: "添加 Secret" }),
		section.getByRole("button", { name: "添加环境变量" }),
	])
		expect(Math.abs((await height(button)) - 44)).toBeLessThanOrEqual(0.5);
	// 1440 三列同行，390 单列。
	const [nameBox, statusBox, triggerBox] = await Promise.all([
		name.boundingBox(),
		status.boundingBox(),
		trigger.boundingBox(),
	]);
	if (info.project.name === "desktop") {
		expect(statusBox?.y).toBe(nameBox?.y);
		expect((triggerBox?.x ?? 0) > (statusBox?.x ?? 0)).toBe(true);
	} else {
		expect((statusBox?.y ?? 0) > (nameBox?.y ?? 0)).toBe(true);
		expect((triggerBox?.y ?? 0) > (statusBox?.y ?? 0)).toBe(true);
	}
	await noHorizontalOverflow(page);

	// 先做未保存的修改：移除组织范围、改环境变量、加一行空白环境变量（NI-71）。
	await page.getByRole("button", { name: "移除 平台工程" }).click();
	// 移除 chip 后焦点在下一帧回到该选择器的输入框；先等焦点落定，再填写其他字段，
	// 否则高负载下 fill 的输入会落进目录选择器。
	await expect(
		page.getByRole("combobox", { name: "可使用的组织", exact: true }),
	).toBeFocused();
	await section.getByLabel("值", { exact: true }).fill("unsaved-workspace");
	await expect(section.getByLabel("值", { exact: true })).toHaveValue(
		"unsaved-workspace",
	);
	await section.getByRole("button", { name: "添加环境变量" }).click();

	// 取消、Esc、点遮罩都不发请求，焦点回到触发按钮。
	for (const dismiss of ["cancel", "escape", "backdrop"] as const) {
		await trigger.click();
		const dialog = page.getByRole("dialog", { name: "替换 Secret" });
		await expect(dialog).toHaveAttribute("aria-modal", "true");
		await expect(dialog).toContainText(
			"输入新值后只会保存密文版本。页面不会显示当前 Secret 值。",
		);
		await expect(dialog).toContainText("RELEASE_KEY");
		const input = dialog.getByLabel("新 Secret 值");
		await expect(input).toBeFocused();
		await expect(input).toHaveAttribute("placeholder", "仅本次提交使用");
		await expect(input).toHaveValue("");
		await expect(
			dialog.locator('[data-slot="dialog-footer"]').getByRole("button"),
		).toHaveText(["取消", "保存替换"]);
		await input.fill("discarded-value");
		if (dismiss === "cancel")
			await dialog.getByRole("button", { name: "取消" }).click();
		else if (dismiss === "escape") await page.keyboard.press("Escape");
		else await page.mouse.click(5, 5);
		await expect(dialog).toBeHidden();
		await expect(trigger).toBeFocused();
	}
	expect(api.commands).toEqual([]);

	await trigger.click();
	const dialog = page.getByRole("dialog", { name: "替换 Secret" });
	const input = dialog.getByLabel("新 Secret 值");
	// 空值：零请求，字段下方 12px --danger-ink 的纯文字错误（NI-95）。
	await dialog.getByRole("button", { name: "保存替换" }).click();
	const empty = dialog.getByText("请输入新的 Secret 值。");
	await expectDangerInkFieldError(page, empty);
	await expect(input).toHaveAttribute("aria-invalid", "true");
	expect(api.commands).toEqual([]);

	// 失败：弹窗保留，弹窗内提示，焦点回到密码框，不写页面级错误。
	await input.fill(probe);
	expect(await pageHasProbe()).toBe(false);
	api.hold("configuration");
	api.fail("configuration");
	await dialog.getByRole("button", { name: "保存替换" }).press("Enter");
	const pending = dialog.getByRole("button", { name: "正在保存…" });
	await expect(pending).toHaveAttribute("aria-disabled", "true");
	await expect(pending).toBeFocused();
	expect(await pageHasProbe()).toBe(false);
	await page.keyboard.press("Escape");
	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole("button", { name: "关闭" })).toBeDisabled();
	api.release("configuration");
	await expect(dialog.getByRole("alert")).toHaveText(
		"Secret 替换未完成，请重试。",
	);
	await expect(input).toBeFocused();
	await expect(main(page)).not.toContainText("配置未能保存");

	// 成功：只提交这一个 Secret，关闭弹窗，Toast 带新版本，行状态回读更新。
	await dialog.getByRole("button", { name: "保存替换" }).click();
	await expect(dialog).toBeHidden();
	expect(api.commands.map(({ path, body }) => ({ path, body }))).toEqual([
		{
			path: "/api/v2/agents/agent-pilot-1/configuration",
			body: {
				schemaVersion: 2,
				secrets: [{ name: "RELEASE_KEY", value: probe }],
			},
		},
		{
			path: "/api/v2/agents/agent-pilot-1/configuration",
			body: {
				schemaVersion: 2,
				secrets: [{ name: "RELEASE_KEY", value: probe }],
			},
		},
	]);
	await expect(toast(page)).toHaveText(
		"Secret 已写入 pending version 4，等待平台激活",
	);
	await expect(status).toHaveValue("已设置 · version 4");
	await expect(trigger).toBeFocused();
	expect(await pageHasProbe()).toBe(false);
	// 未保存的修改仍在页面上，页脚保存仍可用。
	await expect(page.getByRole("button", { name: "移除 平台工程" })).toHaveCount(
		0,
	);
	await expect(section.getByLabel("值", { exact: true }).first()).toHaveValue(
		"unsaved-workspace",
	);
	await expect(page.getByRole("button", { name: "保存配置" })).toBeEnabled();
	await expect(main(page)).not.toContainText("配置已提交");
});

test("environment variables save as a full table and the page stays after saving (O-10, RK2-09)", async ({
	page,
}) => {
	const api = await ownerConfigFixture(page);
	await page.goto("/agents/agent-pilot-1/configuration");
	const section = page.getByRole("region", {
		name: "环境变量与 Secret",
		exact: true,
	});
	const name = section.getByLabel("环境变量名", { exact: true });
	await expect(name).toHaveValue("AGENT_WORKSPACE");
	// 标准模板只能选模板开放的键。
	expect(
		await name.evaluate((select) =>
			[...(select as HTMLSelectElement).options].map((option) => option.value),
		),
	).toEqual(["", "AGENT_WORKSPACE", "LOG_LEVEL"]);
	await expect(
		section.getByRole("button", { name: "移除：AGENT_WORKSPACE" }),
	).toHaveText("移除");
	const save = page.getByRole("button", { name: "保存配置" });
	await expect(save).toBeDisabled();
	await section.getByLabel("值", { exact: true }).fill("workspace");
	await expect(main(page).getByText("没有需要保存的变更。")).toHaveCount(0);
	await save.click();
	await expect(toast(page)).toHaveText("配置已保存，Secret 值不会回显");
	expect(api.commands.at(-1)?.body).toEqual({
		schemaVersion: 2,
		coOwnerIds: ["user-owner-1"],
		availability: [{ kind: "organization", organizationId: "org-platform" }],
		environment: [{ name: "AGENT_WORKSPACE", value: "workspace" }],
	});
	// 页面保留，以新投影重置；焦点不落在 body。
	await expect(main(page)).not.toContainText("配置已提交");
	const hint = main(page).getByText("没有需要保存的变更。");
	await expect(hint).toBeFocused();
	await section.getByRole("button", { name: "移除：AGENT_WORKSPACE" }).click();
	await save.click();
	await expect.poll(() => api.commands.length).toBe(2);
	expect(api.commands.at(-1)?.body).toMatchObject({ environment: [] });
});

test("the default Relay Key has its own section and a verified replacement (G-08, G-09, RK2-08)", async ({
	page,
}, info) => {
	const api = await ownerConfigFixture(page, { keySet: true });
	const probe = "probe-relay-key";
	await page.goto("/agents/agent-pilot-1/configuration");
	const models = page.getByRole("region", { name: "模型与凭证", exact: true });
	const section = page.getByRole("region", {
		name: "Agent 默认 Relay Key",
		exact: true,
	});
	await expect(
		section.getByText(
			"供 API、评测和后台任务使用；Web 对话和企微继续使用个人 Key。",
		),
	).toBeVisible();
	const chip = section.locator('[data-slot="badge"][data-variant="chip"]');
	await expect(chip).toHaveText("已设置");
	await expect(chip).toHaveAttribute("data-tone", "green");
	const facts = section.locator("dl");
	await expect(facts.locator("dt")).toHaveText([
		"当前版本",
		"可用模型",
		"密钥值",
	]);
	await expect(facts.locator("dd").first()).toHaveText("version 3");
	await expect(facts.locator('[data-slot="badge"]')).toHaveText([
		"gpt-5 · 均衡/高",
		"gpt-5-mini · 均衡",
	]);
	await expect(facts.locator("dd").last()).toHaveText("只显示状态，不回显");
	const columns = await computed(facts, ["gridTemplateColumns"]);
	if (info.project.name === "desktop")
		expect(columns.gridTemplateColumns.startsWith("150px ")).toBe(true);
	else expect(columns.gridTemplateColumns.split(" ")).toHaveLength(1);
	// 模型分区在前；两个分区内没有 primary，也没有常驻 Key 输入框与「检查可用模型」。
	expect(
		await models.evaluate(
			(element, other) =>
				Boolean(
					other &&
						element.compareDocumentPosition(other) &
							Node.DOCUMENT_POSITION_FOLLOWING,
				),
			await section.elementHandle(),
		),
	).toBe(true);
	await expect(page.getByRole("button", { name: "检查可用模型" })).toHaveCount(
		0,
	);
	await expect(section.locator("input")).toHaveCount(0);
	const primary = await resolved(page, "backgroundColor", "var(--accent-ink)");
	for (const area of [models, section])
		for (const button of await area.getByRole("button").all())
			expect(
				(await computed(button, ["backgroundColor"])).backgroundColor,
			).not.toBe(primary);
	await expect(page.locator(".configuration-form-footer")).toContainText(
		"保存配置",
	);
	for (const text of ["普通业务投影", "已有 Agent 默认 Relay Key 不回显"])
		await expect(main(page)).not.toContainText(text);
	// X-09：默认 Key 没有「撤销」与「未设置」态（授权控制里的「撤销使用」不属于这里）。
	for (const text of ["撤销", "未设置"])
		await expect(section).not.toContainText(text);

	// RK2-08：先勾选一个模型（不保存），替换流程中保留并禁用。
	const mini = models.getByRole("checkbox", {
		name: "Relay · Internal · gpt-5-mini",
	});
	await mini.click();
	await expect(mini).toBeChecked();

	const trigger = section.getByRole("button", { name: "替换默认 Key" });
	expect(Math.abs((await height(trigger)) - 44)).toBeLessThanOrEqual(0.5);
	await expect(trigger.locator("svg")).toHaveCount(1);
	await trigger.click();
	const dialog = page.getByRole("dialog", {
		name: "替换 Agent 默认 Relay Key",
	});
	await expect(dialog).toHaveAttribute("aria-modal", "true");
	const input = dialog.getByLabel("新的 Relay Key");
	await expect(input).toBeFocused();
	await expect(input).toHaveAttribute(
		"placeholder",
		"仅本次提交使用，不会回显",
	);
	await expect(input).toHaveAttribute("autocomplete", "new-password");
	await expect(
		dialog.locator('[data-slot="dialog-footer"]').getByRole("button"),
	).toHaveText(["取消", "校验并替换"]);
	await dialog.getByRole("button", { name: "校验并替换" }).click();
	const empty = dialog.getByRole("alert");
	await expect(empty).toHaveText("请输入默认 Relay Key。");
	await expectDangerInkFieldError(page, empty);
	expect(api.commands).toEqual([]);

	await input.fill(probe);
	api.hold("check");
	await dialog.getByRole("button", { name: "校验并替换" }).click();
	await expect(dialog.getByRole("button", { name: "正在校验…" })).toBeFocused();
	expect((await page.content()).includes(probe)).toBe(false);
	api.hold("replace-key");
	api.release("check");
	await expect(dialog).toBeHidden();
	// 写入中：chip「校验中」，notice 代替 dl，选择器保留并禁用。
	await expect(chip).toHaveText("校验中");
	await expect(chip).toHaveAttribute("data-tone", "amber");
	await expect(section.getByRole("status")).toContainText("正在校验默认 Key");
	await expect(mini).toBeDisabled();
	await expect(mini).toBeChecked();
	expect((await page.content()).includes(probe)).toBe(false);
	const candidateReads = () =>
		api.reads.filter((path) =>
			path.endsWith("/default-relay-key/display-candidates"),
		).length;
	const readsBefore = candidateReads();
	api.release("replace-key");
	await expect(chip).toHaveText("已设置");
	await expect(facts.locator("dd").first()).toHaveText("version 4");
	await expect(toast(page)).toHaveText("Agent 默认 Relay Key 已替换");
	await expect(trigger).toBeFocused();
	await expect.poll(candidateReads).toBe(readsBefore + 1);
	expect(api.commands.map(({ method, path }) => `${method} ${path}`)).toEqual([
		"POST /api/v2/agents/agent-pilot-1/default-relay-key/display-candidates",
		"PUT /api/v2/agents/agent-pilot-1/default-relay-key",
	]);
	expect(JSON.stringify(api.commands)).toContain(probe);
	expect((await page.content()).includes(probe)).toBe(false);
	// 用户未保存的勾选仍在新候选内，保留。
	await expect(mini).toBeChecked();
});

test("a new Key that cannot call current models is committed with a new selection only", async ({
	page,
}) => {
	const api = await ownerConfigFixture(page, { keySet: true });
	api.checkReturns([candidates.mini]);
	await page.goto("/agents/agent-pilot-1/configuration");
	await page.getByRole("button", { name: "移除 平台工程" }).click();
	// 焦点在下一帧回到该选择器的输入框；等它落定再打开弹窗填写，避免输入落进选择器。
	await expect(
		page.getByRole("combobox", { name: "可使用的组织", exact: true }),
	).toBeFocused();
	await page.getByRole("button", { name: "替换默认 Key" }).click();
	const dialog = page.getByRole("dialog", {
		name: "替换 Agent 默认 Relay Key",
	});
	await dialog.getByLabel("新的 Relay Key").fill("synthetic-new-key");
	await dialog.getByRole("button", { name: "校验并替换" }).click();
	await expect(dialog.getByText("新的 Key 不能调用部分当前模型")).toBeVisible();
	await expect(dialog).toContainText("Primary model");
	expect(api.commands.map(({ path }) => path)).toEqual([
		"/api/v2/agents/agent-pilot-1/default-relay-key/display-candidates",
	]);
	await dialog
		.getByRole("checkbox", { name: "Relay · Internal · gpt-5-mini" })
		.click();
	await dialog.getByRole("button", { name: "校验并替换" }).click();
	await expect(dialog).toBeHidden();
	const write = api.commands.at(-1);
	expect(write?.path).toBe("/api/v2/agents/agent-pilot-1/configuration");
	expect(Object.keys(write?.body as object).sort()).toEqual([
		"defaultRelayKey",
		"expectedConfigurationRevision",
		"expectedKeyVersion",
		"modelConfiguration",
		"schemaVersion",
	]);
	expect(
		api.commands.some(
			({ method, path }) =>
				method === "PUT" && path.endsWith("/default-relay-key"),
		),
	).toBe(false);
	await expect(toast(page)).toHaveText("Agent 默认 Relay Key 已替换");
	// 页面上的范围修改仍未保存。
	await expect(page.getByRole("button", { name: "移除 平台工程" })).toHaveCount(
		0,
	);
	await expect(page.getByRole("button", { name: "保存配置" })).toBeEnabled();
});

test("a failed default Key write keeps the version and shows no page-level error", async ({
	page,
}) => {
	const api = await ownerConfigFixture(page, { keySet: true });
	api.fail("replace-key");
	await page.goto("/agents/agent-pilot-1/configuration");
	const section = page.getByRole("region", {
		name: "Agent 默认 Relay Key",
		exact: true,
	});
	await section.getByRole("button", { name: "替换默认 Key" }).click();
	const dialog = page.getByRole("dialog", {
		name: "替换 Agent 默认 Relay Key",
	});
	await dialog.getByLabel("新的 Relay Key").fill("synthetic-new-key");
	await dialog.getByRole("button", { name: "校验并替换" }).click();
	await expect(section.getByRole("alert")).toContainText("默认 Key 未替换");
	await expect(
		section.locator('[data-slot="badge"][data-variant="chip"]'),
	).toHaveText("已设置");
	await expect(section.locator("dd").first()).toHaveText("version 3");
	await expect(main(page)).not.toContainText("配置未能保存");
});

test("saved-Key candidates start unchanged and use readable names (RK2-01, RK2-02, RK2-07)", async ({
	page,
}) => {
	const api = await ownerConfigFixture(page, { keySet: true, saved: "same" });
	await page.goto("/agents/agent-pilot-1/configuration");
	const models = page.getByRole("region", { name: "模型与凭证", exact: true });
	const picker = models.locator('[data-slot="keyless-model-picker"]');
	await expect(picker).toBeVisible();
	// 加载完成后没有改动：当前选项是旧格式（无 endpointId）也不算改动。
	await expect(main(page).getByText("没有需要保存的变更。")).toBeVisible();
	await expect(page.getByRole("button", { name: "保存配置" })).toBeDisabled();
	await expect(
		models.getByRole("checkbox", {
			name: "Relay · Internal · gpt-5",
			exact: true,
		}),
	).toBeChecked();
	const levels = models.getByRole("group", {
		name: "Relay · Internal · gpt-5 的推理档位",
	});
	await expect(levels.getByRole("checkbox")).toHaveCount(2);
	await expect(levels).toContainText("均衡");
	await expect(levels).toContainText("高");
	const text = (await picker.innerText()).toLowerCase();
	for (const raw of ["endpoint-primary", "medium", "high"])
		expect(text).not.toContain(raw);
	// 只有一个「默认模型选项」下拉；选择器根节点没有边线，也没有可见 legend。
	await expect(models.getByLabel("默认模型选项")).toHaveCount(1);
	await expect(models.getByLabel("默认模型", { exact: true })).toHaveCount(0);
	await expect(models.getByLabel("默认推理档位")).toHaveCount(0);
	expect((await computed(picker, ["borderTopWidth"])).borderTopWidth).toBe(
		"0px",
	);
	expect(
		await picker
			.locator("legend")
			.evaluateAll(
				(legends) =>
					legends.filter((legend) => legend.getBoundingClientRect().height > 0)
						.length,
			),
	).toBe(0);
	const label = models.locator('label[data-variant="option"]').first();
	expect(await computed(label, ["fontSize", "fontWeight"])).toEqual({
		fontSize: "13px",
		fontWeight: "400",
	});
	await expect(models).not.toContainText("当前默认：");
	// 勾选再取消同一档位后仍为未改动。
	const high = levels.getByRole("checkbox", { name: "高" });
	await high.click();
	await expect(page.getByRole("button", { name: "保存配置" })).toBeEnabled();
	await high.click();
	await expect(page.getByRole("button", { name: "保存配置" })).toBeDisabled();
	// 只改环境变量并保存：schemaVersion 2，不带模型。
	await page
		.getByRole("region", { name: "环境变量与 Secret", exact: true })
		.getByLabel("值", { exact: true })
		.fill("owner-only-change");
	await page.getByRole("button", { name: "保存配置" }).click();
	await expect(toast(page)).toHaveText("配置已保存，Secret 值不会回显");
	expect(api.commands.at(-1)?.body).toMatchObject({ schemaVersion: 2 });
	expect(api.commands.at(-1)?.body).not.toHaveProperty("modelConfiguration");
});

test("subset, empty and failed candidate reads never block other fields (RK2-03, RK2-04, RK2-06)", async ({
	page,
}) => {
	const api = await ownerConfigFixture(page, { keySet: true, saved: "subset" });
	await page.goto("/agents/agent-pilot-1/configuration");
	const models = page.getByRole("region", { name: "模型与凭证", exact: true });
	await expect(
		models.locator('[data-slot="keyless-model-picker"]'),
	).toBeVisible();
	// 候选不含当前模型：加载后没有错误，也不判定为改动。
	await expect(main(page).getByRole("alert")).toHaveCount(0);
	await expect(page.getByRole("button", { name: "保存配置" })).toBeDisabled();
	const mini = models.getByRole("checkbox", {
		name: "Relay · Internal · gpt-5-mini",
	});
	// 改动选择会移除当前模型：保存前先列出来。
	await mini.click();
	await expect(models.getByText("保存后会移除这些模型")).toBeVisible();
	await expect(models.getByRole("status")).toContainText("Primary model");
	await mini.click();
	await expect(models.getByText("保存后会移除这些模型")).toHaveCount(0);
	// 勾选再取消回到初始状态：不显示「至少选择一个模型。」，页面也判定为未改动。
	await expect(main(page).getByRole("alert")).toHaveCount(0);
	await expect(main(page).getByText("没有需要保存的变更。")).toBeVisible();
	await expect(page.getByRole("button", { name: "保存配置" })).toBeDisabled();

	// 取消全部勾选后只出现一条字段错误；保存不发请求，焦点回到选择器第一个控件。
	api.savedMode("same");
	await page.reload();
	const gpt5 = models.getByRole("checkbox", {
		name: "Relay · Internal · gpt-5",
		exact: true,
	});
	await gpt5.click();
	const error = main(page).getByRole("alert");
	await expect(error).toHaveText("至少选择一个模型。");
	await expectDangerInkFieldError(page, error);
	await page.getByRole("button", { name: "保存配置" }).click();
	await expect(gpt5).toBeFocused();
	expect(api.commands).toEqual([]);
	await gpt5.click();
	await expect(main(page).getByRole("alert")).toHaveCount(0);

	api.savedMode("empty");
	await page.reload();
	await expect(
		models.getByText("当前默认 Key 没有此模板可用的模型"),
	).toBeVisible();
	await expect(models.getByRole("checkbox")).toHaveCount(0);
	await expect(main(page).getByRole("alert")).toHaveCount(0);
	const facts = page
		.getByRole("region", { name: "Agent 默认 Relay Key", exact: true })
		.locator("dl");
	await expect(facts.locator("dd").nth(1)).toHaveText("无");
	await expect(page.getByRole("button", { name: "替换默认 Key" })).toHaveCount(
		1,
	);

	api.savedMode("error");
	await page.reload();
	const alert = models.getByRole("alert");
	await expect(alert).toContainText("暂时无法读取可用模型");
	api.savedMode("same");
	const before = api.reads.length;
	await alert.getByRole("button", { name: "重新读取可用模型" }).click();
	await expect(
		models.locator('[data-slot="keyless-model-picker"]'),
	).toBeVisible();
	expect(
		api.reads
			.slice(before)
			.filter((path) => path.endsWith("/default-relay-key/display-candidates")),
	).toHaveLength(1);

	api.savedMode("forbidden");
	await page.reload();
	await expect(models.getByRole("alert")).toContainText("无法读取可用模型");
	await expect(models.getByRole("alert")).not.toContainText("暂时");
	await expect(
		models.getByRole("button", { name: "重新读取可用模型" }),
	).toHaveCount(0);
	await page
		.getByRole("region", { name: "环境变量与 Secret", exact: true })
		.getByLabel("值", { exact: true })
		.fill("still-saves");
	await page.getByRole("button", { name: "保存配置" }).click();
	await expect.poll(() => api.commands.length).toBe(1);
	expect(api.commands[0]?.body).not.toHaveProperty("modelConfiguration");
});

test("saved-Key candidates show a loading line only on the first read (RK2-05)", async ({
	page,
}) => {
	const api = await ownerConfigFixture(page, { keySet: true });
	api.hold("saved-candidates");
	await page.goto("/agents/agent-pilot-1/configuration");
	const models = page.getByRole("region", { name: "模型与凭证", exact: true });
	const loading = models.locator('[data-slot="loading-line"]');
	await expect(loading).toHaveAttribute("role", "status");
	const spinner = loading.locator('[data-slot="spinner"]');
	// 旋转中的包围盒会变大，读取计算尺寸。
	expect(await computed(spinner, ["width", "height"])).toEqual({
		width: "15px",
		height: "15px",
	});
	api.release("saved-candidates");
	await expect(
		models.locator('[data-slot="keyless-model-picker"]'),
	).toBeVisible();
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await page.waitForTimeout(300);
	await expect(loading).toHaveCount(0);
	await expect(models).not.toContainText("正在读取");
});

test("the Owner configuration links to the Agent's Skill page (O-02)", async ({
	page,
}, info) => {
	const api = await ownerConfigFixture(page);
	await page.goto("/agents/agent-pilot-1/configuration");
	const section = page.getByRole("region", { name: "Skill", exact: true });
	await expect(
		section.getByText("Skill 版本、同步和对话可用性分开管理。"),
	).toBeVisible();
	const link = section.getByRole("link", { name: "管理 Skill 绑定" });
	await expect(link).toHaveAttribute("href", "/agents/agent-pilot-1/skills");
	await expect(link.locator("svg")).toHaveAttribute("aria-hidden", "true");
	expect(await height(link)).toBeGreaterThanOrEqual(44);
	if (info.project.name === "desktop") {
		const [headingBox, linkBox] = await Promise.all([
			section.getByRole("heading", { level: 2 }).boundingBox(),
			link.boundingBox(),
		]);
		// 链接与 h2 同行：两者在纵向上重叠，链接在右侧。
		const linkTop = linkBox?.y ?? 0;
		const headingTop = headingBox?.y ?? 0;
		expect(linkTop < headingTop + (headingBox?.height ?? 0)).toBe(true);
		expect(linkTop + (linkBox?.height ?? 0) > headingTop).toBe(true);
		expect((linkBox?.x ?? 0) > (headingBox?.x ?? 0) + 300).toBe(true);
	}
	await noHorizontalOverflow(page);
	// 路由 Link：不发生文档级导航，页面状态（含窗口上的探针）保留（acc-5 新问题 2）。
	const documents = await markSinglePageNavigation(page);
	await link.focus();
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(/\/agents\/agent-pilot-1\/skills$/);
	await expect(page.getByRole("heading", { level: 1 })).toHaveText(
		"Agent 的 Skill",
	);
	await expectNoDocumentNavigation(page, documents);
	// B2-06：顶栏页面名按导出稿为「Owner 配置 / Skill 绑定」，h1 仍是「Agent 的 Skill」。
	await expect(page.locator('[data-slot="breadcrumb-page"]')).toHaveText(
		"Skill 绑定",
	);
	await expect(page).toHaveTitle("Skill 绑定 · Agora Agent");
	await expect(main(page)).toContainText("Owner 配置 / Skill");
	await expect(main(page)).toContainText(
		"Release assistant · 固定 Skill 版本，完成同步后才能在对话中使用。",
	);
	await expect(main(page)).toContainText("暂时无法读取当前 Agent 版本");
	for (const label of ["Agent ID", "Agent 版本", "配置 revision", "Grant JSON"])
		await expect(page.getByLabel(label)).toHaveCount(0);
	// 部署未配置 Agent Version：读过当前版本后不发任何绑定读写（#2903）。
	expect(api.reads).toContain(
		"/api/v2/agents/agent-pilot-1/skills/current-version",
	);
	expect(api.reads.filter((path) => path.includes("/versions/"))).toEqual([]);
	expect(api.commands).toEqual([]);
	await noHorizontalOverflow(page);
});

test("an Owner lists, binds and unbinds Skill versions under the server's Agent Version (O-02, #2903)", async ({
	page,
}) => {
	const pageErrors = trackPageErrors(page);
	const api = await ownerConfigFixture(page, {
		agentVersion: "agent-version-7",
	});
	await page.goto("/agents/agent-pilot-1/skills");
	const region = main(page);
	// W-37 / B2-07：部署配置的 Agent Version 只有内部标识、没有显示名：按导出稿显示「当前配置版本」，
	// 不截断成「agent-ve…」，也不外露内部标识；绑定读写仍走服务端给出的完整版本（见下方请求路径）。
	const versionTitle = region.locator(
		'.agent-skill-version-notice [data-slot="alert-title"]',
	);
	await expect(versionTitle).toHaveText("当前 Agent 版本：当前配置版本");
	await expect(versionTitle.locator("code")).toHaveCount(0);
	await expect(region).not.toContainText(/agent-ve|agent-version-7/);
	await expect(region.getByText("还未绑定 Skill")).toBeVisible();
	// 版本只来自服务端：页面没有可手填的版本字段。
	await expect(page.getByLabel("Agent 版本")).toHaveCount(0);
	const bindingPath =
		"/api/v2/agents/agent-pilot-1/versions/agent-version-7/skills";
	const minimalGrant = {
		schemaVersion: 1,
		tools: [],
		connections: [],
		fileRoots: [],
		networkOrigins: [],
		scripts: false,
	};
	// W-32：绑定按钮撑满右栏，高度沿公共 44px。
	const bindTrigger = region.getByRole("button", { name: "绑定固定版本" });
	const [submitColumn, bindBox] = await Promise.all([
		region.locator(".skill-bind-submit").boundingBox(),
		bindTrigger.boundingBox(),
	]);
	expect(
		Math.abs((bindBox?.width ?? 0) - (submitColumn?.width ?? 0)),
	).toBeLessThanOrEqual(0.5);
	expect(bindBox?.height).toBe(44);
	// W-30 / W-36：确认后焦点交给结果卡片标题或页面 h1，任何时候都不落到 body。
	const activeElement = () =>
		page.evaluate(() => {
			const element = document.activeElement;
			return element === document.body || !element
				? "body"
				: `${element.tagName.toLowerCase()}:${element.textContent?.trim()}`;
		});
	const bind = async (versionId: string, label: string) => {
		await region
			.getByLabel("固定版本", { exact: true })
			.selectOption(versionId);
		await region.getByRole("button", { name: "绑定固定版本" }).click();
		const dialog = page.getByRole("dialog", { name: "确认绑定固定版本" });
		await expect(dialog).toContainText(label);
		await expectBindingFacts(dialog);
		// #3037 X-07：Skill 确认弹窗使用设计 .skill-dialog 外观与文字「关闭」。
		await expectSkillDialog(
			page,
			dialog,
			test.info().project.name === "mobile",
		);
		await dialog.getByRole("button", { name: "确认绑定" }).click();
		await expect(dialog).toHaveCount(0);
		expect(await activeElement()).not.toBe("body");
		await expect
			.poll(() => page.evaluate(() => document.activeElement === document.body))
			.toBe(false);
	};
	await bind("code-review-v1", "code-review · v1.0.0");
	await expect(toast(page).last()).toHaveText("已提交绑定，等待同步");
	const codeReview = region.getByRole("heading", {
		level: 2,
		name: "code-review v1.0.0",
	});
	await expect(codeReview).toBeVisible();
	await expect(codeReview).toBeFocused();
	expect(await activeElement()).toBe("h2:code-review v1.0.0");
	await bind("workspace-summary-v1", "workspace-summary · v1.0.0");
	await expect(region.getByRole("article")).toHaveCount(2);
	await expect(
		region.getByRole("heading", { level: 2, name: "workspace-summary v1.0.0" }),
	).toBeFocused();
	await noHorizontalOverflow(page);

	// 取消与 Esc 仍回到触发按钮。
	const unbindCodeReview = region.getByRole("button", {
		name: "解除绑定：code-review",
	});
	await unbindCodeReview.click();
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect(unbindCodeReview).toBeFocused();

	await unbindCodeReview.click();
	const unbind = page.getByRole("dialog", { name: "确认解除绑定" });
	await expect(unbind).toContainText("code-review · v1.0.0");
	await expectSkillDialog(page, unbind, test.info().project.name === "mobile");
	await unbind.getByRole("button", { name: "解除绑定" }).click();
	expect(await activeElement()).not.toBe("body");
	await expect(toast(page).last()).toHaveText("已解除绑定");
	await expect(region.getByRole("article")).toHaveCount(1);
	// 解除绑定后触发按钮随卡片卸载，焦点不落到 body（#3037 AC-2）。
	await expect
		.poll(() => page.evaluate(() => document.activeElement === document.body))
		.toBe(false);
	await expectCleanPage(page, pageErrors);
	// 解除后焦点交给下一张卡片的标题。
	await expect(
		region.getByRole("heading", { level: 2, name: "workspace-summary v1.0.0" }),
	).toBeFocused();
	await region
		.getByRole("button", { name: "解除绑定：workspace-summary" })
		.click();
	await page
		.getByRole("dialog", { name: "确认解除绑定" })
		.getByRole("button", { name: "解除绑定" })
		.click();
	await expect(region.getByText("还未绑定 Skill")).toBeVisible();
	// 没有下一张卡片：焦点交给页面 h1。
	await expect(
		page.getByRole("heading", { level: 1, name: "Agent 的 Skill" }),
	).toBeFocused();
	expect(await activeElement()).toBe("h1:Agent 的 Skill");

	// 每次写入都用服务端给出的版本、当前配置修订和完整集合。
	expect(api.commands).toEqual([
		{
			method: "PUT",
			path: bindingPath,
			body: {
				schemaVersion: 1,
				expectedConfigurationRevision: 7,
				bindings: [{ skillVersionId: "code-review-v1", grant: minimalGrant }],
			},
		},
		{
			method: "PUT",
			path: bindingPath,
			body: {
				schemaVersion: 1,
				expectedConfigurationRevision: 8,
				bindings: [
					{ skillVersionId: "code-review-v1", grant: minimalGrant },
					{ skillVersionId: "workspace-summary-v1", grant: minimalGrant },
				],
			},
		},
		{
			method: "PUT",
			path: bindingPath,
			body: {
				schemaVersion: 1,
				expectedConfigurationRevision: 9,
				bindings: [
					{ skillVersionId: "workspace-summary-v1", grant: minimalGrant },
				],
			},
		},
		{
			method: "PUT",
			path: bindingPath,
			body: {
				schemaVersion: 1,
				expectedConfigurationRevision: 10,
				bindings: [],
			},
		},
	]);
	expect(
		api.reads.filter(
			(path) => path.includes("/versions/") && path !== bindingPath,
		),
	).toEqual([]);
	await noHorizontalOverflow(page);
});

test("the Agent's Skill heading follows the Skill detail layout (#agent-skills)", async ({
	page,
}, info) => {
	await ownerConfigFixture(page);
	await page.goto("/agents/agent-pilot-1/skills");
	const mobile = info.project.name === "mobile";
	const back = main(page).getByRole("link", { name: "返回 Owner 配置" });
	await expect(back).toBeVisible();
	const geometry = await page
		.locator("header.agent-skill-heading")
		.evaluate((element) => {
			const box = (node: Element | null) => {
				if (!node) throw new Error("Expected heading geometry");
				const rect = node.getBoundingClientRect();
				return {
					top: rect.top + scrollY,
					bottom: rect.bottom + scrollY,
					left: rect.left,
					right: rect.right,
				};
			};
			const back = element.previousElementSibling;
			return {
				marginTop: getComputedStyle(element).marginTop,
				head: box(element),
				back: box(back),
				eyebrow: box(element.querySelector(".page-eyebrow")),
				h1: box(element.querySelector("h1")),
				subtitle: box(element.querySelector("h1 + p")),
				actions: box(element.querySelector(".agent-skill-heading-actions")),
				action: box(element.querySelector(".agent-skill-heading-actions > a")),
			};
		});
	// 设计 #agent-skills（与 #skill-detail 同结构）：页头紧接返回按钮，没有上外边距；
	// 1440 下 eyebrow 150、h1 174.39，390 下 141、165.39。
	expect(geometry.marginTop).toBe("0px");
	expect(
		Math.abs(geometry.head.top - geometry.back.bottom),
	).toBeLessThanOrEqual(0.5);
	expect(
		Math.abs(geometry.eyebrow.top - (mobile ? 141 : 150)),
	).toBeLessThanOrEqual(1);
	expect(
		Math.abs(geometry.h1.top - (mobile ? 165.39 : 174.39)),
	).toBeLessThanOrEqual(1);
	if (mobile) {
		// ≤767：操作在副标题下方 14px，左对齐。
		expect(
			Math.abs(geometry.actions.top - (geometry.subtitle.bottom + 14)),
		).toBeLessThanOrEqual(1);
		expect(
			Math.abs(geometry.action.left - geometry.head.left),
		).toBeLessThanOrEqual(0.5);
	} else {
		// ≥768：文案左、「浏览 Skill Hub」右，与文案块垂直居中（设计 top 179.69）。
		expect(
			Math.abs(geometry.action.right - geometry.head.right),
		).toBeLessThanOrEqual(0.5);
		expect(geometry.action.top).toBeGreaterThan(geometry.head.top);
		expect(geometry.action.bottom).toBeLessThan(geometry.head.bottom);
		expect(
			Math.abs(
				(geometry.action.top + geometry.action.bottom) / 2 -
					(geometry.head.top + geometry.head.bottom) / 2,
			),
		).toBeLessThanOrEqual(1);
	}
	await noHorizontalOverflow(page);
});

test("the Agent's Skill links navigate in the app without a document reload or aria-current (FIX3-3)", async ({
	page,
}) => {
	await ownerConfigFixture(page);
	await page.goto("/agents/agent-pilot-1/skills");
	const back = main(page).getByRole("link", { name: "返回 Owner 配置" });
	await expect(back).toHaveAttribute(
		"href",
		"/agents/agent-pilot-1/configuration",
	);
	await expect(back).not.toHaveAttribute("aria-current", /.*/);
	let documents = await markSinglePageNavigation(page);
	await back.click();
	await expect(page).toHaveURL(/\/agents\/agent-pilot-1\/configuration$/);
	await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
	await expectNoDocumentNavigation(page, documents);

	// Skill Hub 目录读取不在本夹具内：返回 503，只验证跳转本身。
	await page.route(/\/api\/v[12]\/skills(?:[/?]|$)/, (route) =>
		route.fulfill({
			status: 503,
			json: {
				schemaVersion: 1,
				code: "DEPENDENCY_UNAVAILABLE",
				message: "Controlled Skill Hub failure",
				retryable: true,
				traceId: "trace-agent-skill-hub-link",
			},
		}),
	);
	await page.goto("/agents/agent-pilot-1/skills");
	const hub = main(page).getByRole("link", { name: "浏览 Skill Hub" });
	await expect(hub).toHaveAttribute("href", "/skills");
	documents = await markSinglePageNavigation(page);
	await hub.focus();
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(/\/skills$/);
	await expect(
		page.getByRole("heading", { level: 1, name: "Skill Hub" }),
	).toBeVisible();
	await expectNoDocumentNavigation(page, documents);
});

test("the Owner configuration back link navigates without a document reload or aria-current (acc-5)", async ({
	page,
}) => {
	await ownerConfigFixture(page);
	await page.goto("/agents/agent-pilot-1/configuration");
	const back = main(page).getByRole("link", { name: "返回 Agent 详情" });
	await expect(back).toHaveAttribute("href", "/agents/agent-pilot-1");
	// 返回链接是当前路径的前缀，不能被前缀匹配标成当前页。
	await expect(back).not.toHaveAttribute("aria-current", /.*/);
	const documents = await markSinglePageNavigation(page);
	await back.click();
	await expect(page).toHaveURL(/\/agents\/agent-pilot-1$/);
	await expect(page.getByRole("heading", { level: 1 })).toHaveText(
		"Release assistant",
	);
	await expectNoDocumentNavigation(page, documents);
});

for (const role of ["admin", "employee"] as const) {
	test(`a ${role} sees no Skill entry and no bindings (O-02)`, async ({
		page,
	}) => {
		const api = await ownerConfigFixture(page, { role });
		await page.goto("/agents/agent-pilot-1/configuration");
		await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
		await expect(
			page.getByRole("region", { name: "Skill", exact: true }),
		).toHaveCount(0);
		await page.goto("/agents/agent-pilot-1/skills");
		await expect(main(page)).toContainText("没有权限");
		const back = main(page).getByRole("link", { name: "返回 Agent 详情" });
		await expect(back).toHaveAttribute("href", "/agents/agent-pilot-1");
		// /agents/agent-pilot-1 是当前地址的前缀：返回链接不是当前页，且走路由跳转。
		await expect(back).not.toHaveAttribute("aria-current", /.*/);
		await expect(
			page.getByRole("button", { name: "绑定固定版本" }),
		).toHaveCount(0);
		expect(api.reads.filter((path) => path.includes("/versions/"))).toEqual([]);
		// 非 Owner 不读取当前 Agent Version（#2903）。
		expect(
			api.reads.filter((path) => path.endsWith("/skills/current-version")),
		).toEqual([]);
		expect(api.commands).toEqual([]);
		const documents = await markSinglePageNavigation(page);
		await back.click();
		await expect(page).toHaveURL(/\/agents\/agent-pilot-1$/);
		await expect(
			page.getByRole("heading", { level: 1, name: "Release assistant" }),
		).toBeVisible();
		await expectNoDocumentNavigation(page, documents);
	});
}

// #3040 AC-2：Owner 配置与 Agent 的 Skill 页在 1440×900 与 390×844 下没有横向溢出、
// 控制台错误与同页同名控件（含一张绑定卡与绑定表单同屏时）。
test("Owner configuration and the Agent's Skill page have no overflow, console errors or duplicate controls (#3040 AC-2)", async ({
	page,
}, info) => {
	await page.setViewportSize(
		info.project.name === "mobile"
			? { width: 390, height: 844 }
			: { width: 1440, height: 900 },
	);
	const pageErrors = trackPageErrors(page);
	await ownerConfigFixture(page, { agentVersion: "agent-version-7" });
	await page.goto("/agents/agent-pilot-1/configuration");
	await expect(
		page.getByRole("region", { name: "渠道", exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("region", { name: "企微机器人", exact: true }),
	).toBeVisible();
	await expectCleanPage(page, pageErrors);
	await expectNoDuplicateControls(page, "Owner 配置");

	await page.goto("/agents/agent-pilot-1/skills");
	const region = main(page);
	await expect(region.getByText("还未绑定 Skill")).toBeVisible();
	await expectNoDuplicateControls(page, "Agent 的 Skill（空）");
	await region
		.getByLabel("固定版本", { exact: true })
		.selectOption("code-review-v1");
	await region.getByRole("button", { name: "绑定固定版本" }).click();
	const bindDialog = page.getByRole("dialog", { name: "确认绑定固定版本" });
	await expectBindingFacts(bindDialog);
	await bindDialog.getByRole("button", { name: "确认绑定" }).click();
	await expect(
		region.getByRole("heading", { level: 2, name: "code-review v1.0.0" }),
	).toBeFocused();
	await expectCleanPage(page, pageErrors);
	await expectNoDuplicateControls(page, "Agent 的 Skill（已绑定）");
});

async function viewport(page: Page, mobile: boolean) {
	await page.setViewportSize(
		mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
	);
}

/** 两个盒子之间的竖直间距：next 的顶边减去 previous 的底边。 */
async function verticalGap(previous: Locator, next: Locator) {
	const [above, below] = await Promise.all([
		previous.boundingBox(),
		next.boundingBox(),
	]);
	if (!above || !below) throw new Error("Missing dialog geometry");
	return below.y - (above.y + above.height);
}

// #3152 AC-2：纯系统管理员视图的创建失败提示距「权限边界」12px（与 .configuration-notices 内提示间距一致，
// 设计 owner-config-notice + owner-config-creation-failure），距下方「管理员操作」16px；两视口一致。
test("a pure administrator's creation failure notice keeps 12px below the permission boundary and 16px above administrator actions (#3152 AC-2)", async ({
	page,
}, info) => {
	await viewport(page, info.project.name === "mobile");
	await ownerConfigFixture(page, {
		role: "admin",
		creationFailure: "deployment_unavailable",
	});
	await page.goto("/agents/agent-pilot-1/configuration");
	const region = main(page);
	const notice = region.locator(
		'[data-creation-failure="deployment_unavailable"]',
	);
	await expect(notice).toContainText("失败原因：部署资源暂不可用");
	const boundary = region.locator(
		'.configuration-notices > [data-slot="alert"]',
		{ hasText: "权限边界" },
	);
	const admin = region.getByRole("region", {
		name: "管理员操作",
		exact: true,
	});
	await expect(admin.getByRole("button", { name: "重试创建" })).toBeVisible();
	await expect(region.locator(".configuration-notices")).toHaveCSS(
		"row-gap",
		"12px",
	);
	expect(await verticalGap(boundary, notice)).toBeCloseTo(12, 1);
	expect(await verticalGap(notice, admin)).toBeCloseTo(16, 1);
});

// #3152：Owner 视图的创建失败提示仍在页脚 flex 内，不额外加上外边距。
test("an Owner's creation failure notice stays in the footer without extra top margin (#3152)", async ({
	page,
}, info) => {
	await viewport(page, info.project.name === "mobile");
	await ownerConfigFixture(page, { creationFailure: "health_check_failed" });
	await page.goto("/agents/agent-pilot-1/configuration");
	const footer = main(page).locator(".configuration-form-footer");
	const notice = footer.locator(
		'[data-creation-failure="health_check_failed"]',
	);
	await expect(notice).toContainText("失败原因：健康检查未通过");
	await expect(notice).toHaveCSS("margin-top", "0px");
	await expect(footer).toHaveCSS("row-gap", "14px");
});

// #3128 B2-03 / B2-05 / B2-11：Owner 配置「可使用的用户」的占位符与申请表单一致；同一人员同时在
// 「共同 Owner 用户」与「可使用的用户」时，两个移除按钮带各自的选择器标签，同页没有同名控件；
// 页面按钮（含企微卡片操作）悬停为指针。
test("Owner configuration directory pickers keep distinct remove names and the design placeholder (B2-03 / B2-05 / B2-11)", async ({
	page,
}, info) => {
	await viewport(page, info.project.name === "mobile");
	const pageErrors = trackPageErrors(page);
	await ownerConfigFixture(page);
	await page.goto("/agents/agent-pilot-1/configuration");
	const users = page.getByRole("combobox", {
		name: "可使用的用户",
		exact: true,
	});
	await expect(users).toHaveAttribute(
		"placeholder",
		"搜索姓名、邮箱或组织路径",
	);
	await expect(
		page.getByRole("region", { name: "企微机器人", exact: true }),
	).toBeVisible();
	await expectPointerButtons(page.locator("body"), "Owner 配置");
	await expect(
		page.getByRole("button", {
			name: "从共同 Owner 用户移除 当前 Owner",
			exact: true,
		}),
	).toBeVisible();
	await users.click();
	await page.getByRole("option", { name: /当前 Owner/ }).click();
	const fromUsers = page.getByRole("button", {
		name: "从可使用的用户移除 当前 Owner",
		exact: true,
	});
	await expect(fromUsers).toBeVisible();
	await expect(users).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(users).toHaveAttribute("aria-expanded", "false");
	await expect(
		page.getByRole("button", { name: /移除 当前 Owner$/ }),
	).toHaveCount(2);
	await expectCleanPage(page, pageErrors);
	await expectNoDuplicateControls(page, "Owner 配置（同一人员在两个选择器）");
	// 从「可使用的用户」移除不影响共同 Owner；焦点回到该选择器的输入框。
	await fromUsers.click();
	await expect(users).toBeFocused();
	await expect(fromUsers).toHaveCount(0);
	await expect(
		page.getByRole("button", {
			name: "从共同 Owner 用户移除 当前 Owner",
			exact: true,
		}),
	).toBeVisible();
});

// #3128 B2-08 / B2-09 / B2-11：Skill 绑定确认弹窗的对象名与事实列表相距 15px；解除绑定与更换固定版本的
// 说明按设计 .form-hint（12px、--muted-ink、行高 20.4px），仍是弹窗的可访问描述；页面与弹窗按钮悬停为指针。
test("Skill binding dialogs follow the design spacing and hint text (B2-08 / B2-09 / B2-11)", async ({
	page,
}, info) => {
	await viewport(page, info.project.name === "mobile");
	const pageErrors = trackPageErrors(page);
	await ownerConfigFixture(page, { agentVersion: "agent-version-7" });
	await page.goto("/agents/agent-pilot-1/skills");
	const region = main(page);
	await expect(region.getByText("还未绑定 Skill")).toBeVisible();
	await expectPointerButtons(page.locator("body"), "Agent 的 Skill");
	await region
		.getByLabel("固定版本", { exact: true })
		.selectOption("workspace-summary-v1");
	await region.getByRole("button", { name: "绑定固定版本" }).click();
	const bind = page.getByRole("dialog", { name: "确认绑定固定版本" });
	await expectBindingFacts(bind);
	expect(
		Math.abs(
			(await verticalGap(
				bind.locator('[data-slot="confirm-dialog-subject"]'),
				bind.locator("dl.skill-binding-facts"),
			)) - 15,
		),
	).toBeLessThanOrEqual(0.5);
	await expectPointerButtons(bind, "确认绑定弹窗");
	await bind.getByRole("button", { name: "确认绑定" }).click();
	await expect(
		region.getByRole("heading", { level: 2, name: "workspace-summary v1.0.0" }),
	).toBeFocused();

	const hintStyle = {
		fontSize: "12px",
		color: await resolved(page, "color", "var(--muted-ink)"),
		lineHeight: "20.4px",
	};
	const changeTrigger = region.getByRole("button", {
		name: "更换固定版本：workspace-summary",
	});
	await changeTrigger.click();
	const change = page.getByRole("dialog", { name: "更换固定版本" });
	const changeHint = change.locator('[data-slot="dialog-description"]');
	await expect(changeHint).toHaveText(
		"现有执行保留原版本。新的调用要等同步和装配确认完成。",
	);
	expect(
		await computed(changeHint, ["fontSize", "color", "lineHeight"]),
	).toEqual(hintStyle);
	// 设计 .section-tight + .form-hint：说明与上方「目标版本」字段相距 15px。
	expect(
		Math.abs(
			(await verticalGap(change.locator('[data-slot="field"]'), changeHint)) -
				15,
		),
	).toBeLessThanOrEqual(0.5);
	await expect(change).toHaveAccessibleDescription(
		"现有执行保留原版本。新的调用要等同步和装配确认完成。",
	);
	await expectPointerButtons(change, "更换固定版本弹窗");
	await page.keyboard.press("Escape");
	await expect(change).toHaveCount(0);
	await expect(changeTrigger).toBeFocused();

	const unbindTrigger = region.getByRole("button", {
		name: "解除绑定：workspace-summary",
	});
	await unbindTrigger.click();
	const unbind = page.getByRole("dialog", { name: "确认解除绑定" });
	const unbindHint = unbind.getByText(
		"解除后，新的调用不再提供这个 Skill；现有执行保留原版本。",
		{ exact: true },
	);
	expect(
		await computed(unbindHint, ["fontSize", "color", "lineHeight"]),
	).toEqual(hintStyle);
	// 设计 .form-hint margin-top 8px：与上方对象名相距 8px。
	expect(
		Math.abs(
			(await verticalGap(
				unbind.locator('[data-slot="confirm-dialog-subject"]'),
				unbindHint,
			)) - 8,
		),
	).toBeLessThanOrEqual(0.5);
	await expect(unbind).toHaveAccessibleDescription(
		/解除后，新的调用不再提供这个 Skill；现有执行保留原版本。/,
	);
	await expectPointerButtons(unbind, "确认解除绑定弹窗");
	await page.keyboard.press("Escape");
	await expect(unbind).toHaveCount(0);
	await expect(unbindTrigger).toBeFocused();
	await expectCleanPage(page, pageErrors);
});

// #3179 G4-19：「更换固定版本」确认后，焦点交给新版本绑定卡的标题（D2-59、W-30）。旧卡随新版本卸载、
// 弹窗一并消失，之后的回读也不能把焦点挪到 body 或页面 h1。点击与键盘 Enter 两种方式都覆盖。
for (const mode of ["click", "keyboard"] as const)
	test(`changing a fixed version by ${mode} focuses the replacement binding title (G4-19)`, async ({
		page,
	}, info) => {
		await viewport(page, info.project.name === "mobile");
		const pageErrors = trackPageErrors(page);
		const api = await ownerConfigFixture(page, {
			agentVersion: "agent-version-7",
		});
		await page.goto("/agents/agent-pilot-1/skills");
		const region = main(page);
		await region
			.getByLabel("固定版本", { exact: true })
			.selectOption("workspace-summary-v1");
		await region.getByRole("button", { name: "绑定固定版本" }).click();
		await page
			.getByRole("dialog", { name: "确认绑定固定版本" })
			.getByRole("button", { name: "确认绑定" })
			.click();
		await expect(
			region.getByRole("heading", {
				level: 2,
				name: "workspace-summary v1.0.0",
			}),
		).toBeFocused();
		await region
			.getByRole("button", { name: "更换固定版本：workspace-summary" })
			.click();
		const change = page.getByRole("dialog", { name: "更换固定版本" });
		await expect(change).toContainText("workspace-summary · v1.0.0 → v1.1.0");
		const confirm = change.getByRole("button", { name: "确认版本变更" });
		if (mode === "click") await confirm.click();
		else {
			await confirm.focus();
			await page.keyboard.press("Enter");
		}
		await expect(change).toHaveCount(0);
		const replacement = region.getByRole("heading", {
			level: 2,
			name: "workspace-summary v1.1.0",
		});
		await expect(replacement).toBeFocused();
		await expect(region.getByRole("article")).toHaveCount(1);
		// 之后 1.5s 内多次采样：焦点一直在新卡标题上，不被回读挪到 body 或 h1。
		for (let sample = 0; sample < 5; sample += 1) {
			await page.waitForTimeout(300);
			expect(
				await page.evaluate(() => {
					const active = document.activeElement;
					return active === document.body
						? "body"
						: `${active?.tagName.toLowerCase()}#${active?.id}`;
				}),
			).toBe("h2#skill-binding-title-workspace-summary-v2");
		}
		expect(api.commands.at(-1)?.body).toEqual({
			schemaVersion: 1,
			expectedConfigurationRevision: 8,
			bindings: [
				{
					skillVersionId: "workspace-summary-v2",
					grant: {
						schemaVersion: 1,
						tools: [],
						connections: [],
						fileRoots: [],
						networkOrigins: [],
						scripts: false,
					},
				},
			],
		});
		await expectCleanPage(page, pageErrors);
	});

// #3179 G4-17：「Agent 默认 Relay Key」区头的「已设置」chip 在两个视口都留在 h2 右侧、与 h2 顶对齐，
// 不折到说明下方；X-06 的「管理 Skill 绑定」仍在窄屏换到说明下方。
test("the default Relay Key chip stays beside its heading at both viewports (G4-17)", async ({
	page,
}, info) => {
	const mobile = info.project.name === "mobile";
	await viewport(page, mobile);
	const pageErrors = trackPageErrors(page);
	await ownerConfigFixture(page, { keySet: true });
	await page.goto("/agents/agent-pilot-1/configuration");
	const section = page.locator('[data-od-id="owner-default-relay-key"]');
	const head = section.locator(".configuration-section-head");
	const chip = head.locator(':scope > [data-slot="badge"]');
	await expect(chip).toHaveText("已设置");
	const [title, description, chipBox] = await Promise.all([
		head.locator("h2").boundingBox(),
		head.locator('[data-slot="form-section-description"]').boundingBox(),
		chip.boundingBox(),
	]);
	if (!title || !description || !chipBox)
		throw new Error("Missing section head geometry");
	// chip 在文字列右侧；窄屏与 h2 顶对齐（设计 ≤767 .section-head{align-items:flex-start}），
	// 桌面沿区头底对齐，都在区头第一列之外，不折到说明下方。
	expect(chipBox.x).toBeGreaterThanOrEqual(description.x + description.width);
	if (mobile) expect(Math.abs(chipBox.y - title.y)).toBeLessThanOrEqual(0.5);
	else expect(chipBox.y).toBeLessThan(description.y + description.height);
	// Skill 分区的入口按钮：窄屏在说明下方，桌面在标题右侧（X-06 不变）。
	const skillHead = page.locator(
		'[data-od-id="owner-skill-entry"] .configuration-section-head',
	);
	const [skillCopy, skillLink] = await Promise.all([
		skillHead.locator(":scope > div").first().boundingBox(),
		skillHead.getByRole("link", { name: "管理 Skill 绑定" }).boundingBox(),
	]);
	if (!skillCopy || !skillLink) throw new Error("Missing Skill head geometry");
	if (mobile)
		expect(skillLink.y).toBeGreaterThanOrEqual(skillCopy.y + skillCopy.height);
	else
		expect(skillLink.x).toBeGreaterThanOrEqual(skillCopy.x + skillCopy.width);
	await expectNoDuplicateControls(page, "Owner 配置（G4-17）");
	await expectCleanPage(page, pageErrors);
});

// #3179 G4-18：已停用 Agent 的配置表单整体禁用时，输入框、文本框与下拉一样只降透明度到 .5，
// 背景仍为 --surface，不再叠加 --input 灰底。
test("disabled inputs keep the surface background like disabled selects (G4-18)", async ({
	page,
}, info) => {
	await viewport(page, info.project.name === "mobile");
	const pageErrors = trackPageErrors(page);
	await ownerConfigFixture(page);
	const base = AgentProjectionV2Schema.parse(
		pilotFakeScenariosV2.starting.response.body,
	);
	await page.route("**/api/v2/agents/agent-pilot-1", (route) =>
		route.request().method() === "GET"
			? route.fulfill({
					json: AgentProjectionV2Schema.parse({
						...base,
						managementStatus: "disabled",
						serviceAvailability: null,
						configuration: {
							...base.configuration,
							environment: [{ name: "AGENT_WORKSPACE", value: "platform" }],
						},
					}),
				})
			: route.fallback(),
	);
	await page.goto("/agents/agent-pilot-1/configuration");
	const form = main(page);
	await expect(
		form.getByText("运行资格已撤销，Owner 无法恢复。"),
	).toBeVisible();
	const surface = await resolved(page, "backgroundColor", "var(--surface)");
	// 目录选择器的输入框嵌在带 --surface 底的 .directory-control 里，本身透明无边框，不在此列。
	const controls = form.locator(
		'input[data-slot="input"]:disabled:not(.directory-input), textarea[data-slot="textarea"]:disabled',
	);
	expect(await controls.count()).toBeGreaterThan(0);
	for (const control of await controls.all())
		expect(await computed(control, ["backgroundColor", "opacity"])).toEqual({
			backgroundColor: surface,
			opacity: "0.5",
		});
	await expectNoDuplicateControls(page, "已停用 Agent 的 Owner 配置（G4-18）");
	await expectCleanPage(page, pageErrors);
});

// #3179 G4-20 / G4-21 / G4-22：空态图标为 Search；同步失败卡阶段到错误 12px、错误到操作 0，
// 失败阶段文字为 --danger；「确认绑定固定版本」事实列表在窄屏按单列 .facts（gap 3、dt 上距 8、dd 下距 4）。
test("Skill binding empty state, failed sync card and narrow bind facts follow the design (G4-20 / G4-21 / G4-22)", async ({
	page,
}, info) => {
	const mobile = info.project.name === "mobile";
	await viewport(page, mobile);
	const pageErrors = trackPageErrors(page);
	await ownerConfigFixture(page, { agentVersion: "agent-version-7" });
	await page.goto("/agents/agent-pilot-1/skills");
	const region = main(page);
	const empty = region.locator(".agent-skill-empty");
	await expect(empty).toContainText("还未绑定 Skill");
	expect(
		(await empty.locator("svg").getAttribute("class"))?.split(/\s+/),
	).toContain("lucide-search");

	// 服务端回报 code-review 内容同步失败。
	const metadata = skillDirectory.find(
		(version) => version.skillVersionId === "code-review-v1",
	);
	if (!metadata) throw new Error("Missing Skill fixture");
	await page.route(
		"**/api/v2/agents/agent-pilot-1/versions/agent-version-7/skills",
		(route) =>
			route.request().method() !== "GET"
				? route.fallback()
				: route.fulfill({
						json: SkillHubAgentBindingStatusResponseV1Schema.parse({
							schemaVersion: 1,
							agentId: "agent-pilot-1",
							agentVersion: "agent-version-7",
							configurationRevision: 8,
							bindings: [
								{
									schemaVersion: 1,
									agentId: "agent-pilot-1",
									agentVersion: "agent-version-7",
									skillName: metadata.name,
									skillVersion: {
										schemaVersion: 1,
										skillId: metadata.skillId,
										skillVersionId: metadata.skillVersionId,
										provider: metadata.provider,
										version: metadata.version,
										packageDigest: metadata.packageDigest,
										manifestDigest: metadata.manifestDigest,
										signatureDigest: metadata.signatureDigest,
									},
									grant: {
										schemaVersion: 1,
										tools: [],
										connections: [],
										fileRoots: [],
										networkOrigins: [],
										scripts: false,
									},
									configurationRevision: 8,
									syncRevision: 1,
									state: "failed",
									failureReason: "content sync failed",
									appliedReceipt: null,
								},
							],
						}),
					}),
	);
	await page.reload();
	const card = region.getByRole("article", { name: /code-review/ });
	const error = card.locator(".skill-binding-error");
	await expect(error).toHaveText("内容同步失败，这个版本不会在对话中提供。");
	const stages = card.locator(".sync-stages");
	const actions = card.locator(".skill-actions");
	expect(Math.abs((await verticalGap(stages, error)) - 12)).toBeLessThanOrEqual(
		0.5,
	);
	expect(Math.abs(await verticalGap(error, actions))).toBeLessThanOrEqual(0.5);
	await expect(card.locator(".sync-stage[data-failed]")).toHaveCSS(
		"color",
		await resolved(page, "color", "var(--danger)"),
	);

	await region
		.getByLabel("固定版本", { exact: true })
		.selectOption("workspace-summary-v1");
	await region.getByRole("button", { name: "绑定固定版本" }).click();
	const bind = page.getByRole("dialog", { name: "确认绑定固定版本" });
	const facts = bind.locator("dl.skill-binding-facts");
	await expect(facts).toBeVisible();
	if (mobile) {
		await expect(facts).toHaveCSS("row-gap", "3px");
		await expect(facts.locator("dt").first()).toHaveCSS("margin-top", "8px");
		await expect(facts.locator("dd").first()).toHaveCSS("margin-bottom", "4px");
		// 对象行到首个 dt 23px（facts 上距 15 + dt 上距 8），dt→dd 3px，组间 15px。
		const subject = bind.locator('[data-slot="confirm-dialog-subject"]');
		expect(
			Math.abs((await verticalGap(subject, facts.locator("dt").first())) - 23),
		).toBeLessThanOrEqual(0.5);
		expect(
			Math.abs(
				(await verticalGap(
					facts.locator("dt").first(),
					facts.locator("dd").first(),
				)) - 3,
			),
		).toBeLessThanOrEqual(0.5);
		expect(
			Math.abs(
				(await verticalGap(
					facts.locator("dd").first(),
					facts.locator("dt").nth(1),
				)) - 15,
			),
		).toBeLessThanOrEqual(0.5);
	} else
		await expect(facts.locator("dt").first()).toHaveCSS("margin-top", "0px");
	await page.keyboard.press("Escape");
	await expect(bind).toHaveCount(0);
	await expectNoDuplicateControls(page, "Agent 的 Skill（同步失败，G4-21）");
	await expectCleanPage(page, pageErrors);
});
