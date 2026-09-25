import {
	accessTargetKey,
	parseAvailability,
	parseOwnerIds,
} from "./agent-configuration-input.js";
import {
	decodeAgentConfigurationRecordV2,
	requireAdmittedConfigurationPolicy,
} from "./agent-configuration-record.js";
import type {
	AgentConfigurationAccessPlanV1,
	AgentConfigurationActorContextV1,
	AgentConfigurationChangedFieldV1,
	AgentConfigurationResultV1,
	AgentConfigurationTransactionPortV1,
	AgentConfigurationWritePlanV1,
	LegacyUpdateAgentConfigurationCommandV1,
	UpdateAgentConfigurationCommandV2,
	UpgradeCustomAgentImageCommandV1,
} from "./agent-configuration-types.js";
import {
	denseArray,
	exactObject,
	idMaxBytes,
	invalidCommand,
	isText,
	maxAccessTargets,
	persistenceValue,
	sameValue,
} from "./agent-configuration-values.js";
import {
	requireAgentManagementExactKeys,
	snapshotAgentManagementDataObject,
	snapshotAgentManagementDenseArray,
} from "./agent-management-input.js";
import { platformIdempotencyV1 } from "./idempotency.js";

export function requestDigest(
	command:
		| UpdateAgentConfigurationCommandV2
		| LegacyUpdateAgentConfigurationCommandV1,
	actor: AgentConfigurationActorContextV1,
): string {
	try {
		return platformIdempotencyV1.canonicalRequestDigest({
			schemaVersion: 1,
			operation:
				command.schemaVersion === 1
					? "agent.configuration.update.v1"
					: "agent.configuration.update.v2",
			agentId: command.agentId,
			actorId: actor.actorId,
			rawRequestDigest: actor.rawRequestDigest,
			changes: command.changes as never,
		});
	} catch {
		invalidCommand();
	}
}

export function customImageUpgradeRequestDigest(
	command: UpgradeCustomAgentImageCommandV1,
	actor: AgentConfigurationActorContextV1,
): string {
	try {
		return platformIdempotencyV1.canonicalRequestDigest({
			schemaVersion: 1,
			operation: "agent.configuration.custom-image.upgrade.v1",
			agentId: command.agentId,
			actorId: actor.actorId,
			rawRequestDigest: actor.rawRequestDigest,
			imageReference: command.imageReference,
		});
	} catch {
		invalidCommand();
	}
}

export function parseResult(
	input: unknown,
	agentId: string,
): AgentConfigurationResultV1 {
	return persistenceValue(() => {
		const result = exactObject(input, [
			"schemaVersion",
			"agentId",
			"revision",
			"changedFields",
		]);
		const changedFields = denseArray(result.changedFields, 8);
		if (
			result.schemaVersion !== 1 ||
			result.agentId !== agentId ||
			typeof result.revision !== "number" ||
			!Number.isSafeInteger(result.revision) ||
			result.revision < 0 ||
			changedFields.length === 0 ||
			new Set(changedFields).size !== changedFields.length ||
			!sameValue(changedFields, [...changedFields].sort()) ||
			changedFields.some(
				(field) =>
					!(
						[
							"source",
							"environment",
							"modelConfiguration",
							"secrets",
							"actions",
							"channels",
							"owners",
							"availability",
						] as readonly unknown[]
					).includes(field),
			)
		) {
			invalidCommand();
		}
		return {
			schemaVersion: 1,
			agentId,
			revision: result.revision,
			changedFields: changedFields as AgentConfigurationChangedFieldV1[],
		};
	});
}

function configurationPlanObject(
	input: unknown,
	keys: readonly string[],
): Record<string, unknown> {
	return persistenceValue(() => {
		const values = snapshotAgentManagementDataObject(input);
		requireAgentManagementExactKeys(values, keys);
		return values;
	});
}

function configurationPlanDate(input: unknown): Date {
	return persistenceValue(() => {
		const milliseconds = Date.prototype.getTime.call(input);
		if (!Number.isFinite(milliseconds)) throw new Error();
		return new Date(milliseconds);
	});
}

function snapshotConfigurationAccessPlanV1(
	input: unknown,
	agentId: string,
): AgentConfigurationAccessPlanV1 | null {
	if (input === null) return null;
	return persistenceValue(() => {
		const values = configurationPlanObject(input, [
			"schemaVersion",
			"fragmentType",
			"agentId",
			"expectedRevision",
			"ownerIds",
			"availability",
		]);
		const ownerInputs = snapshotAgentManagementDenseArray(
			values.ownerIds,
			maxAccessTargets,
		);
		const ownerIds = parseOwnerIds(ownerInputs);
		const availabilityInputs = snapshotAgentManagementDenseArray(
			values.availability,
			maxAccessTargets,
		);
		const availability = parseAvailability(availabilityInputs);
		if (
			values.schemaVersion !== 1 ||
			values.fragmentType !== "agent_access" ||
			values.agentId !== agentId ||
			!Number.isSafeInteger(values.expectedRevision) ||
			(values.expectedRevision as number) < 0 ||
			ownerIds.length === 0 ||
			new Set(ownerIds).size !== ownerIds.length ||
			new Set(availability.map(accessTargetKey)).size !== availability.length ||
			!sameValue(ownerInputs, ownerIds) ||
			!sameValue(availabilityInputs, availability)
		) {
			throw new Error();
		}
		return {
			schemaVersion: 1,
			fragmentType: "agent_access",
			agentId,
			expectedRevision: values.expectedRevision as number,
			ownerIds,
			availability,
		};
	});
}

export function snapshotAgentConfigurationWritePlanV1(
	input: unknown,
): AgentConfigurationWritePlanV1 {
	return persistenceValue(() => {
		const values = configurationPlanObject(input, [
			"schemaVersion",
			"agentId",
			"baseRevision",
			"nextRevision",
			"expectedManagementRevision",
			"expectedAuthorizationRevision",
			"nextAuthorizationRevision",
			"configuration",
			"accessUpdate",
			"result",
			"idempotency",
			"outboxIntent",
			"auditEvent",
		]);
		if (!isText(values.agentId, idMaxBytes)) throw new Error();
		const agentId = values.agentId;
		const configuration = decodeAgentConfigurationRecordV2(
			values.configuration,
		);
		requireAdmittedConfigurationPolicy(configuration);
		const result = parseResult(values.result, agentId);
		const accessUpdate = snapshotConfigurationAccessPlanV1(
			values.accessUpdate,
			agentId,
		);
		const idempotency = configurationPlanObject(values.idempotency, [
			"key",
			"requestDigest",
		]);
		const audit = configurationPlanObject(values.auditEvent, [
			"action",
			"actorId",
			"agentId",
			"subjectType",
			"subjectId",
			"changedFields",
			"traceId",
			"requestId",
			"occurredAt",
		]);
		const auditChangedFields = snapshotAgentManagementDenseArray(
			audit.changedFields,
			8,
		);
		const auditOccurredAt = configurationPlanDate(audit.occurredAt);
		const accessFields = result.changedFields.filter(
			(field) => field === "owners" || field === "availability",
		);
		const accessOnly = accessFields.length === result.changedFields.length;
		const runtimeUnchanged = result.changedFields.every(
			(field) => field === "availability",
		);
		const expectedAction = accessOnly
			? "agent.access.updated"
			: "agent.configuration.revised";
		if (
			values.schemaVersion !== 1 ||
			snapshotAgentManagementDataObject(values.configuration).schemaVersion !==
				2 ||
			result.changedFields.includes("actions") ||
			!Number.isSafeInteger(values.baseRevision) ||
			(values.baseRevision as number) < 1 ||
			!Number.isSafeInteger(values.nextRevision) ||
			values.nextRevision !==
				(values.baseRevision as number) + (runtimeUnchanged ? 0 : 1) ||
			(values.expectedManagementRevision !== null &&
				(!Number.isSafeInteger(values.expectedManagementRevision) ||
					(values.expectedManagementRevision as number) < 0)) ||
			(accessUpdate !== null &&
				accessUpdate.expectedRevision !== values.expectedManagementRevision) ||
			!isText(values.expectedAuthorizationRevision, idMaxBytes) ||
			!isText(values.nextAuthorizationRevision, idMaxBytes) ||
			configuration.agentId !== agentId ||
			configuration.revision !== values.nextRevision ||
			result.revision !== values.nextRevision ||
			!isText(idempotency.key, 128) ||
			!/^[A-Za-z0-9._~-]{1,128}$/.test(idempotency.key) ||
			typeof idempotency.requestDigest !== "string" ||
			!/^[a-f0-9]{64}$/.test(idempotency.requestDigest) ||
			audit.action !== expectedAction ||
			!isText(audit.actorId, idMaxBytes) ||
			audit.agentId !== agentId ||
			audit.subjectType !== "agent" ||
			audit.subjectId !== agentId ||
			!sameValue(auditChangedFields, result.changedFields) ||
			!isText(audit.traceId, idMaxBytes) ||
			!isText(audit.requestId, idMaxBytes) ||
			accessFields.length > 0 !== (accessUpdate !== null)
		) {
			throw new Error();
		}
		let outboxIntent: AgentConfigurationWritePlanV1["outboxIntent"] = null;
		if (runtimeUnchanged) {
			if (values.outboxIntent !== null) throw new Error();
		} else {
			const outbox = configurationPlanObject(values.outboxIntent, [
				"operation",
				"payload",
				"traceId",
				"requestId",
				"occurredAt",
			]);
			const payload = configurationPlanObject(outbox.payload, [
				"schemaVersion",
				"agentId",
				"baseRevision",
				"configurationRevision",
				"changedFields",
			]);
			const payloadChangedFields = snapshotAgentManagementDenseArray(
				payload.changedFields,
				8,
			);
			const occurredAt = configurationPlanDate(outbox.occurredAt);
			if (
				outbox.operation !== "agent.configuration.revised.v1" ||
				payload.schemaVersion !== 1 ||
				payload.agentId !== agentId ||
				payload.baseRevision !== values.baseRevision ||
				payload.configurationRevision !== values.nextRevision ||
				!sameValue(payloadChangedFields, result.changedFields) ||
				outbox.traceId !== audit.traceId ||
				outbox.requestId !== audit.requestId ||
				occurredAt.getTime() !== auditOccurredAt.getTime()
			) {
				throw new Error();
			}
			outboxIntent = {
				operation: "agent.configuration.revised.v1",
				payload: {
					schemaVersion: 1,
					agentId,
					baseRevision: values.baseRevision as number,
					configurationRevision: values.nextRevision as number,
					changedFields: result.changedFields,
				},
				traceId: audit.traceId,
				requestId: audit.requestId,
				occurredAt,
			};
		}
		return {
			schemaVersion: 1,
			agentId,
			baseRevision: values.baseRevision as number,
			nextRevision: values.nextRevision as number,
			expectedManagementRevision: values.expectedManagementRevision as
				| number
				| null,
			expectedAuthorizationRevision: values.expectedAuthorizationRevision,
			nextAuthorizationRevision: values.nextAuthorizationRevision,
			configuration,
			accessUpdate,
			result,
			idempotency: {
				key: idempotency.key,
				requestDigest: idempotency.requestDigest,
			},
			outboxIntent,
			auditEvent: {
				action: expectedAction,
				actorId: audit.actorId,
				agentId,
				subjectType: "agent",
				subjectId: agentId,
				changedFields: result.changedFields,
				traceId: audit.traceId,
				requestId: audit.requestId,
				occurredAt: auditOccurredAt,
			},
		};
	});
}

export function parseTransactionReadDecision(
	input: unknown,
	agentId: string,
): Awaited<ReturnType<AgentConfigurationTransactionPortV1["read"]>> {
	return persistenceValue(() => {
		const base = exactObject(input, ["outcome"], ["record", "result"]);
		if (base.outcome === "ready") {
			requireAgentManagementExactKeys(base, ["outcome", "record"]);
			const record = exactObject(base.record, [
				"schemaVersion",
				"configuration",
				"authorizationRevision",
			]);
			if (
				record.schemaVersion !== 1 ||
				!isText(record.authorizationRevision, idMaxBytes)
			) {
				invalidCommand();
			}
			return {
				outcome: "ready",
				record: {
					schemaVersion: 1,
					configuration: decodeAgentConfigurationRecordV2(record.configuration),
					authorizationRevision: record.authorizationRevision,
				},
			};
		}
		if (base.outcome === "replayed") {
			requireAgentManagementExactKeys(base, ["outcome", "result"]);
			return { outcome: "replayed", result: parseResult(base.result, agentId) };
		}
		if (base.outcome === "missing" || base.outcome === "idempotency_conflict") {
			requireAgentManagementExactKeys(base, ["outcome"]);
			return { outcome: base.outcome };
		}
		invalidCommand();
	});
}

export function parseTransactionCommitDecision(
	input: unknown,
	agentId: string,
): Awaited<ReturnType<AgentConfigurationTransactionPortV1["commit"]>> {
	return persistenceValue(() => {
		const base = exactObject(input, ["outcome"], ["result"]);
		if (base.outcome === "committed" || base.outcome === "replayed") {
			requireAgentManagementExactKeys(base, ["outcome", "result"]);
			return {
				outcome: base.outcome,
				result: parseResult(base.result, agentId),
			};
		}
		if (base.outcome === "stale" || base.outcome === "idempotency_conflict") {
			requireAgentManagementExactKeys(base, ["outcome"]);
			return { outcome: base.outcome };
		}
		invalidCommand();
	});
}
