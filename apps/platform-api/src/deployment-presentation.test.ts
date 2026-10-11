import type { BrowserCapabilityProjectionV1 } from "@agent-infra/contracts/runtime";
import { describe, expect, it, vi } from "vitest";

import { createDeploymentPresentation } from "./deployment-presentation.js";

const identity = {
	schemaVersion: 1 as const,
	userId: "user_01",
	displayName: "Employee",
	accountStatus: "active" as const,
	organizationIds: ["org_01"],
	roles: ["employee" as const],
	authorizationRevision: "authrev_01",
};

const configuration = {
	agentId: "agent_01",
	revision: 1,
	source: {
		kind: "custom" as const,
		interactionMode: "self-managed" as const,
		identityResponsibility: "platform-managed" as const,
		connectionEnabled: false,
	},
	ownerIds: ["user_01"],
	availability: [],
	modelOptions: [],
	defaultModelOptionId: null,
	defaultReasoningLevel: null,
	environment: [],
	channelKinds: [],
	secrets: [],
};

const management = {
	schemaVersion: 1 as const,
	applicationId: "application_01",
	agentId: "agent_01",
	applicantId: "user_01",
	status: "available" as const,
	revision: 1,
	approvalRevision: 1,
	decisionReason: null,
	serviceAvailability: "ready" as const,
	desiredState: "running" as const,
	workloadRevision: 1,
	fence: 1,
	ownerIds: ["user_01"],
	availability: [],
	failureCode: null,
};

describe("deployment presentation platform identity route", () => {
	it("keeps Runtime model selection hidden until the API reader is wired", async () => {
		const request = new Request("https://platform.test/agents/agent_01");
		const base = {
			identityScope: {
				currentRequest: () => request,
				currentIdentity: async () => identity,
			} as never,
			configurationQuery: {
				readRuntimePresentation: vi.fn().mockResolvedValue({
					outcome: "found",
					sourceReference: "sha256:custom",
					capabilities: { modelSelection: true },
					interactionUrl: null,
				}),
			},
			resourceProfile: {
				profileId: "profile_01",
				displayName: "Small",
				estimatedResources: {
					cpuMillicores: 100,
					memoryMiB: 128,
					storageGiB: 1,
				},
			},
			imageRepository: "registry.example.test/agents",
		};
		const unavailable = await createDeploymentPresentation(base)({
			agentId: "agent_01",
			configuration: {
				...configuration,
				source: {
					kind: "custom",
					interactionMode: "platform-adapter",
					connectionEnabled: false,
				},
			},
			management,
		});
		expect(unavailable.capabilities.modelSelection).toBe(false);
		const available = await createDeploymentPresentation({
			...base,
			modelSelectionAvailable: true,
		})({
			agentId: "agent_01",
			configuration: {
				...configuration,
				source: {
					kind: "custom",
					interactionMode: "platform-adapter",
					connectionEnabled: false,
				},
			},
			management,
		});
		expect(available.capabilities.modelSelection).toBe(true);
		const standard = await createDeploymentPresentation(base)({
			agentId: "agent_01",
			configuration: {
				...configuration,
				source: {
					kind: "standard",
					templateId: "codex",
					connectionEnabled: false,
				},
			},
			management,
		});
		expect(standard.capabilities.modelSelection).toBe(true);
	});

	it("uses only a resolver-provided canonical HTTPS origin", async () => {
		const request = new Request("https://platform.test/agents/agent_01");
		const present = createDeploymentPresentation({
			identityScope: {
				currentRequest: () => request,
				currentIdentity: async () => identity,
			} as never,
			configurationQuery: {
				readRuntimePresentation: vi.fn().mockResolvedValue({
					outcome: "found",
					sourceReference: "sha256:custom",
					capabilities: {},
					interactionUrl: null,
				}),
			},
			resourceProfile: {
				profileId: "profile_01",
				displayName: "Small",
				estimatedResources: {
					cpuMillicores: 100,
					memoryMiB: 128,
					storageGiB: 1,
				},
			},
			imageRepository: "registry.example.test/agents",
			resolveCustomAgentInteractionUrl: async () =>
				"https://agent.example.test",
		});
		const result = await present({
			agentId: "agent_01",
			configuration,
			management,
		});
		expect(result.interactionUrl).toBe("https://agent.example.test");

		const unsafe = createDeploymentPresentation({
			identityScope: {
				currentRequest: () => request,
				currentIdentity: async () => identity,
			} as never,
			configurationQuery: {
				readRuntimePresentation: vi.fn().mockResolvedValue({
					outcome: "found",
					sourceReference: "sha256:custom",
					capabilities: {},
					interactionUrl: null,
				}),
			},
			resourceProfile: {
				profileId: "profile_01",
				displayName: "Small",
				estimatedResources: {
					cpuMillicores: 100,
					memoryMiB: 128,
					storageGiB: 1,
				},
			},
			imageRepository: "registry.example.test/agents",
			resolveCustomAgentInteractionUrl: async () => "http://agent.example.test",
		});
		expect(
			(await unsafe({ agentId: "agent_01", configuration, management }))
				.interactionUrl,
		).toBeNull();
	});
});

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
