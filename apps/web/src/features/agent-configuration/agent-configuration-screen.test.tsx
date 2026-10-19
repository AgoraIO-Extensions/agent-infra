import {
	AgentProjectionV2Schema,
	BrowserSessionProjectionV1Schema,
} from "@agent-infra/contracts/pilot";
import { pilotFakeScenariosV2 } from "@agent-infra/test-support/pilot";
import {
	act,
	cleanup,
	fireEvent,
	render as renderWithoutToast,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import type { ComponentProps, ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "../../pilot/generated/client.gen.js";

import { AgentConfigurationScreen } from "./agent-configuration-screen.js";
import { ConfigurationTestProviders } from "./test-router-context.js";

// 企微卡片、镜像升级、Secret 与默认 Key 替换都会调用 Toast；页面在根布局的 ToastProvider 内渲染。
// 页头与 Skill 入口是路由 Link，同时提供路由上下文。
function render(ui: ReactElement) {
	return renderWithoutToast(ui, { wrapper: ConfigurationTestProviders });
}

function toastText() {
	return document.querySelector('[data-slot="toast"]')?.textContent ?? "";
}

/** 弹窗外的页面级提示。 */
function pageAlerts() {
	return screen
		.queryAllByRole("alert")
		.filter((element) => !element.closest('[role="dialog"]'));
}

// Toast 宿主也是 role="status"；页面自身的状态排除它再查找。
function pageStatuses() {
	return screen
		.queryAllByRole("status")
		.filter((element) => element.getAttribute("data-slot") !== "toast");
}

/** 「环境变量与 Secret」分区里的密码框（企微卡片有自己的 Secret 字段，不计入）。 */
function secretSectionPasswordInputs() {
	return screen
		.getByRole("region", { name: "环境变量与 Secret" })
		.querySelectorAll('input[type="password"]');
}

const agent = AgentProjectionV2Schema.parse(
	pilotFakeScenariosV2.starting.response.body,
);
const ownerSession = BrowserSessionProjectionV1Schema.parse({
	schemaVersion: 1,
	user: {
		userId: "user-owner-1",
		displayName: "Owner",
		roles: ["employee"],
	},
});
const ordinarySession = BrowserSessionProjectionV1Schema.parse({
	schemaVersion: 1,
	user: {
		userId: "user-ordinary-1",
		displayName: "Ordinary user",
		roles: ["employee"],
	},
});

type ScreenProps = ComponentProps<typeof AgentConfigurationScreen>;

function renderScreen(overrides: Partial<ScreenProps> = {}) {
	const onSave = vi.fn();
	const props: ScreenProps = {
		agent,
		onSave,
		onUpgradeImage: vi.fn(),
		session: { kind: "ready", session: ownerSession },
		submitting: false,
		...overrides,
	};
	const view = render(<AgentConfigurationScreen {...props} />);
	return {
		onSave: props.onSave as ReturnType<typeof vi.fn>,
		props,
		rerender: (next: Partial<ScreenProps>) =>
			view.rerender(<AgentConfigurationScreen {...props} {...next} />),
	};
}

const saveButton = () => screen.getByRole("button", { name: "保存配置" });

/** 制造一次真实改动：修改环境变量的值（Owner 与范围没有变化时，保存按钮本来是禁用的，#2560）。 */
function changeEnvironment(value = "changed-value") {
	fireEvent.change(screen.getByLabelText("值"), { target: { value } });
}

/** 在只写密码框里输入：直接写 DOM 值（非受控 input），再触发 input 事件。 */
function typeWriteOnly(input: HTMLElement, value: string) {
	(input as HTMLInputElement).value = value;
	fireEvent.input(input);
}

beforeEach(() => {
	// 企微卡片会读取渠道状态；默认返回未配置，避免读取失败的提示混入断言。
	client.setConfig({ baseUrl: "https://platform.test" });
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json({ status: "not_configured" })),
	);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("AgentConfigurationScreen", () => {
	it("summarizes the current models in Chinese and merges the default into one select (RK2-01, RK2-07)", () => {
		const configuredAgent = AgentProjectionV2Schema.parse({
			...agent,
			configuration: {
				...agent.configuration,
				modelOptions: [
					{
						optionId: "other-model",
						displayName: "Other model",
						modelId: "other",
						reasoningLevels: ["low"],
					},
					{
						optionId: "current-default",
						displayName: "Current model",
						modelId: "current",
						reasoningLevels: ["low", "high"],
					},
				],
				defaultModelOptionId: "current-default",
				defaultReasoningLevel: "high",
			},
		});
		renderScreen({
			agent: configuredAgent,
			endpointNames: { catalog: "Catalog endpoint" },
			deploymentModelCandidates: [
				{ endpointId: "catalog", modelId: "other", reasoningLevels: ["low"] },
				{
					endpointId: "catalog",
					modelId: "current",
					reasoningLevels: ["low", "high"],
				},
			],
		});

		expect(
			screen.getByRole("heading", { level: 2, name: "模型与凭证" }),
		).toBeTruthy();
		expect(
			screen.getByText("Owner 可以设置默认模型和可用推理档位。"),
		).toBeTruthy();
		expect(screen.getByText("当前默认：Current model · 高")).toBeTruthy();
		fireEvent.click(screen.getByRole("checkbox", { name: "替换模型配置" }));
		// 显示选择器时隐藏摘要；两个默认下拉合并为一个「默认模型选项」。
		expect(screen.queryByText(/^当前默认：/)).toBeNull();
		expect(screen.queryByLabelText("默认模型")).toBeNull();
		expect(screen.queryByLabelText("默认推理档位")).toBeNull();
		const select = screen.getByLabelText<HTMLSelectElement>("默认模型选项");
		expect([...select.options].map((option) => option.textContent)).toEqual([
			"Catalog endpoint · other · 低",
			"Catalog endpoint · current · 高",
			"Catalog endpoint · current · 低",
		]);
		expect(select.value).toBe("catalog:current|high");
		// 选择器是分区内容：不嵌套 fieldset + legend。
		expect(document.querySelector("legend")).toBeNull();
	});

	it("does not render configuration data or controls for an ordinary-user projection", () => {
		renderScreen({ session: { kind: "ready", session: ordinarySession } });

		expect(screen.getByRole("heading", { name: "配置不可用" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "保存配置" })).toBeNull();
		expect(screen.queryByText("MODEL_API_KEY")).toBeNull();
	});

	it("uses a separate custom image upgrade command", () => {
		const onUpgradeImage = vi.fn();
		renderScreen({
			agent: AgentProjectionV2Schema.parse({
				...agent,
				source: {
					kind: "custom",
					imageReference: "registry.example/agents/release:1",
					interactionMode: "platform-adapter",
				},
			}),
			onUpgradeImage,
		});

		fireEvent.change(screen.getByLabelText("新镜像引用"), {
			target: { value: "registry.example/agents/release:2" },
		});
		fireEvent.click(screen.getByRole("button", { name: "升级镜像" }));
		expect(onUpgradeImage).toHaveBeenCalledWith(
			"registry.example/agents/release:2",
		);
	});

	it("keeps the page after a successful save and confirms it with a toast (RK2-09)", async () => {
		const { rerender } = renderScreen();
		changeEnvironment();
		fireEvent.click(saveButton());
		// 保存的 mutation 在 Agent 详情回读后才完成：结果与新投影一起到达。
		const saved = {
			...agent,
			configuration: {
				...agent.configuration,
				environment: [{ name: "WORKSPACE_NAME", value: "changed-value" }],
			},
		};
		rerender({ agent: saved, commandResult: saved });

		await waitFor(() =>
			expect(toastText()).toBe("配置已保存，Secret 值不会回显"),
		);
		// 表单仍在，以新投影重置草稿；没有「配置已提交」视图。
		expect(document.body.textContent).not.toContain("配置已提交");
		expect(screen.getByLabelText<HTMLInputElement>("值").value).toBe(
			"changed-value",
		);
		const hint = screen.getByText("没有需要保存的变更。");
		await waitFor(() => expect(document.activeElement).toBe(hint));
		expect(document.activeElement).not.toBe(document.body);
	});

	it("does not treat another Agent's result as this page's save", () => {
		renderScreen({
			agent: { ...agent, agentId: "agent-pilot-2" },
			commandResult: { ...agent, managementStatus: "creating" },
		});
		expect(toastText()).toBe("");
		expect(document.body.textContent).not.toContain("配置已提交");
	});

	it("shows path-specific save failures without mentioning model credentials (RK2-09)", () => {
		const { rerender } = renderScreen();
		changeEnvironment();
		fireEvent.click(saveButton());
		rerender({
			commandError: Object.assign(new Error("private transport detail"), {
				retryable: true,
				status: 503,
			}),
		});
		const footer = saveButton().closest(".form-footer") as HTMLElement;
		expect(within(footer).getByRole("alert").textContent).toBe(
			"配置未能保存，请重试。",
		);

		rerender({
			commandError: Object.assign(new Error("private transport detail"), {
				retryable: false,
				status: 403,
			}),
		});
		expect(screen.getByRole("alert").textContent).toBe(
			"权限或 Agent 状态已变化，请刷新页面。",
		);
		expect(document.body.textContent).not.toContain("private transport detail");
		expect(document.body.textContent).not.toContain("模型凭证");
	});

	it("allows catalog model replacement with readable endpoint names", () => {
		const { onSave } = renderScreen({
			endpointNames: { "approved-endpoint": "Approved endpoint" },
			deploymentModelCandidates: [
				{
					endpointId: "approved-endpoint",
					modelId: "release-model",
					reasoningLevels: ["high"],
				},
			],
		});
		fireEvent.click(screen.getByRole("checkbox", { name: "替换模型配置" }));
		fireEvent.click(
			screen.getByRole("checkbox", {
				name: "Approved endpoint · release-model",
			}),
		);
		expect(screen.getByRole("checkbox", { name: "高" })).toBeTruthy();
		fireEvent.click(saveButton());
		expect(onSave).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				modelConfiguration: {
					options: [
						{
							optionId: "approved-endpoint:release-model",
							endpointId: "approved-endpoint",
							modelId: "release-model",
							reasoningLevels: ["high"],
						},
					],
					defaultOptionId: "approved-endpoint:release-model",
					defaultReasoningLevel: "high",
				},
			}),
		);
		// 页面不显示原始端点 ID 与英文档位。
		expect(document.body.textContent).not.toContain("approved-endpoint");
	});

	it("does not render per-model credential fields", () => {
		renderScreen();
		fireEvent.click(screen.getByRole("checkbox", { name: "替换模型配置" }));
		expect(screen.queryByLabelText("新模型凭证")).toBeNull();
	});

	it("puts footer lifecycle actions after save and the danger zone after the form card", () => {
		renderScreen({
			afterForm: <section aria-label="停止区">停止区内容</section>,
			footerActions: <button type="button">重启 Agent</button>,
		});
		const footer = saveButton().closest(".form-footer");
		expect(footer).not.toBeNull();
		expect(
			within(footer as HTMLElement)
				.getAllByRole("button")
				.map((button) => button.textContent),
		).toEqual(["保存配置", "重启 Agent"]);
		const card = footer?.closest(".configuration-form-card");
		const zone = screen.getByRole("region", { name: "停止区" });
		expect(card?.contains(zone)).toBe(false);
		expect(card?.nextElementSibling).toBe(zone);
		expect(document.querySelector(".form-aside, .lifecycle-panel")).toBeNull();
		expect(document.body.textContent).not.toContain("生命周期");
	});

	it("shows the design heading and the permission boundary notice", () => {
		renderScreen();
		expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
			"配置 Agent 的 Owner、范围和运行方式。",
		);
		const header = document.querySelector("header.page-heading");
		// O-12：副标题按设计原文，与 Secret 分区「等待 Worker 激活」一致。
		expect(header?.textContent).toContain(
			"保存后由 Worker 更新实例；Secret 只显示状态和版本。",
		);
		// 设计 tag-row：只有一个可用性 chip（服务启动中），加一个「Owner · 名称」tag。
		const tagRow = header?.querySelector(".tag-row");
		const chips = [
			...(tagRow?.querySelectorAll(
				'[data-slot="badge"][data-variant="chip"]',
			) ?? []),
		];
		expect(chips.map((chip) => chip.textContent)).toEqual(["启动中"]);
		expect(chips[0]?.getAttribute("data-tone")).toBe("amber");
		expect(
			[
				...(tagRow?.querySelectorAll(
					'[data-slot="badge"][data-variant="tag"]',
				) ?? []),
			].map((tag) => tag.textContent),
		).toEqual(["Owner · Owner"]);
		// 返回链接是路由 Link：href 不变，且不被前缀匹配标成当前页。
		const back = screen.getByRole("link", { name: "返回 Agent 详情" });
		expect(back.getAttribute("href")).toBe("/agents/agent-pilot-1");
		expect(back.getAttribute("aria-current")).toBeNull();
		const boundary = screen
			.getByText("权限边界")
			.closest('[data-slot="alert"]');
		expect(boundary?.getAttribute("data-tone")).toBe("info");
		expect(boundary?.textContent).toContain(
			"Connection 授权由使用者自己完成。",
		);
	});

	it.each([
		["ready", "就绪", "green"],
		["unavailable", "暂时不可用", "gray"],
	] as const)(
		"derives the single heading chip from service availability %s",
		(serviceAvailability, label, tone) => {
			renderScreen({
				agent: AgentProjectionV2Schema.parse({ ...agent, serviceAvailability }),
			});
			const chips = document.querySelectorAll(
				'header.page-heading [data-slot="badge"][data-variant="chip"]',
			);
			expect([...chips].map((chip) => chip.textContent)).toEqual([label]);
			expect(chips[0]?.getAttribute("data-tone")).toBe(tone);
			expect(
				document.querySelector("header.page-heading")?.textContent,
			).not.toContain("可用启动中");
		},
	);

	it("names the scope sections with the design headings and descriptions", () => {
		renderScreen({
			authorization: <section data-slot="form-section">授权控制</section>,
			defaultRelayKeyActions: {
				check: vi.fn(),
				replaceKey: vi.fn(),
				replaceKeyWithModels: vi.fn(),
			},
		});
		const headings = screen
			.getAllByRole("heading", { level: 2 })
			.map((heading) => heading.textContent);
		expect(headings.slice(0, 2)).toEqual(["共同 Owner", "可用范围"]);
		// 设计 #owner-config 分区顺序：模型与凭证、Agent 默认 Relay Key 在渠道之前（acc-5 新问题 5）。
		expect(headings).toEqual([
			"共同 Owner",
			"可用范围",
			"模型与凭证",
			"Agent 默认 Relay Key",
			"企微渠道",
			"Skill",
			"环境变量与 Secret",
		]);
		expect(document.querySelector("legend")).toBeNull();
	});

	it("links the Skill section to the Agent's Skill bindings (O-02)", () => {
		renderScreen();
		const section = screen.getByRole("region", { name: "Skill" });
		expect(
			within(section).getByText("Skill 版本、同步和对话可用性分开管理。"),
		).toBeTruthy();
		const link = within(section).getByRole("link", { name: "管理 Skill 绑定" });
		expect(link.getAttribute("href")).toBe("/agents/agent-pilot-1/skills");
		expect(link.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
		// 位于「环境变量与 Secret」之前。
		const secrets = screen.getByRole("region", { name: "环境变量与 Secret" });
		expect(section.compareDocumentPosition(secrets)).toBe(
			Node.DOCUMENT_POSITION_FOLLOWING,
		);
	});

	it("hides the Skill section for a self-managed custom Agent until product confirms it", () => {
		renderScreen({
			agent: AgentProjectionV2Schema.parse({
				...agent,
				source: {
					kind: "custom",
					imageReference: "registry.example/agents/self:1",
					interactionMode: "self-managed",
					identityResponsibility: "self-managed",
				},
			}),
		});
		expect(screen.queryByRole("region", { name: "Skill" })).toBeNull();
		expect(screen.queryByRole("link", { name: "管理 Skill 绑定" })).toBeNull();
	});

	it("unbinds a WeCom channel through its own request without saving the page", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ status: "connected" })),
		);
		const onUnbindChannel = vi.fn(async () => undefined);
		const { onSave } = renderScreen({ onUnbindChannel });
		changeEnvironment();
		fireEvent.click(
			await screen.findByRole("button", { name: "解除绑定：企微机器人" }),
		);
		fireEvent.click(
			within(
				await screen.findByRole("dialog", { name: "解除企微机器人绑定？" }),
			).getByRole("button", { name: "确认解除" }),
		);
		await waitFor(() =>
			expect(onUnbindChannel).toHaveBeenCalledExactlyOnceWith("wecom_bot"),
		);
		expect(onSave).not.toHaveBeenCalled();
		// 未保存的修改仍在，保存按钮仍可用。
		expect(screen.getByLabelText<HTMLInputElement>("值").value).toBe(
			"changed-value",
		);
		expect(saveButton().hasAttribute("disabled")).toBe(false);
	});

	it("reports an accepted custom image upgrade with a toast instead of a saved-result view", async () => {
		const onUpgradeImage = vi.fn(async () => true);
		renderScreen({
			agent: AgentProjectionV2Schema.parse({
				...agent,
				source: {
					kind: "custom",
					imageReference: "registry.example/agents/release:1",
					interactionMode: "platform-adapter",
				},
			}),
			onUpgradeImage,
		});
		const input = screen.getByLabelText<HTMLInputElement>("新镜像引用");
		fireEvent.change(input, {
			target: { value: "registry.example/agents/release:2" },
		});
		// 分区在整页表单内：Enter 不触发保存。
		expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false);
		fireEvent.click(screen.getByRole("button", { name: "升级镜像" }));
		await waitFor(() => expect(toastText()).toBe("已提交镜像升级请求"));
		expect(input.value).toBe("");
		expect(
			document.querySelector(".agent-configuration")?.textContent,
		).not.toContain("配置已提交");
	});

	it.each(["pending", "disabled"] as const)(
		"prevents saving a configuration that is %s",
		(state) => {
			const { onSave } = renderScreen({
				agent:
					state === "disabled"
						? {
								...agent,
								managementStatus: "disabled",
								serviceAvailability: null,
							}
						: agent,
				submitting: state === "pending",
			});
			const button = screen.getByRole("button", {
				name: state === "pending" ? "保存中…" : "保存配置",
			});
			expect(button.getAttribute("disabled")).not.toBeNull();
			fireEvent.click(button);
			const form = button.closest("form");
			if (form) fireEvent.submit(form);
			expect(onSave).not.toHaveBeenCalled();
		},
	);

	it("shows group visibility and the self-built application setup contract", () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ status: "not_configured" })),
		);
		renderScreen();
		expect(screen.getByText(/群消息和 Agent 回复对群成员可见/)).toBeTruthy();
		expect(screen.getByRole("region", { name: "企微应用" })).toBeTruthy();
		expect(screen.getByLabelText("企业 ID")).toBeTruthy();
	});
});

describe("Secrets (O-10, N-08)", () => {
	const projectionWithVersion = (version: number) =>
		AgentProjectionV2Schema.parse({
			...agent,
			configuration: {
				...agent.configuration,
				secrets: [{ name: "MODEL_API_KEY", isSet: true, version }],
			},
		});

	function renderSecrets(overrides: Partial<ScreenProps> = {}) {
		const onReplaceSecret = vi.fn(async () => projectionWithVersion(2));
		const view = renderScreen({ onReplaceSecret, ...overrides });
		return {
			...view,
			onReplaceSecret: view.props.onReplaceSecret as typeof onReplaceSecret,
		};
	}
	const trigger = () =>
		screen.getByRole("button", { name: "替换 Secret：MODEL_API_KEY" });
	async function openDialog() {
		trigger().focus();
		fireEvent.click(trigger());
		return screen.findByRole("dialog", { name: "替换 Secret" });
	}

	it("lists each Secret as a read-only row with a replace action", () => {
		renderSecrets();
		const section = screen.getByRole("region", { name: "环境变量与 Secret" });
		expect(
			within(section).getByText(
				"Secret 只显示名称、版本和状态；替换后生成新版本。",
			),
		).toBeTruthy();
		const name =
			within(section).getByLabelText<HTMLInputElement>("Secret 名称");
		const status = within(section).getByLabelText<HTMLInputElement>("当前状态");
		expect([name.value, name.readOnly]).toEqual(["MODEL_API_KEY", true]);
		expect([status.value, status.readOnly]).toEqual([
			"已设置 · version 1",
			true,
		]);
		expect(trigger().querySelectorAll("svg")).toHaveLength(1);
		// 页面上没有可编辑的 Secret 输入框，也没有「移除 Secret」（申请表单的按钮已补中英文空格）。
		expect(screen.queryByLabelText("新 Secret 值")).toBeNull();
		expect(document.body.textContent).not.toMatch(/移除\s?Secret/);
		expect(secretSectionPasswordInputs()).toHaveLength(0);
	});

	it("opens a write-only modal and cancels without a request", async () => {
		const { onReplaceSecret } = renderSecrets();
		const dialog = await openDialog();
		expect(dialog.getAttribute("aria-modal")).toBe("true");
		expect(dialog.textContent).toContain(
			"输入新值后只会保存密文版本。页面不会显示当前 Secret 值。",
		);
		expect(dialog.textContent).toContain("MODEL_API_KEY");
		const input =
			within(dialog).getByLabelText<HTMLInputElement>("新 Secret 值");
		await waitFor(() => expect(document.activeElement).toBe(input));
		expect(input.type).toBe("password");
		expect(input.placeholder).toBe("仅本次提交使用");
		expect(
			within(dialog)
				.getAllByRole("button")
				.map((button) => button.textContent),
		).toEqual(["", "取消", "保存替换"]);
		typeWriteOnly(input, "cancelled-secret-value");
		fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(onReplaceSecret).not.toHaveBeenCalled();
		expect(document.body.innerHTML).not.toContain("cancelled-secret-value");
		const reopened = await openDialog();
		expect(
			within(reopened).getByLabelText<HTMLInputElement>("新 Secret 值").value,
		).toBe("");
	});

	it("saves the replacement directly, keeps unsaved page edits and toasts the new version (NI-13, NI-71)", async () => {
		const { onReplaceSecret, onSave } = renderSecrets();
		changeEnvironment("unsaved-edit");
		fireEvent.click(screen.getByRole("button", { name: "添加环境变量" }));
		const dialog = await openDialog();
		typeWriteOnly(
			within(dialog).getByLabelText("新 Secret 值"),
			"replacement-value",
		);
		fireEvent.click(within(dialog).getByRole("button", { name: "保存替换" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		// 只提交这一个 Secret：页面草稿不进入请求，也不经过整页保存。
		expect(onReplaceSecret).toHaveBeenCalledExactlyOnceWith(
			"MODEL_API_KEY",
			"replacement-value",
		);
		expect(onSave).not.toHaveBeenCalled();
		expect(toastText()).toBe(
			"Secret 已写入 pending version 2，等待 Worker 激活",
		);
		await waitFor(() => expect(document.activeElement).toBe(trigger()));
		// 未保存的修改仍在页面上，页脚保存仍可用；没有「配置已提交」和可编辑的 Secret 行。
		expect(screen.getAllByLabelText<HTMLInputElement>("值")[0]?.value).toBe(
			"unsaved-edit",
		);
		expect(saveButton().hasAttribute("disabled")).toBe(false);
		expect(document.body.textContent).not.toContain("配置已提交");
		expect(secretSectionPasswordInputs()).toHaveLength(0);
	});

	it("never puts the Secret into the DOM while typing, pending, failing, succeeding or cancelling (NI-02)", async () => {
		const probe = "probe-secret-value";
		let reject: (error: Error) => void = () => undefined;
		let resolve: (value: ReturnType<typeof projectionWithVersion>) => void =
			() => undefined;
		const onReplaceSecret = vi
			.fn()
			.mockImplementationOnce(
				() =>
					new Promise((_resolve, rejectRequest) => {
						reject = rejectRequest;
					}),
			)
			.mockImplementationOnce(
				() =>
					new Promise((resolveRequest) => {
						resolve = resolveRequest;
					}),
			);
		renderSecrets({ onReplaceSecret });
		const noLeak = () => {
			expect(document.body.innerHTML).not.toContain(probe);
			for (const input of document.querySelectorAll("input"))
				expect(input.getAttribute("value") ?? "").not.toContain(probe);
		};
		let dialog = await openDialog();
		const input = within(dialog).getByLabelText("新 Secret 值");
		typeWriteOnly(input, probe);
		noLeak();
		expect(input.getAttribute("value")).toBeNull();
		fireEvent.click(within(dialog).getByRole("button", { name: "保存替换" }));
		noLeak();
		await act(async () => reject(new Error("unavailable")));
		await within(dialog).findByRole("alert");
		noLeak();
		fireEvent.click(within(dialog).getByRole("button", { name: "保存替换" }));
		noLeak();
		await act(async () => resolve(projectionWithVersion(2)));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		noLeak();
		dialog = await openDialog();
		expect(
			within(dialog).getByLabelText<HTMLInputElement>("新 Secret 值").value,
		).toBe("");
		typeWriteOnly(within(dialog).getByLabelText("新 Secret 值"), probe);
		fireEvent.keyDown(dialog, { key: "Escape" });
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		noLeak();
	});

	it("keeps focus and the modal while pending, and reports failure only inside it (NI-95)", async () => {
		let reject: (error: Error) => void = () => undefined;
		const onReplaceSecret = vi.fn(
			() =>
				new Promise<never>((_resolve, rejectRequest) => {
					reject = rejectRequest;
				}),
		);
		renderSecrets({ onReplaceSecret });
		const dialog = await openDialog();
		const input = within(dialog).getByLabelText("新 Secret 值");
		typeWriteOnly(input, "pending-secret-value");
		const save = within(dialog).getByRole("button", { name: "保存替换" });
		save.focus();
		fireEvent.click(save);
		const pending = within(dialog).getByRole("button", { name: "正在保存…" });
		expect(pending.getAttribute("aria-disabled")).toBe("true");
		expect(pending.hasAttribute("disabled")).toBe(false);
		expect(document.activeElement).toBe(pending);
		// 取消、关闭钮与 Esc 都不关闭弹窗。
		expect(
			within(dialog)
				.getByRole("button", { name: "取消" })
				.hasAttribute("disabled"),
		).toBe(true);
		expect(
			within(dialog)
				.getByRole("button", { name: "关闭" })
				.hasAttribute("disabled"),
		).toBe(true);
		fireEvent.keyDown(dialog, { key: "Escape" });
		expect(screen.getByRole("dialog", { name: "替换 Secret" })).toBe(dialog);
		fireEvent.click(pending);
		expect(onReplaceSecret).toHaveBeenCalledOnce();

		await act(async () => reject(new Error("unavailable")));
		expect((await within(dialog).findByRole("alert")).textContent).toBe(
			"Secret 替换未完成，请重试。",
		);
		await waitFor(() => expect(document.activeElement).toBe(input));
		expect(pageAlerts()).toEqual([]);
		expect(document.body.textContent).not.toContain("配置未能保存");
	});

	it("shows a plain field error for an empty value without sending (NI-95)", async () => {
		const { onReplaceSecret } = renderSecrets();
		const dialog = await openDialog();
		fireEvent.click(within(dialog).getByRole("button", { name: "保存替换" }));
		const error = within(dialog).getByText("请输入新的 Secret 值。");
		expect(error.getAttribute("data-slot")).toBe("field-error");
		expect(error.getAttribute("role")).toBe("alert");
		expect(error.className).toContain("text-[12px]");
		expect(error.className).toContain("text-(--danger-ink)");
		expect(error.closest('[data-slot="alert"]')).toBeNull();
		const input = within(dialog).getByLabelText("新 Secret 值");
		expect(input.getAttribute("aria-invalid")).toBe("true");
		expect(input.getAttribute("aria-describedby")).toBe(error.id);
		expect(onReplaceSecret).not.toHaveBeenCalled();
	});

	it("adds a template-allowed Secret through the same modal (O-10)", async () => {
		const { onReplaceSecret } = renderSecrets({
			allowedSecretKeys: ["MODEL_API_KEY", "RELEASE_KEY"],
		});
		const add = screen.getByRole("button", { name: "添加 Secret" });
		add.focus();
		fireEvent.click(add);
		const dialog = await screen.findByRole("dialog", { name: "添加 Secret" });
		const name =
			within(dialog).getByLabelText<HTMLSelectElement>("Secret 名称");
		// 已有的 Secret 不再出现在添加选项里，需用「替换 Secret」。
		expect([...name.options].map((option) => option.value)).toEqual([
			"",
			"RELEASE_KEY",
		]);
		fireEvent.click(
			within(dialog).getByRole("button", { name: "保存 Secret" }),
		);
		// 中文与「Secret」之间有一个空格。
		expect(within(dialog).getByText("请输入 Secret 名称。")).toBeTruthy();
		fireEvent.change(name, { target: { value: "RELEASE_KEY" } });
		typeWriteOnly(within(dialog).getByLabelText("新 Secret 值"), "new-value");
		fireEvent.click(
			within(dialog).getByRole("button", { name: "保存 Secret" }),
		);
		await waitFor(() =>
			expect(onReplaceSecret).toHaveBeenCalledExactlyOnceWith(
				"RELEASE_KEY",
				"new-value",
			),
		);
	});

	it("rejects platform-reserved names for a custom Agent without a request", async () => {
		const { onReplaceSecret } = renderSecrets({
			agent: AgentProjectionV2Schema.parse({
				...agent,
				source: {
					kind: "custom",
					imageReference: "registry.example/agents/release:1",
					interactionMode: "platform-adapter",
				},
			}),
		});
		fireEvent.click(screen.getByRole("button", { name: "添加 Secret" }));
		const dialog = await screen.findByRole("dialog", { name: "添加 Secret" });
		fireEvent.change(within(dialog).getByLabelText("Secret 名称"), {
			target: { value: "AGENT_INFRA_TOKEN" },
		});
		typeWriteOnly(within(dialog).getByLabelText("新 Secret 值"), "value");
		fireEvent.click(
			within(dialog).getByRole("button", { name: "保存 Secret" }),
		);
		expect(
			within(dialog).getByText("Secret 名称不能以 AGENT_INFRA_ 开头。"),
		).toBeTruthy();
		expect(onReplaceSecret).not.toHaveBeenCalled();
	});

	it("hides the add action when the template has no more Secret keys", () => {
		renderSecrets({ allowedSecretKeys: ["MODEL_API_KEY"] });
		expect(screen.queryByRole("button", { name: "添加 Secret" })).toBeNull();
	});
});

describe("environment variables (O-10)", () => {
	it("edits, removes and adds environment variables and submits the full table only when changed", () => {
		const { onSave } = renderScreen();
		expect(screen.getByLabelText<HTMLInputElement>("环境变量名").value).toBe(
			"WORKSPACE_NAME",
		);
		expect(screen.getByLabelText<HTMLInputElement>("值").value).toBe("release");
		const remove = screen.getByRole("button", { name: "移除：WORKSPACE_NAME" });
		expect(remove.textContent).toBe("移除");
		expect(screen.getByText("没有需要保存的变更。")).toBeTruthy();

		changeEnvironment("workspace");
		expect(screen.queryByText("没有需要保存的变更。")).toBeNull();
		fireEvent.click(saveButton());
		expect(onSave.mock.calls[0]?.[0]).toMatchObject({
			schemaVersion: 2,
			environment: [{ name: "WORKSPACE_NAME", value: "workspace" }],
		});
		expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty("secrets");

		fireEvent.click(
			screen.getByRole("button", { name: "移除：WORKSPACE_NAME" }),
		);
		fireEvent.click(saveButton());
		expect(onSave.mock.calls[1]?.[0].environment).toEqual([]);
	});

	it("restricts standard-template names to the template keys", () => {
		const { onSave } = renderScreen({
			allowedEnvironmentKeys: ["LOG_LEVEL", "WORKSPACE_NAME"],
		});
		const name = screen.getByLabelText<HTMLSelectElement>("环境变量名");
		expect([...name.options].map((option) => option.value)).toEqual([
			"",
			"LOG_LEVEL",
			"WORKSPACE_NAME",
		]);
		fireEvent.click(screen.getByRole("button", { name: "添加环境变量" }));
		fireEvent.click(saveButton());
		// 新增的空白行未选名称：字段错误并聚焦，不发请求。
		const error = screen.getByText("请输入环境变量名。");
		expect(error.getAttribute("data-slot")).toBe("field-error");
		expect(document.activeElement?.id).toBe("configuration-environment-name-1");
		expect(onSave).not.toHaveBeenCalled();
		fireEvent.change(screen.getAllByLabelText("环境变量名")[1] as HTMLElement, {
			target: { value: "LOG_LEVEL" },
		});
		fireEvent.change(screen.getAllByLabelText("值")[1] as HTMLElement, {
			target: { value: "debug" },
		});
		fireEvent.click(saveButton());
		expect(onSave.mock.calls[0]?.[0].environment).toEqual([
			{ name: "WORKSPACE_NAME", value: "release" },
			{ name: "LOG_LEVEL", value: "debug" },
		]);
	});

	it("validates free-text names for a custom Agent", () => {
		const { onSave } = renderScreen({
			agent: AgentProjectionV2Schema.parse({
				...agent,
				source: {
					kind: "custom",
					imageReference: "registry.example/agents/release:1",
					interactionMode: "platform-adapter",
				},
			}),
		});
		fireEvent.change(screen.getByLabelText("环境变量名"), {
			target: { value: "AGENT_INFRA_MODE" },
		});
		fireEvent.click(saveButton());
		expect(
			screen.getByText("环境变量名不能以 AGENT_INFRA_ 开头。"),
		).toBeTruthy();
		expect(onSave).not.toHaveBeenCalled();
	});
});

const keyedAgent = AgentProjectionV2Schema.parse({
	...agent,
	configuration: {
		...agent.configuration,
		modelOptions: [
			{
				optionId: "relay:model-a",
				displayName: "model-a",
				modelId: "model-a",
				reasoningLevels: ["high", "medium"],
			},
		],
		defaultModelOptionId: "relay:model-a",
		defaultReasoningLevel: "medium",
	},
});
const savedCandidates = [
	{
		endpointId: "relay",
		modelId: "model-a",
		reasoningLevels: ["medium", "high"],
	},
	{
		endpointId: "relay",
		modelId: "model-b",
		reasoningLevels: ["low", "medium"],
	},
];
const endpointNames = { relay: "Relay · Internal" };

function renderManaged(overrides: Partial<ScreenProps> = {}) {
	return renderScreen({
		agent: keyedAgent,
		defaultRelayKeyManaged: true,
		endpointNames,
		savedRelayKeyCandidates: savedCandidates,
		savedRelayKeyConfigurationRevision: 7,
		savedRelayKeyVersion: 2,
		...overrides,
	});
}

describe("models managed by the saved default Relay Key (RK2-01～RK2-07)", () => {
	it("starts unchanged and stays unchanged after toggling a level back (RK2-02)", () => {
		renderManaged();
		expect(screen.getByText("没有需要保存的变更。")).toBeTruthy();
		expect(saveButton().hasAttribute("disabled")).toBe(true);
		const levels = screen.getByRole("group", {
			name: "Relay · Internal · model-a 的推理档位",
		});
		fireEvent.click(within(levels).getByRole("checkbox", { name: "高" }));
		expect(saveButton().hasAttribute("disabled")).toBe(false);
		fireEvent.click(within(levels).getByRole("checkbox", { name: "高" }));
		expect(saveButton().hasAttribute("disabled")).toBe(true);
		expect(screen.getByText("没有需要保存的变更。")).toBeTruthy();
	});

	it("shows readable names and Chinese levels without the summary (RK2-01, RK2-07)", () => {
		renderManaged();
		const picker = document.getElementById(
			"configuration-saved-key-model",
		) as HTMLElement;
		expect(
			within(picker)
				.getAllByRole("checkbox")
				.map((box) => box.parentElement?.textContent),
		).toEqual([
			"Relay · Internal · model-a",
			"均衡",
			"高",
			"Relay · Internal · model-b",
		]);
		expect(picker.textContent).not.toMatch(/relay ·|medium|high|\blow\b/);
		expect(screen.getByLabelText<HTMLSelectElement>("默认模型选项").value).toBe(
			"relay:model-a|medium",
		);
		expect(screen.queryByText(/^当前默认：/)).toBeNull();
		expect(pageStatuses()).toEqual([]);
	});

	it("saves a changed selection with the saved-Key versions (schemaVersion 4)", () => {
		const { onSave } = renderManaged();
		fireEvent.click(
			screen.getByRole("checkbox", { name: "Relay · Internal · model-b" }),
		);
		fireEvent.change(screen.getByLabelText("默认模型选项"), {
			target: { value: "relay:model-b|medium" },
		});
		fireEvent.click(saveButton());
		expect(onSave).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				schemaVersion: 4,
				expectedConfigurationRevision: 7,
				expectedKeyVersion: 2,
				modelConfiguration: expect.objectContaining({
					defaultOptionId: "relay:model-b",
					defaultReasoningLevel: "medium",
				}),
			}),
		);
		expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty("defaultRelayKey");
	});

	it("does not send models when only other fields changed, even if candidates miss current models (RK2-02, RK2-03)", () => {
		const { onSave } = renderManaged({
			savedRelayKeyCandidates: [
				savedCandidates[1] as (typeof savedCandidates)[number],
			],
		});
		expect(pageAlerts()).toEqual([]);
		expect(pageStatuses()).toEqual([]);
		changeEnvironment();
		fireEvent.click(saveButton());
		expect(onSave).toHaveBeenCalledOnce();
		expect(onSave.mock.calls[0]?.[0]).toMatchObject({ schemaVersion: 2 });
		expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty("modelConfiguration");
		// 改动选择后会移除当前模型：保存前先列出来。
		fireEvent.click(
			screen.getByRole("checkbox", { name: "Relay · Internal · model-b" }),
		);
		const notice = screen
			.getByText("保存后会移除这些模型")
			.closest('[data-slot="alert"]');
		expect(notice?.textContent).toContain("Relay · Internal · model-a");
	});

	it("shows one field error only after an invalid edit and blocks only that save (RK2-03)", async () => {
		const { onSave } = renderManaged();
		changeEnvironment();
		fireEvent.click(
			screen.getByRole("checkbox", { name: "Relay · Internal · model-a" }),
		);
		const alerts = pageAlerts();
		expect(alerts.map((alert) => alert.textContent)).toEqual([
			"至少选择一个模型。",
		]);
		expect(alerts[0]?.getAttribute("data-slot")).toBe("field-error");
		fireEvent.click(saveButton());
		expect(onSave).not.toHaveBeenCalled();
		expect(document.activeElement).toBe(
			screen.getByRole("checkbox", { name: "Relay · Internal · model-a" }),
		);
		fireEvent.click(
			screen.getByRole("checkbox", { name: "Relay · Internal · model-a" }),
		);
		expect(pageAlerts()).toEqual([]);
		fireEvent.click(saveButton());
		expect(onSave).toHaveBeenCalledOnce();
	});

	it("shows no field error after toggling back to a subset baseline that has no selection", () => {
		const { onSave } = renderManaged({
			savedRelayKeyCandidates: [
				savedCandidates[1] as (typeof savedCandidates)[number],
			],
		});
		const modelB = () =>
			screen.getByRole("checkbox", { name: "Relay · Internal · model-b" });
		// 候选不含当前模型：初始没有勾选。勾选再取消回到初始状态，不显示错误、也不判定改动。
		fireEvent.click(modelB());
		fireEvent.click(modelB());
		expect(pageAlerts()).toEqual([]);
		expect(screen.getByText("没有需要保存的变更。")).toBeTruthy();
		expect(saveButton().hasAttribute("disabled")).toBe(true);

		// 一次被拦下的保存之后再改回初始状态，同样不沿用提交时的错误。
		fireEvent.click(modelB());
		const levels = screen.getByRole("group", {
			name: "Relay · Internal · model-b 的推理档位",
		});
		for (const level of within(levels).getAllByRole("checkbox"))
			fireEvent.click(level);
		fireEvent.click(saveButton());
		expect(onSave).not.toHaveBeenCalled();
		expect(pageAlerts().map((alert) => alert.textContent)).toEqual([
			"每个已选模型至少保留一个推理档位。",
		]);
		for (const level of within(levels).getAllByRole("checkbox"))
			fireEvent.click(level);
		fireEvent.click(modelB());
		expect(pageAlerts()).toEqual([]);
		expect(saveButton().hasAttribute("disabled")).toBe(true);
	});

	it("explains an empty candidate list instead of an empty picker (RK2-04)", () => {
		renderManaged({ savedRelayKeyCandidates: [] });
		const models = screen.getByRole("region", { name: "模型与凭证" });
		expect(within(models).queryAllByRole("checkbox")).toEqual([]);
		expect(screen.queryByText("请先选择模型")).toBeNull();
		expect(screen.getByText("当前默认 Key 没有此模板可用的模型")).toBeTruthy();
		expect(pageAlerts()).toEqual([]);
		// 摘要同样用端点显示名与中文档位。
		expect(screen.getByText(/^当前默认：/).textContent).toBe(
			"当前默认：Relay · Internal · model-a · 均衡",
		);
	});

	it("uses the shared loading line only while first reading (RK2-05)", () => {
		renderManaged({
			savedRelayKeyCandidates: undefined,
			savedRelayKeyCandidatesLoading: true,
		});
		const [status, ...rest] = pageStatuses();
		expect(rest).toEqual([]);
		expect(status?.getAttribute("data-slot")).toBe("loading-line");
		expect(status?.querySelector('[data-slot="spinner"]')).not.toBeNull();
	});

	it("distinguishes retryable and final read failures (RK2-06)", () => {
		const onRetry = vi.fn();
		const { onSave, rerender } = renderManaged({
			savedRelayKeyCandidates: undefined,
			savedRelayKeyCandidatesError: Object.assign(new Error("opaque"), {
				retryable: true,
				status: 503,
			}),
			onRetrySavedRelayKeyCandidates: onRetry,
		});
		const alert = screen.getByRole("alert");
		expect(alert.getAttribute("data-tone")).toBe("danger");
		expect(alert.textContent).toContain("暂时无法读取可用模型");
		fireEvent.click(screen.getByRole("button", { name: "重新读取可用模型" }));
		expect(onRetry).toHaveBeenCalledOnce();

		for (const status of [403, 409]) {
			rerender({
				savedRelayKeyCandidatesError: Object.assign(new Error("opaque"), {
					retryable: false,
					status,
				}),
			});
			expect(screen.getByRole("alert").textContent).toContain(
				"无法读取可用模型",
			);
			expect(screen.getByRole("alert").textContent).not.toContain("暂时");
			expect(
				screen.queryByRole("button", { name: "重新读取可用模型" }),
			).toBeNull();
		}
		expect(document.body.textContent).not.toContain("opaque");
		// 读取失败不拦截其他字段的保存。
		changeEnvironment();
		fireEvent.click(saveButton());
		expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty("modelConfiguration");
	});

	it("offers to reload candidates after a saved-model conflict (RK2-09)", () => {
		const onReloadSavedRelayKey = vi.fn();
		const { rerender } = renderManaged({ onReloadSavedRelayKey });
		fireEvent.click(
			screen.getByRole("checkbox", { name: "Relay · Internal · model-b" }),
		);
		fireEvent.click(saveButton());
		rerender({
			commandError: Object.assign(new Error("conflict"), {
				retryable: false,
				status: 409,
			}),
		});
		const alert = saveButton()
			.closest(".form-footer")
			?.querySelector('[role="alert"]') as HTMLElement;
		expect(alert.textContent).toContain(
			"默认 Key 或配置已更新，请重新读取可用模型后再保存。",
		);
		fireEvent.click(
			within(alert).getByRole("button", { name: "重新读取可用模型" }),
		);
		expect(onReloadSavedRelayKey).toHaveBeenCalledOnce();
		rerender({
			commandError: Object.assign(new Error("unavailable"), {
				retryable: true,
				status: 503,
			}),
		});
		expect(
			saveButton().closest(".form-footer")?.querySelector('[role="alert"]')
				?.textContent,
		).toBe("模型配置未能保存，请重试。");
	});
});

describe("Agent default Relay Key (G-08, G-09)", () => {
	const keyState = {
		schemaVersion: 1 as const,
		isSet: true as const,
		keyVersion: 3,
		configurationRevision: 7,
	};
	function renderKey(
		actions: Partial<NonNullable<ScreenProps["defaultRelayKeyActions"]>> = {},
		overrides: Partial<ScreenProps> = {},
	) {
		const defaultRelayKeyActions = {
			check: vi.fn(async () => ({
				schemaVersion: 1 as const,
				configurationRevision: 7,
				keyVersion: 3,
				candidates: savedCandidates,
			})),
			replaceKey: vi.fn(async () => ({ ...keyState, keyVersion: 4 })),
			replaceKeyWithModels: vi.fn(async () => keyedAgent),
			...actions,
		};
		const view = renderManaged({
			defaultRelayKeyActions,
			defaultRelayKeyState: keyState,
			...overrides,
		});
		return { ...view, actions: defaultRelayKeyActions };
	}
	const section = () =>
		screen.getByRole("region", { name: "Agent 默认 Relay Key" });
	const replaceButton = () =>
		within(section()).getByRole("button", { name: "替换默认 Key" });
	async function openKeyDialog() {
		replaceButton().focus();
		fireEvent.click(replaceButton());
		return screen.findByRole("dialog", { name: "替换 Agent 默认 Relay Key" });
	}

	it("has its own section with usage boundary, status, version and available models", () => {
		renderKey();
		const region = section();
		expect(
			within(region).getByText(
				"供 API、评测和后台任务使用；Web 对话和企微继续使用个人 Key。",
			),
		).toBeTruthy();
		expect(within(region).getByText("已设置").className).toContain(
			"text-(--success-ink)",
		);
		const facts = region.querySelector("dl") as HTMLElement;
		expect(
			[...facts.querySelectorAll("dt")].map((dt) => [
				dt.textContent,
				dt.nextElementSibling?.textContent,
			]),
		).toEqual([
			["当前版本", "version 3"],
			["可用模型", "model-a · 均衡/高model-b · 低/均衡"],
			["密钥值", "只显示状态，不回显"],
		]);
		expect(replaceButton().querySelectorAll("svg")).toHaveLength(1);
		// 模型分区在默认 Key 分区之前；两个分区内都没有 primary 按钮（RK2-08）。
		const models = screen.getByRole("region", { name: "模型与凭证" });
		expect(models.compareDocumentPosition(region)).toBe(
			Node.DOCUMENT_POSITION_FOLLOWING,
		);
		for (const area of [models, region])
			expect(area.querySelector(".bg-accent-ink")).toBeNull();
		expect(region.querySelector("input")).toBeNull();
		expect(screen.queryByRole("button", { name: "检查可用模型" })).toBeNull();
		for (const text of [
			"普通业务投影",
			"已有 Agent 默认 Relay Key 不回显",
			"撤销",
		])
			expect(document.body.textContent).not.toContain(text);
	});

	it("opens the replacement modal and requires a value (G-09)", async () => {
		const { actions } = renderKey();
		const dialog = await openKeyDialog();
		const input =
			within(dialog).getByLabelText<HTMLInputElement>("新的 Relay Key");
		await waitFor(() => expect(document.activeElement).toBe(input));
		expect(input.placeholder).toBe("仅本次提交使用，不会回显");
		expect(input.getAttribute("autocomplete")).toBe("new-password");
		expect(
			within(dialog)
				.getAllByRole("button")
				.map((button) => button.textContent),
		).toEqual(["", "取消", "校验并替换"]);
		fireEvent.click(within(dialog).getByRole("button", { name: "校验并替换" }));
		const error = within(dialog).getByRole("alert");
		expect(error.textContent).toBe("请输入默认 Relay Key。");
		expect(error.getAttribute("data-slot")).toBe("field-error");
		expect(actions.check).not.toHaveBeenCalled();
		fireEvent.keyDown(dialog, { key: "Escape" });
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		await waitFor(() => expect(document.activeElement).toBe(replaceButton()));
	});

	it("replaces a covering Key with a verifying state, a toast and the new version", async () => {
		let finish: (value: typeof keyState) => void = () => undefined;
		const replaceKey = vi.fn(
			() =>
				new Promise<typeof keyState>((resolve) => {
					finish = resolve;
				}),
		);
		const { actions, onSave } = renderKey({ replaceKey });
		const probe = "probe-relay-key";
		const dialog = await openKeyDialog();
		typeWriteOnly(within(dialog).getByLabelText("新的 Relay Key"), probe);
		expect(document.body.innerHTML).not.toContain(probe);
		fireEvent.click(within(dialog).getByRole("button", { name: "校验并替换" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(actions.check).toHaveBeenCalledExactlyOnceWith(probe);
		expect(replaceKey).toHaveBeenCalledExactlyOnceWith({
			keyValue: probe,
			configurationRevision: 7,
			expectedVersion: 3,
		});
		// 写入中：chip「校验中」与校验 notice，选择器保留但禁用（RK2-08）。
		expect(within(section()).getByText("校验中")).toBeTruthy();
		expect(within(section()).getByRole("status").textContent).toContain(
			"正在校验默认 Key",
		);
		const modelBox = screen.getByRole("checkbox", {
			name: "Relay · Internal · model-a",
		});
		expect(modelBox.hasAttribute("data-disabled")).toBe(true);
		expect(document.body.innerHTML).not.toContain(probe);
		await act(async () => finish({ ...keyState, keyVersion: 4 }));
		expect(within(section()).getByText("已设置")).toBeTruthy();
		expect(section().querySelector("dd")?.textContent).toBe("version 4");
		expect(toastText()).toBe("Agent 默认 Relay Key 已替换");
		await waitFor(() => expect(document.activeElement).toBe(replaceButton()));
		expect(onSave).not.toHaveBeenCalled();
		expect(document.body.innerHTML).not.toContain(probe);
	});

	it("asks for a new model selection when the new Key cannot call current models", async () => {
		const { actions, onSave } = renderKey({
			check: vi.fn(async () => ({
				schemaVersion: 1 as const,
				configurationRevision: 7,
				keyVersion: 3,
				candidates: [savedCandidates[1] as (typeof savedCandidates)[number]],
			})),
		});
		// 页面上先有未保存的修改。
		changeEnvironment("unsaved-edit");
		const dialog = await openKeyDialog();
		typeWriteOnly(within(dialog).getByLabelText("新的 Relay Key"), "new-key");
		fireEvent.click(within(dialog).getByRole("button", { name: "校验并替换" }));
		const notice = await within(dialog).findByText(
			"新的 Key 不能调用部分当前模型",
		);
		expect(notice.closest('[data-slot="alert"]')?.textContent).toContain(
			"Relay · Internal · model-a",
		);
		expect(actions.replaceKey).not.toHaveBeenCalled();
		fireEvent.click(
			within(dialog).getByRole("checkbox", {
				name: "Relay · Internal · model-b",
			}),
		);
		fireEvent.click(within(dialog).getByRole("button", { name: "校验并替换" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(actions.replaceKeyWithModels).toHaveBeenCalledOnce();
		const body = vi.mocked(actions.replaceKeyWithModels).mock.calls[0]?.[0] as
			| Record<string, unknown>
			| undefined;
		expect(Object.keys(body ?? {}).sort()).toEqual([
			"defaultRelayKey",
			"expectedConfigurationRevision",
			"expectedKeyVersion",
			"modelConfiguration",
			"schemaVersion",
		]);
		expect(body).toMatchObject({
			schemaVersion: 2,
			defaultRelayKey: "new-key",
			expectedConfigurationRevision: 7,
			expectedKeyVersion: 3,
		});
		expect(toastText()).toBe("Agent 默认 Relay Key 已替换");
		expect(onSave).not.toHaveBeenCalled();
		// 页面上的修改仍未保存。
		expect(screen.getByLabelText<HTMLInputElement>("值").value).toBe(
			"unsaved-edit",
		);
	});

	it("keeps the version and the user's picks after a failed replacement", async () => {
		renderKey({
			replaceKey: vi.fn(async () => {
				throw Object.assign(new Error("unavailable"), {
					retryable: true,
					status: 503,
				});
			}),
		});
		fireEvent.click(
			screen.getByRole("checkbox", { name: "Relay · Internal · model-b" }),
		);
		let dialog = await openKeyDialog();
		fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		dialog = await openKeyDialog();
		typeWriteOnly(within(dialog).getByLabelText("新的 Relay Key"), "new-key");
		fireEvent.click(within(dialog).getByRole("button", { name: "校验并替换" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		const alert = await within(section()).findByRole("alert");
		expect(alert.textContent).toContain("默认 Key 未替换");
		expect(within(section()).getByText("已设置")).toBeTruthy();
		expect(section().querySelector("dd")?.textContent).toBe("version 3");
		expect(document.body.textContent).not.toContain("配置未能保存");
		expect(
			screen
				.getByRole("checkbox", { name: "Relay · Internal · model-b" })
				.getAttribute("aria-checked"),
		).toBe("true");
	});
});

describe("saving an unchanged configuration (#2560)", () => {
	it("disables the save button and says why while nothing changed", () => {
		const { onSave } = renderScreen();
		expect(saveButton().hasAttribute("disabled")).toBe(true);
		const hint = screen.getByText("没有需要保存的变更。");
		expect(saveButton().getAttribute("aria-describedby")).toBe(hint.id);
		fireEvent.click(saveButton());
		expect(onSave).not.toHaveBeenCalled();
	});

	it("enables the save button for a real change and disables it again when the change is undone", () => {
		const { onSave } = renderScreen();
		changeEnvironment();
		expect(saveButton().hasAttribute("disabled")).toBe(false);
		expect(screen.queryByText("没有需要保存的变更。")).toBeNull();
		changeEnvironment("release");
		expect(saveButton().hasAttribute("disabled")).toBe(true);
		expect(screen.getByText("没有需要保存的变更。")).toBeTruthy();
		changeEnvironment();
		fireEvent.click(saveButton());
		expect(onSave).toHaveBeenCalledOnce();
	});

	it("does not offer the hint while a save is already running", () => {
		renderScreen({ submitting: true });
		expect(screen.queryByText("没有需要保存的变更。")).toBeNull();
	});
});
