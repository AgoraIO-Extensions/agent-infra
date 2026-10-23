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
import {
	createWorkloadReconciliationV1,
	type WorkloadBrowserCapabilityProjectionV1,
	type WorkloadPhaseV1,
	type WorkloadReconciliationStateV1,
	type WorkloadRuntimePortV1,
	type WorkloadVersionV1,
} from "./workload-reconciliation.js";

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
		channels: [],
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
	it("fails closed when Browser deployment exposure disagrees with configuration", () => {
		const input = fixture();
		const runtime = input.facts.runtime;
		if (!runtime) throw new Error();
		const facts = {
			...input.facts,
			runtime: {
				...runtime,
				deployment: {
					...runtime.deployment,
					route: { exposure: "platform-auth" as const },
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
	it("preserves verified Skill capability metadata for Agent presentation", () => {
		const input = fixture();
		const runtime = input.facts.runtime;
		if (!runtime) throw new Error();
		const skills = [
			{
				schemaVersion: 1 as const,
				name: "workspace-summary",
				version: "0.1.0",
				manifestSha256: "a".repeat(64),
				packageDigest: "b".repeat(64),
				readOnly: true as const,
			},
			{
				schemaVersion: 1 as const,
				name: "release-notes",
				version: "1.0.0",
				manifestSha256: "c".repeat(64),
				packageDigest: "d".repeat(64),
				readOnly: true as const,
			},
		];
		const facts = {
			...input.facts,
			runtime: {
				...runtime,
				state: {
					...runtime.state,
					capabilities: { modelSelection: true, skills },
				},
			},
		};
		expect(decideAgentRuntimePresentationV1({ ...input, facts })).toMatchObject(
			{
				outcome: "found",
				capabilities: { skills },
			},
		);
		const emptyFacts = {
			...input.facts,
			runtime: {
				...runtime,
				state: {
					...runtime.state,
					capabilities: { modelSelection: true, skills: [] },
				},
			},
		};
		expect(
			decideAgentRuntimePresentationV1({ ...input, facts: emptyFacts }),
		).toMatchObject({ capabilities: { skills: [] } });
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
			channels: [],
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

// #3304：漂移恢复只推进 Workload revision，verified 部署保留产生它的修订（#1480）。
describe("Agent runtime presentation after Workload drift recovery", () => {
	const capabilities = {
		modelSelection: true,
		attachments: true,
		resultFiles: true,
		nativeMetadata: true,
	};

	/** 以真实调谐状态机驱动 Workload：先创建到 ready，再按 `health` 依次返回观测结果。 */
	function reconciled() {
		const input = fixture();
		const configuration = input.facts.configuration;
		const management = structuredClone(input.facts.management);
		const health: ("healthy" | "drifted")[] = [];
		const phases: WorkloadPhaseV1[] = [];
		let state: WorkloadReconciliationStateV1 | null = null;
		const runtime: WorkloadRuntimePortV1 = {
			capabilities: async () => structuredClone(capabilities),
			// 与 Worker 一致：部署契约在 preflight 时记录当时的 Workload 修订与 fence。
			preflight: async (_input, current) => ({
				configuration: current.candidate.configuration,
				deployment: {
					agentId: current.agentId,
					configRevision: current.candidate.configuration.revision,
					workloadRevision: current.revision,
					fence: current.fence,
					desiredState: "running",
					imageDigest: current.candidate.configuration.source.imageDigest,
					runtimeManifest: { interactionMode: "platform-adapter" },
					route: { exposure: "internal-only" },
				},
			}),
			closeRoute: async () => undefined,
			apply: async () => ({ uid: "workload_01", generation: 1 }),
			observe: async () => health.shift() ?? "healthy",
			activateSecrets: async () => "active",
			promote: async () => undefined,
			discardUnactivatedSecrets: async () => true,
			cleanup: async () => true,
		};
		const worker = createWorkloadReconciliationV1({
			runtime,
			store: {
				async runNext(_workerId, step) {
					state = await step({
						management,
						configuration,
						state: structuredClone(state),
						requestId: "request_01",
						traceId: "trace_01",
					});
					phases.push(state.phase);
					return "advanced";
				},
			},
		});
		const current = () => {
			if (!state) throw new Error("Expected a Workload state");
			return state;
		};
		return {
			health,
			phases,
			get state() {
				return current();
			},
			async tick(times: number) {
				for (let i = 0; i < times; i++) await worker.tick("worker_01");
			},
			/** Store 从持久状态解出的事实：deployment 取自 verified 部署本身。 */
			present() {
				const runtimeFacts = input.facts.runtime;
				const persisted = current();
				if (!runtimeFacts || !persisted.verified) throw new Error();
				return decideAgentRuntimePresentationV1({
					...input,
					facts: {
						...input.facts,
						runtime: {
							...runtimeFacts,
							revision: persisted.revision,
							state: persisted,
							deployment: persisted.verified
								.deployment as typeof runtimeFacts.deployment,
						},
					},
				});
			},
		};
	}

	async function recovered() {
		const f = reconciled();
		await f.tick(7);
		expect(f.state).toMatchObject({ phase: "ready", revision: 1 });
		expect(f.present()).toMatchObject({ outcome: "found", capabilities });
		f.phases.length = 0;
		f.health.push("drifted");
		await f.tick(5);
		return f;
	}

	it("keeps the verified capabilities after ready → drifted → applying → observing → promoting → ready", async () => {
		const f = await recovered();
		expect(f.phases).toEqual([
			"applying",
			"observing",
			"activating",
			"promoting",
			"ready",
		]);
		// 漂移恢复的合法形态：修订推进到 2，verified 部署仍是修订 1 产生的同一部署。
		expect(f.state).toMatchObject({
			phase: "ready",
			revision: 2,
			verifiedRevision: 2,
			verified: { deployment: { workloadRevision: 1, fence: 1 } },
			capabilities,
		});
		expect(f.state.candidate).toEqual(f.state.verified);
		expect(f.present()).toEqual({
			outcome: "found",
			sourceReference: "template_01",
			channels: [],
			capabilities,
			interactionUrl: null,
		});
	});

	it("projects an already persisted drift-recovered state without restarting the Agent", () => {
		// 固定环境回读的形态：revision=verifiedRevision=3，verified 部署修订为 2。
		const input = fixture();
		const runtime = input.facts.runtime;
		if (!runtime) throw new Error();
		const deployment = { ...runtime.deployment, workloadRevision: 2 };
		const version = {
			configuration: input.facts.configuration,
			deployment,
		} as unknown as WorkloadVersionV1;
		const facts = {
			...input.facts,
			runtime: {
				...runtime,
				revision: 3,
				deployment,
				state: {
					...runtime.state,
					revision: 3,
					verifiedRevision: 3,
					candidate: version,
					verified: version,
					capabilities,
				},
			},
		};
		expect(decideAgentRuntimePresentationV1({ ...input, facts })).toMatchObject(
			{ outcome: "found", capabilities },
		);
	});

	it.each<
		[
			string,
			(
				state: WorkloadReconciliationStateV1,
				deployment: Record<string, unknown>,
			) => {
				state?: Partial<WorkloadReconciliationStateV1>;
				deployment?: Record<string, unknown>;
				candidateOnly?: boolean;
				fence?: number;
				rowRevision?: number;
			},
		]
	>([
		["a newer management fence", () => ({ fence: 2 })],
		["a stale deployment fence", () => ({ deployment: { fence: 2 } })],
		[
			"a stale Workload configuration revision",
			(s) => ({
				state: {
					sourceConfigurationRevision: s.sourceConfigurationRevision + 1,
				},
			}),
		],
		[
			"a deployment of another configuration revision",
			(_, d) => ({
				deployment: { configRevision: (d.configRevision as number) + 1 },
			}),
		],
		[
			"a deployment of another image digest",
			() => ({ deployment: { imageDigest: `sha256:${"f".repeat(64)}` } }),
		],
		[
			"a candidate that differs from verified",
			() => ({ deployment: { workloadRevision: 2 }, candidateOnly: true }),
		],
		[
			"a deployment newer than the Workload revision",
			(s) => ({ deployment: { workloadRevision: s.revision + 1 } }),
		],
		[
			"an invalid deployment revision",
			() => ({ deployment: { workloadRevision: 0 } }),
		],
		[
			"a promotion of another Workload revision",
			(s) => ({ state: { verifiedRevision: s.revision - 1 } }),
		],
		[
			"a stale persisted row revision",
			(s) => ({ rowRevision: s.revision + 1 }),
		],
	])(
		"still withholds capabilities after drift recovery with %s",
		async (_name, mutate) => {
			const f = await recovered();
			const recoveredState = f.state;
			const verified = recoveredState.verified;
			if (!verified) throw new Error();
			const current = verified.deployment as Record<string, unknown>;
			const change = mutate(recoveredState, current);
			const deployment = { ...current, ...change.deployment };
			const version = { ...verified, deployment };
			const state: WorkloadReconciliationStateV1 = {
				...recoveredState,
				...change.state,
				candidate: version,
				verified: change.candidateOnly ? verified : version,
			};
			const input = fixture();
			const runtime = input.facts.runtime;
			if (!runtime) throw new Error();
			const management = {
				...input.facts.management,
				fence: change.fence ?? input.facts.management.fence,
			};
			expect(
				decideAgentRuntimePresentationV1({
					...input,
					expected: { ...input.expected, management },
					facts: {
						...input.facts,
						management,
						runtime: {
							...runtime,
							revision: change.rowRevision ?? state.revision,
							state,
							deployment: (change.candidateOnly
								? current
								: deployment) as unknown as typeof runtime.deployment,
						},
					},
				}),
			).toEqual({
				outcome: "found",
				sourceReference: "template_01",
				channels: [],
				capabilities: null,
				interactionUrl: null,
			});
		},
	);
});

describe("personal API runtime presentation purpose", () => {
	it.each(["manage", "use"])(
		"accepts an explicit %s grant for a non-Owner",
		(grant) => {
			const input = fixture();
			const apiActor = { ...actor, userId: "api-reader" };
			expect(
				decideAgentRuntimePresentationV1({
					...input,
					actor: apiActor,
					apiMetadata: {
						agentId: input.agentId,
						userId: apiActor.userId,
						grantTypes: [grant],
					},
				}).outcome,
			).toBe("found");
		},
	);
	it.each(["no-grant", "wrong-agent", "wrong-user", "disabled"])(
		"denies %s despite Browser Owner/admin roles",
		(failure) => {
			const input = fixture();
			const apiActor = {
				...actor,
				isAdministrator: true,
				...(failure === "disabled"
					? { accountStatus: "disabled" as const }
					: {}),
			};
			expect(
				decideAgentRuntimePresentationV1({
					...input,
					actor: apiActor,
					apiMetadata: {
						agentId: failure === "wrong-agent" ? "other-agent" : input.agentId,
						userId: failure === "wrong-user" ? "other-user" : apiActor.userId,
						grantTypes: failure === "no-grant" ? [] : ["use"],
					},
				}),
			).toEqual({ outcome: "unavailable" });
		},
	);
});

// #2910：已配置企微渠道的展示状态只来自当前绑定引用的连接事实。
describe("Agent channel presentation status", () => {
	type Fact = AgentRuntimePresentationFactsV1["channels"][number];
	const bot = { kind: "wecom_bot" as const, bindingReference: "bot_ref" };
	const app = { kind: "wecom_app" as const, bindingReference: "app_ref" };
	const activeSession = (
		kind: "wecom_bot" | "wecom_app",
		overrides: Partial<NonNullable<Fact["session"]>> = {},
	) => ({
		agentId: "agent_01",
		kind,
		status: "active",
		callbackVerified: kind === "wecom_app",
		...overrides,
	});

	function decide(
		channels: readonly (typeof bot | typeof app)[],
		facts: readonly Fact[],
		hasRuntime = false,
	) {
		const input = fixture();
		// 同一配置对象同时是当前修订与已验证修订，保持运行时投影路径可用。
		Object.assign(input.facts.configuration, { channels });
		return decideAgentRuntimePresentationV1({
			...input,
			facts: {
				...input.facts,
				channels: facts,
				runtime: hasRuntime ? input.facts.runtime : null,
			},
		});
	}

	it.each<[string, Fact | undefined, "binding" | "bound" | "failed"]>([
		["no fact", undefined, "binding"],
		[
			"no connection row",
			{ ...bot, session: null, connections: [] },
			"binding",
		],
		[
			"verifying",
			{ ...bot, session: null, connections: ["verifying"] },
			"binding",
		],
		[
			"connected",
			{ ...bot, session: null, connections: ["connected"] },
			"bound",
		],
		[
			"disconnected",
			{ ...bot, session: null, connections: ["disconnected"] },
			"failed",
		],
		[
			"auth_failed",
			{ ...bot, session: null, connections: ["auth_failed"] },
			"failed",
		],
		[
			"managed connected",
			{
				...bot,
				session: activeSession("wecom_bot"),
				connections: ["connected"],
			},
			"bound",
		],
		[
			"cancelled managed session",
			{
				...bot,
				session: activeSession("wecom_bot", { status: "cancelled" }),
				connections: ["connected"],
			},
			"failed",
		],
		[
			"another Agent's session",
			{
				...bot,
				session: activeSession("wecom_bot", { agentId: "agent_02" }),
				connections: ["connected"],
			},
			"failed",
		],
		[
			"session of another channel kind",
			{
				...bot,
				session: activeSession("wecom_app"),
				connections: ["connected"],
			},
			"failed",
		],
		[
			"ambiguous connection rows",
			{ ...bot, session: null, connections: ["connected", "connected"] },
			"failed",
		],
		[
			"connected row of an old binding reference",
			{
				...bot,
				bindingReference: "old_ref",
				session: null,
				connections: ["connected"],
			},
			"binding",
		],
	])("maps a WeCom bot with %s", (_name, fact, status) => {
		expect(decide([bot], fact ? [fact] : [])).toMatchObject({
			outcome: "found",
			channels: [{ kind: "wecom_bot", status }],
		});
	});

	it.each<[string, Fact, "binding" | "bound" | "failed"]>([
		[
			"an activated callback-verified session",
			{
				...app,
				session: activeSession("wecom_app"),
				connections: ["disconnected"],
			},
			"bound",
		],
		[
			"an activated session without callback verification",
			{
				...app,
				session: activeSession("wecom_app", { callbackVerified: false }),
				connections: [],
			},
			"failed",
		],
		[
			"a failed session",
			{
				...app,
				session: activeSession("wecom_app", { status: "auth_failed" }),
				connections: [],
			},
			"failed",
		],
		[
			"a failed application probe",
			{
				...app,
				session: activeSession("wecom_app"),
				connections: ["auth_failed"],
			},
			"failed",
		],
		[
			"a deployment binding without platform evidence",
			{ ...app, session: null, connections: [] },
			"binding",
		],
	])("maps a WeCom application with %s", (_name, fact, status) => {
		expect(decide([app], [fact])).toMatchObject({
			outcome: "found",
			channels: [{ kind: "wecom_app", status }],
		});
	});

	it("keeps configuration order and only lists configured channels with verified runtime", () => {
		const decision = decide(
			[app, bot],
			[
				{ ...bot, session: null, connections: ["connected"] },
				{
					...app,
					session: activeSession("wecom_app"),
					connections: [],
				},
			],
			true,
		);
		expect(decision).toMatchObject({
			outcome: "found",
			capabilities: { modelSelection: true },
		});
		expect(decision.outcome === "found" && decision.channels).toEqual([
			{ kind: "wecom_app", status: "bound" },
			{ kind: "wecom_bot", status: "bound" },
		]);
		expect(
			decide([], [{ ...bot, session: null, connections: ["connected"] }]),
		).toMatchObject({ outcome: "found", channels: [] });
	});

	it("does not project channel facts to an unauthorized subject", () => {
		const input = fixture();
		Object.assign(input.facts.configuration, { channels: [bot] });
		expect(
			decideAgentRuntimePresentationV1({
				...input,
				actor: { ...actor, userId: "unrelated" },
				facts: {
					...input.facts,
					channels: [{ ...bot, session: null, connections: ["connected"] }],
				},
			}),
		).toEqual({ outcome: "unavailable" });
	});
});
