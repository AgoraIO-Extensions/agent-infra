import { BrowserCapabilityProjectionV1Schema } from "@agent-infra/contracts/runtime";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
	BrowserCapabilityStatus,
	BrowserWorkflowStatus,
} from "./browser-capability-status.js";

const available = BrowserCapabilityProjectionV1Schema.parse({
	schemaVersion: 1,
	capabilityVersion: 1,
	status: "available",
	operations: ["navigate", "observe", "interact"],
	policy: {
		allowedOrigins: ["https://example.test/", "https://docs.example.test/"],
		maxContexts: 1,
		maxTabs: 2,
		maxPages: 4,
		maxViewportWidth: 1280,
		maxViewportHeight: 720,
		maxConcurrentActions: 1,
		maxDownloads: 2,
		maxDownloadBytes: 1_000_000,
		maxUploadBytes: 1_000_000,
		maxScreenshotBytes: 1_000_000,
		maxBrowserDurationMs: 60_000,
		maxRetainedProfileBytes: 10_000_000,
		navigationTimeoutMs: 15_000,
		actionTimeoutMs: 5_000,
		requireSideEffectConfirmation: true,
		allowUserHandoff: true,
	},
	provenance: {
		browser: "chromium",
		chromiumVersion: "153.0.8010.12",
		playwrightVersion: "1.63.0",
		imageDigest: `sha256:${"a".repeat(64)}`,
	},
	conformance: {
		schemaVersion: 1,
		receiptId: "browser-receipt-1",
		probeVersion: "browser-probe-1",
		verifiedAt: "2026-10-10T00:00:00Z",
		manifestDigest: `sha256:${"b".repeat(64)}`,
		evidenceHash: "c".repeat(64),
		operations: ["navigate", "observe", "interact"],
	},
});

describe("BrowserCapabilityStatus", () => {
	afterEach(() => cleanup());

	it("renders bounded available provenance and policy summary", () => {
		render(<BrowserCapabilityStatus capability={available} />);

		expect(
			screen.getByRole("heading", { name: "Browser Capability" }),
		).toBeTruthy();
		expect(screen.getByRole("status").textContent).toContain("可用");
		expect(screen.getByText(/Chromium 153\.0\.8010\.12/)).toBeTruthy();
		expect(screen.getByText("2 个受控 origin")).toBeTruthy();
		expect(screen.getByText("1 个 Context、2 个 Tab、4 个 Page")).toBeTruthy();
		expect(screen.getByText("支持受控接管")).toBeTruthy();
		expect(screen.queryByText(/sha256/)).toBeNull();
	});

	it.each([
		["intent", "正在受理", "操作：navigate"],
		["observing", "正在观察", "Browser 工作流正在推进。"],
		["action", "正在执行", "操作：click"],
		["approval_pending", "等待确认", "目标 origin：https://example.test"],
		["handoff_pending", "等待接管", "需要完成 MFA"],
		["handed_off", "用户已接管", "Agent 操作保持暂停"],
		["unknown", "待核实", "已阻断自动重试"],
	] as const)("renders the %s workflow state", (kind, label, detail) => {
		const workflow =
			kind === "intent"
				? { kind, operation: "navigate" }
				: kind === "action"
					? { kind, operation: "click" }
					: kind === "approval_pending"
						? { kind, operation: "submit", origin: "https://example.test" }
						: kind === "handoff_pending"
							? { kind, reason: "需要完成 MFA" }
							: kind === "unknown"
								? { kind, operation: "purchase" }
								: { kind };

		render(<BrowserWorkflowStatus workflow={workflow} />);

		expect(screen.getByRole("alert").textContent).toContain(label);
		expect(screen.getByRole("alert").textContent).toContain(detail);
	});

	it.each([
		["not_configured", "未配置", false],
		["probe_failed", "探测失败", true],
		["unavailable", "不可用", true],
		["stale", "证据过期", true],
	] as const)(
		"renders the fail-closed %s state",
		(status, label, retryable) => {
			const capability = BrowserCapabilityProjectionV1Schema.parse({
				schemaVersion: 1,
				capabilityVersion: 1,
				status,
				errorCode:
					status === "not_configured"
						? "BROWSER_CAPABILITY_NOT_CONFIGURED"
						: status === "probe_failed"
							? "BROWSER_CAPABILITY_PROBE_FAILED"
							: status === "unavailable"
								? "BROWSER_CAPABILITY_UNAVAILABLE"
								: "BROWSER_CAPABILITY_STALE",
				reason: "controlled test reason",
				retryable,
			});

			render(<BrowserCapabilityStatus capability={capability} />);

			expect(screen.getByRole("alert").textContent).toContain(label);
			expect(screen.getByRole("alert").textContent).toContain(
				"controlled test reason",
			);
			expect(screen.getByRole("alert").textContent).toContain(
				retryable ? "可以稍后重试" : "当前不会自动重试",
			);
		},
	);
});
