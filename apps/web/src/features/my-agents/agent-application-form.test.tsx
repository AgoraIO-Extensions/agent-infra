import { AgentApplicationProjectionV2Schema } from "@agent-infra/contracts/pilot";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client as generatedClient } from "../../pilot/generated-v2/client.gen.js";
import type { DeploymentConfigurationProjectionV2 } from "../../pilot/generated-v2/types.gen.js";
import {
	directoryRequestUrl,
	directorySearchResponse,
} from "../directory-test-fixtures.js";
import { AgentApplicationForm as AgentApplicationFormView } from "./agent-application-form.js";
import {
	pendingApplication as basePendingApplication,
	deploymentConfiguration,
	pendingApplication,
} from "./test-fixtures.js";

beforeEach(() => {
	// 生成 Client 默认使用相对地址；jsdom 下的 Request 需要绝对地址。
	generatedClient.setConfig({ baseUrl: "https://platform.test" });
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

const digest = `sha256:${"a".repeat(64)}`;

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

function check(label: string) {
	fireEvent.click(screen.getByRole("checkbox", { name: label }));
}

function stubDirectorySearch() {
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async (input: string | URL | Request) =>
				new Response(
					JSON.stringify(
						directorySearchResponse(directoryRequestUrl(input), [
							{
								kind: "user",
								canonicalId: "owner-2",
								displayName: "Owner Two",
								email: "owner.two@example.test",
								organizationPath: "平台工程",
							},
							{
								kind: "user",
								canonicalId: "owner-3",
								displayName: "Owner Three",
								email: "owner.three@example.test",
								organizationPath: "研发基础设施",
							},
							{
								kind: "user",
								canonicalId: "user-available",
								displayName: "Available User",
								email: "available@example.test",
								organizationPath: "支持中心",
							},
							{
								kind: "organization",
								canonicalId: "organization-available",
								displayName: "Available Organization",
								organizationPath: "客户成功 / 支持中心",
							},
						]),
					),
					{ headers: { "Content-Type": "application/json" } },
				),
		),
	);
}

async function chooseDirectory(
	label: string,
	query: string,
	optionName: string,
) {
	const input = screen.getByRole("combobox", { name: label });
	fireEvent.change(input, { target: { value: query } });
	const field = input.closest<HTMLElement>(".directory-field");
	if (!field) throw new Error(`Directory field not found: ${label}`);
	let option: HTMLElement | undefined;
	await waitFor(() => {
		option = Array.from(
			field.querySelectorAll<HTMLElement>('[role="option"]'),
		).find((element) => element.textContent?.includes(optionName));
		if (!option) throw new Error(`Directory option not found: ${optionName}`);
	});
	if (!option) throw new Error(`Directory option not found: ${optionName}`);
	fireEvent.click(option);
}

function openAdvancedConfiguration() {
	const toggle = screen.queryByRole("button", { name: /高级配置/ });
	if (toggle?.getAttribute("aria-expanded") === "false")
		fireEvent.click(toggle);
}

describe("AgentApplicationForm", () => {
	it("accepts an inline multi-service YAML and shows its semantic summary", () => {
		const onSubmit = vi.fn();
		render(
			<AgentApplicationForm
				mode="create"
				onSubmit={onSubmit}
				submitting={false}
			/>,
		);
		fireEvent.change(screen.getByLabelText("Agent 名称"), {
			target: { value: "Payments" },
		});
		fireEvent.change(screen.getByLabelText("用途说明"), {
			target: { value: "Runs payment services" },
		});
		choose("Agent 来源", "多服务 Agent · 自有交互入口");
		const manifestField = document.getElementById(
			"application-multi-service-manifest",
		);
		if (!(manifestField instanceof HTMLTextAreaElement))
			throw new Error("multi-service manifest field not found");
		fireEvent.change(manifestField, {
			target: {
				value: `schemaVersion: 1
entryServiceName: api
resources:
  - apiVersion: apps/v1
    kind: Deployment
    metadata:
      name: api
      labels: {app: payments}
    spec:
      replicas: 1
      selector: {matchLabels: {app: payments}}
      template:
        metadata: {labels: {app: payments}}
        spec:
          containers: [{name: api, image: ${digest}, ports: [{name: http, port: 8080, targetPort: 8080}]}]
  - apiVersion: v1
    kind: Service
    metadata:
      name: api
      labels: {app: payments}
      annotations: {agent-infra.agora.io/entry: "true"}
    spec:
      type: ClusterIP
      selector: {app: payments}
      ports: [{name: http, port: 8080, targetPort: 8080}]
  - apiVersion: apps/v1
    kind: Deployment
    metadata:
      name: worker
      labels: {app: worker}
    spec:
      replicas: 1
      selector: {matchLabels: {app: worker}}
      template:
        metadata: {labels: {app: worker}}
        spec:
          containers: [{name: worker, image: ${digest}, ports: [{name: http, port: 8080, targetPort: 8080}]}]
  - apiVersion: v1
    kind: Service
    metadata:
      name: worker
      labels: {app: worker}
    spec:
      type: ClusterIP
      selector: {app: worker}
      ports: [{name: http, port: 8080, targetPort: 8080}]
`,
			},
		});
		expect(screen.getByRole("status").textContent).toContain("入口服务：api");
		fireEvent.click(screen.getByRole("button", { name: "提交审批" }));
		expect(onSubmit).toHaveBeenCalledWith(
			expect.objectContaining({
				source: expect.objectContaining({
					interactionMode: "self-managed",
					manifest: expect.stringContaining("entryServiceName: api"),
				}),
			}),
		);
	});

	it("keeps invalid multi-service YAML out of the submission", () => {
		const onSubmit = vi.fn();
		render(
			<AgentApplicationForm
				mode="create"
				onSubmit={onSubmit}
				submitting={false}
			/>,
		);
		fireEvent.change(screen.getByLabelText("Agent 名称"), {
			target: { value: "Payments" },
		});
		fireEvent.change(screen.getByLabelText("用途说明"), {
			target: { value: "Runs payment services" },
		});
		choose("Agent 来源", "多服务 Agent · 自有交互入口");
		const manifestField = document.getElementById(
			"application-multi-service-manifest",
		);
		if (!(manifestField instanceof HTMLTextAreaElement))
			throw new Error("multi-service manifest field not found");
		fireEvent.change(manifestField, {
			target: { value: "schemaVersion: 1\nresources: []" },
		});
		fireEvent.click(screen.getByRole("button", { name: "提交审批" }));
		expect(onSubmit).not.toHaveBeenCalled();
		expect(screen.getByText(/多服务 YAML 不符合/)).toBeTruthy();
	});

	// #3119：文本框与上方文件输入各有名称，占位符是三行示例而不是字面量 \n。
	it("names the multi-service YAML textarea apart from the file input with a three-line placeholder", () => {
		render(
			<AgentApplicationForm
				mode="create"
				onSubmit={vi.fn()}
				submitting={false}
			/>,
		);
		choose("Agent 来源", "多服务 Agent · 自有交互入口");
		const manifestField = screen.getByRole("textbox", {
			name: "多服务资源 YAML 内容",
		});
		expect(manifestField.id).toBe("application-multi-service-manifest");
		// 同页只有这一个控件使用该名称；文件输入保留「多服务资源 YAML」。
		expect(screen.getAllByLabelText("多服务资源 YAML 内容")).toEqual([
			manifestField,
		]);
		expect(screen.getByLabelText("多服务资源 YAML").id).toBe(
			"application-multi-service-file",
		);
		const placeholder = manifestField.getAttribute("placeholder") ?? "";
		expect(placeholder.split("\n")).toEqual([
			"schemaVersion: 1",
			"entryServiceName: api",
			"resources:",
		]);
		expect(placeholder).not.toContain("\\n");
	});

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
		choose("标准模板", "Codex");
		expect(
			(screen.getByLabelText("Agent 默认 Relay Key") as HTMLInputElement)
				.required,
		).toBe(true);
		fireEvent.click(screen.getByRole("button", { name: "提交审批" }));

		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("shows one selectable model when the catalog repeats its ID", () => {
		const endpoint = at(deploymentConfiguration.modelCatalog.endpoints, 0);
		render(
			<AgentApplicationForm
				deploymentConfiguration={{
					...deploymentConfiguration,
					modelCatalog: {
						...deploymentConfiguration.modelCatalog,
						endpoints: [
							{ ...endpoint, models: [...endpoint.models, ...endpoint.models] },
						],
					},
				}}
				mode="create"
				onSubmit={vi.fn()}
				submitting={false}
			/>,
		);

		choose("标准模板", "Codex");
		choose("模型端点：模型选项 1", "Primary endpoint");
		fireEvent.click(screen.getByRole("combobox", { name: "模型：模型选项 1" }));
		expect(screen.getAllByRole("option", { name: "gpt-5" })).toHaveLength(1);
	});

	it("does not submit an initial standard application without a default Relay Key", () => {
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
		choose("标准模板", "Codex");
		choose("模型端点：模型选项 1", "Primary endpoint");
		choose("模型：模型选项 1", "gpt-5");
		check("均衡：模型选项 1");
		check("高：模型选项 1");
		choose("默认模型", "Primary endpoint · gpt-5");
		choose("默认推理档位", "均衡");
		fireEvent.click(screen.getByRole("button", { name: "提交审批" }));

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
		expect(screen.queryByRole("combobox", { name: "入口身份校验" })).toBeNull();
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
		fireEvent.click(screen.getByRole("button", { name: "提交审批" }));

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

	// #3034：部署未提供平台身份入口时，服务端以 ACTION_UNAVAILABLE 拒绝「由平台校验」。
	it("explains a missing platform identity entry at the identity field and blocks resubmission until it changes", async () => {
		const onSubmit = vi.fn();
		render(
			<AgentApplicationForm
				mode="create"
				onSubmit={onSubmit}
				serverError={{ code: "ACTION_UNAVAILABLE" }}
				submitting={false}
			/>,
		);
		fireEvent.change(screen.getByLabelText("Agent 名称"), {
			target: { value: "Release assistant" },
		});
		fireEvent.change(screen.getByLabelText("用途说明"), {
			target: { value: "Helps the release team" },
		});
		// 标准模板不受影响：只有自有入口且选择由平台校验时才提示。
		expect(screen.queryByText(/当前部署未启用平台身份入口/)).toBeNull();
		fireEvent.click(screen.getByRole("combobox", { name: "Agent 来源" }));
		const sourceOption = await screen.findByRole("option", {
			name: "自定义 Agent · 自有交互入口",
		});
		fireEvent.pointerDown(sourceOption, { pointerType: "mouse" });
		fireEvent.click(sourceOption, { detail: 1 });
		fireEvent.change(await screen.findByLabelText("镜像地址"), {
			target: { value: "registry.example/agents/release:v1" },
		});
		const identity = screen.getByRole("combobox", { name: "入口身份校验" });
		expect(identity.textContent).toContain("由平台校验");
		expect(identity.getAttribute("aria-invalid")).toBe("true");
		const message = document.getElementById(
			identity.getAttribute("aria-describedby") ?? "",
		);
		expect(message?.textContent).toBe(
			"当前部署未启用平台身份入口，请改选「由自有入口校验」后再提交。",
		);
		fireEvent.click(screen.getByRole("button", { name: "提交审批" }));
		expect(onSubmit).not.toHaveBeenCalled();

		fireEvent.click(identity);
		const selfManaged = await screen.findByRole("option", {
			name: "由自有入口校验",
		});
		fireEvent.pointerDown(selfManaged, { pointerType: "mouse" });
		fireEvent.click(selfManaged, { detail: 1 });
		expect(identity.getAttribute("aria-invalid")).toBeNull();
		expect(screen.queryByText(/当前部署未启用平台身份入口/)).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "提交审批" }));
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

	it("points an existing platform identity application to a new application because its entry cannot change", () => {
		const onSubmit = vi.fn();
		const application = AgentApplicationProjectionV2Schema.parse({
			...pendingApplication,
			status: "rejected",
			decision: {
				decidedAt: "2026-09-02T00:00:00.000Z",
				reason: "请调整后重提",
			},
			source: {
				kind: "custom",
				imageReference: "registry.example/agents/release:v1",
				interactionMode: "self-managed",
				identityResponsibility: "platform-managed",
			},
			configuration: {
				...pendingApplication.configuration,
				modelOptions: [],
				defaultModelOptionId: null,
				defaultReasoningLevel: null,
			},
		});
		render(
			<AgentApplicationForm
				action="resubmit"
				application={application}
				mode="update"
				onSubmit={onSubmit}
				serverError={{ code: "ACTION_UNAVAILABLE" }}
				submitting={false}
			/>,
		);
		const identity = screen.getByRole("combobox", { name: "入口身份校验" });
		expect(identity.getAttribute("aria-invalid")).toBe("true");
		expect(
			document.getElementById(identity.getAttribute("aria-describedby") ?? "")
				?.textContent,
		).toBe(
			"当前部署未启用平台身份入口。已有申请不能更改入口身份校验，请新建申请并选择「由自有入口校验」。",
		);
		fireEvent.click(screen.getByRole("button", { name: "修改并重新提交" }));
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("recomputes duplicate environment errors after row removal and edits", async () => {
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
		openAdvancedConfiguration();
		fireEvent.click(screen.getByRole("button", { name: "添加环境变量" }));
		openAdvancedConfiguration();
		fireEvent.click(screen.getByRole("button", { name: "添加环境变量" }));
		openAdvancedConfiguration();
		fireEvent.click(screen.getByRole("button", { name: "添加环境变量" }));
		const names = screen.getAllByLabelText("变量名称");
		const values = screen.getAllByLabelText("变量值");
		names.forEach((input) => {
			fireEvent.change(input, { target: { value: "A" } });
		});
		values.forEach((input) => {
			fireEvent.change(input, { target: { value: "value" } });
		});
		const thirdName = names[2];
		if (!thirdName) throw new Error("third environment name input missing");
		fireEvent.change(thirdName, { target: { value: "B" } });
		fireEvent.click(screen.getByRole("button", { name: "提交审批" }));
		expect(screen.getAllByText("名称不能重复。")).toHaveLength(2);

		fireEvent.click(
			screen.getByRole("button", { name: "移除环境变量：环境变量 3" }),
		);
		expect(screen.getAllByText("名称不能重复。")).toHaveLength(2);

		const firstName = names[0];
		if (!firstName) throw new Error("environment name input missing");
		fireEvent.change(firstName, { target: { value: "B" } });
		expect(screen.queryByText("名称不能重复。")).toBeNull();
		const secondName = names[1];
		if (!secondName) throw new Error("second environment name input missing");
		fireEvent.change(secondName, { target: { value: "C" } });
		expect(screen.queryByText("名称不能重复。")).toBeNull();
		fireEvent.change(secondName, { target: { value: "D" } });
		expect((values[1] as HTMLInputElement).value).toBe("value");
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("recomputes duplicate Secret errors after row removal", () => {
		render(
			<AgentApplicationForm
				mode="create"
				onSubmit={vi.fn()}
				submitting={false}
			/>,
		);

		choose("标准模板", "Codex");
		openAdvancedConfiguration();
		fireEvent.click(screen.getByRole("button", { name: "添加 Secret" }));
		openAdvancedConfiguration();
		fireEvent.click(screen.getByRole("button", { name: "添加 Secret" }));
		choose("Secret 名称：Secret 1", "MODEL_API_KEY");
		choose("Secret 名称：Secret 2", "MODEL_API_KEY");
		fireEvent.change(at(screen.getAllByLabelText("替换值"), 0), {
			target: { value: "secret-one" },
		});
		fireEvent.change(at(screen.getAllByLabelText("替换值"), 1), {
			target: { value: "secret-two" },
		});
		fireEvent.click(screen.getByRole("button", { name: "提交审批" }));
		expect(screen.getAllByText("名称不能重复。")).toHaveLength(2);

		fireEvent.click(
			screen.getByRole("button", { name: "移除 Secret：Secret 2" }),
		);
		expect(screen.queryByText("名称不能重复。")).toBeNull();
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

		choose("标准模板", "Codex");
		openAdvancedConfiguration();
		fireEvent.click(screen.getByRole("button", { name: "添加 Secret" }));
		choose("Secret 名称：Secret 1", "MODEL_API_KEY");
		fireEvent.change(screen.getByLabelText("替换值"), {
			target: { value: "old-secret" },
		});
		choose("标准模板", "Minimal");
		await waitFor(() =>
			expect((screen.getByLabelText("替换值") as HTMLInputElement).value).toBe(
				"",
			),
		);
		choose("Secret 名称：Secret 1", "OTHER_SECRET");
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
		choose("标准模板", "Codex");
		choose("模型端点：模型选项 1", "Primary endpoint");
		choose("模型：模型选项 1", "gpt-5");
		check("均衡：模型选项 1");
		fireEvent.click(screen.getByRole("button", { name: "添加模型选项" }));
		choose("模型端点：模型选项 2", "Primary endpoint");
		choose("模型：模型选项 2", "gpt-5");
		check("均衡：模型选项 2");
		fireEvent.change(screen.getByLabelText("Agent 默认 Relay Key"), {
			target: { value: "agent-relay-key-value" },
		});
		fireEvent.click(screen.getByRole("button", { name: "提交审批" }));
		expect(screen.getAllByText("模型选项不能重复。")).toHaveLength(2);

		choose("模型端点：模型选项 1", "Secondary endpoint");
		await waitFor(() =>
			expect(screen.queryAllByText("模型选项不能重复。")).toHaveLength(0),
		);
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("recomputes duplicate model errors after row removal", () => {
		render(
			<AgentApplicationForm
				mode="create"
				onSubmit={vi.fn()}
				submitting={false}
			/>,
		);

		fireEvent.change(screen.getByLabelText("Agent 名称"), {
			target: { value: "Release assistant" },
		});
		fireEvent.change(screen.getByLabelText("用途说明"), {
			target: { value: "Helps the release team" },
		});
		choose("标准模板", "Codex");
		choose("模型端点：模型选项 1", "Primary endpoint");
		choose("模型：模型选项 1", "gpt-5");
		check("均衡：模型选项 1");
		fireEvent.click(screen.getByRole("button", { name: "添加模型选项" }));
		choose("模型端点：模型选项 2", "Primary endpoint");
		choose("模型：模型选项 2", "gpt-5");
		check("均衡：模型选项 2");
		fireEvent.click(screen.getByRole("button", { name: "提交审批" }));
		expect(screen.getAllByText("模型选项不能重复。")).toHaveLength(2);

		fireEvent.click(
			screen.getByRole("button", { name: "移除模型选项：模型选项 2" }),
		);
		expect(screen.queryByText("模型选项不能重复。")).toBeNull();
	});

	it("submits the writable application configuration entered by the employee", async () => {
		const onSubmit = vi.fn();
		stubDirectorySearch();
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
		choose("标准模板", "Codex");
		await chooseDirectory("共同 Owner 用户", "owner", "Owner Two");
		await chooseDirectory("共同 Owner 用户", "owner", "Owner Three");
		await chooseDirectory("可使用的用户", "available", "Available User");
		await chooseDirectory(
			"可使用的组织",
			"available",
			"Available Organization",
		);
		expect(screen.queryByRole("button", { name: "Add action" })).toBeNull();
		openAdvancedConfiguration();
		fireEvent.click(screen.getByRole("button", { name: "添加环境变量" }));
		fireEvent.change(screen.getByLabelText("变量名称"), {
			target: { value: "LOG_LEVEL" },
		});
		fireEvent.change(screen.getByLabelText("变量值"), {
			target: { value: "debug" },
		});
		openAdvancedConfiguration();
		fireEvent.click(screen.getByRole("button", { name: "添加 Secret" }));
		choose("Secret 名称：Secret 1", "MODEL_API_KEY");
		fireEvent.change(screen.getByLabelText("替换值"), {
			target: { value: "never-echo" },
		});
		choose("模型端点：模型选项 1", "Primary endpoint");
		choose("模型：模型选项 1", "gpt-5");
		check("均衡：模型选项 1");
		check("高：模型选项 1");
		choose("默认模型", "Primary endpoint · gpt-5");
		choose("默认推理档位", "均衡");
		fireEvent.change(screen.getByLabelText("Agent 默认 Relay Key"), {
			target: { value: "agent-relay-key-value" },
		});
		fireEvent.click(screen.getByRole("button", { name: "提交审批" }));

		expect(onSubmit).toHaveBeenCalledWith({
			schemaVersion: 2,
			defaultRelayKey: "agent-relay-key-value",
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
		choose("标准模板", "Codex");
		choose("模型端点：模型选项 1", "Colon endpoint");
		choose("模型：模型选项 1", "model:primary");
		check("均衡：模型选项 1");
		choose("默认模型", "Colon endpoint · model:primary");
		choose("默认推理档位", "均衡");
		fireEvent.change(screen.getByLabelText("Agent 默认 Relay Key"), {
			target: { value: "agent-relay-key-value" },
		});
		fireEvent.click(screen.getByRole("button", { name: "提交审批" }));

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
		choose("标准模板", "Codex");
		openAdvancedConfiguration();
		fireEvent.click(screen.getByRole("button", { name: "添加环境变量" }));
		fireEvent.change(screen.getByLabelText("变量名称"), {
			target: { value: "LOG_LEVEL" },
		});
		expect((screen.getByLabelText("变量值") as HTMLInputElement).required).toBe(
			true,
		);
		fireEvent.click(screen.getByRole("button", { name: "提交审批" }));

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
		expect(screen.getByRole("combobox", { name: "标准模板" })).toHaveProperty(
			"disabled",
			true,
		);
		fireEvent.click(screen.getByRole("button", { name: "提交审批" }));
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("keeps directory controls readable without exposing canonical IDs", () => {
		render(
			<AgentApplicationForm
				mode="create"
				onSubmit={vi.fn()}
				submitting={false}
			/>,
		);

		expect(screen.getByText("共同 Owner 用户")).toBeTruthy();
		expect(screen.getByText("可使用的用户")).toBeTruthy();
		expect(screen.getByText("可使用的组织")).toBeTruthy();
		expect(screen.queryByText("共同 Owner 用户 ID")).toBeNull();
		expect(screen.queryByText("可使用的用户 ID")).toBeNull();
		expect(screen.queryByText("可使用的组织 ID")).toBeNull();
	});

	it("does not add a directory option after Escape or while loading", async () => {
		let resolveSearch: ((response: Response) => void) | undefined;
		let searchUrl: URL | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(
				(input: string | URL | Request) =>
					new Promise<Response>((resolve) => {
						searchUrl = directoryRequestUrl(input);
						resolveSearch = resolve;
					}),
			),
		);
		render(
			<AgentApplicationForm
				mode="create"
				onSubmit={vi.fn()}
				submitting={false}
			/>,
		);

		const input = screen.getByRole("combobox", { name: "共同 Owner 用户" });
		fireEvent.change(input, { target: { value: "owner" } });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(screen.queryByText("Owner Two")).toBeNull();

		// 生成 Client 在若干微任务后才调用 fetch：等关键词请求真正发出后再返回结果。
		await waitFor(() => expect(searchUrl?.searchParams.get("q")).toBe("owner"));
		resolveSearch?.(
			new Response(
				JSON.stringify(
					directorySearchResponse(
						searchUrl ?? new URL("https://platform.test/?kind=user"),
						[
							{
								kind: "user",
								canonicalId: "owner-2",
								displayName: "Owner Two",
								email: "owner.two@example.test",
							},
						],
					),
				),
				{ headers: { "Content-Type": "application/json" } },
			),
		);
		await waitFor(() => expect(screen.getByText("Owner Two")).toBeTruthy());
		fireEvent.keyDown(input, { key: "Escape" });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(
			screen.queryByLabelText("从共同 Owner 用户移除 Owner Two"),
		).toBeNull();
	});

	it("reopens advanced configuration when a collapsed row has errors", () => {
		render(
			<AgentApplicationForm
				mode="create"
				onSubmit={vi.fn()}
				submitting={false}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "展开高级配置" }));
		fireEvent.click(screen.getByRole("button", { name: "添加环境变量" }));
		fireEvent.click(screen.getByRole("button", { name: "收起高级配置" }));
		expect(screen.getByLabelText("变量名称")).toBeTruthy();
		expect(
			screen.getByLabelText("变量名称").closest("[hidden]"),
		).not.toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "提交审批" }));

		expect(screen.getByRole("button", { name: "收起高级配置" })).toBeTruthy();
		expect(screen.getByLabelText("变量名称")).toBeTruthy();
		expect(screen.getByText("请选择或填写名称。")).toBeTruthy();
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
			.getByRole("button", { name: "提交审批" })
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
			.getByRole("button", { name: "提交审批" })
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
				screen.getByRole("combobox", { name: "模型端点：模型选项 1" })
					.textContent,
			).toContain("Secondary endpoint"),
		);
	});

	it("requires reselection when a legacy option has no exact endpoint match", () => {
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
		expect(
			screen.getByRole("combobox", { name: "模型端点：模型选项 1" })
				.textContent,
		).toContain("选择模型端点");
		fireEvent.click(screen.getByRole("button", { name: "修改申请" }));
		expect(screen.getByText("模型选项已移除，请重新选择。")).toBeTruthy();
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("rejects a canonical option that collides with another endpoint's legacy ID", () => {
		const conflictingDeployment = {
			...deploymentConfiguration,
			modelCatalog: {
				...deploymentConfiguration.modelCatalog,
				endpoints: [
					{
						endpointId: "endpoint:primary",
						displayName: "Primary endpoint",
						models: [{ modelId: "gpt-5", reasoningLevels: ["medium"] }],
					},
					{
						endpointId: "endpoint%3Aprimary",
						displayName: "Legacy endpoint",
						models: [{ modelId: "gpt-5", reasoningLevels: ["medium"] }],
					},
				],
			},
		};
		const application = AgentApplicationProjectionV2Schema.parse({
			...pendingApplication,
			configuration: {
				...pendingApplication.configuration,
				modelOptions: [
					{
						optionId: "endpoint%3Aprimary:gpt-5",
						displayName: "Ambiguous model",
						modelId: "gpt-5",
						reasoningLevels: ["medium"],
					},
				],
				defaultModelOptionId: "endpoint%3Aprimary:gpt-5",
				defaultReasoningLevel: "medium",
			},
		});
		const onSubmit = vi.fn();
		render(
			<AgentApplicationForm
				application={application}
				action="edit"
				deploymentConfiguration={conflictingDeployment}
				mode="update"
				onSubmit={onSubmit}
				submitting={false}
			/>,
		);

		fireEvent.click(screen.getByRole("checkbox", { name: "修改模型配置" }));
		expect(
			screen.getByRole("combobox", { name: "模型端点：模型选项 1" })
				.textContent,
		).toContain("选择模型端点");
		fireEvent.click(screen.getByRole("button", { name: "修改申请" }));
		expect(screen.getByText("模型选项已移除，请重新选择。")).toBeTruthy();
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("does not require a per-model credential after canonicalizing a legacy option", () => {
		const application = AgentApplicationProjectionV2Schema.parse({
			...pendingApplication,
			configuration: {
				...pendingApplication.configuration,
				modelOptions: [
					{
						optionId: "endpoint:primary:gpt-5",
						displayName: "Primary model",
						modelId: "gpt-5",
						reasoningLevels: ["medium"],
					},
				],
				defaultModelOptionId: "endpoint:primary:gpt-5",
				defaultReasoningLevel: "medium",
			},
		});
		const onSubmit = vi.fn();
		const colonDeployment = {
			...deploymentConfiguration,
			modelCatalog: {
				...deploymentConfiguration.modelCatalog,
				endpoints: [
					{
						endpointId: "endpoint:primary",
						displayName: "Primary endpoint",
						models: [{ modelId: "gpt-5", reasoningLevels: ["medium"] }],
					},
				],
			},
		};
		render(
			<AgentApplicationForm
				application={application}
				action="edit"
				deploymentConfiguration={colonDeployment}
				mode="update"
				onSubmit={onSubmit}
				submitting={false}
			/>,
		);

		fireEvent.click(screen.getByRole("checkbox", { name: "修改模型配置" }));
		fireEvent.click(screen.getByRole("button", { name: "修改申请" }));
		expect(screen.queryByText("请输入模型凭证。")).toBeNull();
		expect(onSubmit).toHaveBeenCalled();
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

	it("does not show a stale model status before model editing is enabled", () => {
		const application = AgentApplicationProjectionV2Schema.parse({
			...pendingApplication,
			configuration: {
				...pendingApplication.configuration,
				modelOptions: [
					{
						optionId: "removed-model",
						displayName: "Removed model",
						modelId: "removed-model",
						reasoningLevels: ["medium"],
					},
				],
				defaultModelOptionId: "removed-model",
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

		expect(
			screen.queryByText(
				"当前申请包含已移除的部署选项，请重新加载并重新选择。",
			),
		).toBeNull();
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
		choose("模型端点：模型选项 1", "Primary endpoint");
		expect(
			screen.getByLabelText("默认模型").getAttribute("aria-invalid"),
		).toBeNull();
	});

	it("keeps a server model error after credential or reasoning changes", () => {
		const onSubmit = vi.fn();
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
				onSubmit={onSubmit}
				serverError={{ code: "MODEL_SELECTION_INVALID" }}
				submitting={false}
			/>,
		);
		fireEvent.click(screen.getByRole("checkbox", { name: "修改模型配置" }));
		const defaultModel = screen.getByLabelText("默认模型");
		expect(defaultModel.getAttribute("aria-invalid")).toBe("true");
		fireEvent.click(screen.getByRole("button", { name: "修改申请" }));
		expect(onSubmit).not.toHaveBeenCalled();
		expect(defaultModel.getAttribute("aria-invalid")).toBe("true");
		choose("默认推理档位", "高");
		expect(defaultModel.getAttribute("aria-invalid")).toBe("true");
		check("高：模型选项 1");
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
		expect(screen.getByRole("option", { name: "均衡" })).toBeTruthy();
		expect(screen.queryByRole("option", { name: "高" })).toBeNull();
		// 推理档位只显示中文：复选框与默认档位都不出现原始枚举。
		expect(
			screen.getByRole("checkbox", { name: "均衡：模型选项 1" }),
		).toBeTruthy();
		expect(screen.queryByText("medium")).toBeNull();
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
		choose("标准模板", "Codex");
		choose("模型端点：模型选项 1", "Primary endpoint");
		choose("模型：模型选项 1", "gpt-5");
		fireEvent.change(screen.getByLabelText("Agent 默认 Relay Key"), {
			target: { value: "agent-relay-key-value" },
		});
		fireEvent.click(screen.getByRole("button", { name: "提交审批" }));

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
		fireEvent.click(screen.getByRole("button", { name: "提交审批" }));

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

	it("focuses earlier local errors before server model errors", () => {
		render(
			<AgentApplicationForm
				application={pendingApplication}
				action="edit"
				mode="update"
				onSubmit={vi.fn()}
				serverError={{ code: "MODEL_SELECTION_INVALID" }}
				submitting={false}
			/>,
		);

		fireEvent.change(screen.getByLabelText("Agent 名称"), {
			target: { value: "" },
		});
		fireEvent.click(screen.getByRole("button", { name: "修改申请" }));
		expect(document.activeElement).toBe(screen.getByLabelText("Agent 名称"));
	});

	it("focuses the model toggle when hidden model rows are rejected", () => {
		const application = AgentApplicationProjectionV2Schema.parse({
			...pendingApplication,
			configuration: {
				...pendingApplication.configuration,
				modelOptions: [
					{
						optionId: "removed-model",
						displayName: "Removed model",
						modelId: "removed-model",
						reasoningLevels: ["medium"],
					},
				],
				defaultModelOptionId: "removed-model",
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

		const toggle = screen.getByRole("checkbox", { name: "修改模型配置" });
		expect(toggle.getAttribute("aria-invalid")).toBe("true");
		expect(document.activeElement).toBe(toggle);
	});

	it("focuses the model configuration toggle when an update rejects its model", () => {
		render(
			<AgentApplicationForm
				application={pendingApplication}
				action="edit"
				mode="update"
				onSubmit={vi.fn()}
				serverError={{ code: "MODEL_SELECTION_INVALID" }}
				submitting={false}
			/>,
		);

		const toggle = screen.getByRole("checkbox", { name: "修改模型配置" });
		expect(toggle.getAttribute("aria-invalid")).toBe("true");
		expect(
			screen.getByText(
				"模型配置未通过默认 Relay Key 的验证，请开启修改模型配置。",
			),
		).toBeTruthy();
		expect(document.activeElement).toBe(toggle);
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

	it("blocks an unchanged server invalid-request retry", () => {
		const onSubmit = vi.fn();
		render(
			<AgentApplicationForm
				application={pendingApplication}
				action="edit"
				mode="update"
				onSubmit={onSubmit}
				serverError={{ code: "INVALID_REQUEST" }}
				submitting={false}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "修改申请" }));
		expect(onSubmit).not.toHaveBeenCalled();
		fireEvent.change(screen.getByLabelText("用途说明"), {
			target: { value: "Retry after correction" },
		});
		fireEvent.click(screen.getByRole("button", { name: "修改申请" }));
		expect(onSubmit).toHaveBeenCalled();
	});

	it("retries a server invalid request after removing an environment row", () => {
		const onSubmit = vi.fn();
		const application = AgentApplicationProjectionV2Schema.parse({
			...pendingApplication,
			configuration: {
				...pendingApplication.configuration,
				environment: [{ name: "LOG_LEVEL", value: "debug" }],
			},
		});
		render(
			<AgentApplicationForm
				application={application}
				action="edit"
				mode="update"
				onSubmit={onSubmit}
				serverError={{ code: "INVALID_REQUEST" }}
				submitting={false}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "修改申请" }));
		expect(onSubmit).not.toHaveBeenCalled();
		fireEvent.click(
			screen.getByRole("button", { name: "移除环境变量：环境变量 1" }),
		);
		fireEvent.click(screen.getByRole("button", { name: "修改申请" }));
		expect(onSubmit).toHaveBeenCalledWith(
			expect.objectContaining({ environment: [] }),
		);
	});

	it("retries a server invalid request after changing the source kind", async () => {
		const onSubmit = vi.fn();
		const formProps = { mode: "create", onSubmit, submitting: false } as const;
		const view = render(<AgentApplicationForm {...formProps} />);
		fireEvent.change(screen.getByLabelText("Agent 名称"), {
			target: { value: "Release assistant" },
		});
		fireEvent.change(screen.getByLabelText("用途说明"), {
			target: { value: "Helps the release team" },
		});
		view.rerender(
			<AgentApplicationForm
				{...formProps}
				serverError={{ code: "INVALID_REQUEST" }}
			/>,
		);
		expect(
			screen.getByText("申请内容未通过服务端校验，请检查表单后重试。"),
		).toBeTruthy();

		fireEvent.click(screen.getByRole("combobox", { name: "Agent 来源" }));
		const sourceOption = await screen.findByRole("option", {
			name: "自定义 Agent · 平台交互入口",
		});
		fireEvent.pointerDown(sourceOption, { pointerType: "mouse" });
		fireEvent.click(sourceOption, { detail: 1 });
		fireEvent.change(await screen.findByLabelText("镜像地址"), {
			target: { value: "registry.example/agents/release:v1" },
		});
		fireEvent.click(screen.getByRole("button", { name: "提交审批" }));
		expect(onSubmit).toHaveBeenCalledWith(
			expect.objectContaining({
				source: {
					kind: "custom",
					imageReference: "registry.example/agents/release:v1",
					interactionMode: "platform-adapter",
				},
			}),
		);
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
				.getByRole("combobox", { name: "标准模板" })
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
		fireEvent.click(screen.getByRole("button", { name: "提交审批" }));
		fireEvent.click(screen.getByRole("button", { name: "提交审批" }));
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
		choose("标准模板", "Codex");
		choose("模型端点：模型选项 1", "Primary endpoint");
		choose("模型：模型选项 1", "gpt-5");
		check("均衡：模型选项 1");
		choose("默认模型", "Primary endpoint · gpt-5");
		choose("默认推理档位", "均衡");
		fireEvent.change(screen.getByLabelText("Agent 默认 Relay Key"), {
			target: { value: "agent-relay-key-value" },
		});
		fireEvent.click(screen.getByRole("button", { name: "提交审批" }));

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
		fireEvent.click(screen.getByRole("button", { name: "提交审批" }));

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
		fireEvent.click(screen.getByRole("button", { name: "提交审批" }));
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

describe("AgentApplicationForm editing the models of a default-Key application (#2421)", () => {
	const key = "SYNTHETIC_FORM_KEY_0000001";
	const candidates = {
		schemaVersion: 1 as const,
		configurationRevision: 7,
		keyVersion: 2,
		candidates: [
			{
				endpointId: "endpoint-primary",
				modelId: "gpt-5",
				reasoningLevels: ["medium", "high"],
			},
			{
				endpointId: "endpoint-primary",
				modelId: "gpt-5-mini",
				reasoningLevels: ["low"],
			},
		],
	};
	// 已持久化的模型选项与候选一致，编辑时从它们开始。
	const pendingApplication = AgentApplicationProjectionV2Schema.parse({
		...basePendingApplication,
		configuration: {
			...basePendingApplication.configuration,
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
	function renderManaged(check = vi.fn().mockResolvedValue(candidates)) {
		const onSubmit = vi.fn();
		render(
			<AgentApplicationForm
				action="edit"
				application={pendingApplication}
				defaultRelayKeyManaged
				mode="update"
				onCheckDefaultRelayKey={check}
				onSubmit={onSubmit}
				submitting={false}
			/>,
		);
		return { onSubmit, check };
	}

	it("replaces the catalog rows with a Key check and a candidate picker", async () => {
		const { check } = renderManaged();
		// 没有修改模型配置时没有 Key 输入，请求也不带 Key。
		expect(screen.queryByLabelText("Agent 默认 Relay Key")).toBeNull();
		fireEvent.click(screen.getByRole("checkbox", { name: "修改模型配置" }));
		expect(
			screen.getByLabelText<HTMLInputElement>("Agent 默认 Relay Key").type,
		).toBe("password");
		// 目录里的逐行模型编辑被候选选择取代：任何一行的「模型端点」都不出现。
		expect(screen.queryByRole("combobox", { name: /^模型端点/ })).toBeNull();
		fireEvent.change(screen.getByLabelText("Agent 默认 Relay Key"), {
			target: { value: key },
		});
		fireEvent.click(screen.getByRole("button", { name: "检查可用模型" }));
		await screen.findByText("选择允许的模型");
		expect(check).toHaveBeenCalledWith(key);
		// 当前模型预先勾选，Key 可见的另一个模型可选。
		expect(
			screen
				.getByRole("checkbox", { name: "endpoint-primary · gpt-5" })
				.getAttribute("aria-checked"),
		).toBe("true");
		expect(
			screen
				.getByRole("checkbox", { name: "endpoint-primary · gpt-5-mini" })
				.getAttribute("aria-checked"),
		).toBe("false");
	});

	it("submits the Key, the checked versions and the selection once the Key was checked", async () => {
		const { onSubmit } = renderManaged();
		fireEvent.click(screen.getByRole("checkbox", { name: "修改模型配置" }));
		fireEvent.change(screen.getByLabelText("Agent 默认 Relay Key"), {
			target: { value: key },
		});
		fireEvent.click(screen.getByRole("button", { name: "检查可用模型" }));
		await screen.findByText("选择允许的模型");
		fireEvent.click(
			screen.getByRole("checkbox", { name: "endpoint-primary · gpt-5-mini" }),
		);
		fireEvent.click(screen.getByRole("button", { name: "修改申请" }));
		expect(onSubmit).toHaveBeenCalledTimes(1);
		const body = onSubmit.mock.calls[0]?.[0];
		expect(body).toMatchObject({
			schemaVersion: 2,
			defaultRelayKey: key,
			expectedConfigurationRevision: 7,
			expectedKeyVersion: 2,
		});
		expect(
			body.modelConfiguration.options.map(
				(o: { optionId: string }) => o.optionId,
			),
		).toEqual(["endpoint-primary:gpt-5", "endpoint-primary:gpt-5-mini"]);
		expect(body.modelConfiguration.defaultOptionId).toBe(
			"endpoint-primary:gpt-5",
		);
	});

	it("blocks the submission until the Key was checked and models were selected", async () => {
		const { onSubmit } = renderManaged();
		fireEvent.click(screen.getByRole("checkbox", { name: "修改模型配置" }));
		fireEvent.click(screen.getByRole("button", { name: "修改申请" }));
		expect(screen.getByText("请输入 Agent 默认 Relay Key。")).toBeTruthy();
		fireEvent.change(screen.getByLabelText("Agent 默认 Relay Key"), {
			target: { value: key },
		});
		fireEvent.click(screen.getByRole("button", { name: "修改申请" }));
		expect(screen.getByText(/请先点击「检查可用模型」并选好模型/)).toBeTruthy();
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("does not send the Key or versions when the models stay untouched", () => {
		const { onSubmit } = renderManaged();
		fireEvent.click(screen.getByRole("button", { name: "修改申请" }));
		expect(onSubmit).toHaveBeenCalledTimes(1);
		const body = onSubmit.mock.calls[0]?.[0];
		expect(body).not.toHaveProperty("defaultRelayKey");
		expect(body).not.toHaveProperty("expectedKeyVersion");
		expect(body).not.toHaveProperty("modelConfiguration");
	});

	it("keeps the previous behaviour for an application the default Key does not manage", () => {
		render(
			<AgentApplicationForm
				action="edit"
				application={pendingApplication}
				mode="update"
				onSubmit={vi.fn()}
				submitting={false}
			/>,
		);
		fireEvent.click(screen.getByRole("checkbox", { name: "修改模型配置" }));
		expect(screen.queryByLabelText("Agent 默认 Relay Key")).toBeNull();
		expect(
			screen.getByRole("combobox", { name: "模型端点：模型选项 1" }),
		).toBeTruthy();
	});
});

describe("AgentApplicationForm design alignment", () => {
	// M-08 / N-11 / NI-50：DOM 顺序即视觉顺序，模型与推理在高级配置之前。
	it("orders sections as basics, scope, model, advanced and footer in the DOM", () => {
		render(
			<AgentApplicationForm
				mode="create"
				onSubmit={vi.fn()}
				submitting={false}
			/>,
		);
		const fields = document.querySelector(".application-form-fields");
		if (!fields) throw new Error("application fields missing");
		const order = Array.from(fields.children).map((child) =>
			child.matches(".form-footer")
				? "footer"
				: (child.querySelector("h2")?.textContent ?? child.tagName),
		);
		expect(order).toEqual([
			"基本信息",
			"共同 Owner 与使用范围",
			"模型与推理",
			"高级配置",
			"footer",
		]);
		// 模型区的控件都排在「展开高级配置」之前。
		const toggle = screen.getByRole("button", { name: "展开高级配置" });
		const addModel = screen.getByRole("button", { name: "添加模型选项" });
		expect(
			addModel.compareDocumentPosition(toggle) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	// M-09：字段错误 12px / --danger-ink / polite，与控件关联并聚焦首个错误字段。
	it("announces field errors politely and links them to the invalid control", () => {
		render(
			<AgentApplicationForm
				mode="create"
				onSubmit={vi.fn()}
				submitting={false}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "提交审批" }));
		const name = screen.getByLabelText("Agent 名称");
		expect(name.getAttribute("aria-invalid")).toBe("true");
		const errorId = name.getAttribute("aria-describedby");
		const error = errorId ? document.getElementById(errorId) : null;
		expect(error?.textContent).toBe("请输入 Agent 名称。");
		expect(error?.getAttribute("aria-live")).toBe("polite");
		expect(error?.className).toContain("field-error");
		expect(error?.className).toContain("text-(--danger-ink)");
		expect(error?.className).toContain("text-[12px]");
		expect(document.activeElement).toBe(name);
	});

	// M-10 决策前：没有渠道分区与保存草稿；主按钮文案保持 PRD 用语并带箭头。
	it("keeps the footer to cancel and one submit action without channels or drafts", () => {
		render(
			<AgentApplicationForm
				mode="create"
				onSubmit={vi.fn()}
				submitting={false}
			/>,
		);
		expect(screen.queryByRole("heading", { name: "渠道" })).toBeNull();
		expect(screen.queryByRole("button", { name: /保存草稿/ })).toBeNull();
		const submit = screen.getByRole("button", { name: "提交审批" });
		const icon = submit.querySelector("svg");
		expect(icon?.getAttribute("aria-hidden")).toBe("true");
		expect(submit.lastElementChild).toBe(icon);
	});

	// W-07：分区说明与目录占位符按设计 renderApplicationForm 原文。
	it("uses the design section copy and directory placeholders (W-07)", () => {
		render(
			<AgentApplicationForm
				mode="create"
				onSubmit={vi.fn()}
				submitting={false}
			/>,
		);
		const description = (title: string) =>
			screen
				.getByRole("heading", { level: 2, name: title })
				.parentElement?.querySelector('[data-slot="form-section-description"]')
				?.textContent;
		expect(description("基本信息")).toBe("名称和描述会显示在 Agent 目录。");
		expect(description("共同 Owner 与使用范围")).toBe(
			"从目录选择人员和组织；提交时保存服务端 ID。",
		);
		expect(description("模型与推理")).toBe(
			"这里只显示已部署且通过校验的模型。",
		);
		const placeholder = (label: string) =>
			screen.getByRole("combobox", { name: label }).getAttribute("placeholder");
		expect(placeholder("共同 Owner 用户")).toBe("搜索共同 Owner");
		expect(placeholder("可使用的用户")).toBe("搜索姓名、邮箱或组织路径");
		expect(placeholder("可使用的组织")).toBe("搜索组织名称或路径");
	});
});
