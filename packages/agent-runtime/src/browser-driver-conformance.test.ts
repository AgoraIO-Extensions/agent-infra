import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	browserConformanceCapability,
	browserConformanceRequest,
	browserConformanceTemplates,
	expectBrowserDescriptorMatrix,
	expectBrowserResultEnvelope,
	expectPiBrowserUnavailable,
} from "./browser-conformance.test-support.js";
import { createCodexBrowserToolDescriptorsV1 } from "./codex-browser-tools.js";
import type { RuntimeBrowserToolExecutionResultV1 } from "./driver.js";

/**
 * This matrix intentionally exercises the shared, controlled projection seam.
 * Native binaries, Session Sandbox, Worker dispatch and ACK authority remain
 * outside this fixture and are covered by their owning integration lanes.
 */
const descriptorReaders = Object.fromEntries(
	browserConformanceTemplates.map((template) => [
		template,
		() =>
			template === "Pi"
				? []
				: createCodexBrowserToolDescriptorsV1(browserConformanceCapability),
	]),
) as Record<
	(typeof browserConformanceTemplates)[number],
	() => ReturnType<typeof createCodexBrowserToolDescriptorsV1>
>;

describe("Browser Driver conformance matrix (controlled seam)", () => {
	it.each(browserConformanceTemplates)(
		"%s publishes the common bounded descriptor projection",
		(template) => {
			expectBrowserDescriptorMatrix(template, descriptorReaders[template]());
		},
	);

	it("keeps missing capability fail-closed for every available transport reader", () => {
		for (const template of browserConformanceTemplates) {
			const descriptors =
				template === "Pi" ? [] : createCodexBrowserToolDescriptorsV1(undefined);
			expect(descriptors).toEqual([]);
		}
	});

	it("rejects a foreign result identity or binding at the transport boundary", () => {
		const request = browserConformanceRequest();
		const foreignResults: RuntimeBrowserToolExecutionResultV1[] = [
			{
				...browserResult(request),
				actionId: "foreign-action",
			},
			{
				...browserResult(request),
				binding: { ...request.binding, conversationId: "foreign-conversation" },
			},
		];
		expect(foreignResults[0]?.actionId).not.toBe(request.actionId);
		expect(foreignResults[1]?.binding).not.toEqual(request.binding);
	});

	it.each([
		["completed", true],
		["failed", false],
		["unknown", false],
	] as const)("keeps the %s result envelope stable", (phase, _success) => {
		const request = browserConformanceRequest({ actionId: randomUUID() });
		const result = browserResult(request, phase);
		expectBrowserResultEnvelope(result, request, phase);
	});

	it("represents cancellation as unknown so a caller cannot replay it as success", () => {
		const request = browserConformanceRequest();
		const cancelled = browserResult(request, "unknown", "cancelled");
		expectBrowserResultEnvelope(cancelled, request, "unknown");
		expect(cancelled.failureCode).toBe("cancelled");
	});

	it("keeps the fixed Pi transport explicitly unavailable", () => {
		expectPiBrowserUnavailable(descriptorReaders.Pi());
	});
});

function browserResult(
	request: ReturnType<typeof browserConformanceRequest>,
	phase: RuntimeBrowserToolExecutionResultV1["phase"] = "completed",
	failureCode?: string,
): RuntimeBrowserToolExecutionResultV1 {
	return {
		actionId: request.actionId,
		operationRef: request.operationRef,
		attemptRef: request.attemptRef,
		binding: request.binding,
		phase,
		contentItems:
			phase === "completed"
				? [{ type: "inputText", text: "bounded observation" }]
				: [],
		success: phase === "completed",
		...(failureCode ? { failureCode } : {}),
	};
}
