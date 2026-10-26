import {
	ExecutionDetailProjectionV2Schema,
	PersistedConversationEventV2Schema,
} from "@agent-infra/contracts/pilot";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reasoningLevelLabel } from "@/lib/reasoning-level-label";
import type { ExecutionDetailProjectionV2 } from "../../pilot/generated-v2/types.gen.js";
import { operationEvent } from "./browser-test-fixtures.js";
import {
	ConversationExecutionDetails,
	executionConnectionSummary,
	executionDurationSummary,
	executionModelSummary,
	executionToolSummary,
} from "./conversation-screen-details.js";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

const conversationId = "3f1c2b7a-1d2e-4f5a-8b9c-0d1e2f3a4b5c";
const executionId = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const options = [
	{ optionId: "model-primary", modelId: "gpt-6.1", displayName: "GPT-6.1" },
];

function operation(
	sequence: number,
	payload: Record<string, unknown>,
	type = "execution.operation",
) {
	return PersistedConversationEventV2Schema.parse({
		schemaVersion: 2,
		kind: "event",
		eventId: `detail-event-${sequence}`,
		conversationId,
		executionId,
		sequence,
		conversationCursor: `detail-cursor-${sequence}`,
		occurredAt: "2026-09-03T08:00:00Z",
		type,
		payload,
	});
}

const modelFact = operation(1, {
	kind: "model",
	operationRef: "operation-model",
	attemptRef: "attempt-model",
	phase: "failed",
	failureCode: "response_incomplete",
	model: {
		configVersion: "config-1",
		modelId: "gpt-6.1",
		modelOptionId: "model-primary",
		reasoningLevel: "medium",
	},
});

const connectionFact = (verification: "verified" | "unverified") =>
	operation(2, {
		kind: "tool",
		operationRef: "operation-tool",
		attemptRef: "attempt-tool",
		phase: "completed",
		toolId: "github.issues_read",
		durationMs: 42,
		resultRef: "result-ref-0123456789abcdef",
		connection:
			verification === "verified"
				? {
						verification,
						serviceRef: "service-1",
						callRef: "call-ref-0123456789abcdef",
					}
				: {
						verification,
						serviceRef: "service-1",
						reason: "authorization_unavailable",
					},
	});

function detail(
	patch: Partial<Record<string, unknown>> = {},
): ExecutionDetailProjectionV2 {
	return ExecutionDetailProjectionV2Schema.parse({
		schemaVersion: 2,
		conversationId,
		executionId,
		status: "completed",
		error: null,
		startedAt: "2026-09-03T08:00:00Z",
		finishedAt: "2026-09-03T08:00:05Z",
		processSummary: [
			{
				kind: "status",
				status: "processing",
				occurredAt: "2026-09-03T08:00:01Z",
				summary: "Execution processing.",
			},
			{
				kind: "model_call",
				modelId: "gpt-6.1",
				reasoningLevel: "medium",
				status: "failed",
				occurredAt: "2026-09-03T08:00:02Z",
				summary: "Model call failed.",
			},
		],
		events: [modelFact],
		...patch,
	});
}

function renderDetails(
	data: ExecutionDetailProjectionV2 | undefined,
	props: Partial<Parameters<typeof ConversationExecutionDetails>[0]> = {},
) {
	const onRetry = vi.fn();
	const onClose = vi.fn();
	render(
		<ConversationExecutionDetails
			open
			data={data}
			conversationId={conversationId}
			loading={false}
			failed={false}
			modelOptions={options}
			connectionEnabled={false}
			onRetry={onRetry}
			onClose={onClose}
			{...props}
		/>,
	);
	return { onRetry, onClose };
}

describe("execution details dialog", () => {
	it("renders the design facts, a status chip, the page note and one primary close", async () => {
		const { onClose } = renderDetails(detail());
		const dialog = await screen.findByRole("dialog", { name: "执行详情" });
		expect(dialog.getAttribute("aria-modal")).toBe("true");
		expect(within(dialog).getAllByRole("heading", { level: 2 })).toHaveLength(
			1,
		);
		expect(
			[...dialog.querySelectorAll("dl.conversation-facts > dt")]
				.slice(0, 6)
				.map((item) => item.textContent),
		).toEqual(["Execution ID", "模型", "状态", "耗时", "Connection", "工具"]);
		const chip = dialog.querySelector(
			'[data-slot="badge"][data-execution-status]',
		);
		expect(chip?.textContent).toBe("已完成");
		expect(chip?.getAttribute("data-tone")).toBe("green");
		expect(chip?.getAttribute("data-variant")).toBe("chip");
		expect(
			dialog.querySelector("[data-slot='dialog-body'] > p:last-child")
				?.textContent,
		).toBe(
			"这里展示可审计的执行事实，不包含思考过程；模型提供的思考过程显示在回答上方。",
		);
		expect(
			within(dialog).queryByRole("button", { name: "返回对话" }),
		).toBeNull();
		// 页眉图标钮「关闭弹窗」与页脚主按钮「关闭」不同名（X-04）。
		expect(
			within(dialog)
				.getByRole("button", { name: "关闭弹窗" })
				.closest('[data-slot="dialog-header"]'),
		).not.toBeNull();
		const closes = within(dialog).getAllByRole("button", { name: "关闭" });
		expect(closes).toHaveLength(1);
		const primary = within(dialog).getByText("关闭", { selector: "button" });
		expect(primary.closest('[data-slot="dialog-footer"]')).not.toBeNull();
		expect(primary.className).toContain("bg-accent-ink");
		fireEvent.click(primary);
		await waitFor(() => expect(onClose).toHaveBeenCalled());
	});

	it("maps internal values to readable Chinese and hides raw IDs and ISO times (N-13)", async () => {
		renderDetails(
			detail({
				status: "failed",
				error: {
					schemaVersion: 1,
					code: "EXECUTION_FAILED",
					message: "raw provider message",
					retryable: false,
					traceId: "trace-1",
				},
			}),
		);
		const dialog = await screen.findByRole("dialog", { name: "执行详情" });
		const text = dialog.textContent ?? "";
		expect(text).toContain(`GPT-6.1 · ${reasoningLevelLabel("medium")}`);
		expect(text).toContain("失败原因：响应不完整");
		expect(text).toContain("推理强度 均衡");
		expect(text).toContain("用量未采集");
		expect(text).toContain("耗时未采集");
		expect(text).toContain("模型调用 · GPT-6.1 · 失败");
		expect(text).toContain("执行中");
		expect(text).toContain("模型响应");
		expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
		expect(text).not.toMatch(
			/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
		);
		expect(text).not.toMatch(
			/Execution (submitted|processing|completed|failed|cancelled|unknown)\./,
		);
		expect(text).not.toMatch(
			/authorization_denied|authorization_unavailable|dependency_unavailable|request_rejected|response_incomplete|operation_failed|persistence_unavailable|interrupted|recovery_unconfirmed|\bmedium\b/,
		);
		expect(dialog.innerHTML).not.toContain(conversationId);
		expect(text).not.toMatch(/执行：/);
		expect(dialog.querySelectorAll("time")).toHaveLength(2);
		expect(within(dialog).getByRole("alert").textContent).not.toContain(
			"raw provider message",
		);
		const chip = dialog.querySelector("[data-execution-status]");
		expect(chip?.getAttribute("data-tone")).toBe("red");
	});

	it("shows a short monospace ID and copies the full value", async () => {
		const writeText = vi.fn(async () => undefined);
		vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
		renderDetails(detail());
		const dialog = await screen.findByRole("dialog", { name: "执行详情" });
		const id = within(dialog).getByText(`${executionId.slice(0, 8)}…`);
		expect(id.getAttribute("title")).toBe(executionId);
		fireEvent.click(
			within(dialog).getByRole("button", { name: "复制 Execution ID" }),
		);
		await waitFor(() => expect(writeText).toHaveBeenCalledWith(executionId));
		expect(within(dialog).getByRole("status").textContent).toBe("已复制");
	});

	it("keeps tool IDs and marks missing usage as not collected", async () => {
		vi.stubGlobal("navigator", {
			...navigator,
			clipboard: { writeText: vi.fn(async () => undefined) },
		});
		renderDetails(detail({ events: [modelFact, connectionFact("verified")] }));
		const dialog = await screen.findByRole("dialog", { name: "执行详情" });
		expect(dialog.textContent).toContain(
			"工具调用 · github.issues_read · 已完成",
		);
		expect(dialog.textContent).toContain("耗时 42 ms");
		expect(dialog.textContent).toContain("Connection 关联引用不授予访问权限。");
		expect(
			within(dialog).getByRole("button", { name: "复制 调用关联" }),
		).toBeTruthy();
		expect(dialog.textContent).not.toContain("call-ref-0123456789abcdef");
	});

	it.each([
		["browser_navigate", true, "打开页面"],
		["browser_observe", true, "读取页面"],
		["browser_interact", false, "操作页面"],
		["browser_unregistered", true, "浏览器操作"],
	])(
		"labels the browser tool %s like the browser card instead of its raw ID (Z-15)",
		async (toolId, bound, label) => {
			const browserEvent = {
				...operationEvent(3, "completed", { executionId, toolId }),
				conversationId,
			};
			const payload = { ...browserEvent.payload } as Record<string, unknown>;
			// 没有浏览器绑定、但 toolId 是已登记浏览器工具的事实同样不外露原值。
			if (!bound) delete payload.browser;
			renderDetails(
				detail({ events: [modelFact, { ...browserEvent, payload }] }),
			);
			const dialog = await screen.findByRole("dialog", { name: "执行详情" });
			expect(dialog.textContent).toContain(`工具调用 · ${label} · 已完成`);
			expect(dialog.textContent).not.toContain(toolId);
		},
	);

	it.each([
		[[modelFact, connectionFact("verified")], [], "已调用 1 次 · 已核实"],
		[[modelFact, connectionFact("unverified")], [], "已调用 1 次 · 待核实"],
		[[modelFact], [], "未调用"],
		[[], [], "未采集"],
	])("summarises Connection calls", (events, processSummary, expected) => {
		expect(executionConnectionSummary(detail({ events, processSummary }))).toBe(
			expected,
		);
	});

	it("falls back to the model call summary and then to not collected", () => {
		expect(executionModelSummary(detail({ events: [] }), options)).toBe(
			"GPT-6.1 · 均衡",
		);
		expect(
			executionModelSummary(
				detail({ events: [], processSummary: [] }),
				options,
			),
		).toBe("未采集");
	});

	it("summarises duration and the latest tool for the design facts", () => {
		expect(executionDurationSummary(detail())).toBe("5 秒");
		expect(executionDurationSummary(detail({ finishedAt: null }))).toBe("未知");
		expect(
			executionToolSummary(detail({ events: [connectionFact("verified")] })),
		).toBe("github.issues_read");
		expect(executionToolSummary(detail({ events: [] }))).toBe("未采集");
	});

	it.each(["completed", "cancelled"] as const)(
		"does not offer verification for a %s execution",
		async (status) => {
			renderDetails(detail({ status }));
			const dialog = await screen.findByRole("dialog", { name: "执行详情" });
			expect(
				within(dialog).queryByRole("button", { name: "核实原执行状态" }),
			).toBeNull();
		},
	);

	it("offers verification for an unknown execution", async () => {
		const { onRetry } = renderDetails(
			detail({ status: "unknown", finishedAt: null }),
		);
		const dialog = await screen.findByRole("dialog", { name: "执行详情" });
		fireEvent.click(
			within(dialog).getByRole("button", { name: "核实原执行状态" }),
		);
		expect(onRetry).toHaveBeenCalledTimes(1);
		expect(dialog.textContent).toContain("耗时");
	});

	it("gates the Connection installation by capability and authorization signal", async () => {
		renderDetails(detail());
		let dialog = await screen.findByRole("dialog", { name: "执行详情" });
		expect(within(dialog).queryByText("Connection 安装")).toBeNull();
		expect(within(dialog).queryByText("开始安装")).toBeNull();
		cleanup();

		renderDetails(detail(), { connectionEnabled: true });
		dialog = await screen.findByRole("dialog", { name: "执行详情" });
		const trigger = within(dialog).getByRole("button", {
			name: "Connection 安装",
		});
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		expect(
			within(dialog).queryByRole("button", { name: /开始安装/ }),
		).toBeNull();
		cleanup();

		renderDetails(
			detail({ events: [modelFact, connectionFact("unverified")] }),
			{ connectionEnabled: true },
		);
		dialog = await screen.findByRole("dialog", { name: "执行详情" });
		expect(
			within(dialog)
				.getByRole("button", { name: "Connection 安装" })
				.getAttribute("aria-expanded"),
		).toBe("true");
		expect(
			within(dialog).getByRole("button", { name: /开始安装/ }),
		).toBeTruthy();
	});

	it("offers this execution's browser records as a nested read-only dialog", async () => {
		const browserEvent = {
			...operationEvent(3, "completed", { executionId }),
			conversationId,
		};
		renderDetails(detail({ events: [modelFact, browserEvent] }));
		const dialog = await screen.findByRole("dialog", { name: "执行详情" });
		fireEvent.click(
			within(dialog).getByRole("button", { name: "查看操作记录" }),
		);
		const records = await screen.findByRole("dialog", {
			name: "浏览器操作记录",
		});
		expect(records.textContent).toContain("打开页面");
		cleanup();
		renderDetails(detail());
		expect(
			within(
				await screen.findByRole("dialog", { name: "执行详情" }),
			).queryByRole("button", { name: "查看操作记录" }),
		).toBeNull();
	});

	it("shows loading and read failures inside the dialog", async () => {
		const { onRetry } = renderDetails(undefined, {
			loading: true,
			failed: true,
		});
		const dialog = await screen.findByRole("dialog", { name: "执行详情" });
		expect(within(dialog).getByRole("status").textContent).toContain(
			"正在读取执行记录…",
		);
		expect(within(dialog).getByRole("alert").textContent).toContain(
			"执行记录暂时无法读取。",
		);
		fireEvent.click(
			within(dialog).getByRole("button", { name: "重新读取详情" }),
		);
		expect(onRetry).toHaveBeenCalledTimes(1);
	});
});
