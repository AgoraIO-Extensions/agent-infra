import { describe, expect, it } from "vitest";
import { snapshotAgentConfigurationWritePlanV1 } from "./agent-configuration-plan.ts";
import {
	isSkillHubGrantWithinBoundaryV1,
	parseSkillHubAgentBindingCommandV1,
	parseSkillHubGrantV1,
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
