import {
	AgentProjectionV2Schema,
	BrowserSessionProjectionV1Schema,
} from "@agent-infra/contracts/pilot";
import { pilotFakeScenariosV2 } from "@agent-infra/test-support/pilot";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentConfigurationScreen } from "./agent-configuration-screen.js";

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
const administratorSession = BrowserSessionProjectionV1Schema.parse({
	schemaVersion: 1,
	user: {
		userId: "user-admin-1",
		displayName: "Administrator",
		roles: ["employee", "system_admin"],
	},
});

afterEach(cleanup);

describe("AgentConfigurationScreen", () => {
	it("shows the current default model without prefilling a replacement draft", () => {
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
		render(
			<AgentConfigurationScreen
				agent={configuredAgent}
				deploymentModelCandidates={[
					{
						endpointId: "catalog",
						modelId: "other",
						reasoningLevels: ["low"],
					},
					{
						endpointId: "catalog",
						modelId: "current",
						reasoningLevels: ["low", "high"],
					},
				]}
				onSave={vi.fn()}
				onUpgradeImage={vi.fn()}
				session={{ kind: "ready", session: ownerSession }}
				submitting={false}
			/>,
		);

		expect(screen.getByText("当前默认：Current model · high")).toBeTruthy();
		expect(screen.queryByLabelText("默认模型选项 ID")).toBeNull();
		fireEvent.click(screen.getByRole("checkbox", { name: "替换模型配置" }));
		expect(screen.getByLabelText("默认模型")).toBeTruthy();
		expect(screen.getByLabelText("默认推理档位")).toBeTruthy();
	});

	it("lets an Owner submit configuration while clearing entered 新 Secret 值s", () => {
		const onSave = vi.fn();
		render(
			<AgentConfigurationScreen
				agent={agent}
				deploymentModelCandidates={[
					{
						endpointId: "approved-endpoint",
						modelId: "release-model",
						reasoningLevels: ["high"],
					},
				]}
				onSave={onSave}
				onUpgradeImage={vi.fn()}
				session={{ kind: "ready", session: ownerSession }}
				submitting={false}
			/>,
		);

		expect(screen.getByText("MODEL_API_KEY（已设置，版本 1）")).toBeTruthy();
		expect(screen.queryByText("test-secret-value")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "添加 Secret" }));
		fireEvent.change(screen.getByLabelText("Secret 名称"), {
			target: { value: "NEW_SECRET" },
		});
		fireEvent.change(screen.getByLabelText("新 Secret 值"), {
			target: { value: "test-secret-value" },
		});
		fireEvent.click(screen.getByRole("button", { name: "校验并保存" }));

		expect(onSave).toHaveBeenCalledWith(
			expect.objectContaining({
				schemaVersion: 2,
				secrets: [{ name: "NEW_SECRET", value: "test-secret-value" }],
			}),
		);
		expect(screen.queryByLabelText("新 Secret 值")).toBeNull();
	});

	it("replaces a configured Secret through a write-only dialog", () => {
		const onSave = vi.fn();
		render(
			<AgentConfigurationScreen
				agent={agent}
				onSave={onSave}
				onUpgradeImage={vi.fn()}
				session={{ kind: "ready", session: ownerSession }}
				submitting={false}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "替换 Secret" }));
		expect(screen.getByRole("dialog", { name: "替换 Secret" })).toBeTruthy();
		fireEvent.change(screen.getByLabelText("新 Secret 值"), {
			target: { value: "replacement-value" },
		});
		fireEvent.click(screen.getByRole("button", { name: "保存替换" }));
		expect(screen.queryByRole("dialog", { name: "替换 Secret" })).toBeNull();
		expect(onSave).toHaveBeenCalledWith(
			expect.objectContaining({
				secrets: [{ name: "MODEL_API_KEY", value: "replacement-value" }],
			}),
		);
		expect(screen.queryByText("replacement-value")).toBeNull();
	});

	it("does not render configuration data or controls for an ordinary-user projection", () => {
		render(
			<AgentConfigurationScreen
				agent={agent}
				onSave={vi.fn()}
				onUpgradeImage={vi.fn()}
				session={{ kind: "ready", session: ordinarySession }}
				submitting={false}
			/>,
		);

		expect(screen.getByRole("heading", { name: "配置不可用" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "校验并保存" })).toBeNull();
		expect(screen.queryByText("MODEL_API_KEY")).toBeNull();
	});

	it("explains the separate administrator view without exposing Owner fields", () => {
		render(
			<AgentConfigurationScreen
				agent={agent}
				onSave={vi.fn()}
				onUpgradeImage={vi.fn()}
				session={{ kind: "ready", session: administratorSession }}
				submitting={false}
			/>,
		);

		expect(
			screen.getByRole("heading", { name: "管理员管理视图" }),
		).toBeTruthy();
		expect(
			screen.getByText("此页仅提供管理员授权与生命周期操作。"),
		).toBeTruthy();
		expect(screen.queryByText("MODEL_API_KEY")).toBeNull();
	});

	it("uses a separate custom image upgrade command", () => {
		const onUpgradeImage = vi.fn();
		const customAgent = AgentProjectionV2Schema.parse({
			...agent,
			source: {
				kind: "custom",
				imageReference: "registry.example/agents/release:1",
				interactionMode: "platform-adapter",
			},
		});
		render(
			<AgentConfigurationScreen
				agent={customAgent}
				onSave={vi.fn()}
				onUpgradeImage={onUpgradeImage}
				session={{ kind: "ready", session: ownerSession }}
				submitting={false}
			/>,
		);

		fireEvent.change(screen.getByLabelText("新镜像引用"), {
			target: { value: "registry.example/agents/release:2" },
		});
		fireEvent.click(screen.getByRole("button", { name: "升级镜像" }));
		expect(onUpgradeImage).toHaveBeenCalledWith(
			"registry.example/agents/release:2",
		);
	});

	it("renders projected completion and opaque configuration errors", () => {
		const { rerender } = render(
			<AgentConfigurationScreen
				agent={agent}
				commandResult={{ ...agent, managementStatus: "creating" }}
				onSave={vi.fn()}
				onUpgradeImage={vi.fn()}
				session={{ kind: "ready", session: ownerSession }}
				submitting={false}
			/>,
		);

		expect(screen.getByRole("status").textContent).toBe("配置已提交：创建中。");

		rerender(
			<AgentConfigurationScreen
				agent={agent}
				commandError={Object.assign(new Error("private transport detail"), {
					retryable: false,
				})}
				onSave={vi.fn()}
				onUpgradeImage={vi.fn()}
				session={{ kind: "ready", session: ownerSession }}
				submitting={false}
			/>,
		);

		expect(screen.getByRole("alert").textContent).toBe(
			"权限或 Agent 状态已变化，请刷新页面。",
		);
		expect(screen.queryByText("private transport detail")).toBeNull();
	});

	it("focuses a completion only when it belongs to the displayed Agent", async () => {
		const commandResult = { ...agent, managementStatus: "creating" as const };
		const otherAgent = { ...agent, agentId: "agent-pilot-2" };
		const { rerender } = render(
			<AgentConfigurationScreen
				agent={otherAgent}
				commandResult={commandResult}
				onSave={vi.fn()}
				onUpgradeImage={vi.fn()}
				session={{ kind: "ready", session: ownerSession }}
				submitting={false}
			/>,
		);

		expect(screen.queryByRole("status")).toBeNull();

		rerender(
			<AgentConfigurationScreen
				agent={agent}
				commandResult={commandResult}
				onSave={vi.fn()}
				onUpgradeImage={vi.fn()}
				session={{ kind: "ready", session: ownerSession }}
				submitting={false}
			/>,
		);

		const status = screen.getByRole("status");
		await waitFor(() => expect(document.activeElement).toBe(status));
	});
	it("allows keyless model replacement without reading back credentials", () => {
		const onSave = vi.fn();
		render(
			<AgentConfigurationScreen
				agent={agent}
				deploymentModelCandidates={[
					{
						endpointId: "approved-endpoint",
						modelId: "release-model",
						reasoningLevels: ["high"],
					},
				]}
				onSave={onSave}
				onUpgradeImage={vi.fn()}
				session={{ kind: "ready", session: ownerSession }}
				submitting={false}
			/>,
		);
		fireEvent.click(screen.getByRole("checkbox", { name: "替换模型配置" }));
		fireEvent.click(
			screen.getByRole("checkbox", {
				name: "approved-endpoint · release-model",
			}),
		);
		fireEvent.click(screen.getByRole("button", { name: "校验并保存" }));
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
		expect(screen.queryByDisplayValue("replacement-value")).toBeNull();
	});

	it("does not render per-model credential fields", () => {
		render(
			<AgentConfigurationScreen
				agent={agent}
				onSave={vi.fn()}
				onUpgradeImage={vi.fn()}
				session={{ kind: "ready", session: ownerSession }}
				submitting={false}
			/>,
		);

		const replaceModels = screen.getByRole("checkbox", {
			name: "替换模型配置",
		});
		fireEvent.click(replaceModels);
		expect(screen.queryByLabelText("新模型凭证")).toBeNull();
	});

	it("previews and replaces the default Relay Key without echoing it", async () => {
		const onPreview = vi.fn().mockResolvedValue({
			schemaVersion: 1,
			configurationRevision: 3,
			candidates: [
				{
					endpointId: "endpoint-primary",
					modelId: "gpt-5",
					reasoningLevels: ["medium"],
				},
			],
		});
		const onReplace = vi.fn();
		render(
			<AgentConfigurationScreen
				agent={agent}
				onPreviewDefaultRelayKeyCandidates={onPreview}
				onReplaceDefaultRelayKey={onReplace}
				onSave={vi.fn()}
				onUpgradeImage={vi.fn()}
				session={{ kind: "ready", session: ownerSession }}
				submitting={false}
			/>,
		);

		const input = screen.getByLabelText<HTMLInputElement>(
			"替换 Agent 默认 Relay Key",
		);
		fireEvent.change(input, { target: { value: "private-relay-key" } });
		fireEvent.click(screen.getByRole("button", { name: "检查可用模型" }));
		await waitFor(() =>
			expect(onPreview).toHaveBeenCalledWith("private-relay-key"),
		);
		await waitFor(() =>
			expect(screen.getByText(/endpoint-primary · gpt-5/)).toBeTruthy(),
		);
		fireEvent.click(screen.getByRole("button", { name: "替换默认 Key" }));
		expect(onReplace).toHaveBeenCalledWith("private-relay-key");
		expect(input.value).toBe("");
		expect(screen.queryByText("private-relay-key")).toBeNull();
	});

	it("places lifecycle controls below the configuration form", () => {
		render(
			<AgentConfigurationScreen
				agent={agent}
				lifecycle={<section aria-label="生命周期">测试生命周期操作</section>}
				onSave={vi.fn()}
				onUpgradeImage={vi.fn()}
				session={{ kind: "ready", session: ownerSession }}
				submitting={false}
			/>,
		);
		const controls = screen.getByRole("region", { name: "生命周期" });
		expect(controls.closest(".lifecycle-panel")).not.toBeNull();
		expect(controls.closest(".form-layout")).not.toBeNull();
	});

	it.each(["pending", "disabled"] as const)(
		"prevents saving a configuration that is %s",
		(state) => {
			const onSave = vi.fn();
			render(
				<AgentConfigurationScreen
					agent={
						state === "disabled"
							? {
									...agent,
									managementStatus: "disabled",
									serviceAvailability: null,
								}
							: agent
					}
					onSave={onSave}
					onUpgradeImage={vi.fn()}
					session={{ kind: "ready", session: ownerSession }}
					submitting={state === "pending"}
				/>,
			);
			const button = screen.getByRole("button", {
				name: state === "pending" ? "校验并保存中…" : "校验并保存",
			});
			expect(button.getAttribute("disabled")).not.toBeNull();
			fireEvent.click(button);
			const form = button.closest("form");
			if (form) fireEvent.submit(form);
			expect(onSave).not.toHaveBeenCalled();
		},
	);
});

it("shows group visibility and the self-built application setup contract", () => {
	const onSave = vi.fn();
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json({ status: "not_configured" })),
	);
	render(
		<AgentConfigurationScreen
			agent={agent}
			onSave={onSave}
			onUpgradeImage={vi.fn()}
			session={{ kind: "ready", session: ownerSession }}
			submitting={false}
		/>,
	);
	expect(screen.getByText(/群消息和 Agent 回复对群成员可见/)).toBeTruthy();
	expect(screen.getByRole("region", { name: "自建应用配置" })).toBeTruthy();
	expect(screen.getByLabelText("企业 ID")).toBeTruthy();
	expect(screen.queryByLabelText("自建应用配置标识")).toBeNull();
});

/** 制造一次真实改动：新增一个 Secret（Owner 与范围没有变化时，保存按钮本来是禁用的，#2560）。 */
function addSecretChange() {
	fireEvent.click(screen.getByRole("button", { name: "添加 Secret" }));
	fireEvent.change(screen.getByLabelText("Secret 名称"), {
		target: { value: "CHANGED_SECRET" },
	});
	fireEvent.change(screen.getByLabelText("新 Secret 值"), {
		target: { value: "changed-secret-value" },
	});
}

describe("agents whose models are managed by the default Relay Key (#2421)", () => {
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
	const newKey = "SYNTHETIC_NEW_KEY_000000001";
	const candidates = {
		schemaVersion: 1 as const,
		configurationRevision: 7,
		keyVersion: 2,
		candidates: [
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
		],
	};
	function renderManaged(
		overrides: Partial<Parameters<typeof AgentConfigurationScreen>[0]> = {},
	) {
		const onSave = vi.fn();
		const preview = vi.fn().mockResolvedValue(candidates);
		render(
			<AgentConfigurationScreen
				agent={keyedAgent}
				defaultRelayKeyManaged
				onPreviewDefaultRelayKeyCandidates={preview}
				onReplaceDefaultRelayKey={vi.fn()}
				onSave={onSave}
				onUpgradeImage={vi.fn()}
				session={{ kind: "ready", session: ownerSession }}
				submitting={false}
				{...overrides}
			/>,
		);
		return { onSave, preview };
	}
	async function checkWithKey(key = newKey) {
		fireEvent.change(screen.getByPlaceholderText("输入新 Key"), {
			target: { value: key },
		});
		fireEvent.click(screen.getByRole("button", { name: "检查可用模型" }));
		await screen
			.findByRole("group", { name: /选择允许的模型/ })
			.catch(() => undefined);
		await screen.findByText("选择允许的模型");
	}

	it("replaces the free-text model fields with a candidate picker that starts from the current models", async () => {
		renderManaged();
		expect(screen.queryByRole("checkbox", { name: "替换模型配置" })).toBeNull();
		expect(screen.queryByText("选择允许的模型")).toBeNull();
		await checkWithKey();
		// 当前启用的 model-a 已预先勾选，档位与候选取交集；model-b 未勾选。
		expect(
			screen
				.getByRole<HTMLInputElement>("checkbox", {
					name: "relay · model-a",
				})
				.getAttribute("aria-checked"),
		).toBe("true");
		expect(
			screen
				.getByRole<HTMLInputElement>("checkbox", {
					name: "relay · model-b",
				})
				.getAttribute("aria-checked"),
		).toBe("false");
		expect(screen.getByLabelText<HTMLSelectElement>("默认模型").value).toBe(
			"relay:model-a",
		);
		expect(screen.getByLabelText<HTMLSelectElement>("默认推理档位").value).toBe(
			"medium",
		);
	});

	it("saves the Key, the versions seen at check time and the selected models in one request", async () => {
		const { onSave, preview } = renderManaged();
		await checkWithKey();
		expect(preview).toHaveBeenCalledWith(newKey);
		fireEvent.click(screen.getByRole("checkbox", { name: "relay · model-b" }));
		fireEvent.change(screen.getByLabelText("默认模型"), {
			target: { value: "relay:model-b" },
		});
		fireEvent.click(screen.getByRole("button", { name: "校验并保存" }));
		expect(onSave).toHaveBeenCalledTimes(1);
		const body = onSave.mock.calls[0]?.[0];
		expect(body).toMatchObject({
			schemaVersion: 2,
			defaultRelayKey: newKey,
			expectedConfigurationRevision: 7,
			expectedKeyVersion: 2,
		});
		// 请求里的推理档位按字典序，与服务端准入结果逐字一致。
		expect(body.modelConfiguration).toEqual({
			options: [
				{
					optionId: "relay:model-a",
					endpointId: "relay",
					modelId: "model-a",
					reasoningLevels: ["high", "medium"],
				},
				{
					optionId: "relay:model-b",
					endpointId: "relay",
					modelId: "model-b",
					reasoningLevels: ["low", "medium"],
				},
			],
			defaultOptionId: "relay:model-b",
			// 切换默认模型后沿用原来的默认档位（新模型同样支持 medium）。
			defaultReasoningLevel: "medium",
		});
		// Key 不留在页面里：输入框清空，候选选择消失。
		expect(
			screen.getByPlaceholderText<HTMLInputElement>("输入新 Key").value,
		).toBe("");
		expect(screen.queryByText("选择允许的模型")).toBeNull();
	});

	it("blocks the save instead of dropping a typed Key that was never checked", () => {
		const { onSave } = renderManaged();
		fireEvent.change(screen.getByPlaceholderText("输入新 Key"), {
			target: { value: newKey },
		});
		fireEvent.click(screen.getByRole("button", { name: "校验并保存" }));
		expect(onSave).not.toHaveBeenCalled();
		expect(
			screen.getByText(/已填写新 Key，但还没有可保存的模型选择/),
		).toBeTruthy();
		// 清空 Key 后可以正常保存其他修改。
		fireEvent.change(screen.getByPlaceholderText("输入新 Key"), {
			target: { value: "" },
		});
		expect(
			screen.queryByText(/已填写新 Key，但还没有可保存的模型选择/),
		).toBeNull();
		// 清空 Key 后没有任何改动：保存不可用，并说明原因（#2560）。
		expect(
			screen
				.getByRole("button", { name: "校验并保存" })
				.hasAttribute("disabled"),
		).toBe(true);
		expect(screen.getByText("没有需要保存的变更。")).toBeTruthy();
		addSecretChange();
		fireEvent.click(screen.getByRole("button", { name: "校验并保存" }));
		expect(onSave).toHaveBeenCalledTimes(1);
		expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty("defaultRelayKey");
	});

	it("drops the selection and the versions when the Key text changes after a check", async () => {
		const { onSave } = renderManaged();
		await checkWithKey();
		fireEvent.change(screen.getByPlaceholderText("输入新 Key"), {
			target: { value: `${newKey}-changed` },
		});
		expect(screen.queryByText("选择允许的模型")).toBeNull();
		// 旧的检查结果不能套在新 Key 上：保存被拦下，而不是带着旧版本提交。
		fireEvent.click(screen.getByRole("button", { name: "校验并保存" }));
		expect(onSave).not.toHaveBeenCalled();
		fireEvent.change(screen.getByPlaceholderText("输入新 Key"), {
			target: { value: "" },
		});
		addSecretChange();
		fireEvent.click(screen.getByRole("button", { name: "校验并保存" }));
		expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty("defaultRelayKey");
	});

	it("blocks the save while no model or no reasoning level is selected", async () => {
		const { onSave } = renderManaged();
		await checkWithKey();
		fireEvent.click(screen.getByRole("checkbox", { name: "relay · model-a" }));
		expect(screen.getByText("至少选择一个模型。")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "校验并保存" }));
		expect(onSave).not.toHaveBeenCalled();
		expect(
			screen.getByText(/已填写新 Key，但还没有可保存的模型选择/),
		).toBeTruthy();
		// 再选回一个模型后恢复，提示随之消失并带 Key 保存。
		fireEvent.click(screen.getByRole("checkbox", { name: "relay · model-a" }));
		expect(
			screen.queryByText(/已填写新 Key，但还没有可保存的模型选择/),
		).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "校验并保存" }));
		expect(onSave.mock.calls[0]?.[0]).toMatchObject({
			defaultRelayKey: newKey,
		});
	});

	it("blocks the save while the Key is still being checked", async () => {
		let resolve: (value: typeof candidates) => void = () => undefined;
		const pending = new Promise<typeof candidates>((r) => {
			resolve = r;
		});
		const { onSave } = renderManaged({
			onPreviewDefaultRelayKeyCandidates: vi.fn().mockReturnValue(pending),
		});
		fireEvent.change(screen.getByPlaceholderText("输入新 Key"), {
			target: { value: newKey },
		});
		fireEvent.click(screen.getByRole("button", { name: "检查可用模型" }));
		fireEvent.click(screen.getByRole("button", { name: "校验并保存" }));
		expect(onSave).not.toHaveBeenCalled();
		resolve(candidates);
		await screen.findByText("选择允许的模型");
	});

	it("ignores a late check response after the Key text changed", async () => {
		let resolveFirst: (value: typeof candidates) => void = () => undefined;
		const first = new Promise<typeof candidates>((r) => {
			resolveFirst = r;
		});
		const { onSave } = renderManaged({
			onPreviewDefaultRelayKeyCandidates: vi
				.fn()
				.mockReturnValueOnce(first)
				.mockResolvedValue({ ...candidates, keyVersion: 9 }),
		});
		fireEvent.change(screen.getByPlaceholderText("输入新 Key"), {
			target: { value: "SYNTHETIC_KEY_A_0000000001" },
		});
		fireEvent.click(screen.getByRole("button", { name: "检查可用模型" }));
		// 检查 A 还没返回，用户已改成 B。
		fireEvent.change(screen.getByPlaceholderText("输入新 Key"), {
			target: { value: "SYNTHETIC_KEY_B_0000000001" },
		});
		resolveFirst(candidates);
		await Promise.resolve();
		await Promise.resolve();
		// A 的候选和版本没有被套在 B 上。
		expect(screen.queryByText("选择允许的模型")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "校验并保存" }));
		expect(onSave).not.toHaveBeenCalled();
	});

	it("confirms a successful Key-only replacement with the new version", () => {
		renderManaged({
			relayKeyResult: {
				schemaVersion: 1,
				isSet: true,
				keyVersion: 3,
				configurationRevision: 7,
			},
		});
		expect(screen.getByRole("status").textContent).toContain(
			"默认 Key 已替换，当前版本 3。",
		);
	});

	it("keeps the V2 free-text fields for agents the default Key does not manage", () => {
		render(
			<AgentConfigurationScreen
				agent={keyedAgent}
				onPreviewDefaultRelayKeyCandidates={vi.fn()}
				onReplaceDefaultRelayKey={vi.fn()}
				onSave={vi.fn()}
				onUpgradeImage={vi.fn()}
				session={{ kind: "ready", session: ownerSession }}
				submitting={false}
			/>,
		);
		expect(screen.getByRole("checkbox", { name: "替换模型配置" })).toBeTruthy();
	});

	it("uses deployment catalog candidates instead of model ID text fields", () => {
		render(
			<AgentConfigurationScreen
				agent={keyedAgent}
				deploymentModelCandidates={[
					{
						endpointId: "catalog",
						modelId: "model-a",
						reasoningLevels: ["medium", "high"],
					},
				]}
				onPreviewDefaultRelayKeyCandidates={vi.fn()}
				onReplaceDefaultRelayKey={vi.fn()}
				onSave={vi.fn()}
				onUpgradeImage={vi.fn()}
				session={{ kind: "ready", session: ownerSession }}
				submitting={false}
			/>,
		);
		fireEvent.click(screen.getByRole("checkbox", { name: "替换模型配置" }));
		expect(screen.getAllByText("catalog · model-a").length).toBeGreaterThan(0);
		expect(screen.queryByLabelText("选项 ID")).toBeNull();
	});

	it("uses saved default-Key candidates without asking for Key material", async () => {
		const onSave = vi.fn();
		render(
			<AgentConfigurationScreen
				agent={keyedAgent}
				defaultRelayKeyManaged
				savedRelayKeyCandidates={candidates.candidates}
				savedRelayKeyConfigurationRevision={candidates.configurationRevision}
				savedRelayKeyVersion={candidates.keyVersion}
				onPreviewDefaultRelayKeyCandidates={vi.fn()}
				onReplaceDefaultRelayKey={vi.fn()}
				onSave={onSave}
				onUpgradeImage={vi.fn()}
				session={{ kind: "ready", session: ownerSession }}
				submitting={false}
			/>,
		);

		expect(screen.getByText("选择允许的模型")).toBeTruthy();
		expect(
			screen.getByPlaceholderText<HTMLInputElement>("输入新 Key").value,
		).toBe("");
		fireEvent.click(screen.getByRole("checkbox", { name: "relay · model-b" }));
		fireEvent.change(screen.getByLabelText("默认模型"), {
			target: { value: "relay:model-b" },
		});
		await waitFor(() =>
			expect(
				screen
					.getByRole("button", { name: "校验并保存" })
					.hasAttribute("disabled"),
			).toBe(false),
		);
		fireEvent.click(screen.getByRole("button", { name: "校验并保存" }));
		expect(onSave).toHaveBeenCalledWith(
			expect.objectContaining({
				schemaVersion: 4,
				expectedConfigurationRevision: candidates.configurationRevision,
				expectedKeyVersion: candidates.keyVersion,
				coOwnerIds: ["user-owner-1"],
				availability: [
					{ kind: "organization", organizationId: "org-platform" },
				],
				modelConfiguration: expect.objectContaining({
					defaultOptionId: "relay:model-b",
				}),
			}),
		);
		expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty("defaultRelayKey");
	});

	it("keeps saved-Key read failures actionable", () => {
		const onRetry = vi.fn();
		render(
			<AgentConfigurationScreen
				agent={keyedAgent}
				defaultRelayKeyManaged
				savedRelayKeyCandidatesError={new Error("opaque failure")}
				onRetrySavedRelayKeyCandidates={onRetry}
				onSave={vi.fn()}
				onUpgradeImage={vi.fn()}
				session={{ kind: "ready", session: ownerSession }}
				submitting={false}
			/>,
		);

		expect(
			screen.getByText("已保存的默认 Key 暂时无法读取可用模型。"),
		).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "重新读取可用模型" }));
		expect(onRetry).toHaveBeenCalledOnce();
		expect(screen.queryByText("opaque failure")).toBeNull();
	});
});

describe("saving an unchanged configuration (#2560)", () => {
	function renderPlain() {
		const onSave = vi.fn();
		render(
			<AgentConfigurationScreen
				agent={agent}
				onSave={onSave}
				onUpgradeImage={vi.fn()}
				session={{ kind: "ready", session: ownerSession }}
				submitting={false}
			/>,
		);
		return { onSave };
	}
	const saveButton = () => screen.getByRole("button", { name: "校验并保存" });

	it("disables the save button and says why while nothing changed", () => {
		const { onSave } = renderPlain();
		expect(saveButton().hasAttribute("disabled")).toBe(true);
		const hint = screen.getByText("没有需要保存的变更。");
		expect(saveButton().getAttribute("aria-describedby")).toBe(hint.id);
		fireEvent.click(saveButton());
		expect(onSave).not.toHaveBeenCalled();
	});

	it("enables the save button for a real change and disables it again when the change is undone", () => {
		const { onSave } = renderPlain();
		addSecretChange();
		expect(saveButton().hasAttribute("disabled")).toBe(false);
		expect(screen.queryByText("没有需要保存的变更。")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: /^移除.*Secret/ }));
		expect(saveButton().hasAttribute("disabled")).toBe(true);
		expect(screen.getByText("没有需要保存的变更。")).toBeTruthy();
		addSecretChange();
		fireEvent.click(saveButton());
		expect(onSave).toHaveBeenCalledOnce();
	});

	it("does not offer the hint while a save is already running", () => {
		render(
			<AgentConfigurationScreen
				agent={agent}
				onSave={vi.fn()}
				onUpgradeImage={vi.fn()}
				session={{ kind: "ready", session: ownerSession }}
				submitting
			/>,
		);
		expect(screen.queryByText("没有需要保存的变更。")).toBeNull();
	});
});
