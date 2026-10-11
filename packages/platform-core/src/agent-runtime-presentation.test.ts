import { describe, expect, it } from "vitest";

import { agentConfigurationConformanceRecordV1 } from "./agent-configuration.conformance.js";
import type { AgentConfigurationRecordV2 } from "./agent-configuration-types.js";
import {
	type AgentManagementStateV1,
	isAgentAccessAllowedV1,
} from "./agent-management.js";
import {
	type AgentRuntimePresentationFactsV1,
	decideAgentRuntimePresentationV1,
	snapshotAgentRuntimePresentationExpectationV1,
} from "./agent-runtime-presentation.js";
import type { WorkloadBrowserCapabilityProjectionV1 } from "./workload-reconciliation.js";

const management: AgentManagementStateV1 = {
	schemaVersion: 1,
	applicationId: "application_01",
	agentId: "agent_01",
	applicantId: "owner_01",
	status: "available",
	revision: 11,
	approvalRevision: 1,
	decisionReason: null,
	serviceAvailability: "ready",
	desiredState: "running",
	workloadRevision: 1,
	fence: 1,
	ownerIds: ["owner_01"],
	availability: [],
	failureCode: null,
};
const actor = {
	schemaVersion: 1 as const,
	userId: "owner_01",
	accountStatus: "active" as const,
	organizationIds: [],
	isAdministrator: false,
};

function fixture() {
	const configuration = structuredClone(agentConfigurationConformanceRecordV1);
	const deployment = {
		agentId: "agent_01",
		configRevision: configuration.revision,
		workloadRevision: 1,
		fence: 1,
		desiredState: "running" as const,
		imageDigest: configuration.source.imageDigest,
		runtimeManifest: { interactionMode: "platform-adapter" as const },
		route: { exposure: "internal-only" as const },
	};
	const version = {
		configuration,
		deployment,
	} as unknown as import("./workload-reconciliation.js").WorkloadVersionV1;
	const facts: AgentRuntimePresentationFactsV1 = {
		management: structuredClone(management),
		configuration,
		sourceReference: "template_01",
		runtime: {
			revision: 1,
			verifiedConfiguration: configuration,
			verifiedSourceReference: "template_01",
			deployment,
			state: {
				schemaVersion: 1,
				agentId: "agent_01",
				sourceConfigurationRevision: configuration.revision,
				sourceLifecycleRevision: 1,
				revision: 1,
				fence: 1,
				phase: "ready",
				candidate: version,
				verified: version,
				verifiedRevision: 1,
				identity: { uid: "workload_01", generation: 1 },
				rollback: false,
				failureCode: null,
				attempts: 0,
				capabilities: { modelSelection: true },
			},
		},
	};
	return {
		agentId: "agent_01",
		actor,
		facts,
		expected: snapshotAgentRuntimePresentationExpectationV1({
			configurationRevision: configuration.revision,
			management,
		}),
	};
}

describe("Agent runtime presentation policy", () => {
	it("fails closed when Browser is declared but verified projection is missing", () => {
		const input = fixture();
		const runtime = input.facts.runtime;
		if (!runtime) throw new Error();
		const facts = {
			...input.facts,
			runtime: {
				...runtime,
				deployment: {
					...runtime.deployment,
					runtimeManifest: {
						...runtime.deployment.runtimeManifest,
						capabilities: { browser: {} as never },
					},
				},
			},
		};
		expect(decideAgentRuntimePresentationV1({ ...input, facts })).toEqual({
			outcome: "unavailable",
		});
	});
	it("fails closed while a Browser-declared Workload is not ready", () => {
		const input = fixture();
		const runtime = input.facts.runtime;
		if (!runtime) throw new Error();
		const facts = {
			...input.facts,
			management: {
				...input.facts.management,
				serviceAvailability: "updating" as const,
			},
			runtime: {
				...runtime,
				deployment: {
					...runtime.deployment,
					runtimeManifest: {
						...runtime.deployment.runtimeManifest,
						capabilities: { browser: {} as never },
					},
				},
			},
		};
		expect(decideAgentRuntimePresentationV1({ ...input, facts })).toEqual({
			outcome: "stale",
		});
	});
	it("fails closed when a Browser Workload fence is stale", () => {
		const input = fixture();
		const runtime = input.facts.runtime;
		if (!runtime) throw new Error();
		const facts = {
			...input.facts,
			runtime: {
				...runtime,
				deployment: {
					...runtime.deployment,
					fence: runtime.deployment.fence + 1,
					runtimeManifest: {
						...runtime.deployment.runtimeManifest,
						capabilities: { browser: {} as never },
					},
				},
			},
		};
		expect(decideAgentRuntimePresentationV1({ ...input, facts })).toEqual({
			outcome: "unavailable",
		});
	});

	it("projects the verified Browser state without exposing probe internals", () => {
		const input = fixture();
		const browser: WorkloadBrowserCapabilityProjectionV1 = {
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
		const runtime = input.facts.runtime;
		if (!runtime?.state.capabilities) throw new Error();
		const browserDeclaration = {
			schemaVersion: 1,
			capabilityVersion: 1,
			operations: browser.operations,
			policy: browser.policy,
		};
		const facts = {
			...input.facts,
			runtime: {
				...runtime,
				deployment: {
					...runtime.deployment,
					runtimeManifest: {
						...runtime.deployment.runtimeManifest,
						capabilities: { browser: browserDeclaration },
					},
				},
				state: {
					...runtime.state,
					capabilities: { ...runtime.state.capabilities, browser },
				},
			},
		};
		expect(decideAgentRuntimePresentationV1({ ...input, facts })).toMatchObject(
			{
				outcome: "found",
				capabilities: { modelSelection: true, browser },
			},
		);
	});
	it.each([false, true])(
		"rejects another Agent's configuration before projecting source or capabilities (runtime present: %s)",
		(hasRuntime) => {
			const input = fixture();
			expect(
				decideAgentRuntimePresentationV1({
					...input,
					facts: {
						...input.facts,
						configuration: {
							...input.facts.configuration,
							agentId: "another-agent",
						},
						sourceReference: "another-agent-source",
						runtime: hasRuntime ? input.facts.runtime : null,
					},
				}),
			).toEqual({ outcome: "stale" });
		},
	);

	it("keeps administrator visibility separate from Owner authority and hides stale resources from unrelated or disabled subjects", () => {
		const input = fixture();
		const administrator = {
			...actor,
			userId: "administrator",
			isAdministrator: true,
		};
		expect(isAgentAccessAllowedV1(management, administrator, "manage")).toBe(
			false,
		);
		expect(
			decideAgentRuntimePresentationV1({ ...input, actor: administrator }),
		).toMatchObject({
			outcome: "found",
			capabilities: { modelSelection: true },
		});
		const stale = {
			...input,
			expected: { ...input.expected, configurationRevision: 1 },
		};
		for (const forbidden of [
			{ ...actor, userId: "unrelated" },
			{ ...administrator, accountStatus: "disabled" as const },
		])
			expect(
				decideAgentRuntimePresentationV1({ ...stale, actor: forbidden }),
			).toEqual({ outcome: "unavailable" });
	});

	it("does not attach an older active runtime to the currently selected configuration after rollback", () => {
		const input = fixture();
		const runtime = input.facts.runtime;
		if (!runtime) throw new Error("Expected verified fixture");
		const revision = input.facts.configuration.revision + 1;
		const facts = {
			...input.facts,
			configuration: { ...input.facts.configuration, revision },
			runtime: {
				...runtime,
				state: {
					...runtime.state,
					sourceConfigurationRevision: revision,
					rollback: true,
				},
			},
		};
		expect(
			decideAgentRuntimePresentationV1({
				...input,
				facts,
				expected: { ...input.expected, configurationRevision: revision },
			}),
		).toEqual({
			outcome: "found",
			sourceReference: "template_01",
			capabilities: null,
			interactionUrl: null,
		});
	});

	it("captures the full upstream management snapshot before asynchronous reads", () => {
		const input = fixture();
		const callerManagement = {
			...management,
			ownerIds: [...management.ownerIds],
		};
		const expected = snapshotAgentRuntimePresentationExpectationV1({
			configurationRevision: input.facts.configuration.revision,
			management: callerManagement,
		});
		callerManagement.ownerIds = ["different-owner"];
		expect(expected.management.ownerIds).toEqual(["owner_01"]);
		expect(
			decideAgentRuntimePresentationV1({
				...input,
				expected,
				facts: {
					...input.facts,
					management: { ...management, serviceAvailability: "updating" },
				},
			}),
		).toEqual({ outcome: "stale" });
	});

	it("projects only the verified self-managed HTTPS origin", () => {
		const input = fixture();
		const current = input.facts.runtime;
		if (!current) throw new Error("Expected verified fixture");
		const configuration = {
			...input.facts.configuration,
			source: {
				kind: "custom" as const,
				imageDigest: `sha256:${"b".repeat(64)}`,
				admissionRevision: "custom-admission",
				interactionMode: "self-managed" as const,
				identityResponsibility: "self-managed" as const,
				connectionEnabled: false,
			},
			modelConfiguration: null,
		} as unknown as AgentConfigurationRecordV2;
		const deployment = {
			...current.deployment,
			imageDigest: configuration.source.imageDigest,
			runtimeManifest: { interactionMode: "self-managed" as const },
			route: {
				exposure: "self-managed" as const,
				interactionOrigin: "https://agent.example.test",
			},
		};
		const version = {
			configuration,
			deployment,
		} as unknown as import("./workload-reconciliation.js").WorkloadVersionV1;
		const facts = {
			...input.facts,
			configuration,
			runtime: {
				...current,
				verifiedConfiguration: configuration,
				deployment,
				state: { ...current.state, candidate: version, verified: version },
			},
		};
		expect(decideAgentRuntimePresentationV1({ ...input, facts })).toMatchObject(
			{
				outcome: "found",
				interactionUrl: "https://agent.example.test",
			},
		);
		for (const interactionOrigin of [
			"http://agent.example.test",
			"https://agent.example.test/entry",
			"https://agent.example.test/?token=secret",
		]) {
			const unsafeFacts = {
				...facts,
				runtime: {
					...facts.runtime,
					deployment: {
						...deployment,
						route: { exposure: "self-managed" as const, interactionOrigin },
					},
				},
			};
			expect(
				decideAgentRuntimePresentationV1({ ...input, facts: unsafeFacts }),
			).toMatchObject({ outcome: "found", interactionUrl: null });
		}
		const adapterFacts = fixture().facts;
		if (!adapterFacts.runtime) throw new Error("Expected verified fixture");
		expect(
			decideAgentRuntimePresentationV1({
				...input,
				facts: {
					...adapterFacts,
					runtime: {
						...adapterFacts.runtime,
						deployment: {
							...adapterFacts.runtime.deployment,
							route: {
								exposure: "internal-only",
								interactionOrigin: "https://agent.example.test",
							},
						},
					},
				},
			}),
		).toMatchObject({ outcome: "found", interactionUrl: null });

		const platformManagedConfiguration = {
			...configuration,
			source: {
				...configuration.source,
				identityResponsibility: "platform-managed" as const,
			},
		};
		const platformManagedDeployment = {
			...deployment,
			route: {
				exposure: "platform-auth" as const,
				interactionOrigin: "https://owner.example.test",
			},
		};
		const platformManagedVersion = {
			configuration: platformManagedConfiguration,
			deployment: platformManagedDeployment,
		} as unknown as import("./workload-reconciliation.js").WorkloadVersionV1;
		expect(
			decideAgentRuntimePresentationV1({
				...input,
				facts: {
					...facts,
					configuration: platformManagedConfiguration,
					runtime: {
						...current,
						verifiedConfiguration: platformManagedConfiguration,
						deployment: platformManagedDeployment,
						state: {
							...current.state,
							candidate: platformManagedVersion,
							verified: platformManagedVersion,
						},
					},
				},
			}),
		).toMatchObject({
			outcome: "found",
			interactionUrl: null,
		});
	});
});
