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
				onSave={vi.fn()}
				onUpgradeImage={vi.fn()}
				session={{ kind: "ready", session: ownerSession }}
				submitting={false}
			/>,
		);

		expect(screen.getByText("当前默认：Current model · high")).toBeTruthy();
		expect(screen.queryByLabelText("默认模型选项 ID")).toBeNull();
		fireEvent.click(screen.getByRole("checkbox", { name: "替换模型配置" }));
		expect(
			screen.getByLabelText<HTMLInputElement>("默认模型选项 ID").value,
		).toBe("");
		expect(screen.getByLabelText<HTMLInputElement>("默认推理强度").value).toBe(
			"",
		);
		expect(screen.getByLabelText<HTMLInputElement>("新模型凭证").value).toBe(
			"",
		);
	});

	it("lets an Owner submit configuration while clearing entered 新 Secret 值s", () => {
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
	it("allows model credential replacement without reading back the original value", () => {
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
		fireEvent.click(screen.getByRole("checkbox", { name: "替换模型配置" }));
		const credential = screen.getByLabelText<HTMLInputElement>("新模型凭证");
		expect(credential.value).toBe("");
		expect(credential.type).toBe("password");
		expect(credential.autocomplete).toBe("new-password");
		for (const [label, value] of [
			["选项 ID", "primary"],
			["端点 ID", "approved-endpoint"],
			["模型 ID", "release-model"],
			["可选推理强度", "high"],
			["默认模型选项 ID", "primary"],
			["默认推理强度", "high"],
			["新模型凭证", "replacement-value"],
		]) {
			fireEvent.change(screen.getByLabelText(label), { target: { value } });
		}
		fireEvent.click(screen.getByRole("button", { name: "校验并保存" }));
		expect(onSave).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				modelConfiguration: {
					options: [
						{
							optionId: "primary",
							endpointId: "approved-endpoint",
							modelId: "release-model",
							reasoningLevels: ["high"],
							credentialValue: "replacement-value",
						},
					],
					defaultOptionId: "primary",
					defaultReasoningLevel: "high",
				},
			}),
		);
		expect(credential.value).toBe("");
		expect(screen.queryByDisplayValue("replacement-value")).toBeNull();
	});

	it("places the supplied lifecycle controls in the configuration aside", () => {
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
		expect(controls.closest("aside")?.className).toBe("form-aside");
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
