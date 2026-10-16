import type { BrowserCapabilityProjectionV1 } from "@agent-infra/contracts/runtime";
import { describe, expect, it, vi } from "vitest";

import { createDeploymentIdentityScope } from "./deployment-identity.js";
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

/** 以持久化的多服务清单调用展示函数；单 Agent 档位刻意设为 profile_01 以区分多服务默认档位。 */
function presentMultiServiceManifest(manifest: string) {
	const request = new Request("https://platform.test/agents/agent_01");
	return createDeploymentPresentation({
		identityScope: {
			currentRequest: () => request,
			currentIdentity: async () => identity,
			requestIdentity: async () => identity,
		} as never,
		configurationQuery: {
			readRuntimePresentation: vi.fn().mockResolvedValue({
				outcome: "found",
				sourceReference: "sha256:multi-service",
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
	})({
		agentId: "agent_01",
		configuration: {
			...configuration,
			source: {
				kind: "custom",
				interactionMode: "self-managed",
				identityResponsibility: "self-managed",
				connectionEnabled: false,
				manifest,
			},
		},
		management,
	});
}

/** web（入口）与 worker 两个服务；按名称在工作负载或 Service 上声明档位。 */
function twoServiceManifestJson(
	profiles: {
		readonly workload?: Readonly<Record<string, string>>;
		readonly service?: Readonly<Record<string, string>>;
	} = {},
) {
	const annotation = (ref: string | undefined) =>
		ref === undefined ? {} : { "agent-infra.agora.io/resource-profile": ref };
	return JSON.stringify({
		schemaVersion: 1,
		entryServiceName: "web",
		resources: ["web", "worker"].flatMap((name) => [
			{
				apiVersion: "apps/v1",
				kind: "Deployment",
				metadata: {
					name,
					annotations: annotation(profiles.workload?.[name]),
				},
				spec: {
					replicas: 1,
					selector: { matchLabels: { app: name } },
					template: {
						metadata: { labels: { app: name } },
						spec: {
							containers: [{ name, image: `sha256:${"a".repeat(64)}` }],
						},
					},
				},
			},
			{
				apiVersion: "v1",
				kind: "Service",
				metadata: {
					name,
					annotations: {
						...(name === "web" ? { "agent-infra.agora.io/entry": "true" } : {}),
						...annotation(profiles.service?.[name]),
					},
				},
				spec: {
					type: "ClusterIP",
					selector: { app: name },
					ports: [{ name: "http", port: 8080, targetPort: 8080 }],
				},
			},
		]),
	});
}

describe("deployment presentation platform identity route", () => {
	it("resolves the request identity once for all Agents presented in one request (#2632)", async () => {
		let resolutions = 0;
		const identityScope = createDeploymentIdentityScope({
			async resolve() {
				resolutions += 1;
				return identity;
			},
			async hydrateUsers() {
				return [];
			},
		});
		const readRuntimePresentation = vi.fn().mockResolvedValue({
			outcome: "found",
			sourceReference: "sha256:custom",
			capabilities: {},
			interactionUrl: null,
		});
		const present = createDeploymentPresentation({
			identityScope,
			configurationQuery: { readRuntimePresentation },
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
		});
		const agents = Array.from({ length: 6 }, (_, index) => `agent_0${index}`);
		const presentAll = () =>
			Promise.all(
				agents.map((agentId) =>
					present({
						agentId,
						configuration: { ...configuration, agentId },
						management: { ...management, agentId },
					}),
				),
			);

		await identityScope.requestScope(
			new Request("https://platform.test/api/v2/agents"),
			presentAll,
		);
		// 之前每个 Agent 都完整重新解析一次请求身份（6 次）；现在一个请求只解析一次。
		expect(resolutions).toBe(1);
		expect(readRuntimePresentation).toHaveBeenCalledTimes(6);
		for (const [call] of readRuntimePresentation.mock.calls)
			expect(call).toMatchObject({
				actorId: identity.userId,
				organizationIds: identity.organizationIds,
				isAdministrator: false,
				accountStatus: "active",
			});

		// 下一个请求重新解析，不复用上一个请求的身份。
		await identityScope.requestScope(
			new Request("https://platform.test/api/v2/agents"),
			presentAll,
		);
		expect(resolutions).toBe(2);
	});

	it("keeps Runtime model selection hidden until the API reader is wired", async () => {
		const request = new Request("https://platform.test/agents/agent_01");
		const base = {
			identityScope: {
				currentRequest: () => request,
				currentIdentity: async () => identity,
				requestIdentity: async () => identity,
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

	it("projects a persisted multi-service manifest without inventing an image reference", async () => {
		const request = new Request("https://platform.test/agents/agent_01");
		const present = await createDeploymentPresentation({
			identityScope: {
				currentRequest: () => request,
				currentIdentity: async () => identity,
				requestIdentity: async () => identity,
			} as never,
			configurationQuery: {
				readRuntimePresentation: vi.fn().mockResolvedValue({
					outcome: "found",
					sourceReference: "sha256:multi-service",
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
		})({
			agentId: "agent_01",
			configuration: {
				...configuration,
				source: {
					kind: "custom",
					interactionMode: "self-managed",
					identityResponsibility: "self-managed",
					connectionEnabled: false,
					manifest: '{"schemaVersion":1,"entryServiceName":"api"}',
				},
			},
			management,
		});

		expect(present.source).toEqual({
			kind: "custom",
			manifest: '{"schemaVersion":1,"entryServiceName":"api"}',
			interactionMode: "self-managed",
			identityResponsibility: "self-managed",
		});
		expect(present.source).not.toHaveProperty("imageReference");
	});

	it("projects each Service profile from a persisted YAML manifest", async () => {
		const present = await presentMultiServiceManifest(`schemaVersion: 1
entryServiceName: api
resources:
  - apiVersion: v1
    kind: Service
    metadata:
      name: api
      annotations:
        agent-infra.agora.io/entry: "true"
        agent-infra.agora.io/resource-profile: small
    spec:
      type: ClusterIP
      selector: {app: api}
      ports: [{name: http, port: 8080, targetPort: 8080}]
  - apiVersion: apps/v1
    kind: Deployment
    metadata: {name: api}
    spec:
      replicas: 1
      selector: {matchLabels: {app: api}}
      template:
        metadata: {labels: {app: api}}
        spec:
          containers:
            - name: api
              image: sha256:${"a".repeat(64)}
`);
		expect(present.source).toMatchObject({
			services: [{ name: "api", resourceProfileRef: "small", entry: true }],
		});
	});

	it("projects the multi-service default profile, not the single-Agent profile, when no annotation exists", async () => {
		const present = await presentMultiServiceManifest(twoServiceManifestJson());
		// 单 Agent 档位是 profile_01；多服务未声明时必须展示 Worker 实际注入的 default。
		expect(present.source).toMatchObject({
			services: [
				{ name: "web", resourceProfileRef: "default", entry: true },
				{ name: "worker", resourceProfileRef: "default", entry: false },
			],
		});
	});

	it("projects a workload annotation ahead of its Service annotation", async () => {
		const present = await presentMultiServiceManifest(
			twoServiceManifestJson({
				workload: { web: "large" },
				service: { web: "small", worker: "small" },
			}),
		);
		expect(present.source).toMatchObject({
			services: [
				{ name: "web", resourceProfileRef: "large", entry: true },
				{ name: "worker", resourceProfileRef: "small", entry: false },
			],
		});
	});

	it("uses only a resolver-provided canonical HTTPS origin", async () => {
		const request = new Request("https://platform.test/agents/agent_01");
		const present = createDeploymentPresentation({
			identityScope: {
				currentRequest: () => request,
				currentIdentity: async () => identity,
				requestIdentity: async () => identity,
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
				requestIdentity: async () => identity,
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
			requestIdentity: async () => ({
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
					skills: [
						{
							schemaVersion: 1,
							name: "workspace-summary",
							version: "0.1.0",
							manifestSha256: "a".repeat(64),
							packageDigest: "b".repeat(64),
							readOnly: true,
						},
						{
							schemaVersion: 1,
							name: "release-notes",
							version: "1.0.0",
							manifestSha256: "c".repeat(64),
							packageDigest: "d".repeat(64),
							readOnly: true,
						},
					],
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
			source: {
				kind: "standard",
				templateId: "codex",
				connectionEnabled: false,
			},
			modelOptions: [],
			channelKinds: [],
		} as never,
		management: {} as never,
	});
	expect(result.capabilities.browser).toEqual(browser);
	expect(result.capabilities.skills).toEqual([
		{
			schemaVersion: 1,
			name: "workspace-summary",
			version: "0.1.0",
			manifestSha256: "a".repeat(64),
			packageDigest: "b".repeat(64),
			readOnly: true,
		},
		{
			schemaVersion: 1,
			name: "release-notes",
			version: "1.0.0",
			manifestSha256: "c".repeat(64),
			packageDigest: "d".repeat(64),
			readOnly: true,
		},
	]);
});

it("preserves an explicitly empty Skill capability list", async () => {
	const presentation = createDeploymentPresentation({
		identityScope: {
			currentRequest: () => new Request("https://api.example.test"),
			currentIdentity: async () => identity,
			requestIdentity: async () => identity,
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
					skills: [],
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
			...configuration,
			agentId: "agent-a",
			source: {
				kind: "standard",
				templateId: "codex",
				connectionEnabled: false,
			},
		},
		management: {} as never,
	});
	expect(result.capabilities.skills).toEqual([]);
});
