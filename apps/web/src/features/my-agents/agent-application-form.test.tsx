import { AgentApplicationProjectionV2Schema } from "@agent-infra/contracts/pilot";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeploymentConfigurationProjectionV2 } from "../../pilot/generated-v2/types.gen.js";

import { AgentApplicationForm as AgentApplicationFormView } from "./agent-application-form.js";
import {
	deploymentConfiguration,
	pendingApplication,
} from "./test-fixtures.js";

afterEach(cleanup);

type FormTestProps<T> = T extends unknown
	? Omit<T, "deploymentConfiguration"> & {
			deploymentConfiguration?: DeploymentConfigurationProjectionV2;
		}
	: never;

function AgentApplicationForm(
	props: FormTestProps<Parameters<typeof AgentApplicationFormView>[0]>,
) {
	return (
		<AgentApplicationFormView
			deploymentConfiguration={deploymentConfiguration}
			{...props}
		/>
	);
}

function at<T>(items: readonly T[], index: number) {
	const item = items[index];
	if (item === undefined) throw new Error(`missing item at index ${index}`);
	return item;
}

function choose(label: string, option: string) {
	fireEvent.click(screen.getByRole("combobox", { name: label }));
	const item = screen.getByRole("option", { name: option });
	fireEvent.pointerDown(item);
	fireEvent.pointerUp(item);
	fireEvent.click(item);
}

function chooseAt(label: string, option: string, index: number) {
	fireEvent.click(at(screen.getAllByRole("combobox", { name: label }), index));
	const item = screen.getByRole("option", { name: option });
	fireEvent.pointerDown(item);
	fireEvent.pointerUp(item);
	fireEvent.click(item);
}

function check(label: string) {
	fireEvent.click(screen.getByRole("checkbox", { name: label }));
}

function checkAt(label: string, index: number) {
	fireEvent.click(at(screen.getAllByRole("checkbox", { name: label }), index));
}

describe("AgentApplicationForm", () => {
	it("shows required model fields for a standard-template application", () => {
		const onSubmit = vi.fn();
		render(
			<AgentApplicationForm
				mode="create"
				onSubmit={onSubmit}
				submitting={false}
			/>,
		);

		fireEvent.change(screen.getByLabelText("Agent 名称"), {
			target: { value: "Release assistant" },
		});
		fireEvent.change(screen.getByLabelText("用途说明"), {
			target: { value: "Helps the release team" },
		});
		choose("标准模板 ID", "Codex");
		expect(
			(screen.getByLabelText("模型凭证") as HTMLInputElement).required,
		).toBe(true);
		fireEvent.click(screen.getByRole("button", { name: "提交申请" }));

		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("does not submit an initial standard application without a model credential", () => {
		const onSubmit = vi.fn();
		render(
			<AgentApplicationForm
				mode="create"
				onSubmit={onSubmit}
				submitting={false}
			/>,
		);

		fireEvent.change(screen.getByLabelText("Agent 名称"), {
			target: { value: "Release assistant" },
		});
		fireEvent.change(screen.getByLabelText("用途说明"), {
			target: { value: "Helps the release team" },
		});
		choose("标准模板 ID", "Codex");
		choose("模型端点", "Primary endpoint");
		choose("模型", "gpt-5");
		check("medium");
		check("high");
		choose("默认模型", "Primary endpoint · gpt-5");
		choose("默认推理档位", "medium");
		fireEvent.click(screen.getByRole("button", { name: "提交申请" }));

		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("uses a rejected projection for explicit resubmission without replaying Secrets", () => {
		const onSubmit = vi.fn();
		const rejectedApplication = AgentApplicationProjectionV2Schema.parse({
			...pendingApplication,
			status: "rejected",
			decision: {
				decidedAt: "2026-09-04T00:00:00Z",
				reason: "Capacity is unavailable.",
			},
			configuration: {
				...pendingApplication.configuration,
				secrets: [{ name: "MODEL_API_KEY", isSet: true, version: 2 }],
			},
		});
		render(
			<AgentApplicationForm
				action="resubmit"
				application={rejectedApplication}
				mode="update"
				onSubmit={onSubmit}
				submitting={false}
			/>,
		);

		fireEvent.change(screen.getByLabelText("用途说明"), {
			target: { value: "Resubmitted after capacity review" },
		});
		fireEvent.click(screen.getByRole("button", { name: "修改并重新提交" }));

		expect(onSubmit).toHaveBeenCalledWith({
			schemaVersion: 2,
			name: pendingApplication.name,
			description: "Resubmitted after capacity review",
			source: pendingApplication.source,
			coOwnerIds: ["user-applicant-1"],
			availability: [],

			environment: [],
		});
		expect(screen.queryByDisplayValue("MODEL_API_KEY")).toBeNull();
		expect(screen.queryByText("MODEL_API_KEY")).toBeNull();
	});

	it("keeps the source fixed for an existing application", () => {
		const onSubmit = vi.fn();
		const customApplication = AgentApplicationProjectionV2Schema.parse({
			...pendingApplication,
			source: {
				kind: "custom",
				imageReference: "registry.example/agents/release:v1",
				interactionMode: "platform-adapter",
			},
			status: "rejected",
			decision: {
				decidedAt: "2026-09-04T00:00:00Z",
				reason: "Capacity is unavailable.",
			},
		});
		render(
			<AgentApplicationForm
				action="resubmit"
				application={customApplication}
				mode="update"
				onSubmit={onSubmit}
				submitting={false}
			/>,
		);

		expect(
			(
				screen.getByRole("combobox", {
					name: "Agent 来源",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
		expect(
			(screen.getByLabelText("镜像地址") as HTMLInputElement).disabled,
		).toBe(true);
		fireEvent.click(screen.getByRole("button", { name: "修改并重新提交" }));
		expect(onSubmit).toHaveBeenCalledWith(
			expect.objectContaining({ source: customApplication.source }),
		);
	});

	it("submits a custom self-managed source with its identity responsibility", async () => {
		const onSubmit = vi.fn();
		render(
			<AgentApplicationForm
				mode="create"
				onSubmit={onSubmit}
				submitting={false}
			/>,
		);

		fireEvent.change(screen.getByLabelText("Agent 名称"), {
			target: { value: "Release assistant" },
		});
		fireEvent.change(screen.getByLabelText("用途说明"), {
			target: { value: "Helps the release team" },
		});
		fireEvent.click(screen.getByRole("combobox", { name: "Agent 来源" }));
		const sourceOption = await screen.findByRole("option", {
			name: "自定义 Agent · 自有交互入口",
		});
		fireEvent.pointerDown(sourceOption, { pointerType: "mouse" });
		fireEvent.click(sourceOption, { detail: 1 });
		fireEvent.change(await screen.findByLabelText("镜像地址"), {
			target: { value: "registry.example/agents/release:v1" },
		});
		fireEvent.click(screen.getByRole("combobox", { name: "入口身份校验" }));
		const identityOption = await screen.findByRole("option", {
			name: "由自有入口校验",
		});
		fireEvent.pointerDown(identityOption, { pointerType: "mouse" });
		fireEvent.click(identityOption, { detail: 1 });
		fireEvent.click(screen.getByRole("button", { name: "提交申请" }));

		expect(onSubmit).toHaveBeenCalledWith(
			expect.objectContaining({
				source: {
					kind: "custom",
					imageReference: "registry.example/agents/release:v1",
					interactionMode: "self-managed",
					identityResponsibility: "self-managed",
				},
			}),
		);
	});

	it("keeps remaining duplicate environment errors after one name changes", async () => {
		const onSubmit = vi.fn();
		render(
			<AgentApplicationForm
				mode="create"
				onSubmit={onSubmit}
				submitting={false}
			/>,
		);

		fireEvent.change(screen.getByLabelText("Agent 名称"), {
			target: { value: "Release assistant" },
		});
		fireEvent.change(screen.getByLabelText("用途说明"), {
			target: { value: "Helps the release team" },
		});
		fireEvent.click(screen.getByRole("combobox", { name: "Agent 来源" }));
		const sourceOption = await screen.findByRole("option", {
			name: "自定义 Agent · 平台交互入口",
		});
		fireEvent.pointerDown(sourceOption, { pointerType: "mouse" });
		fireEvent.click(sourceOption, { detail: 1 });
		fireEvent.change(await screen.findByLabelText("镜像地址"), {
			target: { value: "registry.example/agents/release:v1" },
		});
		fireEvent.click(screen.getByRole("button", { name: "添加环境变量" }));
		fireEvent.click(screen.getByRole("button", { name: "添加环境变量" }));
		fireEvent.click(screen.getByRole("button", { name: "添加环境变量" }));
		const names = screen.getAllByLabelText("变量名称");
		const values = screen.getAllByLabelText("变量值");
		names.forEach((input) => {
			fireEvent.change(input, { target: { value: "A" } });
		});
		values.forEach((input) => {
			fireEvent.change(input, { target: { value: "value" } });
		});
		fireEvent.click(screen.getByRole("button", { name: "提交申请" }));
		expect(screen.getAllByText("名称不能重复。")).toHaveLength(3);

		const firstName = names[0];
		if (!firstName) throw new Error("environment name input missing");
		fireEvent.change(firstName, { target: { value: "B" } });
		expect(screen.getAllByText("名称不能重复。")).toHaveLength(2);
		const secondName = names[1];
		if (!secondName) throw new Error("second environment name input missing");
		fireEvent.change(secondName, { target: { value: "C" } });
		expect(screen.queryByText("名称不能重复。")).toBeNull();
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("clears Secret values when the template or Secret name changes", async () => {
		const onSubmit = vi.fn();
		const deploymentWithSecretTemplates = {
			...deploymentConfiguration,
			templates: [
				...deploymentConfiguration.templates,
				{
					templateId: "minimal",
					displayName: "Minimal",
					connectionEnabled: false,
					allowedEnvironmentKeys: [],
					allowedSecretKeys: ["OTHER_SECRET"],
				},
			],
		};
		render(
			<AgentApplicationForm
				deploymentConfiguration={deploymentWithSecretTemplates}
				mode="create"
				onSubmit={onSubmit}
				submitting={false}
			/>,
		);

		choose("标准模板 ID", "Codex");
		fireEvent.click(screen.getByRole("button", { name: "添加 Secret" }));
		choose("Secret 名称", "MODEL_API_KEY");
		fireEvent.change(screen.getByLabelText("替换值"), {
			target: { value: "old-secret" },
		});
		choose("标准模板 ID", "Minimal");
		await waitFor(() =>
			expect((screen.getByLabelText("替换值") as HTMLInputElement).value).toBe(
				"",
			),
		);
		choose("Secret 名称", "OTHER_SECRET");
		expect((screen.getByLabelText("替换值") as HTMLInputElement).value).toBe(
			"",
		);
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("recomputes duplicate model errors after a selection changes", async () => {
		const onSubmit = vi.fn();
		const deploymentWithSecondaryModel = {
			...deploymentConfiguration,
			modelCatalog: {
				...deploymentConfiguration.modelCatalog,
				endpoints: [
					...deploymentConfiguration.modelCatalog.endpoints,
					{
						endpointId: "endpoint-secondary",
						displayName: "Secondary endpoint",
						models: [{ modelId: "claude-3", reasoningLevels: ["medium"] }],
					},
				],
			},
		};
		render(
			<AgentApplicationForm
				deploymentConfiguration={deploymentWithSecondaryModel}
				mode="create"
				onSubmit={onSubmit}
				submitting={false}
			/>,
		);

		fireEvent.change(screen.getByLabelText("Agent 名称"), {
			target: { value: "Release assistant" },
		});
		fireEvent.change(screen.getByLabelText("用途说明"), {
			target: { value: "Helps the release team" },
		});
		choose("标准模板 ID", "Codex");
		chooseAt("模型端点", "Primary endpoint", 0);
		chooseAt("模型", "gpt-5", 0);
		checkAt("medium", 0);
		fireEvent.change(at(screen.getAllByLabelText("模型凭证"), 0), {
			target: { value: "credential-one" },
		});
		fireEvent.click(screen.getByRole("button", { name: "添加模型选项" }));
		chooseAt("模型端点", "Primary endpoint", 1);
		chooseAt("模型", "gpt-5", 1);
		checkAt("medium", 1);
		fireEvent.change(at(screen.getAllByLabelText("模型凭证"), 1), {
			target: { value: "credential-two" },
		});
		fireEvent.click(screen.getByRole("button", { name: "提交申请" }));
		expect(screen.getAllByText("模型选项不能重复。")).toHaveLength(2);

		chooseAt("模型端点", "Secondary endpoint", 0);
		await waitFor(() =>
			expect(screen.queryAllByText("模型选项不能重复。")).toHaveLength(0),
		);
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("submits the writable application configuration entered by the employee", () => {
		const onSubmit = vi.fn();
		render(
			<AgentApplicationForm
				mode="create"
				onSubmit={onSubmit}
				submitting={false}
			/>,
		);

		fireEvent.change(screen.getByLabelText("Agent 名称"), {
			target: { value: "Release assistant" },
		});
		fireEvent.change(screen.getByLabelText("用途说明"), {
			target: { value: "Helps the release team" },
		});
		choose("标准模板 ID", "Codex");
		fireEvent.change(screen.getByLabelText("共同 Owner 用户 ID"), {
			target: { value: "owner-2\nowner-3" },
		});
		fireEvent.change(screen.getByLabelText("可使用的用户 ID"), {
			target: { value: "user-available" },
		});
		fireEvent.change(screen.getByLabelText("可使用的组织 ID"), {
			target: { value: "organization-available" },
		});
		expect(screen.queryByRole("button", { name: "Add action" })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "添加环境变量" }));
		choose("变量名称", "LOG_LEVEL");
		fireEvent.change(screen.getByLabelText("变量值"), {
			target: { value: "debug" },
		});
		fireEvent.click(screen.getByRole("button", { name: "添加 Secret" }));
		choose("Secret 名称", "MODEL_API_KEY");
		fireEvent.change(screen.getByLabelText("替换值"), {
			target: { value: "never-echo" },
		});
		choose("模型端点", "Primary endpoint");
		choose("模型", "gpt-5");
		check("medium");
		check("high");
		fireEvent.change(screen.getByLabelText("模型凭证"), {
			target: { value: "never-echo-model" },
		});
		choose("默认模型", "Primary endpoint · gpt-5");
		choose("默认推理档位", "medium");
		fireEvent.click(screen.getByRole("button", { name: "提交申请" }));

		expect(onSubmit).toHaveBeenCalledWith({
			schemaVersion: 2,
			name: "Release assistant",
			description: "Helps the release team",
			source: { kind: "standard", templateId: "codex" },
			coOwnerIds: ["owner-2", "owner-3"],
			availability: [
				{ kind: "user", userId: "user-available" },
				{ kind: "organization", organizationId: "organization-available" },
			],

			environment: [{ name: "LOG_LEVEL", value: "debug" }],
			secrets: [{ name: "MODEL_API_KEY", value: "never-echo" }],
			modelConfiguration: {
				options: [
					{
						optionId: "endpoint-primary:gpt-5",
						endpointId: "endpoint-primary",
						modelId: "gpt-5",
						reasoningLevels: ["medium", "high"],
						credentialValue: "never-echo-model",
					},
				],
				defaultOptionId: "endpoint-primary:gpt-5",
				defaultReasoningLevel: "medium",
			},
		});
	});

	it("keeps model option IDs unique when IDs contain the separator", () => {
		const onSubmit = vi.fn();
		const colonConfiguration = {
			...deploymentConfiguration,
			modelCatalog: {
				...deploymentConfiguration.modelCatalog,
				endpoints: [
					{
						endpointId: "endpoint%3Aprimary",
						displayName: "Colon endpoint",
						models: [{ modelId: "model:primary", reasoningLevels: ["medium"] }],
					},
				],
			},
		};
		render(
			<AgentApplicationForm
				deploymentConfiguration={colonConfiguration}
				mode="create"
				onSubmit={onSubmit}
				submitting={false}
			/>,
		);

		fireEvent.change(screen.getByLabelText("Agent 名称"), {
			target: { value: "Release assistant" },
		});
		fireEvent.change(screen.getByLabelText("用途说明"), {
			target: { value: "Helps the release team" },
		});
		choose("标准模板 ID", "Codex");
		choose("模型端点", "Colon endpoint");
		choose("模型", "model:primary");
		check("medium");
		fireEvent.change(screen.getByLabelText("模型凭证"), {
			target: { value: "never-echo-model" },
		});
		choose("默认模型", "Colon endpoint · model:primary");
		choose("默认推理档位", "medium");
		fireEvent.click(screen.getByRole("button", { name: "提交申请" }));

		expect(onSubmit).toHaveBeenCalledWith(
			expect.objectContaining({
				modelConfiguration: expect.objectContaining({
					options: [
						expect.objectContaining({
							optionId: "endpoint%253Aprimary:model%3Aprimary",
						}),
					],
					defaultOptionId: "endpoint%253Aprimary:model%3Aprimary",
				}),
			}),
		);
	});

	it("does not submit a partially completed configuration row", () => {
		const onSubmit = vi.fn();
		render(
			<AgentApplicationForm
				mode="create"
				onSubmit={onSubmit}
				submitting={false}
			/>,
		);

		fireEvent.change(screen.getByLabelText("Agent 名称"), {
			target: { value: "Release assistant" },
		});
		fireEvent.change(screen.getByLabelText("用途说明"), {
			target: { value: "Helps the release team" },
		});
		choose("标准模板 ID", "Codex");
		fireEvent.click(screen.getByRole("button", { name: "添加环境变量" }));
		choose("变量名称", "LOG_LEVEL");
		expect((screen.getByLabelText("变量值") as HTMLInputElement).required).toBe(
			true,
		);
		fireEvent.click(screen.getByRole("button", { name: "提交申请" }));

		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("blocks an empty deployment catalog with a recoverable message", () => {
		const onSubmit = vi.fn();
		render(
			<AgentApplicationForm
				deploymentConfiguration={{
					...deploymentConfiguration,
					status: "empty",
					templates: [],
					modelCatalog: {
						...deploymentConfiguration.modelCatalog,
						status: "empty",
						endpoints: [],
					},
				}}
				mode="create"
				onSubmit={onSubmit}
				submitting={false}
			/>,
		);

		expect(screen.getByRole("status").textContent).toContain(
			"没有可用的标准模板",
		);
		expect(
			screen.getByRole("combobox", { name: "标准模板 ID" }),
		).toHaveProperty("disabled", true);
		fireEvent.click(screen.getByRole("button", { name: "提交申请" }));
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("shows duplicate owner IDs and focuses the first invalid field", () => {
		const onSubmit = vi.fn();
		render(
			<AgentApplicationForm
				mode="create"
				onSubmit={onSubmit}
				submitting={false}
			/>,
		);
		fireEvent.change(screen.getByLabelText("Agent 名称"), {
			target: { value: "Release assistant" },
		});
		fireEvent.change(screen.getByLabelText("用途说明"), {
			target: { value: "Helps the release team" },
		});
		choose("标准模板 ID", "Codex");
		fireEvent.change(screen.getByLabelText("共同 Owner 用户 ID"), {
			target: { value: "owner-1\nowner-1" },
		});
		const form = screen
			.getByRole("button", { name: "提交申请" })
			.closest("form");
		if (!form) throw new Error("application form missing");
		fireEvent.submit(form);

		expect(screen.getByText("共同 Owner 用户 ID不能重复。")).toBeTruthy();
		expect(
			screen.getByLabelText("共同 Owner 用户 ID").getAttribute("aria-invalid"),
		).toBe("true");
		expect(
			screen
				.getByLabelText("共同 Owner 用户 ID")
				.getAttribute("aria-describedby"),
		).toBe("application-access-help application-co-owner-ids-error");
		expect(document.activeElement).toBe(
			screen.getByLabelText("共同 Owner 用户 ID"),
		);
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("uses custom validation before native required checks and clears fixed errors", () => {
		const onSubmit = vi.fn();
		render(
			<AgentApplicationForm
				mode="create"
				onSubmit={onSubmit}
				submitting={false}
			/>,
		);

		const form = screen
			.getByRole("button", { name: "提交申请" })
			.closest("form");
		if (!form) throw new Error("application form missing");
		expect(form).toHaveProperty("noValidate", true);
		fireEvent.submit(form);
		expect(
			screen.getByLabelText("Agent 名称").getAttribute("aria-invalid"),
		).toBe("true");

		fireEvent.change(screen.getByLabelText("Agent 名称"), {
			target: { value: "Release assistant" },
		});
		expect(
			screen.getByLabelText("Agent 名称").getAttribute("aria-invalid"),
		).toBeNull();
		const description = screen.getByLabelText("用途说明");
		description.focus();
		fireEvent.change(description, { target: { value: "Updated purpose" } });
		expect(document.activeElement).toBe(description);
	});

	it("does not steal focus during edits and refocuses repeated invalid submissions", () => {
		const onSubmit = vi.fn();
		render(
			<AgentApplicationForm
				mode="create"
				onSubmit={onSubmit}
				submitting={false}
			/>,
		);

		const form = screen
			.getByRole("button", { name: "提交申请" })
			.closest("form");
		if (!form) throw new Error("application form missing");
		fireEvent.submit(form);
		const name = screen.getByLabelText("Agent 名称");
		expect(document.activeElement).toBe(name);

		const description = screen.getByLabelText("用途说明");
		description.focus();
		fireEvent.change(description, { target: { value: "Updated purpose" } });
		expect(document.activeElement).toBe(description);

		fireEvent.submit(form);
		expect(document.activeElement).toBe(name);
	});

	it("restores an edit endpoint from its persisted option ID after deployment loading", async () => {
		const application = AgentApplicationProjectionV2Schema.parse({
			...pendingApplication,
			configuration: {
				...pendingApplication.configuration,
				modelOptions: [
					{
						optionId: "endpoint-secondary:gpt-5",
						displayName: "Secondary model",
						modelId: "gpt-5",
						reasoningLevels: ["medium"],
					},
				],
				defaultModelOptionId: "endpoint-secondary:gpt-5",
				defaultReasoningLevel: "medium",
			},
		});
		const initiallyUnavailable = {
			...deploymentConfiguration,
			modelCatalog: { ...deploymentConfiguration.modelCatalog, endpoints: [] },
		};
		const loadedDeployment = {
			...deploymentConfiguration,
			modelCatalog: {
				...deploymentConfiguration.modelCatalog,
				endpoints: [
					...deploymentConfiguration.modelCatalog.endpoints,
					{
						endpointId: "endpoint-secondary",
						displayName: "Secondary endpoint",
						models: [{ modelId: "gpt-5", reasoningLevels: ["medium"] }],
					},
				],
			},
		};
		const { rerender } = render(
			<AgentApplicationForm
				application={application}
				action="edit"
				deploymentConfiguration={initiallyUnavailable}
				mode="update"
				onSubmit={vi.fn()}
				submitting={false}
			/>,
		);
		fireEvent.click(screen.getByRole("checkbox", { name: "修改模型配置" }));
		rerender(
			<AgentApplicationForm
				application={application}
				action="edit"
				deploymentConfiguration={loadedDeployment}
				mode="update"
				onSubmit={vi.fn()}
				submitting={false}
			/>,
		);

		await waitFor(() =>
			expect(
				screen.getByRole("combobox", { name: "模型端点" }).textContent,
			).toContain("Secondary endpoint"),
		);
	});

	it("restores a legacy option endpoint when the model match is unique", () => {
		const application = AgentApplicationProjectionV2Schema.parse({
			...pendingApplication,
			configuration: {
				...pendingApplication.configuration,
				modelOptions: [
					{
						optionId: "legacy-model",
						displayName: "Primary model",
						modelId: "gpt-5",
						reasoningLevels: ["medium"],
					},
				],
				defaultModelOptionId: "legacy-model",
				defaultReasoningLevel: "medium",
			},
		});
		render(
			<AgentApplicationForm
				application={application}
				action="edit"
				mode="update"
				onSubmit={vi.fn()}
				submitting={false}
			/>,
		);
		fireEvent.click(screen.getByRole("checkbox", { name: "修改模型配置" }));
		expect(
			screen.getByRole("combobox", { name: "模型端点" }).textContent,
		).toContain("Primary endpoint");
	});

	it("marks a persisted model with an unmapped endpoint as stale", () => {
		const application = AgentApplicationProjectionV2Schema.parse({
			...pendingApplication,
			configuration: {
				...pendingApplication.configuration,
				modelOptions: [
					{
						optionId: "legacy-model",
						displayName: "Legacy model",
						modelId: "gpt-5",
						reasoningLevels: ["medium"],
					},
				],
				defaultModelOptionId: "legacy-model",
				defaultReasoningLevel: "medium",
			},
		});
		const onSubmit = vi.fn();
		render(
			<AgentApplicationForm
				application={application}
				action="edit"
				deploymentConfiguration={{
					...deploymentConfiguration,
					modelCatalog: {
						...deploymentConfiguration.modelCatalog,
						endpoints: [
							...deploymentConfiguration.modelCatalog.endpoints,
							{
								endpointId: "endpoint-secondary",
								displayName: "Secondary endpoint",
								models: [{ modelId: "gpt-5", reasoningLevels: ["medium"] }],
							},
						],
					},
				}}
				mode="update"
				onSubmit={onSubmit}
				submitting={false}
			/>,
		);

		fireEvent.click(screen.getByRole("checkbox", { name: "修改模型配置" }));
		fireEvent.click(screen.getByRole("button", { name: "修改申请" }));
		expect(screen.getByText("模型选项已移除，请重新选择。")).toBeTruthy();
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("drops reasoning levels removed from the loaded catalog", () => {
		const application = AgentApplicationProjectionV2Schema.parse({
			...pendingApplication,
			configuration: {
				...pendingApplication.configuration,
				modelOptions: [
					{
						optionId: "endpoint-primary:gpt-5",
						displayName: "Primary model",
						modelId: "gpt-5",
						reasoningLevels: ["medium", "removed"],
					},
				],
				defaultModelOptionId: "endpoint-primary:gpt-5",
				defaultReasoningLevel: "medium",
			},
		});
		const onSubmit = vi.fn();
		render(
			<AgentApplicationForm
				application={application}
				action="edit"
				mode="update"
				onSubmit={onSubmit}
				submitting={false}
			/>,
		);
		fireEvent.click(screen.getByRole("checkbox", { name: "修改模型配置" }));
		fireEvent.click(screen.getByRole("button", { name: "修改申请" }));
		expect(onSubmit).toHaveBeenCalled();
	});

	it("dismisses a server model error after the selection changes", () => {
		const onSubmit = vi.fn();
		render(
			<AgentApplicationForm
				mode="create"
				onSubmit={onSubmit}
				serverError={{ code: "MODEL_SELECTION_INVALID" }}
				submitting={false}
			/>,
		);
		expect(screen.getByLabelText("默认模型").getAttribute("aria-invalid")).toBe(
			"true",
		);
		choose("模型端点", "Primary endpoint");
		expect(
			screen.getByLabelText("默认模型").getAttribute("aria-invalid"),
		).toBeNull();
	});

	it("keeps a server model error after credential or reasoning changes", () => {
		const application = AgentApplicationProjectionV2Schema.parse({
			...pendingApplication,
			configuration: {
				...pendingApplication.configuration,
				modelOptions: [
					{
						optionId: "endpoint-primary:gpt-5",
						displayName: "Primary model",
						modelId: "gpt-5",
						reasoningLevels: ["medium", "high"],
					},
				],
				defaultModelOptionId: "endpoint-primary:gpt-5",
				defaultReasoningLevel: "medium",
			},
		});
		render(
			<AgentApplicationForm
				application={application}
				action="edit"
				mode="update"
				onSubmit={vi.fn()}
				serverError={{ code: "MODEL_SELECTION_INVALID" }}
				submitting={false}
			/>,
		);
		fireEvent.click(screen.getByRole("checkbox", { name: "修改模型配置" }));
		const defaultModel = screen.getByLabelText("默认模型");
		expect(defaultModel.getAttribute("aria-invalid")).toBe("true");
		fireEvent.change(screen.getByLabelText("模型凭证"), {
			target: { value: "replacement-secret" },
		});
		expect(defaultModel.getAttribute("aria-invalid")).toBe("true");
		choose("默认推理档位", "high");
		expect(defaultModel.getAttribute("aria-invalid")).toBe("true");
		check("high");
		expect(defaultModel.getAttribute("aria-invalid")).toBe("true");
	});

	it("limits default reasoning choices to the selected model levels", () => {
		const application = AgentApplicationProjectionV2Schema.parse({
			...pendingApplication,
			configuration: {
				...pendingApplication.configuration,
				modelOptions: [
					{
						optionId: "endpoint-primary:gpt-5",
						displayName: "Primary model",
						modelId: "gpt-5",
						reasoningLevels: ["medium"],
					},
				],
				defaultModelOptionId: "endpoint-primary:gpt-5",
				defaultReasoningLevel: "medium",
			},
		});
		render(
			<AgentApplicationForm
				application={application}
				action="edit"
				mode="update"
				onSubmit={vi.fn()}
				submitting={false}
			/>,
		);

		fireEvent.click(screen.getByRole("checkbox", { name: "修改模型配置" }));
		fireEvent.click(screen.getByRole("combobox", { name: "默认推理档位" }));
		expect(screen.getByRole("option", { name: "medium" })).toBeTruthy();
		expect(screen.queryByRole("option", { name: "high" })).toBeNull();
	});

	it("associates missing reasoning levels with the checkbox group", () => {
		const onSubmit = vi.fn();
		render(
			<AgentApplicationForm
				mode="create"
				onSubmit={onSubmit}
				submitting={false}
			/>,
		);
		fireEvent.change(screen.getByLabelText("Agent 名称"), {
			target: { value: "Release assistant" },
		});
		fireEvent.change(screen.getByLabelText("用途说明"), {
			target: { value: "Helps the release team" },
		});
		choose("标准模板 ID", "Codex");
		choose("模型端点", "Primary endpoint");
		choose("模型", "gpt-5");
		fireEvent.click(screen.getByRole("button", { name: "提交申请" }));

		const group = screen.getByRole("group", { name: "允许的推理档位" });
		expect(group.getAttribute("aria-invalid")).toBe("true");
		expect(screen.getByText("至少选择一个推理档位。")).toBeTruthy();
		expect(screen.queryByText("模型选项已移除，请重新选择。")).toBeNull();
		expect(document.activeElement).toBe(group);
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("focuses deployment status when the template control is disabled", () => {
		const onSubmit = vi.fn();
		render(
			<AgentApplicationForm
				deploymentConfiguration={{
					...deploymentConfiguration,
					templates: [],
					modelCatalog: {
						...deploymentConfiguration.modelCatalog,
						status: "empty",
						endpoints: [],
					},
				}}
				mode="create"
				onSubmit={onSubmit}
				submitting={false}
			/>,
		);
		fireEvent.change(screen.getByLabelText("Agent 名称"), {
			target: { value: "Release assistant" },
		});
		fireEvent.change(screen.getByLabelText("用途说明"), {
			target: { value: "Helps the release team" },
		});
		fireEvent.click(screen.getByRole("button", { name: "提交申请" }));

		const status = screen.getByRole("status");
		expect(document.activeElement).toBe(status);
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("focuses the add-model action when no persisted model is available", () => {
		const onSubmit = vi.fn();
		render(
			<AgentApplicationForm
				application={pendingApplication}
				action="edit"
				deploymentConfiguration={{
					...deploymentConfiguration,
					modelCatalog: {
						...deploymentConfiguration.modelCatalog,
						endpoints: [],
					},
				}}
				mode="update"
				onSubmit={onSubmit}
				submitting={false}
			/>,
		);

		fireEvent.click(screen.getByRole("checkbox", { name: "修改模型配置" }));
		expect(
			(screen.getByLabelText("模型凭证") as HTMLInputElement).required,
		).toBe(true);
		fireEvent.click(screen.getByRole("button", { name: "修改申请" }));

		expect(document.activeElement).toBe(
			screen.getByRole("button", { name: "添加模型选项" }),
		);
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("focuses the default model field after a server model-selection rejection", () => {
		const onSubmit = vi.fn();
		render(
			<AgentApplicationForm
				mode="create"
				onSubmit={onSubmit}
				serverError={{ code: "MODEL_SELECTION_INVALID" }}
				submitting={false}
			/>,
		);

		expect(screen.getByLabelText("默认模型").getAttribute("aria-invalid")).toBe(
			"true",
		);
		expect(document.activeElement).toBe(screen.getByLabelText("默认模型"));
	});

	it("focuses the form for a server invalid-request error", () => {
		const onSubmit = vi.fn();
		render(
			<AgentApplicationForm
				mode="create"
				onSubmit={onSubmit}
				serverError={{ code: "INVALID_REQUEST" }}
				submitting={false}
			/>,
		);

		const form = document.querySelector("form");
		if (!form) throw new Error("application form missing");
		expect(
			screen.getByText("申请内容未通过服务端校验，请检查表单后重试。"),
		).toBeTruthy();
		expect(document.activeElement).toBe(form);
	});

	it("marks a removed existing template instead of submitting it", () => {
		const onSubmit = vi.fn();
		const application = AgentApplicationProjectionV2Schema.parse({
			...pendingApplication,
			source: { kind: "standard", templateId: "removed-template" },
			status: "rejected",
			decision: { decidedAt: "2026-09-04T00:00:00Z", reason: "Removed" },
		});
		render(
			<AgentApplicationForm
				application={application}
				action="resubmit"
				deploymentConfiguration={deploymentConfiguration}
				mode="update"
				onSubmit={onSubmit}
				submitting={false}
			/>,
		);

		expect(screen.getByRole("status").textContent).toContain("已移除");
		fireEvent.click(screen.getByRole("button", { name: "修改并重新提交" }));
		expect(
			screen
				.getByRole("combobox", { name: "标准模板 ID" })
				.getAttribute("aria-describedby"),
		).toBe("application-source-help application-template-id-error");
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("does not mark an unavailable saved template as removed", () => {
		const onSubmit = vi.fn();
		const application = AgentApplicationProjectionV2Schema.parse({
			...pendingApplication,
			status: "rejected",
			decision: {
				decidedAt: "2026-09-04T00:00:00Z",
				reason: "Unavailable",
			},
		});
		render(
			<AgentApplicationForm
				application={application}
				action="resubmit"
				deploymentConfiguration={{
					...deploymentConfiguration,
					status: "unavailable",
					templates: [],
					modelCatalog: {
						...deploymentConfiguration.modelCatalog,
						status: "unavailable",
						endpoints: [],
					},
				}}
				mode="update"
				onSubmit={onSubmit}
				submitting={false}
			/>,
		);

		expect(screen.getByRole("status").textContent).toContain("暂不可用");
		expect(screen.getByRole("status").textContent).not.toContain("已移除");
		fireEvent.click(screen.getByRole("button", { name: "修改并重新提交" }));
		expect(onSubmit).toHaveBeenCalledWith(
			expect.objectContaining({ source: application.source }),
		);
	});

	it("blocks an unavailable model catalog without duplicate submission", () => {
		const onSubmit = vi.fn();
		render(
			<AgentApplicationForm
				deploymentConfiguration={{
					...deploymentConfiguration,
					status: "unavailable",
					modelCatalog: {
						...deploymentConfiguration.modelCatalog,
						status: "unavailable",
					},
				}}
				mode="create"
				onSubmit={onSubmit}
				submitting={false}
			/>,
		);

		expect(screen.getByRole("status").textContent).toContain("暂不可用");
		fireEvent.click(screen.getByRole("button", { name: "提交申请" }));
		fireEvent.click(screen.getByRole("button", { name: "提交申请" }));
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("blocks a stale deployment projection before submitting choices", () => {
		const onSubmit = vi.fn();
		render(
			<AgentApplicationForm
				deploymentConfiguration={{
					...deploymentConfiguration,
					status: "stale",
				}}
				mode="create"
				onSubmit={onSubmit}
				submitting={false}
			/>,
		);

		fireEvent.change(screen.getByLabelText("Agent 名称"), {
			target: { value: "Release assistant" },
		});
		fireEvent.change(screen.getByLabelText("用途说明"), {
			target: { value: "Helps the release team" },
		});
		choose("标准模板 ID", "Codex");
		choose("模型端点", "Primary endpoint");
		choose("模型", "gpt-5");
		check("medium");
		fireEvent.change(screen.getByLabelText("模型凭证"), {
			target: { value: "never-echo-model" },
		});
		choose("默认模型", "Primary endpoint · gpt-5");
		choose("默认推理档位", "medium");
		fireEvent.click(screen.getByRole("button", { name: "提交申请" }));

		expect(screen.getByRole("status").textContent).toBe(
			"部署选项已过期，请重新加载后再提交。",
		);
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("keeps custom-image applications available when choices are unavailable", async () => {
		const onSubmit = vi.fn();
		render(
			<AgentApplicationForm
				deploymentConfiguration={{
					...deploymentConfiguration,
					status: "unavailable",
					templates: [],
					modelCatalog: {
						...deploymentConfiguration.modelCatalog,
						status: "unavailable",
						endpoints: [],
					},
				}}
				mode="create"
				onSubmit={onSubmit}
				submitting={false}
			/>,
		);

		fireEvent.change(screen.getByLabelText("Agent 名称"), {
			target: { value: "Custom assistant" },
		});
		fireEvent.change(screen.getByLabelText("用途说明"), {
			target: { value: "Runs a custom image" },
		});
		fireEvent.click(screen.getByRole("combobox", { name: "Agent 来源" }));
		const sourceOption = await screen.findByRole("option", {
			name: "自定义 Agent · 平台交互入口",
		});
		fireEvent.pointerDown(sourceOption, { pointerType: "mouse" });
		fireEvent.click(sourceOption, { detail: 1 });
		await waitFor(() => expect(screen.getByText("镜像地址")).toBeTruthy());
		fireEvent.change(screen.getByLabelText("镜像地址"), {
			target: { value: "registry.example/agents/custom:v1" },
		});
		fireEvent.click(screen.getByRole("button", { name: "提交申请" }));

		expect(onSubmit).toHaveBeenCalledWith(
			expect.objectContaining({
				source: {
					kind: "custom",
					imageReference: "registry.example/agents/custom:v1",
					interactionMode: "platform-adapter",
				},
			}),
		);
	});

	it("marks a stale deployment projection before submission", () => {
		const onSubmit = vi.fn();
		render(
			<AgentApplicationForm
				deploymentConfiguration={{
					...deploymentConfiguration,
					status: "stale",
					modelCatalog: {
						...deploymentConfiguration.modelCatalog,
						status: "stale",
					},
				}}
				mode="create"
				onSubmit={onSubmit}
				submitting={false}
			/>,
		);

		expect(screen.getByRole("status").textContent).toContain("过期");
		fireEvent.click(screen.getByRole("button", { name: "提交申请" }));
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("uses a new server projection when an edit form changes application", () => {
		const first = AgentApplicationProjectionV2Schema.parse({
			...pendingApplication,
			status: "rejected",
			decision: {
				decidedAt: "2026-09-04T00:00:00Z",
				reason: "Capacity is unavailable.",
			},
		});
		const second = AgentApplicationProjectionV2Schema.parse({
			...first,
			applicationId: "application-other",
			name: "Other release assistant",
		});
		const { rerender } = render(
			<AgentApplicationForm
				action="resubmit"
				application={first}
				key={first.applicationId}
				mode="update"
				onSubmit={vi.fn()}
				submitting={false}
			/>,
		);
		expect(
			(screen.getByLabelText("Agent 名称") as HTMLInputElement).value,
		).toBe("Release assistant request");

		rerender(
			<AgentApplicationForm
				action="resubmit"
				application={second}
				key={second.applicationId}
				mode="update"
				onSubmit={vi.fn()}
				submitting={false}
			/>,
		);
		expect(
			(screen.getByLabelText("Agent 名称") as HTMLInputElement).value,
		).toBe("Other release assistant");
	});
});
