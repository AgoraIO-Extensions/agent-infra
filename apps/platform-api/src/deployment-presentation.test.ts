import type { BrowserCapabilityProjectionV1 } from "@agent-infra/contracts/runtime";
import { describe, expect, it } from "vitest";
import { createDeploymentPresentation } from "./deployment-presentation.js";

const browser: BrowserCapabilityProjectionV1 = {
	schemaVersion: 1,
	capabilityVersion: 1,
	status: "available",
	operations: ["navigate", "observe"],
	policy: {
		allowedOrigins: ["https://example.test/"],
		maxContexts: 1,
		maxTabs: 1,
		maxPages: 1,
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
		chromiumVersion: "140.0.7339.0",
		playwrightVersion: "1.55.0",
		imageDigest: `sha256:${"a".repeat(64)}`,
	},
	conformance: {
		schemaVersion: 1,
		receiptId: "browser-receipt",
		probeVersion: "browser-probe",
		verifiedAt: "2026-10-10T00:00:00.000Z",
		manifestDigest: `sha256:${"a".repeat(64)}`,
		evidenceHash: "b".repeat(64),
		operations: ["navigate", "observe"],
	},
};

it("passes the verified Browser projection through the API presentation", async () => {
	const presentation = createDeploymentPresentation({
		identityScope: {
			currentRequest: () => new Request("https://api.example.test"),
			currentIdentity: async () => ({
				schemaVersion: 1,
				userId: "owner-a",
				accountStatus: "active",
				organizationIds: [],
				roles: ["employee"],
				authorizationRevision: "identity-a",
			}),
		} as never,
		configurationQuery: {
			readRuntimePresentation: async () => ({
				outcome: "found" as const,
				sourceReference: `sha256:${"a".repeat(64)}`,
				capabilities: {
					modelSelection: true,
					attachments: false,
					resultFiles: false,
					connection: false,
					supplementaryInstruction: false,
					browser,
				},
				interactionUrl: null,
			}),
		} as never,
		resourceProfile: {
			profileId: "standard-medium",
			displayName: "Standard medium",
			estimatedResources: {
				cpuMillicores: 2000,
				memoryMiB: 4096,
				storageGiB: 20,
			},
		},
		imageRepository: "registry.example.test/agent",
	});

	const result = await presentation({
		agentId: "agent-a",
		configuration: {
			agentId: "agent-a",
			revision: 1,
			source: { kind: "standard", templateId: "codex" },
			modelOptions: [],
			channelKinds: [],
		} as never,
		management: {} as never,
	});
	expect(result.capabilities.browser).toEqual(browser);
});
