import { AgentApplicationProjectionV2Schema } from "@agent-infra/contracts/pilot";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
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

/** 部署选项读取失败（路由把可重试 503 投影成整份不可用，同 unavailableDeploymentConfiguration，#3389）。 */
const unreadableDeployment: DeploymentConfigurationProjectionV2 = {
	...deploymentConfiguration,
	status: "unavailable",
	templates: [],
	modelCatalog: {
		...deploymentConfiguration.modelCatalog,
		status: "unavailable",
		endpoints: [],
		revision: null,
	},
};

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
	it("shows the server-resolved Connection entry without adding Connection form state", () => {
		render(
			<AgentApplicationForm
				connectionUrl="https://connection.example.test/mcp"
				mode="create"
				onSubmit={vi.fn()}
				submitting={false}
			/>,
		);
		const link = screen.getByRole("link", { name: "打开 Connection" });
		expect(link.getAttribute("href")).toBe(
			"https://connection.example.test/mcp",
		);
		expect(link.getAttribute("target")).toBe("_blank");
		expect(screen.queryByLabelText(/Connection ID|Consumer|Token/i)).toBeNull();
	});

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

	// #3268 N8-2-04：多服务 YAML 未填写或无效时，焦点移到出错的文本框，错误由 aria-describedby 关联。
	it("focuses the multi-service YAML textarea when it is missing or invalid", () => {
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
		const manifestField = screen.getByRole("textbox", {
			name: "多服务资源 YAML 内容",
		});
		fireEvent.click(screen.getByRole("button", { name: "提交审批" }));
		expect(onSubmit).not.toHaveBeenCalled();
		expect(document.activeElement).toBe(manifestField);
		const errorId = manifestField.getAttribute("aria-describedby");
		expect(errorId).toBe("application-multi-service-manifest-error");
		expect(document.getElementById(errorId ?? "")?.textContent).toBe(
			"请上传或粘贴多服务 YAML。",
		);

		fireEvent.change(manifestField, {
			target: { value: "schemaVersion: [" },
		});
		(document.activeElement as HTMLElement | null)?.blur();
		fireEvent.click(screen.getByRole("button", { name: "提交审批" }));
		expect(onSubmit).not.toHaveBeenCalled();
		expect(document.activeElement).toBe(manifestField);
		expect(manifestField.getAttribute("aria-invalid")).toBe("true");
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

	// 需求变化（#3268 N8-2-03）：整表校验失败的结论只在页面顶部的提交失败提示里说明一次，焦点交给
	// 那条提示（见 agent-application-submission-screen.test.tsx）；表单内不再重复提示，也不再让整张
	// 表单成为焦点目标。
	it("does not repeat a server invalid-request error inside the form or focus the form", () => {
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
		expect(screen.queryByText(/未通过服务端校验/)).toBeNull();
		expect(form.hasAttribute("tabindex")).toBe(false);
		expect(form.hasAttribute("aria-describedby")).toBe(false);
		expect(document.activeElement).not.toBe(form);
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
		// 需求变化（#3268 N8-2-03）：表单内不再重复「未通过服务端校验」的提示；改为确认整表校验失败
		// 仍在生效——未修改时再次提交被拦下。
		fireEvent.click(screen.getByRole("button", { name: "提交审批" }));
		expect(onSubmit).not.toHaveBeenCalled();

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
		const unavailable = {
			...deploymentConfiguration,
			status: "unavailable" as const,
			templates: [],
			modelCatalog: {
				...deploymentConfiguration.modelCatalog,
				status: "unavailable" as const,
				endpoints: [],
			},
		};
		const { rerender } = render(
			<AgentApplicationForm
				application={application}
				action="resubmit"
				deploymentConfiguration={unavailable}
				mode="update"
				onSubmit={onSubmit}
				submitting={false}
			/>,
		);

		expect(screen.getByRole("status").textContent).toContain("暂不可用");
		expect(screen.getByRole("status").textContent).not.toContain("已移除");
		// 部署选项不可用时修改标准模板申请同创建申请一样被拦下、不发请求，焦点交给部署状态说明（#3389 N13-09）。
		// 修改申请不能更换模板：由部署状态说明接手，「标准模板」下不另写字段错误。
		fireEvent.click(screen.getByRole("button", { name: "修改并重新提交" }));
		expect(onSubmit).not.toHaveBeenCalled();
		expect(document.activeElement).toBe(screen.getByRole("status"));
		expect(document.getElementById("application-template-id-error")).toBeNull();
		expect(screen.queryByText(/已移除/)).toBeNull();
		expect(
			screen.getByRole("combobox", { name: "标准模板" }).textContent,
		).toContain("Codex");

		// 部署选项恢复后提交原申请的模板，不当作已移除。
		rerender(
			<AgentApplicationForm
				application={application}
				action="resubmit"
				deploymentConfiguration={deploymentConfiguration}
				mode="update"
				onSubmit={onSubmit}
				submitting={false}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "修改并重新提交" }));
		expect(onSubmit).toHaveBeenCalledWith(
			expect.objectContaining({ source: application.source }),
		);
	});

	// #3389 N13-09：修改申请打开时部署选项读取失败、还没读到模板的验证 revision；「重新加载部署选项」读到后
	// 以它为页面读到的 revision，可以直接提交，不再要求刷新页面。读到之后 revision 再变化仍要求确认。
	it("takes the first readable template revision after the deployment was unreadable on open (#3389 N13-09)", () => {
		const onSubmit = vi.fn();
		const application = AgentApplicationProjectionV2Schema.parse({
			...pendingApplication,
			status: "rejected",
			decision: { decidedAt: "2026-09-04T00:00:00Z", reason: "Retry" },
		});
		const [codex] = deploymentConfiguration.templates;
		if (!codex) throw new Error("Missing template fixture");
		const withRevision = (revision: string) => ({
			...deploymentConfiguration,
			templates: [
				{ ...codex, readiness: { state: "ready" as const, revision } },
			],
		});
		const props = {
			action: "resubmit" as const,
			application,
			deploymentConfigurationRetryable: true,
			mode: "update" as const,
			onSubmit,
			submitting: false,
		};
		const { rerender } = render(
			<AgentApplicationForm
				{...props}
				deploymentConfiguration={unreadableDeployment}
			/>,
		);
		rerender(
			<AgentApplicationForm
				{...props}
				deploymentConfiguration={withRevision("codex-r1")}
			/>,
		);
		expect(screen.queryByText("模板已更新，请刷新后确认。")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "修改并重新提交" }));
		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(screen.queryByRole("alert")).toBeNull();

		rerender(
			<AgentApplicationForm
				{...props}
				deploymentConfiguration={withRevision("codex-r2")}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "修改并重新提交" }));
		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(screen.getByRole("alert").textContent).toBe(
			"此申请的模板需要重新确认，请刷新页面后再提交。",
		);
	});

	// #3328 N10-2-02：修改申请不能更换模板。模板已从部署移除时下拉占位与字段错误不再引导重新选择或
	// 重新加载；顶部提示说明请新建申请并获得焦点（只读的「标准模板」不是焦点目标），再次提交仍被拦下。
	it("points an edited application whose template was removed to a new application from the top alert", () => {
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
				mode="update"
				onSubmit={onSubmit}
				showDeploymentStatus={false}
				submitting={false}
			/>,
		);
		const template = screen.getByRole("combobox", { name: "标准模板" });
		expect(
			template.querySelector('[data-slot="select-value"]')?.textContent,
		).toBe("已移除模板");
		expect(screen.queryByRole("alert")).toBeNull();

		const submit = screen.getByRole("button", { name: "修改并重新提交" });
		fireEvent.click(submit);
		const alert = screen.getByRole("alert");
		expect(alert.id).toBe("application-submission-error");
		expect(alert.getAttribute("tabindex")).toBe("-1");
		expect(alert.textContent).toBe("当前部署已移除此申请的模板，请新建申请。");
		expect(document.activeElement).toBe(alert);
		expect(template.getAttribute("aria-invalid")).toBe("true");
		expect(
			document.getElementById("application-template-id-error")?.textContent,
		).toBe("该模板已从当前部署移除。已有申请不能更换模板，请新建申请。");
		expect(screen.queryByText(/重新选择|重新加载/)).toBeNull();

		submit.focus();
		fireEvent.click(submit);
		expect(document.activeElement).toBe(screen.getByRole("alert"));
		expect(onSubmit).not.toHaveBeenCalled();
	});

	// #3328 N10-2-01：修改申请的模板验证失败。字段错误沿用就绪原因（不再写「部署选项暂不可用。」），
	// 出现后不再并列同义的就绪提示；顶部提示给出等待恢复或新建申请，并获得焦点。
	it("explains an edited application's failed template at the top alert without a generic deployment error", () => {
		const onSubmit = vi.fn();
		render(
			<AgentApplicationForm
				application={pendingApplication}
				action="edit"
				deploymentConfiguration={{
					...deploymentConfiguration,
					templates: deploymentConfiguration.templates.map((template) => ({
						...template,
						readiness: { state: "failed" as const, revision: "codex-r1" },
					})),
				}}
				mode="update"
				onSubmit={onSubmit}
				showDeploymentStatus={false}
				submitting={false}
			/>,
		);
		const notice = screen.getByText("验证失败，暂不可申请。", {
			selector: "p",
		});
		expect(notice.getAttribute("aria-live")).toBe("polite");

		fireEvent.click(screen.getByRole("button", { name: "修改申请" }));
		const alert = screen.getByRole("alert");
		expect(alert.textContent).toBe(
			"此申请的模板暂不可申请，请等待模板恢复后再提交，或新建申请。",
		);
		expect(document.activeElement).toBe(alert);
		expect(
			document.getElementById("application-template-id-error")?.textContent,
		).toBe(
			"验证失败，暂不可申请。已有申请不能更换模板，请等待模板恢复后再提交，或新建申请。",
		);
		expect(
			screen.queryByText("验证失败，暂不可申请。", { selector: "p" }),
		).toBeNull();
		expect(screen.queryByText(/部署选项暂不可用/)).toBeNull();
		expect(
			within(screen.getByRole("list", { name: "模板就绪状态" })).getByText(
				"Codex：验证失败，暂不可申请。",
			),
		).toBeTruthy();
		expect(onSubmit).not.toHaveBeenCalled();
	});

	// #3328：模板不能更换又不可申请，同时还有可编辑字段出错时，与修改申请入口身份不可用（#3291 N9-2-03）
	// 一致：顶部提示照常出现（role=alert 自行播报），焦点先到第一个可编辑的出错字段；改好后再次提交，
	// 只剩只读的「标准模板」出错，焦点到顶部提示。
	it("focuses an editable field error before the template alert of an edited application", () => {
		const onSubmit = vi.fn();
		render(
			<AgentApplicationForm
				application={pendingApplication}
				action="edit"
				deploymentConfiguration={{
					...deploymentConfiguration,
					templates: deploymentConfiguration.templates.map((template) => ({
						...template,
						readiness: { state: "failed" as const, revision: "codex-r1" },
					})),
				}}
				mode="update"
				onSubmit={onSubmit}
				showDeploymentStatus={false}
				submitting={false}
			/>,
		);
		const name = screen.getByLabelText("Agent 名称");
		fireEvent.change(name, { target: { value: "" } });
		const submit = screen.getByRole("button", { name: "修改申请" });
		fireEvent.click(submit);
		expect(screen.getByRole("alert").textContent).toBe(
			"此申请的模板暂不可申请，请等待模板恢复后再提交，或新建申请。",
		);
		expect(document.getElementById("application-name-error")?.textContent).toBe(
			"请输入 Agent 名称。",
		);
		expect(document.activeElement).toBe(name);

		fireEvent.change(name, { target: { value: "客户支持助理" } });
		submit.focus();
		fireEvent.click(submit);
		expect(document.getElementById("application-name-error")).toBeNull();
		expect(document.activeElement).toBe(screen.getByRole("alert"));
		expect(onSubmit).not.toHaveBeenCalled();
	});

	// #3328：验证过期（与当前登记不符或超出有效期）要等平台重新验证，与验证失败、停用一样提示等待恢复
	// 或新建申请；这次没能读到验证结果时刷新即可确认，只提示刷新。
	it.each([
		[
			"stale",
			"此申请的模板暂不可申请，请等待模板恢复后再提交，或新建申请。",
			"模板验证已过期，需等待平台重新验证。已有申请不能更换模板，请等待模板恢复后再提交，或新建申请。",
		],
		[
			"disabled",
			"此申请的模板暂不可申请，请等待模板恢复后再提交，或新建申请。",
			"模板已停用。已有申请不能更换模板，请等待模板恢复后再提交，或新建申请。",
		],
		[
			"unavailable",
			"此申请的模板需要重新确认，请刷新页面后再提交。",
			"暂时无法读取验证结果，请刷新后重试。",
		],
	] as const)(
		"explains an edited application's %s template at the focused top alert",
		(state, alertText, fieldText) => {
			render(
				<AgentApplicationForm
					application={pendingApplication}
					action="edit"
					deploymentConfiguration={{
						...deploymentConfiguration,
						templates: deploymentConfiguration.templates.map((template) => ({
							...template,
							readiness: { state, revision: null },
						})),
					}}
					mode="update"
					onSubmit={vi.fn()}
					showDeploymentStatus={false}
					submitting={false}
				/>,
			);
			fireEvent.click(screen.getByRole("button", { name: "修改申请" }));
			const alert = screen.getByRole("alert");
			expect(alert.textContent).toBe(alertText);
			expect(document.activeElement).toBe(alert);
			expect(
				document.getElementById("application-template-id-error")?.textContent,
			).toBe(fieldText);
		},
	);

	// #3328 N10-2-01：修改申请时模板验证 revision 在会话内变化。刷新页面就能确认，顶部提示只要求刷新；
	// 模板恢复为同一 revision 后提示随之收起，申请可以提交。
	it("asks an edited application to refresh after its template revision changes", () => {
		const onSubmit = vi.fn();
		const withRevision = (revision: string) => ({
			...deploymentConfiguration,
			templates: deploymentConfiguration.templates.map((template) => ({
				...template,
				readiness: { state: "ready" as const, revision },
			})),
		});
		const { rerender } = render(
			<AgentApplicationForm
				application={pendingApplication}
				action="edit"
				deploymentConfiguration={withRevision("codex-r1")}
				mode="update"
				onSubmit={onSubmit}
				showDeploymentStatus={false}
				submitting={false}
			/>,
		);
		const rerenderWith = (revision: string) =>
			rerender(
				<AgentApplicationForm
					application={pendingApplication}
					action="edit"
					deploymentConfiguration={withRevision(revision)}
					mode="update"
					onSubmit={onSubmit}
					showDeploymentStatus={false}
					submitting={false}
				/>,
			);
		rerenderWith("codex-r2");
		fireEvent.click(screen.getByRole("button", { name: "修改申请" }));
		const alert = screen.getByRole("alert");
		expect(alert.textContent).toBe(
			"此申请的模板需要重新确认，请刷新页面后再提交。",
		);
		expect(document.activeElement).toBe(alert);
		expect(
			document.getElementById("application-template-id-error")?.textContent,
		).toBe("模板已更新，请刷新后确认。");
		expect(onSubmit).not.toHaveBeenCalled();

		rerenderWith("codex-r1");
		expect(screen.queryByRole("alert")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "修改申请" }));
		expect(onSubmit).toHaveBeenCalledTimes(1);
	});

	// #3328：最近一次提交被模板拦下时，顶部唯一的提示说明模板，先前服务端错误的说明让位；
	// 模板恢复后回到服务端错误的说明。
	it("keeps a single top alert when a template block follows a server error", () => {
		const application = AgentApplicationProjectionV2Schema.parse({
			...pendingApplication,
			source: { kind: "standard", templateId: "removed-template" },
		});
		const props = {
			application,
			action: "edit" as const,
			mode: "update" as const,
			onSubmit: vi.fn(),
			showDeploymentStatus: false,
			submissionErrorMessage: "申请提交失败，部署依赖暂不可用，请稍后重试。",
			submitting: false,
		};
		const { rerender } = render(<AgentApplicationForm {...props} />);
		expect(screen.getByRole("alert").textContent).toBe(
			"申请提交失败，部署依赖暂不可用，请稍后重试。",
		);
		fireEvent.click(screen.getByRole("button", { name: "修改申请" }));
		expect(screen.getAllByRole("alert")).toHaveLength(1);
		expect(screen.getByRole("alert").textContent).toBe(
			"当前部署已移除此申请的模板，请新建申请。",
		);
		rerender(
			<AgentApplicationForm
				{...props}
				deploymentConfiguration={{
					...deploymentConfiguration,
					templates: [
						...deploymentConfiguration.templates,
						{
							...at(deploymentConfiguration.templates, 0),
							templateId: "removed-template",
							displayName: "Restored",
						},
					],
				}}
			/>,
		);
		expect(screen.getAllByRole("alert")).toHaveLength(1);
		expect(screen.getByRole("alert").textContent).toBe(
			"申请提交失败，部署依赖暂不可用，请稍后重试。",
		);
	});

	// #3351 N11-02：非校验类提交失败（503、500、不可重试的 409）没有字段错误，说明只在顶部唯一的提示里：
	// 失败返回、提示出现时它接过焦点（与整表校验失败一致）；再次提交时旧错误还在、请求尚未开始，焦点留在
	// 提交按钮上，不被抢回提示；同一类失败再次返回（新的错误对象）时提示再次接过焦点。
	it.each([
		["DEPENDENCY_UNAVAILABLE", "申请提交失败，部署依赖暂不可用，请稍后重试。"],
		[
			undefined,
			"申请提交失败，非敏感内容已保留。请重新填写 Secret 或模型凭证后再提交。",
		],
		["RESOURCE_UNAVAILABLE", "申请已变更或当前不可用，请刷新页面后核对。"],
	])(
		"focuses the top alert when a %s submission failure arrives",
		(code, message) => {
			const onSubmit = vi.fn();
			const props = {
				application: pendingApplication,
				action: "edit" as const,
				deploymentConfiguration,
				mode: "update" as const,
				onSubmit,
				showDeploymentStatus: false,
				submitting: false,
			};
			const { rerender } = render(<AgentApplicationForm {...props} />);
			const submit = screen.getByRole("button", { name: "修改申请" });
			submit.focus();
			fireEvent.click(submit);
			expect(onSubmit).toHaveBeenCalledTimes(1);
			rerender(<AgentApplicationForm {...props} submitting />);
			expect(document.activeElement).toBe(submit);
			rerender(
				<AgentApplicationForm
					{...props}
					serverError={{ code }}
					submissionErrorMessage={message}
				/>,
			);
			const alert = screen.getByRole("alert");
			expect(alert.textContent).toBe(message);
			expect(document.activeElement).toBe(alert);

			submit.focus();
			fireEvent.click(submit);
			expect(onSubmit).toHaveBeenCalledTimes(2);
			expect(document.activeElement).toBe(submit);
			rerender(<AgentApplicationForm {...props} submitting />);
			expect(screen.queryByRole("alert")).toBeNull();
			expect(document.activeElement).toBe(submit);
			rerender(
				<AgentApplicationForm
					{...props}
					serverError={{ code }}
					submissionErrorMessage={message}
				/>,
			);
			expect(document.activeElement).toBe(screen.getByRole("alert"));
		},
	);

	// #3328 N10-2-01：创建申请时所选模板在会话内更新。字段错误沿用「模板已更新，请刷新后确认。」，
	// 不再并列同义提示，也不写「部署选项暂不可用。」；下拉可改选，焦点到它。未选模板时仍提示选择。
	it("reuses the template readiness reason as the create field error", () => {
		const onSubmit = vi.fn();
		const withRevision = (revision: string) => ({
			...deploymentConfiguration,
			templates: deploymentConfiguration.templates.map((template) => ({
				...template,
				readiness: { state: "ready" as const, revision },
			})),
		});
		const { rerender } = render(
			<AgentApplicationForm
				deploymentConfiguration={withRevision("codex-r1")}
				mode="create"
				onSubmit={onSubmit}
				showDeploymentStatus={false}
				submitting={false}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "提交审批" }));
		expect(
			document.getElementById("application-template-id-error")?.textContent,
		).toBe("请选择标准模板。");

		fireEvent.change(screen.getByLabelText("Agent 名称"), {
			target: { value: "Release assistant" },
		});
		fireEvent.change(screen.getByLabelText("用途说明"), {
			target: { value: "Helps the release team" },
		});
		choose("标准模板", "Codex");
		rerender(
			<AgentApplicationForm
				deploymentConfiguration={withRevision("codex-r2")}
				mode="create"
				onSubmit={onSubmit}
				showDeploymentStatus={false}
				submitting={false}
			/>,
		);
		expect(
			screen
				.getByText("模板已更新，请刷新后确认。", { selector: "p" })
				.getAttribute("aria-live"),
		).toBe("polite");
		fireEvent.click(screen.getByRole("button", { name: "提交审批" }));
		const template = screen.getByRole("combobox", { name: "标准模板" });
		expect(
			document.getElementById("application-template-id-error")?.textContent,
		).toBe("模板已更新，请刷新后确认。");
		expect(screen.getAllByText("模板已更新，请刷新后确认。")).toHaveLength(1);
		expect(screen.queryByText(/部署选项暂不可用/)).toBeNull();
		expect(screen.queryByRole("alert")).toBeNull();
		expect(template.getAttribute("aria-invalid")).toBe("true");
		expect(document.activeElement).toBe(template);
		expect(onSubmit).not.toHaveBeenCalled();
	});

	type Readiness = NonNullable<
		DeploymentConfigurationProjectionV2["templates"][number]["readiness"]
	>;
	/** Codex 按参数（null 为已从部署移除），Claude 按参数或为可申请（#3364）。 */
	function deploymentWithReadiness(
		codex: Readiness | null,
		claude: Readiness = { state: "ready", revision: "claude-r1" },
	): DeploymentConfigurationProjectionV2 {
		const codexTemplate = at(deploymentConfiguration.templates, 0);
		return {
			...deploymentConfiguration,
			templates: [
				...(codex ? [{ ...codexTemplate, readiness: codex }] : []),
				{
					...codexTemplate,
					templateId: "claude",
					displayName: "Claude",
					readiness: claude,
				},
			],
		};
	}
	const readinessItems = () =>
		within(screen.getByRole("list", { name: "模板就绪状态" }))
			.getAllByRole("listitem")
			.map((item) => item.textContent);
	const templateError = () =>
		document.getElementById("application-template-id-error")?.textContent ??
		null;

	// #3364 N12-01：修改申请提交被模板拦下后，部署选项重读使就绪状态再变化（不再提交）。顶部提示与字段错误
	// 都按当前状态实时改写，给出同一个下一步，并与就绪列表一致；顶部提示仍是同一个元素、焦点留在它上面。
	// 模板恢复且验证 revision 与页面一致时二者一起清除，焦点交给页面标题、不落到 body。
	it("rewrites an edited application's template lock and field error from the current readiness (#3364 N12-01)", async () => {
		const onSubmit = vi.fn();
		const renderPage = (codex: Readiness | null) => (
			<div id="main-content" tabIndex={-1}>
				<h1 tabIndex={-1}>修改申请</h1>
				<AgentApplicationForm
					application={pendingApplication}
					action="edit"
					deploymentConfiguration={deploymentWithReadiness(codex)}
					mode="update"
					onSubmit={onSubmit}
					showDeploymentStatus={false}
					submitting={false}
				/>
			</div>
		);
		const { rerender } = render(
			renderPage({ state: "failed", revision: "codex-r1" }),
		);
		const submit = screen.getByRole("button", { name: "修改申请" });
		submit.focus();
		fireEvent.click(submit);
		const alert = screen.getByRole("alert");
		expect(alert.textContent).toBe(
			"此申请的模板暂不可申请，请等待模板恢复后再提交，或新建申请。",
		);
		expect(templateError()).toBe(
			"验证失败，暂不可申请。已有申请不能更换模板，请等待模板恢复后再提交，或新建申请。",
		);
		expect(document.activeElement).toBe(alert);

		const steps: [Readiness | null, string, string, string | undefined][] = [
			[
				{ state: "ready", revision: "codex-r9" },
				"此申请的模板需要重新确认，请刷新页面后再提交。",
				"模板已更新，请刷新后确认。",
				"Codex：可申请",
			],
			[
				{ state: "unavailable", revision: null },
				"此申请的模板需要重新确认，请刷新页面后再提交。",
				"暂时无法读取验证结果，请刷新后重试。",
				"Codex：暂时无法读取验证结果，请刷新后重试。",
			],
			[
				{ state: "stale", revision: null },
				"此申请的模板暂不可申请，请等待模板恢复后再提交，或新建申请。",
				"模板验证已过期，需等待平台重新验证。已有申请不能更换模板，请等待模板恢复后再提交，或新建申请。",
				"Codex：模板验证已过期，需等待平台重新验证。",
			],
			[
				null,
				"当前部署已移除此申请的模板，请新建申请。",
				"该模板已从当前部署移除。已有申请不能更换模板，请新建申请。",
				undefined,
			],
		];
		for (const [codex, alertText, fieldText, listed] of steps) {
			rerender(renderPage(codex));
			expect(screen.getAllByRole("alert")).toEqual([alert]);
			expect(alert.textContent).toBe(alertText);
			expect(templateError()).toBe(fieldText);
			if (listed) expect(readinessItems()).toContain(listed);
			else expect(readinessItems()).toEqual(["Claude：可申请"]);
			expect(document.activeElement).toBe(alert);
		}
		expect(onSubmit).not.toHaveBeenCalled();

		// 恢复为页面读到的同一 revision：顶部提示与字段错误一起清除，焦点交给页面标题。
		rerender(renderPage({ state: "ready", revision: "codex-r1" }));
		expect(screen.queryByRole("alert")).toBeNull();
		expect(templateError()).toBeNull();
		expect(
			screen
				.getByRole("combobox", { name: "标准模板" })
				.getAttribute("aria-invalid"),
		).toBeNull();
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByRole("heading", { name: "修改申请" }),
			),
		);
		// 清除之后状态再变化只给出提交前的提示，不在未提交时重新拦下。
		rerender(renderPage({ state: "failed", revision: "codex-r1" }));
		expect(screen.queryByRole("alert")).toBeNull();
		expect(templateError()).toBeNull();
		expect(
			screen.getByText("验证失败，暂不可申请。", { selector: "p" }),
		).toBeTruthy();
		rerender(renderPage({ state: "ready", revision: "codex-r1" }));
		fireEvent.click(submit);
		expect(onSubmit).toHaveBeenCalledTimes(1);
	});

	// #3364 N12-01：创建申请时字段错误同样随当前就绪原因改写（与就绪列表一致，不被旧原因挡住「模板已更新」），
	// 模板恢复且 revision 与所选时一致时清除。
	it("rewrites a create form's template field error from the current readiness (#3364 N12-01)", () => {
		const onSubmit = vi.fn();
		const renderForm = (codex: Readiness) => (
			<AgentApplicationForm
				deploymentConfiguration={deploymentWithReadiness(codex)}
				mode="create"
				onSubmit={onSubmit}
				showDeploymentStatus={false}
				submitting={false}
			/>
		);
		const { rerender } = render(
			renderForm({ state: "ready", revision: "codex-r1" }),
		);
		fireEvent.change(screen.getByLabelText("Agent 名称"), {
			target: { value: "Release assistant" },
		});
		fireEvent.change(screen.getByLabelText("用途说明"), {
			target: { value: "Helps the release team" },
		});
		choose("标准模板", "Codex");
		rerender(renderForm({ state: "stale", revision: null }));
		const submit = screen.getByRole("button", { name: "提交审批" });
		submit.focus();
		fireEvent.click(submit);
		const template = screen.getByRole("combobox", { name: "标准模板" });
		expect(templateError()).toBe("模板验证已过期，需等待平台重新验证。");
		expect(document.activeElement).toBe(template);

		rerender(renderForm({ state: "ready", revision: "codex-r2" }));
		expect(templateError()).toBe("模板已更新，请刷新后确认。");
		expect(screen.getAllByText("模板已更新，请刷新后确认。")).toHaveLength(1);
		expect(readinessItems()).toEqual(["Codex：可申请", "Claude：可申请"]);
		rerender(renderForm({ state: "failed", revision: null }));
		expect(templateError()).toBe("验证失败，暂不可申请。");
		expect(screen.getAllByText("验证失败，暂不可申请。")).toHaveLength(1);
		expect(document.activeElement).toBe(template);

		rerender(renderForm({ state: "ready", revision: "codex-r1" }));
		expect(templateError()).toBeNull();
		expect(template.getAttribute("aria-invalid")).toBeNull();
		expect(screen.queryByText(/验证失败|模板已更新/)).toBeNull();
		expect(onSubmit).not.toHaveBeenCalled();
	});

	// #3364 N12-02：创建申请时部署里没有一个模板可申请，同「部署没有标准模板」：下拉禁用，就绪列表照常
	// 列出每项原因，字段错误说明没有可申请的模板，不提示「请选择标准模板。」。其中有暂时读不到验证结果的
	// 模板时提示刷新；之后有模板恢复可申请时下拉可用，字段错误随之改为提示选择。
	it.each([
		[
			"unverified",
			{ state: "unverified", revision: null },
			{ state: "unverified", revision: null },
			"当前没有可申请的标准模板，请等待模板完成验证或联系平台管理员。",
		],
		[
			"mixed",
			{ state: "failed", revision: null },
			{ state: "unregistered", revision: null },
			"当前没有可申请的标准模板，请等待模板完成验证或联系平台管理员。",
		],
		[
			"unavailable",
			{ state: "stale", revision: null },
			{ state: "unavailable", revision: null },
			"当前没有可申请的标准模板，请刷新后重试。",
		],
	] as const)(
		"explains that no template can be applied for when all are %s (#3364 N12-02)",
		(_name, codex, claude, message) => {
			const onSubmit = vi.fn();
			const renderForm = (ready = false) => (
				<AgentApplicationForm
					deploymentConfiguration={deploymentWithReadiness(
						codex,
						ready ? { state: "ready", revision: "claude-r1" } : claude,
					)}
					mode="create"
					onSubmit={onSubmit}
					showDeploymentStatus={false}
					submitting={false}
				/>
			);
			const { rerender } = render(renderForm());
			fireEvent.change(screen.getByLabelText("Agent 名称"), {
				target: { value: "Release assistant" },
			});
			fireEvent.change(screen.getByLabelText("用途说明"), {
				target: { value: "Helps the release team" },
			});
			const template = screen.getByRole("combobox", { name: "标准模板" });
			// 可聚焦的禁用：不能展开，提交被拦下时焦点到它（字段错误经 aria-describedby 说明）。
			expect(template.getAttribute("aria-disabled")).toBe("true");
			expect(template.hasAttribute("disabled")).toBe(false);
			fireEvent.click(template);
			expect(screen.queryByRole("listbox")).toBeNull();
			expect(readinessItems()).toHaveLength(2);
			expect(readinessItems()).not.toContain("Codex：可申请");
			fireEvent.click(screen.getByRole("button", { name: "提交审批" }));
			expect(templateError()).toBe(message);
			expect(screen.queryByText("请选择标准模板。")).toBeNull();
			expect(document.activeElement).toBe(template);
			expect(template.getAttribute("aria-describedby")).toContain(
				"application-template-id-error",
			);
			expect(onSubmit).not.toHaveBeenCalled();

			rerender(renderForm(true));
			expect(template.getAttribute("aria-disabled")).toBeNull();
			expect(templateError()).toBe("请选择标准模板。");
		},
	);

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

	// #3389 N13-08：部署选项读取失败（可重试 503 投影成整份不可用）时，就绪列表仍按 PRD §4 列出四个首发
	// 模板，原因是读不到就绪状态，下一步与部署状态说明一致，不按「尚未登记」请联系平台管理员；不可重试时
	// 请联系管理员。已选模板的下拉按显示名显示，不外露模板 ID。
	for (const retryable of [true, false])
		it(`explains an unreadable deployment in the readiness list (${retryable ? "retryable" : "not retryable"}, #3389 N13-08)`, () => {
			render(
				<AgentApplicationForm
					deploymentConfiguration={unreadableDeployment}
					deploymentConfigurationRetryable={retryable}
					mode="create"
					onSubmit={vi.fn()}
					submitting={false}
				/>,
			);
			const reason = retryable
				? "暂时无法读取就绪状态，请重新加载部署选项。"
				: "暂时无法读取就绪状态，请联系管理员。";
			const list = screen.getByRole("list", { name: "模板就绪状态" });
			expect(
				within(list)
					.getAllByRole("listitem")
					.map((item) => item.textContent),
			).toEqual(
				["Codex", "Claude", "OpenCode", "Pi"].map(
					(name) => `${name}：${reason}`,
				),
			);
			expect(screen.queryByText(/尚未登记/)).toBeNull();
			expect(screen.getByRole("status").textContent).toBe(
				retryable
					? "部署选项暂不可用，请重新加载；标准模板申请暂不能提交。"
					: "部署选项暂不可用，请联系管理员。",
			);
		});

	it("shows the display name of an edited application's template while the deployment is unreadable (#3389 N13-08)", () => {
		render(
			<AgentApplicationForm
				action="edit"
				application={pendingApplication}
				deploymentConfiguration={unreadableDeployment}
				deploymentConfigurationRetryable
				mode="update"
				onSubmit={vi.fn()}
				submitting={false}
			/>,
		);
		const template = screen.getByRole("combobox", { name: "标准模板" });
		expect(template.textContent).toContain("Codex");
		expect(template.textContent).not.toContain("codex");
		expect(screen.queryByText(/\bcodex\b/)).toBeNull();
	});

	it("names an unknown template neutrally instead of exposing its ID while the deployment is unreadable (#3389 N13-08)", () => {
		render(
			<AgentApplicationForm
				action="edit"
				application={AgentApplicationProjectionV2Schema.parse({
					...pendingApplication,
					source: { kind: "standard", templateId: "internal-template-7" },
				})}
				deploymentConfiguration={unreadableDeployment}
				mode="update"
				onSubmit={vi.fn()}
				submitting={false}
			/>,
		);
		const template = screen.getByRole("combobox", { name: "标准模板" });
		expect(template.textContent).toContain("标准模板");
		expect(document.body.textContent).not.toContain("internal-template-7");
	});

	// #3389 N13-10：部署选项读取失败时提交标准模板申请：被拦下、不发请求；「标准模板」与模型选择器都禁用，
	// 不对禁用的模型选择器列「请选择…」，焦点交给部署状态说明，不留在提交按钮上。
	it("hands focus to the deployment status instead of disabled model choices while the deployment is unreadable (#3389 N13-10)", () => {
		const onSubmit = vi.fn();
		render(
			<AgentApplicationForm
				deploymentConfiguration={unreadableDeployment}
				deploymentConfigurationRetryable
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
		const submit = screen.getByRole("button", { name: "提交审批" });
		submit.focus();
		fireEvent.click(submit);

		expect(onSubmit).not.toHaveBeenCalled();
		expect(
			document.getElementById("application-template-id-error")?.textContent,
		).toBe("部署选项暂不可用，请重新加载；标准模板申请暂不能提交。");
		for (const message of [
			"请选择模型端点。",
			"请选择模型。",
			"至少选择一个推理档位。",
			"请选择默认模型。",
			"请选择默认推理档位。",
			"至少添加一个模型选项。",
			"请输入 Agent 默认 Relay Key。",
		])
			expect(screen.queryByText(message)).toBeNull();
		expect(document.activeElement).toBe(screen.getByRole("status"));
	});

	// #3389 N13-08：下拉展开时部署选项重读失败、下拉随之禁用：弹层一起收起，不留一个展开却不能操作的
	// 菜单；焦点不落到 body。
	it("closes an open template menu when a reread disables it (#3389 N13-08)", async () => {
		const props = {
			mode: "create" as const,
			onSubmit: vi.fn(),
			submitting: false,
		};
		const { rerender } = render(<AgentApplicationForm {...props} />);
		const template = screen.getByRole("combobox", { name: "标准模板" });
		fireEvent.click(template);
		await waitFor(() => expect(screen.getByRole("listbox")).toBeTruthy());
		expect(template.getAttribute("aria-expanded")).toBe("true");

		rerender(
			<AgentApplicationForm
				{...props}
				deploymentConfiguration={unreadableDeployment}
				deploymentConfigurationRetryable
			/>,
		);
		expect(template).toHaveProperty("disabled", true);
		await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
		expect(template.getAttribute("aria-expanded")).toBe("false");
		expect(document.activeElement).not.toBe(document.body);
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
		// 需求变化（#3268 N8-2-05）：与 Owner 配置共用模型选择器，模型列表组名为「允许的模型」。
		await screen.findByRole("group", { name: "允许的模型" });
		expect(check).toHaveBeenCalledWith(key);
		// 当前模型预先勾选，Key 可见的另一个模型可选。
		// 需求变化（#3215 G5-12 / #3212）：候选按部署目录写「{端点显示名} · {模型}」，不显示原始端点 ID。
		expect(
			screen
				.getByRole("checkbox", { name: "Primary endpoint · gpt-5" })
				.getAttribute("aria-checked"),
		).toBe("true");
		expect(
			screen
				.getByRole("checkbox", { name: "Primary endpoint · gpt-5-mini" })
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
		// 需求变化（#3268 N8-2-05）：与 Owner 配置共用模型选择器，模型列表组名为「允许的模型」。
		await screen.findByRole("group", { name: "允许的模型" });
		fireEvent.click(
			screen.getByRole("checkbox", { name: "Primary endpoint · gpt-5-mini" }),
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
		// G5-12：页面显示中文档位，请求仍提交原始档位与端点（#3212 AC-2）。
		expect(
			body.modelConfiguration.options.map(
				(o: { endpointId: string; reasoningLevels: string[] }) => [
					o.endpointId,
					[...o.reasoningLevels].sort(),
				],
			),
		).toEqual([
			["endpoint-primary", ["high", "medium"]],
			["endpoint-primary", ["low"]],
		]);
		expect(body.modelConfiguration.defaultReasoningLevel).toBe("medium");
	});

	it("shows endpoint display names and Chinese reasoning levels in the candidate picker (G5-12)", async () => {
		renderManaged();
		fireEvent.click(screen.getByRole("checkbox", { name: "修改模型配置" }));
		fireEvent.change(screen.getByLabelText("Agent 默认 Relay Key"), {
			target: { value: key },
		});
		fireEvent.click(screen.getByRole("button", { name: "检查可用模型" }));
		// 需求变化（#3268 N8-2-05）：修改申请与 Owner 配置共用同一个模型选择器——模型列表为
		// 「允许的模型」组，默认项是单个「默认模型选项」（{模型} · {档位}），不再拆成两个下拉。
		await screen.findByRole("group", { name: "允许的模型" });
		const picker = screen.getByRole("group", { name: "允许的模型" });
		const pickerRoot = document.getElementById("application-keyless-model");
		if (!pickerRoot) throw new Error("model picker missing");
		expect(
			within(picker).getByRole("checkbox", {
				name: "均衡：Primary endpoint · gpt-5",
			}),
		).toBeTruthy();
		expect(
			within(picker).getByRole("checkbox", {
				name: "高：Primary endpoint · gpt-5",
			}),
		).toBeTruthy();
		const defaultOption =
			within(pickerRoot).getByLabelText<HTMLSelectElement>("默认模型选项");
		expect(
			[...defaultOption.options].map((option) => option.textContent),
		).toEqual([
			"Primary endpoint · gpt-5 · 高",
			"Primary endpoint · gpt-5 · 均衡",
		]);
		expect(defaultOption.value).toBe("endpoint-primary:gpt-5|medium");
		expect(within(pickerRoot).queryByLabelText("默认推理档位")).toBeNull();
		expect(pickerRoot.textContent).not.toMatch(/endpoint-primary|medium|high/);
		// 说明与 Owner 配置同级（.keyless-model-description，13px）。
		expect(
			pickerRoot.querySelector(".keyless-model-description")?.textContent,
		).toBe(
			"只列出该 Key 可见、且模板支持的模型。勾选后可调整推理档位和默认模型选项。",
		);
	});

	// #3268 N8-2-05：检查成功但没有可用模型时给出与 Owner 配置一致的 warn 提示，拦截文案说明的是
	// 「没有可用模型」而不是「请先检查」。
	it("explains a checked Key without usable models and blocks with a matching message", async () => {
		const { onSubmit } = renderManaged(
			vi.fn().mockResolvedValue({ ...candidates, candidates: [] }),
		);
		fireEvent.click(screen.getByRole("checkbox", { name: "修改模型配置" }));
		fireEvent.change(screen.getByLabelText("Agent 默认 Relay Key"), {
			target: { value: key },
		});
		fireEvent.click(screen.getByRole("button", { name: "检查可用模型" }));
		const notice = await screen.findByText("该 Key 没有此模板可用的模型");
		const alert = notice.closest('[data-slot="alert"]');
		expect(alert?.getAttribute("data-tone")).toBe("warn");
		expect(alert?.getAttribute("role")).toBe("status");
		expect(screen.queryByRole("group", { name: "允许的模型" })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "修改申请" }));
		const error = screen.getByText(
			"该 Key 没有此模板可用的模型，请换一个 Key 后重新检查。",
		);
		expect(error.getAttribute("data-slot")).toBe("field-error");
		expect(error.getAttribute("aria-live")).toBe("polite");
		expect(screen.queryByText(/请先点击「检查可用模型」/)).toBeNull();
		expect(onSubmit).not.toHaveBeenCalled();
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

	// #3291 N9-2-02：修改申请里选择器的字段错误与 Key 字段的拦截错误、申请表单其余字段一样用 polite，
	// 页面上没有 role=alert 打断播报；焦点在 Key 输入框。
	it("announces the picker problem politely next to the Key field error", async () => {
		const { onSubmit } = renderManaged();
		fireEvent.click(screen.getByRole("checkbox", { name: "修改模型配置" }));
		fireEvent.change(screen.getByLabelText("Agent 默认 Relay Key"), {
			target: { value: key },
		});
		fireEvent.click(screen.getByRole("button", { name: "检查可用模型" }));
		await screen.findByRole("group", { name: "允许的模型" });
		fireEvent.click(
			screen.getByRole("checkbox", { name: "Primary endpoint · gpt-5" }),
		);
		const problem = screen.getByText("至少选择一个模型。");
		expect(problem.getAttribute("data-slot")).toBe("field-error");
		expect(problem.getAttribute("aria-live")).toBe("polite");
		expect(problem.getAttribute("role")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "修改申请" }));
		const keyError = screen.getByText(
			"请在下方选好模型（至少一个模型，每个模型至少一个推理档位）。",
		);
		expect(keyError.getAttribute("aria-live")).toBe("polite");
		expect(screen.queryAllByRole("alert")).toEqual([]);
		expect(document.activeElement).toBe(
			screen.getByLabelText("Agent 默认 Relay Key"),
		);
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
		// #3242 K7-02：页脚移到 fieldset 之后（提交进行中字段由 fieldset 禁用，提交按钮仍可聚焦），
		// 仍紧跟在高级配置之后。
		const order = [
			...Array.from(fields.children),
			...(fields.nextElementSibling ? [fields.nextElementSibling] : []),
		].map((child) =>
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
