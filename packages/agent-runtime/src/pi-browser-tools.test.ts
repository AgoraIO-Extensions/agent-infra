import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserCapabilityAvailableV1 } from "@agent-infra/contracts/runtime";
import { expect, it, vi } from "vitest";
import { PiRuntimeDriver } from "./pi-runtime-driver.js";

const capability: BrowserCapabilityAvailableV1 = {
	schemaVersion: 1,
	capabilityVersion: 1,
	status: "available",
	operations: ["navigate", "observe"],
	policy: {
		allowedOrigins: ["https://example.test/"],
		maxContexts: 1,
		maxTabs: 2,
		maxPages: 2,
		maxViewportWidth: 1280,
		maxViewportHeight: 720,
		maxConcurrentActions: 1,
		maxDownloads: 0,
		maxDownloadBytes: 0,
		maxUploadBytes: 0,
		maxScreenshotBytes: 1024,
		maxBrowserDurationMs: 60_000,
		maxRetainedProfileBytes: 100_000,
		navigationTimeoutMs: 15_000,
		actionTimeoutMs: 5_000,
		requireSideEffectConfirmation: true,
		allowUserHandoff: false,
	},
	provenance: {
		browser: "chromium",
		chromiumVersion: "153.0.8010.12",
		playwrightVersion: "1.63.0",
		imageDigest: `sha256:${"a".repeat(64)}`,
	},
	conformance: {
		schemaVersion: 1,
		receiptId: "controlled-receipt",
		probeVersion: "controlled-probe",
		verifiedAt: "2026-10-10T00:00:00Z",
		manifestDigest: `sha256:${"b".repeat(64)}`,
		evidenceHash: "c".repeat(64),
		operations: ["navigate", "observe"],
	},
};

it.each([undefined, capability])(
	"exposes only admitted Browser descriptors without launching the native peer (%s)",
	async (browserCapability) => {
		const path = await mkdtemp(join(tmpdir(), "pi-browser-tools-"));
		const launch = vi.fn(async () => {
			throw new Error("Descriptor discovery must not launch a native peer");
		});
		const driver = await PiRuntimeDriver.open({
			path,
			configVersion: "controlled",
			defaultModelOptionId: "primary",
			defaultReasoningLevel: "high",
			modelOptions: [
				{
					modelOptionId: "primary",
					nativeModelId: "configured/model",
					reasoningLevels: ["high"],
				},
			],
			browserCapability,
			launch,
		});
		try {
			const tools = driver.getBrowserToolDescriptors();
			expect(tools.map((tool) => tool.name)).toEqual(
				browserCapability ? ["browser_navigate", "browser_observe"] : [],
			);
			for (const tool of tools) {
				expect(tool.capabilityVersion).toBe(1);
				expect(tool.inputSchema).toMatchObject({
					type: "object",
					additionalProperties: false,
				});
			}
			expect(JSON.stringify(tools)).not.toMatch(
				/credential|playwright|chromium|imageDigest|example\.test|selector|javascript/i,
			);
			expect(launch).not.toHaveBeenCalled();
		} finally {
			await driver.close();
			await rm(path, { recursive: true, force: true });
		}
	},
);
