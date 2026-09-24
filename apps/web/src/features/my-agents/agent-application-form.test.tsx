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

function choose(label: string, option: string) {
	fireEvent.click(screen.getByRole("combobox", { name: label }));
	fireEvent.click(screen.getByRole("option", { name: option }));
}

function check(label: string) {
	fireEvent.click(screen.getByRole("checkbox", { name: label }));
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
		expect(document.activeElement).toBe(
			screen.getByLabelText("共同 Owner 用户 ID"),
		);
		expect(onSubmit).not.toHaveBeenCalled();
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
		expect(onSubmit).not.toHaveBeenCalled();
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
