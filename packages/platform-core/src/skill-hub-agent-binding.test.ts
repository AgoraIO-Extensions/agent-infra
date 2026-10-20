import { describe, expect, it } from "vitest";
import { agentConfigurationConformanceRecordV1 } from "./agent-configuration.conformance.ts";
import { snapshotAgentConfigurationWritePlanV1 } from "./agent-configuration-plan.ts";
import type {
	AgentConfigurationAccessAuthorityV1,
	AgentConfigurationAuthorizationAdmissionPortV1,
	AgentConfigurationWritePlanV1,
} from "./agent-configuration-types.ts";
import {
	createSkillHubAgentBindingUseCaseV1,
	isSkillHubAgentVersionV1,
	isSkillHubGrantWithinBoundaryV1,
	parseSkillHubAgentBindingCommandV1,
	parseSkillHubGrantV1,
	SkillHubAgentBindingErrorV1,
} from "./skill-hub-agent-binding.ts";

const grant = {
	schemaVersion: 1,
	tools: ["filesystem.read"],
	connections: [],
	fileRoots: ["/workspace"],
	networkOrigins: ["https://example.com/"],
	scripts: false,
} as const;

describe("Skill Hub Agent binding contract", () => {
	it("canonicalizes bounded grants and keeps scripts disabled", () => {
		expect(
			parseSkillHubGrantV1({
				...grant,
				tools: ["z", "a"],
				fileRoots: ["/workspace"],
			}),
		).toMatchObject({ tools: ["a", "z"], scripts: false });
		for (const scripts of [true, "false"]) {
			expect(() => parseSkillHubGrantV1({ ...grant, scripts })).toThrow();
		}
	});

	it("rejects duplicate versions, unsafe roots, and non-HTTPS origins", () => {
		const base = {
			schemaVersion: 1,
			agentId: "agent-1",
			agentVersion: "agent-version-1",
			expectedConfigurationRevision: 1,
			idempotencyKey: "bind-1",
			requestId: "request-1",
			traceId: "trace-1",
			bindings: [{ skillVersionId: "skill-version-1", grant }],
		};
		expect(parseSkillHubAgentBindingCommandV1(base).bindings).toHaveLength(1);
		expect(() =>
			parseSkillHubAgentBindingCommandV1({
				...base,
				bindings: [...base.bindings, ...base.bindings],
			}),
		).toThrow();
		expect(() =>
			parseSkillHubGrantV1({ ...grant, fileRoots: ["/workspace/../secret"] }),
		).toThrow();
		expect(() =>
			parseSkillHubGrantV1({
				...grant,
				networkOrigins: ["http://example.com/"],
			}),
		).toThrow();
	});

	it("only accepts grants inside the existing capability boundary", () => {
		expect(
			isSkillHubGrantWithinBoundaryV1(grant, {
				...grant,
				tools: ["filesystem.read", "filesystem.write"],
			}),
		).toBe(true);
		expect(
			isSkillHubGrantWithinBoundaryV1(
				{ ...grant, tools: ["filesystem.write"] },
				grant,
			),
		).toBe(false);
	});

	it("keeps Skill bindings inside the configuration revision plan", () => {
		const configuration = {
			schemaVersion: 2 as const,
			agentId: "agent-1",
			revision: 2,
			source: {
				kind: "standard" as const,
				templateId: "template-1",
				imageDigest: `sha256:${"a".repeat(64)}`,
				admissionRevision: "admission-1",
				allowedEnvironmentKeys: [],
				allowedSecretKeys: [],
				platformManagedKeys: [],
				connectionEnabled: false,
			},
			modelConfiguration: {
				catalogRevision: "catalog-1",
				options: [
					{
						optionId: "model-1",
						endpointId: "endpoint-1",
						modelId: "model-1",
						reasoningLevels: ["low"],
						credential: {
							secretId: "secret-1",
							version: 1,
							isSet: true as const,
						},
					},
				],
				defaultOptionId: "model-1",
				defaultReasoningLevel: "low",
			},
			environment: [],
			secrets: [],
			channels: [],
			channelRevision: "channel-1",
		};
		const plan = snapshotAgentConfigurationWritePlanV1({
			schemaVersion: 1,
			agentId: "agent-1",
			baseRevision: 1,
			nextRevision: 2,
			expectedManagementRevision: 1,
			expectedAuthorizationRevision: "auth-1",
			nextAuthorizationRevision: "auth-2",
			configuration,
			skillBindings: {
				schemaVersion: 1,
				agentVersion: "agent-version-1",
				bindings: [
					{
						skillVersionId: "skill-version-1",
						principalType: "user",
						principalId: "owner-1",
						grant,
					},
				],
			},
			accessUpdate: null,
			result: {
				schemaVersion: 1,
				agentId: "agent-1",
				revision: 2,
				changedFields: ["skills"],
			},
			idempotency: { key: "bind-1", requestDigest: "b".repeat(64) },
			outboxIntent: {
				operation: "agent.configuration.revised.v1",
				payload: {
					schemaVersion: 1,
					agentId: "agent-1",
					baseRevision: 1,
					configurationRevision: 2,
					changedFields: ["skills"],
				},
				traceId: "trace-1",
				requestId: "request-1",
				occurredAt: new Date("2026-10-09T00:00:00.000Z"),
			},
			auditEvent: {
				action: "agent.configuration.revised",
				actorId: "owner-1",
				agentId: "agent-1",
				subjectType: "agent",
				subjectId: "agent-1",
				changedFields: ["skills"],
				traceId: "trace-1",
				requestId: "request-1",
				occurredAt: new Date("2026-10-09T00:00:00.000Z"),
			},
		});
		expect(plan.skillBindings?.bindings[0]?.skillVersionId).toBe(
			"skill-version-1",
		);
	});
});

// #2903：当前 Agent Version 是部署级固定事实；读写与版本读取共用同一 Owner 判定。
describe("Skill Hub Agent binding use case (#2903)", () => {
	const occurredAt = new Date("2026-10-20T00:00:00.000Z");
	const emptyGrant = {
		schemaVersion: 1,
		tools: [],
		connections: [],
		fileRoots: [],
		networkOrigins: [],
		scripts: false,
	} as const;
	type Authority = AgentConfigurationAccessAuthorityV1;
	function authorityFor(input: {
		agentId: string;
		userId: string;
		ownerIds: readonly string[];
		isAdministrator?: boolean;
		accountStatus?: "active" | "disabled";
	}): Authority {
		return {
			state: {
				schemaVersion: 1,
				applicationId: `application-${input.agentId}`,
				agentId: input.agentId,
				applicantId: "owner-1",
				status: "available",
				// 管理修订故意与配置修订不同：读取必须使用配置修订（调查缺陷 1）。
				revision: 2,
				approvalRevision: 1,
				decisionReason: null,
				serviceAvailability: "ready",
				desiredState: "running",
				workloadRevision: 1,
				fence: 1,
				ownerIds: input.ownerIds,
				availability: [],
				failureCode: null,
			},
			actorContext: {
				schemaVersion: 1,
				userId: input.userId,
				accountStatus: input.accountStatus ?? "active",
				organizationIds: ["org-1"],
				isAdministrator: input.isAdministrator ?? false,
			},
			authorityContext: {
				schemaVersion: 1,
				users: [{ userId: input.userId, accountStatus: "active" }],
				organizationIds: ["org-1"],
			},
		};
	}
	// 授权事实按调用方区分：Owner、只有管理员角色、非 Owner、另一个 Agent 的 Owner。
	const authorities: Record<string, Authority | undefined> = {
		"owner-1": authorityFor({
			agentId: "agent-1",
			userId: "owner-1",
			ownerIds: ["owner-1"],
		}),
		"admin-1": authorityFor({
			agentId: "agent-1",
			userId: "admin-1",
			ownerIds: ["owner-1"],
			isAdministrator: true,
		}),
		"disabled-owner": authorityFor({
			agentId: "agent-1",
			userId: "disabled-owner",
			ownerIds: ["disabled-owner"],
			accountStatus: "disabled",
		}),
		"other-agent-owner": authorityFor({
			agentId: "agent-2",
			userId: "other-agent-owner",
			ownerIds: ["other-agent-owner"],
		}),
		"user-1": undefined,
	};
	const authorizationAdmission: AgentConfigurationAuthorizationAdmissionPortV1 =
		{
			async authorize(input) {
				const accessAuthority = authorities[input.actorId];
				if (!accessAuthority)
					return {
						schemaVersion: 1,
						status: "rejected",
						agentId: input.agentId,
						actorId: input.actorId,
					};
				return {
					schemaVersion: 1,
					status: "admitted",
					agentId: input.agentId,
					actorId: input.actorId,
					authorizationRevision: "authorization-1",
					accessAuthority,
				};
			},
		};
	function harness(
		options: { agentVersion?: string; statusFailure?: boolean } = {},
	) {
		const calls = {
			statusReads: [] as unknown[],
			revisionReads: [] as unknown[],
			transactionReads: 0,
			admissions: 0,
			commits: [] as AgentConfigurationWritePlanV1[],
		};
		const configuration = {
			...structuredClone(agentConfigurationConformanceRecordV1),
			agentId: "agent-1",
		};
		const useCase = createSkillHubAgentBindingUseCaseV1<{ id: string }>({
			...(options.agentVersion !== undefined
				? { agentVersion: options.agentVersion }
				: {}),
			authorizationAdmission,
			bindingAdmission: {
				async admit(input) {
					calls.admissions += 1;
					return {
						schemaVersion: 1,
						status: "admitted",
						bindings: input.requested.map((requested) => ({
							skillVersionId: requested.skillVersionId,
							principalType: "user" as const,
							principalId: input.actorId,
							grant: requested.grant,
						})),
					};
				},
			},
			bindingStatus: {
				async readCurrentConfigurationRevision(input) {
					calls.revisionReads.push(input);
					if (options.statusFailure) throw new Error("store unavailable");
					return 7;
				},
				async readCurrentBindings(input) {
					calls.statusReads.push(input);
					if (options.statusFailure) throw new Error("store unavailable");
					return { configurationRevision: 7, bindings: [{ id: "binding-1" }] };
				},
			},
			transaction: {
				async read() {
					calls.transactionReads += 1;
					return {
						outcome: "ready",
						record: {
							schemaVersion: 1,
							configuration,
							authorizationRevision: "authorization-1",
						},
					};
				},
				async commit(plan) {
					calls.commits.push(plan);
					return { outcome: "committed", result: plan.result };
				},
			},
			now: () => occurredAt,
		});
		return { useCase, calls };
	}
	const query = (actorId: string, agentVersion = "agent-version-1") => ({
		schemaVersion: 1,
		agentId: "agent-1",
		agentVersion,
		actorId,
		requestId: "request-1",
		traceId: "trace-1",
	});
	const versionQuery = (actorId: string) => {
		const { agentVersion: _ignored, ...value } = query(actorId);
		return value;
	};
	const command = (
		bindings: readonly unknown[],
		agentVersion = "agent-version-1",
	) => ({
		schemaVersion: 1,
		agentId: "agent-1",
		agentVersion,
		expectedConfigurationRevision: 7,
		idempotencyKey: "bind-1",
		requestId: "request-1",
		traceId: "trace-1",
		bindings,
	});
	const actor = (actorId: string) => ({
		schemaVersion: 1,
		actorId,
		rawRequestDigest: "a".repeat(64),
	});

	it("gives the current Owner the deployment version and the configuration revision", async () => {
		const { useCase, calls } = harness({ agentVersion: "agent-version-1" });
		await expect(
			useCase.currentVersion(versionQuery("owner-1")),
		).resolves.toEqual({
			schemaVersion: 1,
			agentId: "agent-1",
			agentVersion: "agent-version-1",
			configurationRevision: 7,
		});
		await expect(useCase.read(query("owner-1"))).resolves.toEqual({
			schemaVersion: 1,
			agentId: "agent-1",
			agentVersion: "agent-version-1",
			configurationRevision: 7,
			bindings: [{ id: "binding-1" }],
		});
		// 读取只用服务端当前修订，调用方与管理修订都不参与。
		expect(calls.statusReads).toEqual([
			{
				agentId: "agent-1",
				agentVersion: "agent-version-1",
				actorId: "owner-1",
				organizationIds: ["org-1"],
				isAdministrator: false,
			},
		]);
	});

	for (const actorId of [
		"user-1",
		"admin-1",
		"disabled-owner",
		"other-agent-owner",
	]) {
		it(`denies ${actorId} every read and write without reaching the Store`, async () => {
			const { useCase, calls } = harness({ agentVersion: "agent-version-1" });
			await expect(
				useCase.currentVersion(versionQuery(actorId)),
			).rejects.toMatchObject({ code: "not_authorized" });
			await expect(useCase.read(query(actorId))).rejects.toMatchObject({
				code: "not_authorized",
			});
			// 版本不符也先按无权处理，非 Owner 不能借路径探测当前版本。
			await expect(
				useCase.read(query(actorId, "agent-version-2")),
			).rejects.toMatchObject({ code: "not_authorized" });
			await expect(
				useCase.bind(
					command([{ skillVersionId: "skill-version-1", grant: emptyGrant }]),
					actor(actorId),
				),
			).rejects.toMatchObject({ code: "not_authorized" });
			expect(calls).toMatchObject({
				statusReads: [],
				revisionReads: [],
				transactionReads: 0,
				admissions: 0,
				commits: [],
			});
		});
	}

	for (const agentVersion of [undefined, "", "agent/version"]) {
		it(`rejects reads and writes when the deployment version is ${JSON.stringify(agentVersion)}`, async () => {
			const { useCase, calls } = harness(
				agentVersion === undefined ? {} : { agentVersion },
			);
			await expect(
				useCase.currentVersion(versionQuery("owner-1")),
			).rejects.toMatchObject({ code: "agent_version_unavailable" });
			await expect(useCase.read(query("owner-1"))).rejects.toMatchObject({
				code: "agent_version_unavailable",
			});
			await expect(
				useCase.bind(
					command([{ skillVersionId: "skill-version-1", grant: emptyGrant }]),
					actor("owner-1"),
				),
			).rejects.toMatchObject({ code: "agent_version_unavailable" });
			// 非 Owner 看到的仍是无权，而不是“未配置”。
			await expect(
				useCase.currentVersion(versionQuery("user-1")),
			).rejects.toMatchObject({ code: "not_authorized" });
			expect(calls).toMatchObject({
				statusReads: [],
				revisionReads: [],
				transactionReads: 0,
				commits: [],
			});
		});
	}

	it("rejects a path version that differs from the current version", async () => {
		const { useCase, calls } = harness({ agentVersion: "agent-version-1" });
		await expect(
			useCase.read(query("owner-1", "agent-version-0")),
		).rejects.toMatchObject({ code: "agent_version_mismatch" });
		await expect(
			useCase.bind(
				command(
					[{ skillVersionId: "skill-version-1", grant: emptyGrant }],
					"agent-version-0",
				),
				actor("owner-1"),
			),
		).rejects.toMatchObject({ code: "agent_version_mismatch" });
		expect(calls).toMatchObject({
			statusReads: [],
			transactionReads: 0,
			admissions: 0,
			commits: [],
		});
	});

	it("binds under the current version and unbinds with an empty full set", async () => {
		const { useCase, calls } = harness({ agentVersion: "agent-version-1" });
		await expect(
			useCase.bind(
				command([{ skillVersionId: "skill-version-1", grant: emptyGrant }]),
				actor("owner-1"),
			),
		).resolves.toMatchObject({ revision: 8, replayed: false });
		await expect(
			useCase.bind(
				{ ...command([]), idempotencyKey: "unbind-1" },
				actor("owner-1"),
			),
		).resolves.toMatchObject({ revision: 8, replayed: false });
		expect(calls.admissions).toBe(1);
		expect(
			calls.commits.map((plan) => ({
				agentVersion: plan.skillBindings?.agentVersion,
				skillVersionIds: plan.skillBindings?.bindings.map(
					(binding) => binding.skillVersionId,
				),
				// CAS 仍以管理修订与配置修订双重核对。
				expectedManagementRevision: plan.expectedManagementRevision,
				baseRevision: plan.baseRevision,
			})),
		).toEqual([
			{
				agentVersion: "agent-version-1",
				skillVersionIds: ["skill-version-1"],
				expectedManagementRevision: 2,
				baseRevision: 7,
			},
			{
				agentVersion: "agent-version-1",
				skillVersionIds: [],
				expectedManagementRevision: 2,
				baseRevision: 7,
			},
		]);
	});

	it("maps Store failures to a dependency failure instead of an unclassified error", async () => {
		const { useCase } = harness({
			agentVersion: "agent-version-1",
			statusFailure: true,
		});
		await expect(
			useCase.currentVersion(versionQuery("owner-1")),
		).rejects.toMatchObject({ code: "dependency_unavailable" });
		await expect(useCase.read(query("owner-1"))).rejects.toMatchObject({
			code: "dependency_unavailable",
		});
		await expect(useCase.read(query("owner-1"))).rejects.toBeInstanceOf(
			SkillHubAgentBindingErrorV1,
		);
	});

	it("only accepts deployment versions that fit the binding path identifier", () => {
		expect(isSkillHubAgentVersionV1("agent-version-1")).toBe(true);
		expect(isSkillHubAgentVersionV1("2026.10:r1")).toBe(true);
		for (const value of [undefined, "", "a/b", " agent", "x".repeat(129), 7])
			expect(isSkillHubAgentVersionV1(value)).toBe(false);
	});
});
