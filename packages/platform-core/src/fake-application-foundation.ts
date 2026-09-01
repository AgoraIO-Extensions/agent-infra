import { Buffer } from "node:buffer";

import {
	type AgentConfigurationAccessTargetV1,
	type AgentConfigurationRecordV1,
	decodeAgentConfigurationRecordV1,
} from "./agent-configuration.js";
import {
	ApplicationFoundationError,
	type ApplicationFoundationTransactionPortV1,
	type ApplicationFoundationWritePlanV1,
	type CommitApplicationFoundationResultV1,
	snapshotApplicationFoundationWritePlanV1,
} from "./application-foundation.js";

type FailurePoint =
	| "agent"
	| "application"
	| "configuration_revision"
	| "owner"
	| "availability"
	| "idempotency"
	| "outbox"
	| "audit"
	| "commit";

export interface ApplicationFoundationSnapshot {
	agents: {
		agentId: string;
		currentConfigurationRevision: number;
		authorizationRevision: string;
		createdAt: Date;
	}[];
	applications: {
		applicationId: string;
		agentId: string;
		applicantId: string;
		name: string;
		description: string;
		status: "pending_approval";
		traceId: string;
		requestId: string;
		submittedAt: Date;
	}[];
	configurationRevisions: {
		agentId: string;
		revision: number;
		configuration: AgentConfigurationRecordV1;
		createdAt: Date;
	}[];
	owners: { agentId: string; ownerId: string; createdAt: Date }[];
	availability: {
		agentId: string;
		target: AgentConfigurationAccessTargetV1;
	}[];
	idempotencyResults: {
		agentId: string;
		actorId: string;
		key: string;
		requestDigest: string;
		result: CommitApplicationFoundationResultV1;
		createdAt: Date;
	}[];
	outboxIntents: {
		scopeType: "agent";
		scopeId: string;
		operation: "agent.application.submitted.v1";
		payload: {
			schemaVersion: 1;
			applicationId: string;
			agentId: string;
			configurationRevision: 1;
		};
		traceId: string;
		requestId: string;
		availableAt: Date;
	}[];
	auditEvents: {
		traceId: string;
		requestId: string;
		agentId: string;
		actorType: "user";
		actorId: string;
		action: "agent.application.submitted";
		targetType: "agent_application";
		targetId: string;
		outcome: "succeeded";
		occurredAt: Date;
	}[];
}

function cloneSnapshot(
	snapshot: ApplicationFoundationSnapshot,
): ApplicationFoundationSnapshot {
	return structuredClone(snapshot);
}

const emptySnapshot = (): ApplicationFoundationSnapshot => ({
	agents: [],
	applications: [],
	configurationRevisions: [],
	owners: [],
	availability: [],
	idempotencyResults: [],
	outboxIntents: [],
	auditEvents: [],
});

function accessTargetKey(target: AgentConfigurationAccessTargetV1): string {
	return target.kind === "user"
		? `user\0${target.userId}`
		: `organization\0${target.organizationId}`;
}

function validDate(value: unknown): value is Date {
	try {
		return Number.isFinite(Date.prototype.getTime.call(value));
	} catch {
		return false;
	}
}

function validText(value: unknown, maximum = 1024): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		!value.includes("\0") &&
		String.prototype.isWellFormed.call(value) &&
		Buffer.byteLength(value, "utf8") <= maximum
	);
}

function sameValue(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function validatePlan(plan: ApplicationFoundationWritePlanV1): void {
	let configuration: ReturnType<typeof decodeAgentConfigurationRecordV1>;
	try {
		configuration = decodeAgentConfigurationRecordV1(
			plan.configurationRevision.configuration,
		);
	} catch {
		throw new ApplicationFoundationError("persistence_failed");
	}
	const timestamp = plan.agent.createdAt;
	const expectedResult = {
		schemaVersion: 1,
		applicationId: plan.application.applicationId,
		agentId: plan.agent.agentId,
		configurationRevision: 1,
		status: "pending_approval",
	};
	const ownerIds = [...plan.access.ownerIds];
	const targetKeys = plan.access.availability.map(accessTargetKey);
	if (
		plan.schemaVersion !== 1 ||
		!validText(plan.agent.agentId) ||
		plan.agent.currentConfigurationRevision !== 1 ||
		!validText(plan.agent.authorizationRevision) ||
		!validText(plan.application.applicationId) ||
		plan.application.agentId !== plan.agent.agentId ||
		!validText(plan.application.applicantId) ||
		!validText(plan.application.name, 800) ||
		Array.from(plan.application.name).length > 200 ||
		!validText(plan.application.description, 65_536) ||
		plan.application.applicantId !== plan.auditEvent.actorId ||
		plan.application.status !== "pending_approval" ||
		plan.configurationRevision.agentId !== plan.agent.agentId ||
		plan.configurationRevision.revision !== 1 ||
		configuration.agentId !== plan.agent.agentId ||
		configuration.revision !== 1 ||
		!sameValue(configuration, plan.configurationRevision.configuration) ||
		plan.access.agentId !== plan.agent.agentId ||
		ownerIds.length === 0 ||
		ownerIds.length > 256 ||
		ownerIds.some((ownerId) => !validText(ownerId)) ||
		new Set(ownerIds).size !== ownerIds.length ||
		!sameValue(ownerIds, ownerIds.toSorted()) ||
		!ownerIds.includes(plan.application.applicantId) ||
		targetKeys.length > 256 ||
		new Set(targetKeys).size !== targetKeys.length ||
		!sameValue(targetKeys, targetKeys.toSorted()) ||
		plan.access.availability.some((target) =>
			target.kind === "user"
				? !validText(target.userId)
				: !validText(target.organizationId),
		) ||
		!sameValue(plan.result, expectedResult) ||
		!validText(plan.idempotency.key, 128) ||
		!/^[A-Za-z0-9._~-]{1,128}$/.test(plan.idempotency.key) ||
		!/^[a-f0-9]{64}$/.test(plan.idempotency.requestDigest) ||
		plan.outboxIntent.scopeType !== "agent" ||
		plan.outboxIntent.scopeId !== plan.agent.agentId ||
		plan.outboxIntent.operation !== "agent.application.submitted.v1" ||
		!sameValue(plan.outboxIntent.payload, {
			schemaVersion: 1,
			applicationId: plan.application.applicationId,
			agentId: plan.agent.agentId,
			configurationRevision: 1,
		}) ||
		plan.outboxIntent.traceId !== plan.application.traceId ||
		plan.outboxIntent.requestId !== plan.application.requestId ||
		!validText(plan.application.traceId) ||
		!validText(plan.application.requestId) ||
		plan.auditEvent.agentId !== plan.agent.agentId ||
		plan.auditEvent.actorType !== "user" ||
		plan.auditEvent.action !== "agent.application.submitted" ||
		plan.auditEvent.targetType !== "agent_application" ||
		plan.auditEvent.targetId !== plan.application.applicationId ||
		plan.auditEvent.outcome !== "succeeded" ||
		plan.auditEvent.traceId !== plan.application.traceId ||
		plan.auditEvent.requestId !== plan.application.requestId ||
		!validDate(timestamp) ||
		[
			plan.application.submittedAt,
			plan.configurationRevision.createdAt,
			plan.access.createdAt,
			plan.outboxIntent.occurredAt,
			plan.auditEvent.occurredAt,
		].some(
			(value) =>
				!validDate(value) ||
				Date.prototype.getTime.call(value) !==
					Date.prototype.getTime.call(timestamp),
		)
	) {
		throw new ApplicationFoundationError("persistence_failed");
	}
}

export class FakeApplicationFoundationTransactionV1
	implements ApplicationFoundationTransactionPortV1
{
	#state = emptySnapshot();
	#failurePoint: FailurePoint | undefined;

	failNextBefore(point: FailurePoint): void {
		this.#failurePoint = point;
	}

	snapshot(): ApplicationFoundationSnapshot {
		return cloneSnapshot(this.#state);
	}

	advanceConfigurationForTest(agentId: string): void {
		const draft = cloneSnapshot(this.#state);
		const agent = draft.agents.find((entry) => entry.agentId === agentId);
		const current = draft.configurationRevisions.find(
			(entry) =>
				entry.agentId === agentId &&
				entry.revision === agent?.currentConfigurationRevision,
		);
		const nextRevision =
			(agent?.currentConfigurationRevision ?? Number.NaN) + 1;
		if (!agent || !current || !Number.isSafeInteger(nextRevision)) {
			throw new ApplicationFoundationError("persistence_failed");
		}
		const configuration = decodeAgentConfigurationRecordV1({
			...current.configuration,
			revision: nextRevision,
		});
		draft.configurationRevisions.push({
			agentId,
			revision: nextRevision,
			configuration,
			createdAt: new Date(Date.prototype.getTime.call(current.createdAt) + 1),
		});
		agent.currentConfigurationRevision = nextRevision;
		this.#state = draft;
	}

	async read(
		input: Parameters<ApplicationFoundationTransactionPortV1["read"]>[0],
	): ReturnType<ApplicationFoundationTransactionPortV1["read"]> {
		if (
			Object.keys(input).length !== 6 ||
			input.schemaVersion !== 1 ||
			!validText(input.applicationId) ||
			!validText(input.agentId) ||
			!validText(input.actorId) ||
			!validText(input.idempotencyKey, 128) ||
			!/^[A-Za-z0-9._~-]{1,128}$/.test(input.idempotencyKey) ||
			!/^[a-f0-9]{64}$/.test(input.requestDigest)
		) {
			throw new ApplicationFoundationError("persistence_failed");
		}
		const existing = this.#state.idempotencyResults.find(
			(record) =>
				record.agentId === input.agentId &&
				record.actorId === input.actorId &&
				record.key === input.idempotencyKey,
		);
		if (!existing) return { outcome: "ready" };
		if (existing.requestDigest !== input.requestDigest) {
			return { outcome: "idempotency_conflict" };
		}
		if (
			existing.result.agentId !== input.agentId ||
			existing.result.applicationId !== input.applicationId ||
			!this.#state.agents.some(
				(agent) => agent.agentId === existing.result.agentId,
			) ||
			!this.#state.applications.some(
				(application) =>
					application.applicationId === existing.result.applicationId &&
					application.agentId === existing.result.agentId,
			) ||
			!this.#state.configurationRevisions.some(
				(revision) =>
					revision.agentId === existing.result.agentId &&
					revision.revision === existing.result.configurationRevision,
			)
		) {
			throw new ApplicationFoundationError("persistence_failed");
		}
		return {
			outcome: "replayed",
			result: structuredClone(existing.result),
		};
	}

	async commit(
		input: ApplicationFoundationWritePlanV1,
	): ReturnType<ApplicationFoundationTransactionPortV1["commit"]> {
		const plan = snapshotApplicationFoundationWritePlanV1(input);
		validatePlan(plan);
		const existingIdempotency = this.#state.idempotencyResults.find(
			(record) =>
				record.agentId === plan.agent.agentId &&
				record.actorId === plan.auditEvent.actorId &&
				record.key === plan.idempotency.key,
		);
		if (existingIdempotency) {
			if (
				existingIdempotency.requestDigest !== plan.idempotency.requestDigest
			) {
				return { outcome: "conflict", reason: "idempotency_conflict" };
			}
			if (
				existingIdempotency.result.agentId !== plan.agent.agentId ||
				existingIdempotency.result.applicationId !==
					plan.application.applicationId
			) {
				throw new ApplicationFoundationError("persistence_failed");
			}
			return {
				outcome: "replayed",
				result: structuredClone(existingIdempotency.result),
			};
		}
		if (
			this.#state.agents.some(
				({ agentId }) => agentId === plan.agent.agentId,
			) ||
			this.#state.applications.some(
				({ applicationId }) => applicationId === plan.application.applicationId,
			)
		) {
			return { outcome: "conflict", reason: "duplicate" };
		}

		const draft = cloneSnapshot(this.#state);
		try {
			this.#failBefore("agent");
			draft.agents.push({ ...plan.agent });

			this.#failBefore("application");
			draft.applications.push({ ...plan.application });

			this.#failBefore("configuration_revision");
			draft.configurationRevisions.push(
				structuredClone(plan.configurationRevision),
			);

			this.#failBefore("owner");
			for (const ownerId of plan.access.ownerIds) {
				draft.owners.push({
					agentId: plan.access.agentId,
					ownerId,
					createdAt: plan.access.createdAt,
				});
			}

			this.#failBefore("availability");
			for (const target of plan.access.availability) {
				draft.availability.push({
					agentId: plan.access.agentId,
					target: structuredClone(target),
				});
			}

			this.#failBefore("idempotency");
			draft.idempotencyResults.push({
				agentId: plan.agent.agentId,
				actorId: plan.auditEvent.actorId,
				key: plan.idempotency.key,
				requestDigest: plan.idempotency.requestDigest,
				result: structuredClone(plan.result),
				createdAt: plan.agent.createdAt,
			});

			this.#failBefore("outbox");
			draft.outboxIntents.push({
				scopeType: plan.outboxIntent.scopeType,
				scopeId: plan.outboxIntent.scopeId,
				operation: plan.outboxIntent.operation,
				payload: { ...plan.outboxIntent.payload },
				traceId: plan.outboxIntent.traceId,
				requestId: plan.outboxIntent.requestId,
				availableAt: plan.outboxIntent.occurredAt,
			});

			this.#failBefore("audit");
			draft.auditEvents.push({ ...plan.auditEvent });

			this.#failBefore("commit");
			this.#state = draft;
			return { outcome: "committed", result: structuredClone(plan.result) };
		} catch (error) {
			if (error instanceof ApplicationFoundationError) throw error;
			throw new ApplicationFoundationError("persistence_failed");
		}
	}

	#failBefore(point: FailurePoint): void {
		if (this.#failurePoint !== point) return;
		this.#failurePoint = undefined;
		throw new Error(`Injected failure before ${point}`);
	}
}
