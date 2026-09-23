import { Buffer } from "node:buffer";
import {
	type AgentConfigurationRecordV2,
	type AgentConfigurationWritePlanV1,
	snapshotAgentConfigurationWritePlanV1,
} from "@agent-infra/platform-core";
import { decodeAgentConfigurationResult } from "./agent-configuration-record.js";

export const commandType = "agent.configuration.update.v1";

export const scopeType = "agent";

export const idMaxBytes = 1024;

export const maxAccessTargets = 256;

export class StaleAgentConfigurationCommit extends Error {}

export class AgentConfigurationStoreError extends Error {
	readonly code = "unavailable" as const;

	constructor() {
		super("Agent configuration persistence unavailable");
		this.name = "AgentConfigurationStoreError";
	}
}

export interface PostgresAgentConfigurationOptionsV1 {
	readonly databaseUrl: string;
}

export interface IdempotencyRow {
	readonly requestDigest: string;
	readonly status: "reserved" | "completed";
	readonly result: unknown;
}

export function canonicalSourceReference(
	configuration: AgentConfigurationRecordV2,
) {
	return configuration.source.kind === "standard"
		? configuration.source.templateId
		: configuration.source.imageDigest;
}

export function validateText(
	input: unknown,
	maximum = idMaxBytes,
): input is string {
	return (
		typeof input === "string" &&
		input.length > 0 &&
		!input.includes("\0") &&
		String.prototype.isWellFormed.call(input) &&
		Buffer.byteLength(input, "utf8") <= maximum
	);
}

export function validatedPlan(input: AgentConfigurationWritePlanV1) {
	try {
		return snapshotAgentConfigurationWritePlanV1(input);
	} catch {
		throw new AgentConfigurationStoreError();
	}
}

export function decodedReplay(
	row: IdempotencyRow,
	requestDigest: string,
	agentId: string,
) {
	if (row.requestDigest !== requestDigest) {
		return { outcome: "idempotency_conflict" as const };
	}
	if (row.status !== "completed") throw new AgentConfigurationStoreError();
	try {
		const result = decodeAgentConfigurationResult(row.result);
		if (result.agentId !== agentId) throw new AgentConfigurationStoreError();
		return {
			outcome: "replayed" as const,
			result,
		};
	} catch {
		throw new AgentConfigurationStoreError();
	}
}
