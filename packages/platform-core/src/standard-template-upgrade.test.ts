import { describe, expect, it, vi } from "vitest";
import {
	AgentConfigurationError,
	classifyStandardTemplateUpgradeCompatibilityV1,
	fanOutStandardTemplateUpgradeV2,
	type StandardTemplateReleaseTargetV1,
} from "./index.js";

const oldDigest = `sha256:${"a".repeat(64)}`;
const newDigest = `sha256:${"b".repeat(64)}`;
const target = (
	agentId: string,
	revision: number,
): StandardTemplateReleaseTargetV1 => ({
	schemaVersion: 1,
	releaseId: "release_01",
	agentId,
	templateId: "template_01",
	expectedConfigurationRevision: revision,
	expectedImageDigest: oldDigest,
	targetImageDigest: newDigest,
});
const command = {
	schemaVersion: 2 as const,
	releaseId: "release_01",
	templateId: "template_01",
	expectedImageDigest: oldDigest,
	targetImageDigest: newDigest,
	idempotencyKey: "upgrade_01",
	requestId: "request_01",
	traceId: "trace_01",
};

describe("standard template upgrade fan-out", () => {
	it("classifies verified Runtime projection against the target digest", () => {
		const result = classifyStandardTemplateUpgradeCompatibilityV1({
			target: target("agent_01", 7),
			targetMetadata: {
				templateId: "template_01",
				targetImageDigest: newDigest,
				runtimeSchemaVersion: 4,
			},
			runtimeFacts: {
				agentId: "agent_01",
				configurationRevision: 8,
				modelProjection: {
					schemaVersion: 4,
					agentId: "agent_01",
					configurationRevision: 8,
					standardTemplateBinding: {
						templateId: "template_01",
						imageDigest: newDigest,
						driver: "codex",
						protocol: "openai-responses-v1",
					},
				},
			},
			resultingConfigurationRevision: 8,
		});
		expect(result).toMatchObject({
			status: "compatible",
			agentId: "agent_01",
			configurationRevision: 8,
			targetImageDigest: newDigest,
			reasonCode: "verified",
		});
	});

	it("fails closed when projection or target metadata is unavailable", () => {
		const unknown = classifyStandardTemplateUpgradeCompatibilityV1({
			target: target("agent_01", 7),
			targetMetadata: null,
			runtimeFacts: null,
		});
		expect(unknown.status).toBe("unknown");
		expect(unknown.reasonCode).toBe("target_metadata_missing");
		const incompatible = classifyStandardTemplateUpgradeCompatibilityV1({
			target: target("agent_01", 7),
			targetMetadata: {
				templateId: "template_01",
				targetImageDigest: newDigest,
				runtimeSchemaVersion: 1,
			},
			runtimeFacts: {
				agentId: "agent_01",
				configurationRevision: 7,
				modelProjection: { schemaVersion: 4 },
			},
			resultingConfigurationRevision: 8,
		});
		expect(incompatible.status).toBe("incompatible");
		expect(incompatible.reasonCode).toBe("runtime_schema_mismatch");
	});

	it("enumerates targets and applies each with a bounded per-Agent key", async () => {
		const applied: string[] = [];
		const resolver = {
			discover: vi.fn(async () => [
				target("agent_02", 9),
				target("agent_01", 7),
			]),
		};
		const result = await fanOutStandardTemplateUpgradeV2(
			command,
			resolver,
			(item) => ({
				apply: vi.fn(async (release) => {
					applied.push(`${item.agentId}:${release.idempotencyKey}`);
					return {
						schemaVersion: 1 as const,
						agentId: item.agentId,
						revision: item.expectedConfigurationRevision + 1,
						changedFields: ["source" as const],
					};
				}),
			}),
		);
		expect(result).toEqual({
			schemaVersion: 2,
			releaseId: "release_01",
			templateId: "template_01",
			status: "completed",
			targets: [
				{
					agentId: "agent_02",
					status: "applied",
					configurationRevision: 10,
					errorCode: null,
					compatibility: {
						status: "unknown",
						agentId: "agent_02",
						configurationRevision: 10,
						targetImageDigest: newDigest,
						reasonCode: "target_metadata_missing",
					},
				},
				{
					agentId: "agent_01",
					status: "applied",
					configurationRevision: 8,
					errorCode: null,
					compatibility: {
						status: "unknown",
						agentId: "agent_01",
						configurationRevision: 8,
						targetImageDigest: newDigest,
						reasonCode: "target_metadata_missing",
					},
				},
			],
		});
		expect(applied).toHaveLength(2);
		expect(new Set(applied).size).toBe(2);
		expect(applied.every((value) => value.startsWith("agent_"))).toBe(true);
	});

	it("contains one Agent failure and leaves the other result retryable", async () => {
		const result = await fanOutStandardTemplateUpgradeV2(
			command,
			{ discover: async () => [target("agent_01", 7), target("agent_02", 9)] },
			(item) => ({
				apply: async () => {
					if (item.agentId === "agent_01")
						throw new AgentConfigurationError("stale_revision");
					return {
						schemaVersion: 1,
						agentId: item.agentId,
						revision: item.expectedConfigurationRevision + 1,
						changedFields: ["source"],
					};
				},
			}),
		);
		expect(result.status).toBe("partial");
		expect(result.targets).toEqual([
			{
				agentId: "agent_01",
				status: "failed",
				configurationRevision: null,
				errorCode: "stale_revision",
				compatibility: {
					status: "unknown",
					agentId: "agent_01",
					configurationRevision: 7,
					targetImageDigest: newDigest,
					reasonCode: "target_metadata_missing",
				},
			},
			{
				agentId: "agent_02",
				status: "applied",
				configurationRevision: 10,
				errorCode: null,
				compatibility: {
					status: "unknown",
					agentId: "agent_02",
					configurationRevision: 10,
					targetImageDigest: newDigest,
					reasonCode: "target_metadata_missing",
				},
			},
		]);
	});

	it("rejects duplicate or mismatched discovery before changing any Agent", async () => {
		const apply = vi.fn();
		await expect(
			fanOutStandardTemplateUpgradeV2(
				command,
				{
					discover: async () => [target("agent_01", 7), target("agent_01", 7)],
				},
				() => ({ apply }),
			),
		).rejects.toMatchObject({ code: "stale_revision" });
		expect(apply).not.toHaveBeenCalled();
		await expect(
			fanOutStandardTemplateUpgradeV2(
				command,
				{
					discover: async () => [
						target("agent_01", 7),
						{
							...target("agent_02", 9),
							expectedImageDigest: `sha256:${"c".repeat(64)}`,
						},
					],
				},
				() => ({ apply }),
			),
		).rejects.toMatchObject({ code: "stale_revision" });
	});
});
