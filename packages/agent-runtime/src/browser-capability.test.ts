import {
	BrowserCapabilityConformanceReceiptV1Schema,
	BrowserCapabilityDeclarationV1Schema,
	BrowserCapabilityProvenanceV1Schema,
} from "@agent-infra/contracts/runtime";
import { describe, expect, it } from "vitest";
import { discoverRuntimeBrowserCapabilityV1 } from "./browser-capability.js";

const manifestDigest = `sha256:${"a".repeat(64)}`;
const declaration = BrowserCapabilityDeclarationV1Schema.parse({
	schemaVersion: 1,
	capabilityVersion: 1,
	operations: ["navigate", "observe", "interact"],
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
		allowUserHandoff: false,
	},
});
const provenance = BrowserCapabilityProvenanceV1Schema.parse({
	browser: "chromium",
	chromiumVersion: "140.0.7339.0",
	playwrightVersion: "1.55.0",
	imageDigest: manifestDigest,
});
const conformance = BrowserCapabilityConformanceReceiptV1Schema.parse({
	schemaVersion: 1,
	receiptId: "receipt-browser-1",
	probeVersion: "probe-1",
	verifiedAt: "2026-10-10T00:00:00.000Z",
	manifestDigest,
	evidenceHash: "b".repeat(64),
	operations: ["navigate", "observe"],
});
const probe = {
	capabilityVersion: 1,
	operations: ["navigate", "files"],
	provenance,
	conformance,
};

describe("Runtime Browser capability assembly", () => {
	it("publishes only the manifest/probe operation intersection", () => {
		const result = discoverRuntimeBrowserCapabilityV1(
			{ schemaVersion: 1, minimumCapabilityVersion: 1 },
			{
				declaration,
				manifestDigest,
				probe,
				now: () => Date.parse("2026-10-10T00:01:00.000Z"),
			},
		);
		expect(result).toMatchObject({
			status: "available",
			capabilityVersion: 1,
			operations: ["navigate"],
			provenance,
			conformance,
		});
	});

	it.each([
		["missing evidence", undefined, "BROWSER_CAPABILITY_PROBE_FAILED"],
		[
			"manifest mismatch",
			{
				...probe,
				conformance: {
					...conformance,
					manifestDigest: `sha256:${"c".repeat(64)}`,
				},
			},
			"BROWSER_CAPABILITY_PROBE_FAILED",
		],
		[
			"stale receipt",
			{
				...probe,
				conformance: { ...conformance, verifiedAt: "2026-10-09T00:00:00.000Z" },
			},
			"BROWSER_CAPABILITY_STALE",
		],
		[
			"empty intersection",
			{
				...probe,
				operations: ["files"],
				conformance: { ...conformance, operations: ["files"] },
			},
			"BROWSER_CAPABILITY_PROBE_FAILED",
		],
	] as const)("fails closed for %s", (_name, evidence, errorCode) => {
		const result = discoverRuntimeBrowserCapabilityV1(
			{ schemaVersion: 1 },
			{
				declaration,
				manifestDigest,
				probe: evidence,
				now: () => Date.parse("2026-10-10T00:01:00.000Z"),
			},
		);
		expect(result).toMatchObject({ status: expect.any(String), errorCode });
		expect("status" in result ? result.status : "error").not.toBe("available");
	});

	it("keeps the existing unavailable result without an assembly source", () => {
		expect(
			discoverRuntimeBrowserCapabilityV1({ schemaVersion: 1 }),
		).toMatchObject({
			status: "not_configured",
			errorCode: "BROWSER_CAPABILITY_NOT_CONFIGURED",
		});
	});
});
