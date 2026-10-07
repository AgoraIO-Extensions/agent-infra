import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import {
	BrowserCapabilityAvailableV1Schema,
	BrowserCapabilityDiscoveryRequestV1Schema,
	BrowserCapabilityProjectionV1Schema,
	BrowserCapabilityUnavailableV1Schema,
} from "../../src/runtime/index.js";
import { RuntimeManifestV1Schema } from "../../src/workload/index.js";

const declaration = {
	schemaVersion: 1,
	capabilityVersion: 1,
	operations: ["navigate", "observe", "interact", "files", "handoff"],
	policy: {
		allowedOrigins: ["https://example.test/"],
		maxContexts: 1,
		maxTabs: 4,
		maxPages: 8,
		maxViewportWidth: 1920,
		maxViewportHeight: 1080,
		maxConcurrentActions: 2,
		maxDownloads: 8,
		maxDownloadBytes: 10_000_000,
		maxUploadBytes: 10_000_000,
		maxScreenshotBytes: 10_000_000,
		maxBrowserDurationMs: 60_000,
		maxRetainedProfileBytes: 100_000_000,
		navigationTimeoutMs: 30_000,
		actionTimeoutMs: 15_000,
		requireSideEffectConfirmation: true,
		allowUserHandoff: true,
	},
} as const;

const available = {
	schemaVersion: 1,
	capabilityVersion: 1,
	status: "available",
	operations: declaration.operations,
	policy: declaration.policy,
	provenance: {
		browser: "chromium",
		chromiumVersion: "128.0.6613.0",
		playwrightVersion: "1.48.0",
		imageDigest: `sha256:${"a".repeat(64)}`,
	},
	conformance: {
		schemaVersion: 1,
		receiptId: "browser-receipt-1",
		probeVersion: "browser-probe-1",
		verifiedAt: "2026-10-06T00:00:00Z",
		manifestDigest: `sha256:${"b".repeat(64)}`,
		evidenceHash: "c".repeat(64),
		operations: declaration.operations,
	},
} as const;

describe("Browser Capability V1", () => {
	it("accepts a manifest declaration and exposes it through Runtime capabilities", () => {
		const manifest = RuntimeManifestV1Schema.parse({
			schemaVersion: 1,
			interactionMode: "platform-adapter",
			protocol: "acp",
			service: { port: 8080 },
			health: { path: "/healthz" },
			capabilities: { browser: declaration },
		});
		expect(manifest.capabilities?.browser).toEqual(declaration);
		expect(BrowserCapabilityAvailableV1Schema.parse(available)).toEqual(
			available,
		);
	});

	it("requires fixed provenance, policy and conformance facts for availability", () => {
		expect(BrowserCapabilityProjectionV1Schema.parse(available)).toEqual(
			available,
		);
		expect(
			BrowserCapabilityProjectionV1Schema.safeParse({
				...available,
				policy: { ...available.policy, allowedOrigins: ["not-an-origin"] },
			}).success,
		).toBe(false);
		for (const origin of ["http://127.0.0.1:65536/", "https://[:::]/"])
			expect(
				BrowserCapabilityProjectionV1Schema.safeParse({
					...available,
					policy: { ...available.policy, allowedOrigins: [origin] },
				}).success,
			).toBe(false);
		for (const mutation of [
			{
				...available,
				provenance: { ...available.provenance, browser: "firefox" },
			},
			{
				...available,
				provenance: {
					...available.provenance,
					imageDigest: "sha256:bad",
				},
			},
			{
				...available,
				conformance: { ...available.conformance, evidenceHash: "short" },
			},
			{
				...available,
				policy: {
					...available.policy,
					allowedOrigins: ["https://user:secret@example.test/"],
				},
			},
		])
			expect(
				BrowserCapabilityProjectionV1Schema.safeParse(mutation).success,
			).toBe(false);
	});

	it("keeps unavailable and version negotiation states explicit", () => {
		const unavailable = {
			schemaVersion: 1,
			capabilityVersion: 1,
			status: "probe_failed",
			errorCode: "BROWSER_CAPABILITY_PROBE_FAILED",
			reason: "Browser probe failed",
			retryable: true,
		} as const;
		expect(BrowserCapabilityUnavailableV1Schema.parse(unavailable)).toEqual(
			unavailable,
		);
		expect(
			BrowserCapabilityDiscoveryRequestV1Schema.parse({
				schemaVersion: 1,
				minimumCapabilityVersion: 1,
			}),
		).toEqual({ schemaVersion: 1, minimumCapabilityVersion: 1 });
	});

	it("publishes equivalent machine validation for Browser policy origins", async () => {
		const document = JSON.parse(
			await readFile(
				new URL(
					"../../artifacts/json-schema/browser-capability.v1.schema.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		const ajv = new Ajv2020({ strict: true });
		ajv.addSchema(document);
		const validate = ajv.compile({
			$ref: `${document.$id}#/$defs/BrowserCapabilityDeclarationV1`,
		});
		expect(validate(declaration)).toBe(true);
		for (const origin of [
			"https://user:secret@example.test/",
			"https://example.test/path",
			"http://127.0.0.1:65536/",
		]) {
			expect(
				validate({
					...declaration,
					policy: { ...declaration.policy, allowedOrigins: [origin] },
				}),
			).toBe(false);
		}
	});
});
