import type { BrowserCapabilityAvailableV1 } from "@agent-infra/contracts/runtime";
import { describe, expect, it } from "vitest";
import { createCodexBrowserToolDescriptorsV1 } from "./codex-browser-tools.js";

const capability: BrowserCapabilityAvailableV1 = {
	schemaVersion: 1,
	capabilityVersion: 1,
	status: "available",
	operations: ["navigate", "observe", "interact", "handoff"],
	policy: {
		allowedOrigins: ["https://example.test/"],
		maxContexts: 1,
		maxTabs: 2,
		maxPages: 2,
		maxViewportWidth: 1280,
		maxViewportHeight: 720,
		maxConcurrentActions: 1,
		maxDownloads: 1,
		maxDownloadBytes: 1024,
		maxUploadBytes: 1024,
		maxScreenshotBytes: 1024,
		maxBrowserDurationMs: 60_000,
		maxRetainedProfileBytes: 100_000,
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
		receiptId: "receipt",
		probeVersion: "probe",
		verifiedAt: "2026-10-10T00:00:00Z",
		manifestDigest: `sha256:${"b".repeat(64)}`,
		evidenceHash: "c".repeat(64),
		operations: ["navigate", "observe", "interact", "handoff"],
	},
};

describe("Codex Browser tool descriptors", () => {
	it("maps only admitted operations to bounded structured schemas", () => {
		const tools = createCodexBrowserToolDescriptorsV1(capability);
		expect(tools.map((tool) => tool.name)).toEqual([
			"browser_navigate",
			"browser_observe",
			"browser_interact",
			"browser_handoff",
		]);
		expect(tools[0]?.inputSchema).toMatchObject({
			type: "object",
			additionalProperties: false,
			properties: { url: { maxLength: 2048 } },
		});
		expect(tools[2]?.inputSchema).toMatchObject({
			properties: { elementId: { maxLength: 256 } },
		});
		expect(JSON.stringify(tools)).not.toContain("playwright");
		expect(JSON.stringify(tools)).not.toContain("credential");
	});

	it("fails closed without an available projection", () => {
		expect(createCodexBrowserToolDescriptorsV1(undefined)).toEqual([]);
	});
});
