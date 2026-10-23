import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/components/ui/toast";

import { AgentApplicationSubmissionScreen as AgentApplicationSubmissionScreenView } from "./agent-application-submission-screen.js";
import {
	deploymentConfiguration,
	pendingApplication,
} from "./test-fixtures.js";
import { renderWithMyAgentsRouter as renderInRouter } from "./test-router.js";

// 提交结果用 Toast 补充确认（G4-14）：与根布局一样包一层 Toast 宿主。
function renderWithMyAgentsRouter(content: ReactNode) {
	return renderInRouter(<ToastProvider>{content}</ToastProvider>);
}

/** 页内提交结果获得焦点（读屏读出），Toast 是唯一的 live 播报（G4-14）。 */
async function expectSubmittedFeedback() {
	const notice = screen
		.getByText("申请已提交：待审批。")
		.closest('[data-slot="alert"]');
	await waitFor(() => expect(document.activeElement).toBe(notice));
	expect(notice?.getAttribute("role")).toBeNull();
	const toast = document.querySelector('[data-slot="toast"]');
	await waitFor(() =>
		expect(toast?.textContent).toBe("申请已提交，已进入系统管理员审批队列"),
	);
	expect(
		screen
			.getAllByRole("status")
			.filter((node) => node.textContent?.includes("申请已提交")),
	).toEqual([toast]);
}

const rejectedApplication = {
	...pendingApplication,
	status: "rejected" as const,
	decision: {
		decidedAt: "2026-09-07T00:00:00Z",
		reason: "Capacity is unavailable",
	},
};

type ScreenProps<T> = T extends unknown
	? Omit<
			T,
			| "deploymentConfiguration"
			| "onRefreshDeploymentConfiguration"
			| "refreshingDeploymentConfiguration"
		>
	: never;

function AgentApplicationSubmissionScreen(
	props: ScreenProps<
		Parameters<typeof AgentApplicationSubmissionScreenView>[0]
	>,
) {
	return (
		<AgentApplicationSubmissionScreenView
			{...props}
			deploymentConfiguration={deploymentConfiguration}
			onRefreshDeploymentConfiguration={vi.fn()}
			refreshingDeploymentConfiguration={false}
		/>
	);
}

function creationHeader() {
	const header = screen.getByRole("heading", { level: 1 }).closest("header");
	if (!header) throw new Error("Missing creation header");
	return within(header);
}

// N-03：页头没有退出入口，唯一的「取消」在表单 footer 左侧，是 ghost 按钮。
function expectSingleFooterCancel(href: string) {
	expect(creationHeader().queryAllByRole("link")).toHaveLength(0);
	expect(creationHeader().queryAllByRole("button")).toHaveLength(0);
	const cancels = screen.getAllByRole("link", { name: "取消" });
	expect(cancels).toHaveLength(1);
	const cancel = cancels[0] as HTMLElement;
	expect(cancel.getAttribute("href")).toBe(href);
	expect(cancel.closest(".form-footer")).not.toBeNull();
	expect(cancel.className).toContain("text-muted-foreground");
	expect(cancel.className).not.toContain("bg-card");
	return cancel;
}

describe("AgentApplicationSubmissionScreen", () => {
	it("renders a server-projected create result without exposing request values", async () => {
		await renderWithMyAgentsRouter(
			<AgentApplicationSubmissionScreen
				mode="create"
				onSubmit={vi.fn()}
				result={pendingApplication}
				submitting={false}
			/>,
		);

		expect(screen.getByRole("heading", { name: "申请已提交" })).toBeTruthy();
		await expectSubmittedFeedback();
		expect(
			screen.getByRole("link", { name: "查看申请详情" }).getAttribute("href"),
		).toBe("/my-agents/application%3Atenant%2F01%3Fdraft%23one%25");
		expect(screen.queryByRole("button", { name: "提交审批" })).toBeNull();
		expect(screen.queryByText("MODEL_API_KEY")).toBeNull();
		// 提交成功后表单（及 footer）不再渲染，结果下方给出返回入口；页头仍没有操作。
		expect(creationHeader().queryAllByRole("link")).toHaveLength(0);
		expect(
			screen.getByRole("link", { name: "返回我的 Agent" }).getAttribute("href"),
		).toBe("/my-agents");
		expect(screen.queryByText("退出创建")).toBeNull();
	});

	it("distinguishes retryable submission errors from changed application state", async () => {
		const first = await renderWithMyAgentsRouter(
			<AgentApplicationSubmissionScreen
				error={Object.assign(new Error("private transport detail"), {
					retryable: true,
				})}
				mode="create"
				onSubmit={vi.fn()}
				submitting={false}
			/>,
		);
		expect(screen.getByRole("alert").textContent).toBe(
			"申请提交失败，非敏感内容已保留。请重新填写 Secret 或模型凭证后再提交。",
		);
		expect(screen.queryByText("private transport detail")).toBeNull();
		expectSingleFooterCancel("/my-agents");
		first.unmount();

		const second = await renderWithMyAgentsRouter(
			<AgentApplicationSubmissionScreen
				error={Object.assign(new Error("private authorization detail"), {
					retryable: false,
				})}
				mode="create"
				onSubmit={vi.fn()}
				submitting={false}
			/>,
		);
		expect(screen.getByRole("alert").textContent).toBe(
			"申请已变更或当前不可用，请刷新页面后核对。",
		);
		expectSingleFooterCancel("/my-agents");
		second.unmount();

		await renderWithMyAgentsRouter(
			<AgentApplicationSubmissionScreen
				error={Object.assign(new Error("invalid request"), {
					code: "INVALID_REQUEST",
					retryable: false,
				})}
				mode="create"
				onSubmit={vi.fn()}
				submitting={false}
			/>,
		);
		expect(screen.getByRole("alert").textContent).toBe(
			"申请内容未通过服务端校验，请检查字段后重试。",
		);
		expectSingleFooterCancel("/my-agents");
	});

	// #3268 N8-2-03：服务端整表校验失败只说明一次（页面顶部的 role=alert），焦点移到这条提示，
	// 不再落到整张表单，表单内也没有第二条措辞相近的提示。
	it("focuses the single submission alert for a server invalid-request error", async () => {
		await renderWithMyAgentsRouter(
			<AgentApplicationSubmissionScreen
				error={Object.assign(new Error("invalid request"), {
					code: "INVALID_REQUEST",
					retryable: false,
				})}
				mode="create"
				onSubmit={vi.fn()}
				submitting={false}
			/>,
		);
		const alert = screen.getByRole("alert");
		expect(alert.textContent).toBe(
			"申请内容未通过服务端校验，请检查字段后重试。",
		);
		expect(screen.getAllByText(/未通过服务端校验/)).toHaveLength(1);
		expect(alert.getAttribute("tabindex")).toBe("-1");
		await waitFor(() => expect(document.activeElement).toBe(alert));
		const form = document.querySelector("form");
		expect(form?.hasAttribute("tabindex")).toBe(false);
	});

	// #3034：部署未提供平台身份入口的拒绝按字段校验处理，原因写在入口身份字段下。
	it("treats a missing platform identity entry as a field validation rejection", async () => {
		await renderWithMyAgentsRouter(
			<AgentApplicationSubmissionScreen
				error={Object.assign(new Error("private deployment detail"), {
					code: "ACTION_UNAVAILABLE",
					retryable: false,
				})}
				mode="create"
				onSubmit={vi.fn()}
				submitting={false}
			/>,
		);
		expect(screen.getByRole("alert").textContent).toBe(
			"申请内容未通过服务端校验，请检查字段后重试。",
		);
		expect(screen.queryByText("private deployment detail")).toBeNull();
		expectSingleFooterCancel("/my-agents");
	});

	// #3291 N9-2-03：修改申请不能更改入口身份。顶部提示不再引导「检查字段后重试」，而是提示新建申请，
	// 焦点移到这条提示（只读的入口身份下拉无法获得焦点）；字段下的说明与之一致，再次提交仍被拦下。
	it("points an existing platform identity application to a new application from the focused top alert", async () => {
		const onSubmit = vi.fn();
		await renderWithMyAgentsRouter(
			<AgentApplicationSubmissionScreen
				action="resubmit"
				application={{
					...rejectedApplication,
					source: {
						kind: "custom",
						imageReference: "registry.example/agents/release:v1",
						interactionMode: "self-managed",
						identityResponsibility: "platform-managed",
					},
					configuration: {
						...rejectedApplication.configuration,
						modelOptions: [],
						defaultModelOptionId: null,
						defaultReasoningLevel: null,
					},
				}}
				error={Object.assign(new Error("private deployment detail"), {
					code: "ACTION_UNAVAILABLE",
					retryable: false,
				})}
				mode="update"
				onSubmit={onSubmit}
				submitting={false}
			/>,
		);
		const alert = screen.getByRole("alert");
		expect(alert.textContent).toBe(
			"当前部署不支持此申请的入口身份校验，请新建申请。",
		);
		expect(screen.queryByText(/检查字段后重试/)).toBeNull();
		expect(alert.getAttribute("tabindex")).toBe("-1");
		await waitFor(() => expect(document.activeElement).toBe(alert));
		const identity = screen.getByRole("combobox", { name: "入口身份校验" });
		expect(
			document.getElementById(identity.getAttribute("aria-describedby") ?? "")
				?.textContent,
		).toBe(
			"当前部署未启用平台身份入口。已有申请不能更改入口身份校验，请新建申请并选择「由自有入口校验」。",
		);
		const submit = screen.getByRole("button", { name: "修改并重新提交" });
		submit.focus();
		fireEvent.click(submit);
		expect(onSubmit).not.toHaveBeenCalled();
		await waitFor(() => expect(document.activeElement).toBe(alert));
		expect(screen.queryByText("private deployment detail")).toBeNull();
	});

	// #3328 N10-2-02：修改申请的模板已从部署移除。顶部同一位置的提示说明请新建申请并获得焦点，
	// 页面只有这一条 danger 提示，不发请求。
	it("points an edited application whose template was removed to a new application from the single top alert", async () => {
		const onSubmit = vi.fn();
		await renderWithMyAgentsRouter(
			<AgentApplicationSubmissionScreen
				action="resubmit"
				application={{
					...rejectedApplication,
					source: { kind: "standard", templateId: "removed-template" },
				}}
				mode="update"
				onSubmit={onSubmit}
				submitting={false}
			/>,
		);
		expect(screen.queryByRole("alert")).toBeNull();
		const submit = screen.getByRole("button", { name: "修改并重新提交" });
		submit.focus();
		fireEvent.click(submit);
		const alert = screen.getByRole("alert");
		expect(screen.getAllByRole("alert")).toHaveLength(1);
		expect(alert.className).toContain("application-form-alert");
		expect(alert.textContent).toBe("当前部署已移除此申请的模板，请新建申请。");
		await waitFor(() => expect(document.activeElement).toBe(alert));
		expect(screen.queryByText(/重新选择|重新加载/)).toBeNull();
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("offers one ghost footer cancel and leaves without submitting", async () => {
		const onSubmit = vi.fn();
		await renderWithMyAgentsRouter(
			<AgentApplicationSubmissionScreen
				mode="create"
				onSubmit={onSubmit}
				submitting={false}
			/>,
		);
		const cancel = expectSingleFooterCancel("/my-agents");
		expect(screen.queryByText("退出创建")).toBeNull();
		expect(screen.getByText("我的管理 / 创建申请")).toBeTruthy();
		// 设计 #application-form：h1「创建 Agent」，副标题为设计原文去掉「渠道」（随 #2862 M-10 决定）。
		const heading = screen.getByRole("heading", { level: 1 });
		expect(heading.textContent).toBe("创建 Agent");
		expect(heading.nextElementSibling?.textContent).toBe(
			"填写使用场景，再配置 Owner、范围和模型。提交时会重新校验字段。",
		);
		fireEvent.click(cancel);
		await waitFor(() => {
			expect(screen.queryByRole("heading", { name: "创建 Agent" })).toBeNull();
		});
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it.each(["edit", "resubmit"] as const)(
		"keeps the original application cancellation destination for %s",
		async (action) => {
			await renderWithMyAgentsRouter(
				<AgentApplicationSubmissionScreen
					mode="update"
					action={action}
					application={
						action === "resubmit" ? rejectedApplication : pendingApplication
					}
					onSubmit={vi.fn()}
					submitting={false}
				/>,
			);
			expectSingleFooterCancel(
				"/my-agents/application%3Atenant%2F01%3Fdraft%23one%25",
			);
			expect(screen.queryByText("退出创建")).toBeNull();
			// NI-101：编辑页 eyebrow 与面包屑「编辑申请」一致。
			expect(screen.getByText("我的管理 / 编辑申请")).toBeTruthy();
		},
	);

	it("disables the single creation cancel while submission is pending", async () => {
		const onSubmit = vi.fn();
		await renderWithMyAgentsRouter(
			<AgentApplicationSubmissionScreen
				mode="create"
				onSubmit={onSubmit}
				submitting
			/>,
		);
		expect(screen.queryByRole("link", { name: "取消" })).toBeNull();
		const exits = screen.getAllByText("取消");
		expect(exits).toHaveLength(1);
		for (const exit of exits) {
			expect(exit.getAttribute("aria-disabled")).toBe("true");
			expect(exit.getAttribute("href")).toBeNull();
			expect(exit.tabIndex).toBe(-1);
			expect(exit.closest(".form-footer")).not.toBeNull();
			fireEvent.click(exit);
		}
		expect(creationHeader().queryByText("取消")).toBeNull();
		expect(onSubmit).not.toHaveBeenCalled();
		// #3242 K7-02：提交进行中「正在提交…」是可聚焦的禁用（aria-disabled），不再是原生 disabled。
		const submitting = screen.getByRole("button", { name: "正在提交…" });
		expect(submitting.getAttribute("aria-disabled")).toBe("true");
		expect(submitting.hasAttribute("disabled")).toBe(false);
	});

	it.each(["edit", "resubmit"] as const)(
		"keeps cancellation disabled while %s is pending",
		async (action) => {
			await renderWithMyAgentsRouter(
				<AgentApplicationSubmissionScreen
					mode="update"
					action={action}
					application={
						action === "resubmit" ? rejectedApplication : pendingApplication
					}
					onSubmit={vi.fn()}
					submitting
				/>,
			);
			expect(screen.queryByRole("link", { name: "取消" })).toBeNull();
			expect(screen.getByText("取消").getAttribute("aria-disabled")).toBe(
				"true",
			);
			expect(screen.queryByText("退出创建")).toBeNull();
		},
	);

	it("keeps the update result details without adding a creation exit", async () => {
		await renderWithMyAgentsRouter(
			<AgentApplicationSubmissionScreen
				mode="update"
				action="edit"
				application={pendingApplication}
				onSubmit={vi.fn()}
				result={pendingApplication}
				submitting={false}
			/>,
		);
		await expectSubmittedFeedback();
		expect(
			screen.getByRole("link", { name: "查看申请详情" }).getAttribute("href"),
		).toBe("/my-agents/application%3Atenant%2F01%3Fdraft%23one%25");
		expect(screen.queryByText("退出创建")).toBeNull();
	});

	it("offers a refresh when only the model catalog is empty", async () => {
		await renderWithMyAgentsRouter(
			<AgentApplicationSubmissionScreenView
				mode="create"
				onRefreshDeploymentConfiguration={vi.fn()}
				onSubmit={vi.fn()}
				refreshingDeploymentConfiguration={false}
				deploymentConfigurationRetryable={true}
				result={undefined}
				submitting={false}
				deploymentConfiguration={{
					...deploymentConfiguration,
					modelCatalog: {
						...deploymentConfiguration.modelCatalog,
						status: "empty",
					},
				}}
			/>,
		);

		expect(
			screen.getByRole("button", { name: "重新加载部署选项" }),
		).toBeTruthy();
	});

	it("does not retry when deployment classification is missing", async () => {
		await renderWithMyAgentsRouter(
			<AgentApplicationSubmissionScreenView
				mode="create"
				onRefreshDeploymentConfiguration={vi.fn()}
				onSubmit={vi.fn()}
				refreshingDeploymentConfiguration={false}
				result={undefined}
				submitting={false}
				deploymentConfiguration={{
					...deploymentConfiguration,
					status: "unavailable",
					modelCatalog: {
						...deploymentConfiguration.modelCatalog,
						status: "unavailable",
					},
				}}
			/>,
		);

		expect(
			screen.getAllByText("部署选项暂不可用，请联系管理员。").length,
		).toBeGreaterThan(0);
		expect(
			screen.queryByRole("button", { name: "重新加载部署选项" }),
		).toBeNull();
	});
});
