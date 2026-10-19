import { AgentApplicationProjectionV2Schema } from "@agent-infra/contracts/pilot";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MyAgentApplicationDetailScreen } from "./my-agent-application-detail-screen.js";
import { pendingApplication } from "./test-fixtures.js";
import { renderWithMyAgentsRouter } from "./test-router.js";

const originalTimeZone = process.env.TZ;
afterEach(() => {
	// 原值为空时删除变量，避免写入字符串 "undefined"。
	if (originalTimeZone === undefined) delete process.env.TZ;
	else process.env.TZ = originalTimeZone;
	vi.unstubAllGlobals();
});

/** 时间按本地时区显示在 <time> 中，悬停 title 为完整本地时间，不出现 ISO 原文。 */
function expectLocalTimestamp(value: string, full: string) {
	const time = document.querySelector(`time[datetime="${value}"]`);
	expect(time?.getAttribute("title")).toBe(full);
	expect(document.body.textContent).not.toContain(value);
}

function progressRow(step: "submitted" | "approval" | "creation") {
	const row = document.querySelector(
		`.application-progress li[data-step="${step}"]`,
	);
	if (!(row instanceof HTMLElement)) throw new Error(`Missing ${step} row`);
	return row;
}

describe("MyAgentApplicationDetailScreen", () => {
	it.each([
		["pending_approval", false],
		["rejected", false],
		["withdrawn", false],
		["creating", true],
		["available", true],
		["stopped", true],
		["creation_failed", true],
		["disabled", true],
	] as const)(
		"shows an Agent entrance only after creation has begun (%s)",
		async (status, hasAgentEntrance) => {
			const application = AgentApplicationProjectionV2Schema.parse({
				...pendingApplication,
				agentId: "agent-reserved-before-approval",
				status,
			});
			await renderWithMyAgentsRouter(
				<MyAgentApplicationDetailScreen
					onWithdraw={vi.fn()}
					state={{ kind: "ready", application }}
					withdrawing={false}
				/>,
			);

			const link = screen.queryByRole("link", { name: "查看 Agent" });
			if (hasAgentEntrance) {
				expect(link?.getAttribute("href")).toBe(
					"/agents/agent-reserved-before-approval",
				);
			} else {
				expect(link).toBeNull();
			}
			expect(screen.getByRole("link", { name: "返回我的 Agent" })).toBeTruthy();
		},
	);

	it("renders a pending projection and lets the applicant withdraw it", async () => {
		const onWithdraw = vi.fn();
		await renderWithMyAgentsRouter(
			<MyAgentApplicationDetailScreen
				onWithdraw={onWithdraw}
				state={{ kind: "ready", application: pendingApplication }}
				withdrawing={false}
			/>,
		);

		expect(
			screen.getByRole("heading", { name: "Release assistant request" }),
		).toBeTruthy();
		expect(screen.getByText("待审批")).toBeTruthy();
		expect(
			screen.getByRole("link", { name: "返回我的 Agent" }).getAttribute("href"),
		).toBe("/my-agents");
		expect(
			screen.getByRole("link", { name: "修改申请" }).getAttribute("href"),
		).toBe("/my-agents/application%3Atenant%2F01%3Fdraft%23one%25/edit");
		expect(screen.queryByRole("link", { name: "查看 Agent" })).toBeNull();
		expect(screen.queryByText("MODEL_API_KEY")).toBeNull();
		expect(screen.queryByText("Owner settings")).toBeNull();
		expect(screen.queryByText("Approve application")).toBeNull();
		const withdraw = screen.getByRole("button", { name: "撤回申请" });
		fireEvent.click(withdraw);
		expect(screen.getByRole("dialog", { name: "撤回这条申请？" })).toBeTruthy();
		expect(onWithdraw).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "继续保留申请" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		await waitFor(() => expect(document.activeElement).toBe(withdraw));
		expect(onWithdraw).not.toHaveBeenCalled();
		fireEvent.click(withdraw);
		fireEvent.click(screen.getByRole("button", { name: "确认撤回" }));
		expect(onWithdraw).toHaveBeenCalledOnce();
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});

	it("renders a rejected application history without lifecycle controls", async () => {
		process.env.TZ = "Asia/Shanghai";
		const rejectedApplication = AgentApplicationProjectionV2Schema.parse({
			...pendingApplication,
			applicationId: "application-pilot-rejected",
			status: "rejected",
			decision: {
				decidedAt: "2026-09-03T09:00:00Z",
				reason: "Resource capacity is currently unavailable.",
			},
		});
		await renderWithMyAgentsRouter(
			<MyAgentApplicationDetailScreen
				onWithdraw={vi.fn()}
				state={{ kind: "ready", application: rejectedApplication }}
				withdrawing={false}
			/>,
		);

		// 「已驳回」同时出现在审批进度标题旁的状态 chip 与审批步骤 chip（M-11），分别限定位置断言。
		expect(
			document.querySelector('.section-heading [data-slot="badge"]')
				?.textContent,
		).toBe("已驳回");
		expect(
			within(progressRow("approval")).getByText("已驳回").dataset.tone,
		).toBe("red");
		expect(screen.getByText("审批原因：")).toBeTruthy();
		expect(
			screen.getByText("Resource capacity is currently unavailable."),
		).toBeTruthy();
		expect(screen.getByText(/提交于/)).toBeTruthy();
		expectLocalTimestamp("2026-09-03T08:00:00Z", "2026 年 9 月 3 日 16:00:00");
		expectLocalTimestamp("2026-09-03T09:00:00Z", "2026 年 9 月 3 日 17:00:00");
		expect(screen.queryByRole("button", { name: "撤回申请" })).toBeNull();
		expect(
			screen.getByRole("link", { name: "修改并重新提交" }).getAttribute("href"),
		).toBe("/my-agents/application-pilot-rejected/edit");
		expect(screen.queryByText(/owner settings/i)).toBeNull();
	});

	it("renders an approved decision history without inventing a rejection reason", async () => {
		process.env.TZ = "Asia/Shanghai";
		const approvedApplication = AgentApplicationProjectionV2Schema.parse({
			...pendingApplication,
			applicationId: "application-pilot-approved",
			agentId: "agent-pilot-approved",
			status: "creating",
			decision: {
				decidedAt: "2026-09-03T10:00:00Z",
				reason: null,
			},
		});
		await renderWithMyAgentsRouter(
			<MyAgentApplicationDetailScreen
				onWithdraw={vi.fn()}
				state={{ kind: "ready", application: approvedApplication }}
				withdrawing={false}
			/>,
		);

		expect(screen.getByText("创建中")).toBeTruthy();
		expect(screen.getByText("审批时间")).toBeTruthy();
		expectLocalTimestamp("2026-09-03T10:00:00Z", "2026 年 9 月 3 日 18:00:00");
		expect(screen.queryByText("审批原因：")).toBeNull();
	});

	it("keeps unavailable details opaque and does not direct a withdrawal error to retry", async () => {
		const unavailable = await renderWithMyAgentsRouter(
			<MyAgentApplicationDetailScreen
				onWithdraw={vi.fn()}
				state={{ kind: "unavailable", retryable: false }}
				withdrawing={false}
			/>,
		);

		expect(screen.getByRole("alert").textContent).toBe("当前无法查看此申请。");
		expect(screen.queryByText("Release assistant request")).toBeNull();
		expect(screen.queryByRole("button", { name: "撤回申请" })).toBeNull();
		unavailable.unmount();

		await renderWithMyAgentsRouter(
			<MyAgentApplicationDetailScreen
				onWithdraw={vi.fn()}
				state={{ kind: "ready", application: pendingApplication }}
				withdrawalError
				withdrawing={false}
			/>,
		);
		expect(screen.getByRole("alert").textContent).toBe(
			"暂未确认撤回结果，请先查看申请的最新状态。",
		);
		expect(screen.queryByText(/try again/i)).toBeNull();
		expect(document.activeElement).toBe(
			screen.getByRole("button", { name: "撤回申请" }),
		);
	});

	it("renders a retryable detail failure without a stale application", async () => {
		await renderWithMyAgentsRouter(
			<MyAgentApplicationDetailScreen
				onWithdraw={vi.fn()}
				state={{ kind: "unavailable", retryable: true }}
				withdrawing={false}
			/>,
		);

		expect(screen.getByRole("alert").textContent).toBe(
			"暂时无法读取申请，请稍后重试。",
		);
		expect(screen.queryByText("Release assistant request")).toBeNull();
	});

	it("prevents another withdrawal while its request is pending", async () => {
		const onWithdraw = vi.fn();
		await renderWithMyAgentsRouter(
			<MyAgentApplicationDetailScreen
				onWithdraw={onWithdraw}
				state={{ kind: "ready", application: pendingApplication }}
				withdrawing
			/>,
		);
		const button = screen.getByRole("button", { name: "正在撤回…" });
		expect(button.hasAttribute("disabled")).toBe(true);
		fireEvent.click(button);
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(onWithdraw).not.toHaveBeenCalled();
	});

	it("latches withdrawal before the parent exposes pending state", async () => {
		const onWithdraw = vi.fn();
		await renderWithMyAgentsRouter(
			<MyAgentApplicationDetailScreen
				onWithdraw={onWithdraw}
				state={{ kind: "ready", application: pendingApplication }}
				withdrawing={false}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "撤回申请" }));
		fireEvent.click(screen.getByRole("button", { name: "确认撤回" }));

		expect(onWithdraw).toHaveBeenCalledOnce();
		const withdraw = screen.getByRole("button", { name: "正在撤回…" });
		expect(withdraw.hasAttribute("disabled")).toBe(true);
		fireEvent.click(withdraw);
		expect(onWithdraw).toHaveBeenCalledOnce();
	});

	it("shows a withdrawn application as read-only history and focuses the projected result", async () => {
		const withdrawn = AgentApplicationProjectionV2Schema.parse({
			...pendingApplication,
			status: "withdrawn",
		});
		await renderWithMyAgentsRouter(
			<MyAgentApplicationDetailScreen
				onWithdraw={vi.fn()}
				state={{ kind: "ready", application: withdrawn }}
				withdrawing={false}
				withdrawalResult={withdrawn}
			/>,
		);
		expect(
			screen.getByText("此记录为只读历史。再次申请请从“我的 Agent”新建。"),
		).toBeTruthy();
		expect(screen.queryByRole("button", { name: "撤回申请" })).toBeNull();
		expect(screen.queryByRole("link", { name: "修改申请" })).toBeNull();
		const result = screen.getByRole("status");
		expect(result.textContent).toBe("撤回请求已提交：已撤回。");
		expect(document.activeElement).toBe(result);
	});

	it("shows the actual purpose, Owners, availability and default model without Secret fields", async () => {
		const application = AgentApplicationProjectionV2Schema.parse({
			...pendingApplication,
			configuration: {
				...pendingApplication.configuration,
				availability: [
					{ kind: "user", userId: "user-release-2" },
					{ kind: "organization", organizationId: "org-platform" },
				],
				modelOptions: [
					{
						optionId: "model-primary",
						displayName: "Release model",
						modelId: "release-model-v1",
						reasoningLevels: ["medium", "high"],
					},
				],
				defaultModelOptionId: "model-primary",
				defaultReasoningLevel: "high",
				secrets: [{ name: "MODEL_API_KEY", isSet: true, version: 2 }],
			},
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const kind = new URL(
					String(input),
					"http://localhost",
				).searchParams.get("kind");
				return Response.json({
					items:
						kind === "user"
							? [
									{
										kind,
										canonicalId: "user-release-2",
										displayName: "发布用户二",
										email: "release.two@example.test",
									},
								]
							: [
									{
										kind,
										canonicalId: "org-platform",
										displayName: "平台工程",
										organizationPath: "研发 / 平台工程",
									},
								],
				});
			}),
		);
		await renderWithMyAgentsRouter(
			<MyAgentApplicationDetailScreen
				onWithdraw={vi.fn()}
				state={{ kind: "ready", application }}
				withdrawing={false}
			/>,
		);
		expect(screen.getByText(application.description)).toBeTruthy();
		expect(screen.getAllByText("Applicant").length).toBeGreaterThanOrEqual(1);
		// 使用范围按目录显示姓名与组织名，不显示内部 ID。
		expect(await screen.findByText("发布用户二")).toBeTruthy();
		expect(screen.getByText("平台工程")).toBeTruthy();
		expect(document.body.textContent).not.toMatch(
			/user-release-2|org-platform/,
		);
		expect(
			screen.getByText("Release model · release-model-v1 · medium、high"),
		).toBeTruthy();
		expect(screen.getByText("默认模型").nextElementSibling?.textContent).toBe(
			"Release model",
		);
		expect(
			screen.getByText("默认推理档位").nextElementSibling?.textContent,
		).toBe("high");
		expect(screen.getByText("Small")).toBeTruthy();
		expect(screen.queryByText("MODEL_API_KEY")).toBeNull();
		expect(screen.queryByRole("textbox")).toBeNull();
	});

	it.each([
		[
			"self-managed",
			{
				interactionMode: "self-managed",
				identityResponsibility: "self-managed",
			},
			"自定义 Agent · 自有交互入口",
			"由自有入口校验",
		],
		[
			"platform-managed",
			{
				interactionMode: "self-managed",
				identityResponsibility: "platform-managed",
			},
			"自定义 Agent · 自有交互入口",
			"由平台校验",
		],
		[
			"platform-adapter",
			{ interactionMode: "platform-adapter" },
			"自定义 Agent · 平台交互入口",
			"由平台校验",
		],
	] as const)(
		"projects the custom entry and identity responsibility (%s)",
		async (_name, source, entryLabel, identityLabel) => {
			const application = AgentApplicationProjectionV2Schema.parse({
				...pendingApplication,
				source: {
					kind: "custom",
					imageReference: "registry.example/agents/release:v1",
					...source,
				},
			});
			await renderWithMyAgentsRouter(
				<MyAgentApplicationDetailScreen
					onWithdraw={vi.fn()}
					state={{ kind: "ready", application }}
					withdrawing={false}
				/>,
			);

			expect(screen.getByText(entryLabel)).toBeTruthy();
			expect(screen.getByText(identityLabel)).toBeTruthy();
		},
	);
});

describe("MyAgentApplicationDetailScreen design alignment (M-11)", () => {
	// 三行进度 chip：申请已提交 / 系统管理员审批 / 创建 Agent。
	it.each([
		["pending_approval", ["完成", "green"], ["等待", "gray"], ["等待", "gray"]],
		[
			"withdrawn",
			["完成", "green"],
			["不再审批", "gray"],
			["不再创建", "gray"],
		],
		["rejected", ["完成", "green"], ["已驳回", "red"], ["不再创建", "gray"]],
		["creating", ["完成", "green"], ["已通过", "green"], ["处理中", "amber"]],
		["available", ["完成", "green"], ["已通过", "green"], ["完成", "green"]],
		["stopped", ["完成", "green"], ["已通过", "green"], ["完成", "green"]],
		[
			"creation_failed",
			["完成", "green"],
			["已通过", "green"],
			["失败", "red"],
		],
		["disabled", ["完成", "green"], ["已通过", "green"], ["已停用", "gray"]],
	] as const)(
		"shows the %s progress rows with their own chips",
		async (status, submitted, approval, creation) => {
			const application = AgentApplicationProjectionV2Schema.parse({
				...pendingApplication,
				agentId:
					status === "pending_approval" ||
					status === "withdrawn" ||
					status === "rejected"
						? null
						: "agent-progress",
				status,
				decision:
					status === "pending_approval" || status === "withdrawn"
						? null
						: { decidedAt: "2026-09-03T10:00:00Z", reason: null },
			});
			await renderWithMyAgentsRouter(
				<MyAgentApplicationDetailScreen
					onWithdraw={vi.fn()}
					state={{ kind: "ready", application }}
					withdrawing={false}
				/>,
			);
			const rows = document.querySelectorAll(".application-progress li");
			expect(
				[...rows].map((row) => row.querySelector("strong")?.textContent),
			).toEqual(["申请已提交", "系统管理员审批", "创建 Agent"]);
			for (const [step, [label, tone]] of [
				["submitted", submitted],
				["approval", approval],
				["creation", creation],
			] as const) {
				const chip = progressRow(step).querySelector(
					':scope > [data-slot="badge"]',
				) as HTMLElement;
				expect(chip.textContent, `${status} ${step}`).toBe(label);
				expect(chip.dataset.tone, `${status} ${step}`).toBe(tone);
			}
		},
	);

	// 防回归 NI-14：创建中 / 创建失败不得显示绿色完成；驳回、撤回不得显示「待创建」或红色创建步。
	it.each(["creating", "creation_failed"] as const)(
		"does not mark the %s creation step as completed",
		async (status) => {
			const application = AgentApplicationProjectionV2Schema.parse({
				...pendingApplication,
				agentId: "agent-progress",
				status,
				decision: { decidedAt: "2026-09-03T10:00:00Z", reason: null },
			});
			await renderWithMyAgentsRouter(
				<MyAgentApplicationDetailScreen
					onWithdraw={vi.fn()}
					state={{ kind: "ready", application }}
					withdrawing={false}
				/>,
			);
			const row = progressRow("creation");
			expect(within(row).queryByText("完成")).toBeNull();
			expect(row.textContent).not.toContain("Agent 已创建");
			expect(
				(row.querySelector('[data-slot="badge"]') as HTMLElement).dataset.tone,
			).not.toBe("green");
		},
	);

	it.each(["rejected", "withdrawn"] as const)(
		"does not wait for or fail creation when the application is %s",
		async (status) => {
			const application = AgentApplicationProjectionV2Schema.parse({
				...pendingApplication,
				status,
				decision:
					status === "rejected"
						? { decidedAt: "2026-09-03T10:00:00Z", reason: "范围过大" }
						: null,
			});
			await renderWithMyAgentsRouter(
				<MyAgentApplicationDetailScreen
					onWithdraw={vi.fn()}
					state={{ kind: "ready", application }}
					withdrawing={false}
				/>,
			);
			const row = progressRow("creation");
			expect(row.textContent).not.toContain("待创建");
			expect(within(row).getByText("不再创建").dataset.tone).toBe("gray");
		},
	);

	it("puts the pending actions in the page heading and keeps the progress panel action-free", async () => {
		await renderWithMyAgentsRouter(
			<MyAgentApplicationDetailScreen
				onWithdraw={vi.fn()}
				state={{ kind: "ready", application: pendingApplication }}
				withdrawing={false}
			/>,
		);
		const heading = document.querySelector(
			"header.application-detail-heading",
		) as HTMLElement;
		const actions = heading.querySelector(
			":scope > .card-actions",
		) as HTMLElement;
		const edit = within(actions).getByRole("link", { name: "修改申请" });
		expect(edit.querySelectorAll("svg")).toHaveLength(1);
		expect(
			within(actions).getByRole("button", { name: "撤回申请" }),
		).toBeTruthy();
		const progress = screen.getByRole("region", { name: "审批进度" });
		expect(within(progress).queryAllByRole("button")).toHaveLength(0);
		expect(within(progress).queryAllByRole("link")).toHaveLength(0);
	});

	it("adds an icon to the resubmit action for a rejected application", async () => {
		const application = AgentApplicationProjectionV2Schema.parse({
			...pendingApplication,
			status: "rejected",
			decision: { decidedAt: "2026-09-03T10:00:00Z", reason: "范围过大" },
		});
		await renderWithMyAgentsRouter(
			<MyAgentApplicationDetailScreen
				onWithdraw={vi.fn()}
				state={{ kind: "ready", application }}
				withdrawing={false}
			/>,
		);
		const resubmit = screen.getByRole("link", { name: "修改并重新提交" });
		expect(resubmit.closest("header")).not.toBeNull();
		expect(resubmit.querySelectorAll("svg")).toHaveLength(1);
	});

	it.each([
		[
			"pending_approval",
			"审批通过后，平台会创建长期运行实例并在完成健康检查后显示“就绪”。",
		],
		["withdrawn", "此记录为只读历史。再次申请请从“我的 Agent”新建。"],
		["rejected", "查看审批原因，修改后重新提交。"],
	] as const)(
		"shows the next step for %s with a directory link",
		async (status, note) => {
			const application = AgentApplicationProjectionV2Schema.parse({
				...pendingApplication,
				status,
			});
			await renderWithMyAgentsRouter(
				<MyAgentApplicationDetailScreen
					onWithdraw={vi.fn()}
					state={{ kind: "ready", application }}
					withdrawing={false}
				/>,
			);
			const next = screen.getByRole("region", { name: "下一步" });
			expect(within(next).getByRole("heading", { level: 2 }).textContent).toBe(
				"下一步",
			);
			expect(within(next).getByText(note)).toBeTruthy();
			const directory = within(next).getByRole("link", {
				name: "查看 Agent 目录",
			});
			expect(directory.getAttribute("href")).toBe("/agents");
			expect(directory.querySelectorAll("svg")).toHaveLength(1);
			expect(screen.getAllByText(note)).toHaveLength(1);
		},
	);

	// 防回归 NI-17：目录读取失败时仍逐条显示范围，不显示内部 ID，也不只给数量。
	it("keeps availability entries readable without IDs when the directory fails", async () => {
		const application = AgentApplicationProjectionV2Schema.parse({
			...pendingApplication,
			configuration: {
				...pendingApplication.configuration,
				availability: [
					{ kind: "user", userId: "user-release-2" },
					{ kind: "organization", organizationId: "org-platform" },
				],
				modelOptions: [
					{
						optionId: "model-primary",
						displayName: "Release model",
						modelId: "release-model-v1",
						reasoningLevels: ["medium"],
					},
				],
				defaultModelOptionId: "model-removed",
				defaultReasoningLevel: "medium",
			},
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("{}", { status: 503 })),
		);
		await renderWithMyAgentsRouter(
			<MyAgentApplicationDetailScreen
				onWithdraw={vi.fn()}
				state={{ kind: "ready", application }}
				withdrawing={false}
			/>,
		);
		expect(await screen.findByText(/目录暂时无法读取/)).toBeTruthy();
		const scope = screen.getByText("使用范围")
			.nextElementSibling as HTMLElement;
		expect(within(scope).getAllByRole("listitem")).toHaveLength(2);
		expect(within(scope).getByText("未识别的用户")).toBeTruthy();
		expect(within(scope).getByText("未识别的组织")).toBeTruthy();
		expect(
			screen.getByText("Release model · release-model-v1 · medium"),
		).toBeTruthy();
		expect(screen.getByText("默认模型").nextElementSibling?.textContent).toBe(
			"未识别的模型选项",
		);
		expect(document.body.textContent).not.toMatch(
			/user-release-2|org-platform|model-removed/,
		);
	});
});
