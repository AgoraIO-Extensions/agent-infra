import {
	type BrowserCapabilityAvailableV1,
	BrowserCapabilityAvailableV1Schema,
} from "@agent-infra/contracts/runtime";
import { expect } from "vitest";
import type { CodexBrowserToolDescriptorV1 } from "./codex-browser-tools.js";
import type {
	RuntimeBrowserToolExecutionRequestV1,
	RuntimeBrowserToolExecutionResultV1,
} from "./driver.js";

export const browserConformanceTemplates = [
	"Codex",
	"Claude",
	"OpenCode",
	"Pi",
] as const;

export type BrowserConformanceTemplate =
	(typeof browserConformanceTemplates)[number];

export const browserConformanceCapability: BrowserCapabilityAvailableV1 =
	BrowserCapabilityAvailableV1Schema.parse({
		schemaVersion: 1,
		capabilityVersion: 3,
		status: "available",
		operations: [
			"navigate",
			"observe",
			"interact",
			"files",
			"handoff",
			"side_effects",
		],
		policy: {
			allowedOrigins: ["https://example.test/"],
			maxContexts: 1,
			maxTabs: 2,
			maxPages: 4,
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
			receiptId: "controlled-receipt",
			probeVersion: "controlled-probe",
			verifiedAt: "2026-10-12T00:00:00Z",
			manifestDigest: `sha256:${"b".repeat(64)}`,
			evidenceHash: "c".repeat(64),
			operations: [
				"navigate",
				"observe",
				"interact",
				"files",
				"handoff",
				"side_effects",
			],
		},
	});

export const browserConformanceBinding = {
	agentId: "agent-conformance",
	conversationId: "conversation-conformance",
	sessionGeneration: 2,
	resourceFence: 7,
	workloadRevision: 4,
	imageDigest: `sha256:${"d".repeat(64)}`,
} as const;

export function browserConformanceRequest(
	overrides: Partial<RuntimeBrowserToolExecutionRequestV1> = {},
): RuntimeBrowserToolExecutionRequestV1 {
	return {
		tool: "browser_navigate",
		arguments: { url: "https://example.test/" },
		actionId: "action-conformance",
		operationRef: "operation-conformance",
		attemptRef: "attempt-conformance",
		binding: {
			...browserConformanceBinding,
			executionId: "execution-conformance",
			capabilityVersion: browserConformanceCapability.capabilityVersion,
			pageRevision: 1,
		},
		...overrides,
	};
}

export function expectBrowserDescriptorMatrix(
	template: BrowserConformanceTemplate,
	descriptors: readonly CodexBrowserToolDescriptorV1[],
) {
	const operations =
		template === "Pi" ? [] : browserConformanceCapability.operations;
	expect(descriptors.map((descriptor) => descriptor.operation)).toEqual(
		operations,
	);
	expect(descriptors.map((descriptor) => descriptor.name)).toEqual(
		operations.map((operation) => `browser_${operation}`),
	);
	for (const descriptor of descriptors) {
		expect(descriptor.capabilityVersion).toBe(
			browserConformanceCapability.capabilityVersion,
		);
		expect(descriptor.inputSchema).toMatchObject({
			type: "object",
			additionalProperties: false,
		});
	}
	const serialized = JSON.stringify(descriptors);
	expect(serialized).not.toMatch(
		/credential|playwright|chromium|imageDigest|example\.test|selector|javascript/i,
	);
}

export function expectBrowserResultEnvelope(
	result: RuntimeBrowserToolExecutionResultV1,
	request: RuntimeBrowserToolExecutionRequestV1,
	phase: RuntimeBrowserToolExecutionResultV1["phase"],
) {
	expect(result).toMatchObject({
		actionId: request.actionId,
		operationRef: request.operationRef,
		attemptRef: request.attemptRef,
		binding: request.binding,
		phase,
		success: phase === "completed",
	});
	for (const item of result.contentItems) {
		expect(item.type).toBe("inputText");
		expect(item.text).not.toMatch(/credential|token|password|secret/i);
	}
}

export function expectPiBrowserUnavailable(
	descriptors: readonly CodexBrowserToolDescriptorV1[],
) {
	expect(descriptors).toEqual([]);
}
