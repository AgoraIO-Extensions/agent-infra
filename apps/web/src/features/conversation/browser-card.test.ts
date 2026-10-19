// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { PersistedConversationEventV2 } from "../../pilot/generated-v2/types.gen.js";
import { selectBrowserCard } from "./browser-card.js";
import {
	browserTestNow,
	handoffEvent,
	operationEvent,
	sideEffectEvent,
} from "./browser-test-fixtures.js";

const later = Date.parse("2026-10-11T13:00:00.000Z");

function card(
	events: PersistedConversationEventV2[],
	{
		executionId = "execution-1",
		browserAvailable = true,
		now = browserTestNow,
	}: { executionId?: string; browserAvailable?: boolean; now?: number } = {},
) {
	return selectBrowserCard({
		events,
		conversationId: "conversation-1",
		executionId,
		browserAvailable,
		now,
	});
}

function text(value: ReturnType<typeof card>) {
	return JSON.stringify(value);
}

const internal =
	/Browser|browser_|origin|页面版本|Session|绑定|receipt|BROWSER_HANDOFF_|\bsubmit\b|https?:\/\//;

describe("selectBrowserCard", () => {
	it.each([
		[[], "idle", "浏览器操作", "可请求", []],
		[
			[sideEffectEvent(1, "pending")],
			"request",
			"浏览器操作请求",
			"等待确认",
			["confirm_side_effect", "reject_side_effect"],
		],
		[
			[handoffEvent(1, "requested")],
			"handoff",
			"需要你接管浏览器",
			"等待接管",
			["take_over", "revoke"],
		],
		[
			[handoffEvent(1, "active")],
			"handoff",
			"需要你接管浏览器",
			"已接管",
			["return_to_agent", "revoke"],
		],
		[
			[handoffEvent(1, "returning")],
			"running",
			"浏览器操作进行中",
			"执行中",
			["stop_execution"],
		],
		[
			[operationEvent(1, "intent")],
			"running",
			"浏览器操作进行中",
			"执行中",
			["stop_execution"],
		],
		[
			[sideEffectEvent(1, "confirmed")],
			"running",
			"浏览器操作进行中",
			"执行中",
			["stop_execution"],
		],
		[
			[operationEvent(1, "completed")],
			"complete",
			"浏览器操作已完成",
			"已完成",
			[],
		],
		[
			[sideEffectEvent(1, "rejected")],
			"denied",
			"浏览器操作已拒绝",
			"已拒绝",
			[],
		],
		[[handoffEvent(1, "revoked")], "stopped", "浏览器操作已停止", "已停止", []],
		[
			[sideEffectEvent(1, "cancelled")],
			"stopped",
			"浏览器操作已停止",
			"已停止",
			[],
		],
		[
			[operationEvent(1, "failed")],
			"stopped",
			"浏览器操作已停止",
			"已停止",
			[],
		],
		[
			[operationEvent(1, "unknown")],
			"unknown",
			"浏览器结果待核实",
			"待核实",
			[],
		],
	] as const)(
		"maps %j to the %s phase",
		(events, phase, title, status, commands) => {
			const result = card([...events]);
			expect(result).toMatchObject({ phase, title, status });
			expect(result?.actions.map((action) => action.command.kind)).toEqual(
				commands,
			);
			// 内部值不进入卡片：toolId、operation 枚举、origin、页面版本、Session/绑定。
			expect(text(result)).not.toMatch(internal);
		},
	);

	it("lights one, two and three timeline steps as the page progresses", () => {
		expect(card([operationEvent(1, "intent")])?.timeline).toBe(1);
		expect(card([operationEvent(1, "started")])?.timeline).toBe(2);
		expect(card([operationEvent(1, "completed")])?.timeline).toBe(3);
		expect(card([operationEvent(1, "unknown")])?.timeline).toBe(1);
		for (const events of [
			[sideEffectEvent(1, "pending")],
			[handoffEvent(1, "requested")],
			[sideEffectEvent(1, "rejected")],
			[handoffEvent(1, "revoked")],
		])
			expect(card(events)?.timeline).toBeUndefined();
	});

	it("describes the request with host, readable action and scope plus risk", () => {
		const result = card([
			sideEffectEvent(1, "pending", {
				targetOrigin: "https://example.test:8443",
			}),
		]);
		expect(result?.meta).toEqual([
			{ label: "域名", value: "example.test:8443" },
			{ label: "操作", value: "提交" },
			{ label: "范围", value: "提交公开表单（已脱敏） · 会产生外部操作" },
		]);
		expect(result?.actions.map((action) => action.accessibleName)).toEqual([
			"允许这次操作：提交 example.test:8443",
			"拒绝：提交 example.test:8443",
		]);
		expect(
			card([sideEffectEvent(1, "pending", { operation: "custom.op" })])
				?.meta[1],
		).toEqual({ label: "操作", value: "外部操作" });
	});

	it("uses neutral verbs for any site navigation", () => {
		expect(card([operationEvent(1, "started")])?.body).toBe(
			"Agent 正在打开页面。你可以随时停止。",
		);
		expect(
			card([operationEvent(1, "started", { toolId: "browser_observe" })])?.meta,
		).toEqual([{ label: "操作", value: "读取页面" }]);
		expect(
			card([operationEvent(1, "started", { toolId: "vendor_tool" })])?.meta,
		).toEqual([{ label: "操作", value: "浏览器操作" }]);
	});

	it("keeps terminal states after expiry or capability loss (NW-10)", () => {
		for (const [events, phase] of [
			[[sideEffectEvent(1, "confirmed")], "running"],
			[[sideEffectEvent(1, "rejected")], "denied"],
			[[sideEffectEvent(1, "cancelled")], "stopped"],
			[[operationEvent(1, "completed")], "complete"],
			[[handoffEvent(1, "revoked")], "stopped"],
		] as const) {
			expect(card([...events], { now: later })?.phase).toBe(phase);
			expect(card([...events], { browserAvailable: false })?.phase).toBe(phase);
			expect(text(card([...events], { now: later }))).not.toContain(
				"不会执行此副作用",
			);
		}
		// 已交回 Agent 的接管不单独成卡，过期后也不会变成阻断。
		expect(card([handoffEvent(1, "completed")], { now: later })?.phase).toBe(
			"idle",
		);
	});

	it("removes actions from an expired or unavailable open request", () => {
		for (const events of [
			[sideEffectEvent(1, "pending")],
			[handoffEvent(1, "requested")],
			[handoffEvent(1, "active")],
		]) {
			const expired = card(events, { now: later });
			expect(expired?.phase).toBe("stopped");
			expect(expired?.actions).toEqual([]);
			const unavailable = card(events, { browserAvailable: false });
			expect(unavailable?.phase).toBe("stopped");
			expect(unavailable?.actions).toEqual([]);
		}
	});

	it("only reflects the latest execution (NW-10)", () => {
		const previous = [
			sideEffectEvent(1, "pending", { executionId: "execution-a" }),
			handoffEvent(2, "requested", { executionId: "execution-a" }),
		];
		const idle = card(previous, { executionId: "execution-b" });
		expect(idle?.phase).toBe("idle");
		expect(idle?.actions).toEqual([]);
		const next = card(
			[
				...previous,
				operationEvent(3, "started", { executionId: "execution-b" }),
			],
			{ executionId: "execution-b" },
		);
		expect(next?.phase).toBe("running");
		expect(text(next)).not.toMatch(/confirmation-1|handoff-1/);
		expect(card(previous, { executionId: undefined })?.phase).toBe("idle");
	});

	it("ignores events from an older browser session generation", () => {
		const result = card([
			sideEffectEvent(1, "pending", {
				binding: { sessionGeneration: 1 },
			}),
			operationEvent(2, "completed", { sessionGeneration: 2 }),
		]);
		expect(result?.phase).toBe("complete");
	});

	it("opens the request after a completed handoff with another page revision (NW-11)", () => {
		const result = card([
			handoffEvent(1, "completed", { pageRevision: 4 }),
			sideEffectEvent(2, "pending", { pageRevision: 5 }),
		]);
		expect(result?.phase).toBe("request");
		expect(result?.actions.map((action) => action.command)).toEqual([
			{ kind: "confirm_side_effect", confirmationId: "confirmation-1" },
			{ kind: "reject_side_effect", confirmationId: "confirmation-1" },
		]);
		expect(text(result)).not.toMatch(/已阻断|Session|绑定/);
	});

	it("keeps confirmation closed while a handoff is open or has ended abnormally", () => {
		const open = card([
			handoffEvent(1, "active"),
			sideEffectEvent(2, "pending"),
		]);
		expect(open?.phase).toBe("handoff");
		expect(
			open?.actions.some(
				(action) => action.command.kind === "confirm_side_effect",
			),
		).toBe(false);
		for (const status of ["revoked", "crashed"] as const) {
			const blocked = card([
				handoffEvent(1, status),
				sideEffectEvent(2, "pending"),
			]);
			expect(blocked?.phase).toBe("stopped");
			expect(blocked?.actions).toEqual([]);
		}
	});

	it("never offers allow on the handoff request (NI-94)", () => {
		const result = card([handoffEvent(1, "requested")]);
		expect(result?.actions.map((action) => action.label)).toEqual([
			"接管浏览器",
			"停止",
		]);
		expect(result?.actions[0]?.command).toEqual({
			kind: "take_over",
			handoffId: "handoff-1",
		});
	});

	it.each([
		[
			"an origin with a path",
			sideEffectEvent(1, "pending", {
				targetOrigin: "https://example.test/private?token=secret",
				unchecked: true,
			}),
		],
		[
			"an origin with credentials",
			sideEffectEvent(1, "pending", {
				targetOrigin: "https://user:secret@example.test",
				unchecked: true,
			}),
		],
		[
			"an empty summary",
			sideEffectEvent(1, "pending", { summary: "\u0007 ", unchecked: true }),
		],
		[
			"a structurally invalid binding",
			handoffEvent(1, "requested", {
				binding: { resourceFence: 0 },
				unchecked: true,
			}),
		],
		[
			"a binding for another execution",
			sideEffectEvent(1, "pending", {
				binding: { executionId: "execution-foreign" },
				unchecked: true,
			}),
		],
		[
			"an invalid expiry",
			sideEffectEvent(1, "pending", { expires: "invalid", unchecked: true }),
		],
		["an unknown status", sideEffectEvent(1, "unknown")],
	])("fails closed for %s", (_name, event) => {
		const result = card([event]);
		expect(result?.phase).toBe("unknown");
		expect(result?.title).toBe("浏览器结果待核实");
		expect(result?.actions).toEqual([]);
		expect(text(result)).not.toMatch(/example\.test|secret/);
	});

	it("shows nothing when the browser is unavailable and nothing happened", () => {
		expect(card([], { browserAvailable: false })).toBeUndefined();
	});

	// 中西文之间留空格：西文开头的原因前补空格，中文开头的原因直接相接（acc-2 新问题 1）。
	it.each([
		[
			"mfa",
			"requested",
			"请接管浏览器完成 MFA 验证，然后把控制权交还给 Agent。接管期间 Agent 不会操作页面。",
		],
		[
			"captcha",
			"requested",
			"请接管浏览器完成 CAPTCHA 验证，然后把控制权交还给 Agent。接管期间 Agent 不会操作页面。",
		],
		[
			"login",
			"requested",
			"请接管浏览器完成登录，然后把控制权交还给 Agent。接管期间 Agent 不会操作页面。",
		],
		[
			"human_judgment",
			"requested",
			"请接管浏览器完成需要人工判断的步骤，然后把控制权交还给 Agent。接管期间 Agent 不会操作页面。",
		],
		["mfa", "active", "请在浏览器中完成 MFA 验证，然后把控制权交还给 Agent。"],
		[
			"captcha",
			"active",
			"请在浏览器中完成 CAPTCHA 验证，然后把控制权交还给 Agent。",
		],
		["login", "active", "请在浏览器中完成登录，然后把控制权交还给 Agent。"],
	] as const)(
		"spaces the %s reason in the %s handoff body",
		(reason, status, body) => {
			expect(card([handoffEvent(1, status, { reason })])?.body).toBe(body);
		},
	);

	it("keeps site-specific design examples and a second mapping out of the card modules (NI-22)", () => {
		for (const file of [
			"browser-card.ts",
			"browser-labels.ts",
			"browser-activity-card.tsx",
			"browser-audit-view.tsx",
		]) {
			const source = readFileSync(
				fileURLToPath(new URL(file, import.meta.url)),
				"utf8",
			);
			expect(source).not.toContain("读取当前仓库页面");
			expect(source).not.toContain("github.com");
			expect(source).not.toMatch(/replace\(\/\^https\?/);
			if (file !== "browser-labels.ts")
				expect(source).not.toMatch(/browser_navigate|"submit"/);
		}
	});
});
