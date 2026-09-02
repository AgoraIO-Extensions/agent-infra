import { decodeAgentConfigurationRecordV1 } from "./agent-configuration.js";
import {
	ApplicationRevisionError,
	type ApplicationRevisionReadStateV1,
	type ApplicationRevisionResultV1,
	type ApplicationRevisionTransactionPortV1,
	type ApplicationRevisionWritePlanV1,
	snapshotApplicationRevisionWritePlanV1,
} from "./application-revision.js";

export const applicationRevisionFailurePoints = [
	"application",
	"configuration",
	"access",
	"authorization",
	"management",
	"history",
	"idempotency",
	"outbox",
	"audit",
	"commit",
] as const;

export type ApplicationRevisionFailurePoint =
	(typeof applicationRevisionFailurePoints)[number];

export interface ApplicationRevisionFakeSnapshotV1 {
	readonly state: ApplicationRevisionReadStateV1;
	readonly commitCount: number;
	readonly lastPlan: ApplicationRevisionWritePlanV1 | null;
	readonly idempotencyCount: number;
	readonly history: readonly {
		readonly from: "pending_approval" | "rejected";
		readonly to: "pending_approval";
		readonly revision: number;
	}[];
	readonly outboxCount: number;
	readonly auditCount: number;
}

interface CompletedRevision {
	readonly applicationId: string;
	readonly agentId: string;
	readonly actorId: string;
	readonly requestDigest: string;
	readonly result: ApplicationRevisionResultV1;
}

function sameValue(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function scope(applicationId: string, actorId: string, key: string): string {
	return JSON.stringify([applicationId, actorId, key]);
}

export class FakeApplicationRevisionTransactionV1
	implements ApplicationRevisionTransactionPortV1
{
	#state: ApplicationRevisionReadStateV1;
	#completed = new Map<string, CompletedRevision>();
	#commitCount = 0;
	#lastPlan: ApplicationRevisionWritePlanV1 | null = null;
	#history: ApplicationRevisionFakeSnapshotV1["history"] = [];
	#outboxCount = 0;
	#auditCount = 0;
	#failurePoint: ApplicationRevisionFailurePoint | undefined;

	constructor(state: ApplicationRevisionReadStateV1) {
		this.#state = structuredClone(state);
	}

	failNextBefore(point: ApplicationRevisionFailurePoint): void {
		this.#failurePoint = point;
	}

	advanceManagementRevision(): void {
		this.#state = {
			...this.#state,
			management: {
				...this.#state.management,
				revision: this.#state.management.revision + 1,
			},
		};
	}

	advanceConfigurationRevision(): void {
		const revision = this.#state.configuration.revision + 1;
		this.#state = {
			...this.#state,
			configuration: decodeAgentConfigurationRecordV1({
				...this.#state.configuration,
				revision,
			}),
		};
	}

	setAuthorizationRevision(revision: string): void {
		this.#state = { ...this.#state, authorizationRevision: revision };
	}

	async read(
		input: Parameters<ApplicationRevisionTransactionPortV1["read"]>[0],
	): ReturnType<ApplicationRevisionTransactionPortV1["read"]> {
		const existing = this.#completed.get(
			scope(input.applicationId, input.actorId, input.idempotencyKey),
		);
		if (existing) {
			if (existing.requestDigest !== input.requestDigest) {
				return { outcome: "idempotency_conflict" };
			}
			if (
				existing.applicationId !== input.applicationId ||
				existing.actorId !== input.actorId ||
				existing.result.applicationId !== input.applicationId ||
				existing.result.agentId !== existing.agentId
			) {
				throw new ApplicationRevisionError("persistence_failed");
			}
			return { outcome: "replayed", result: structuredClone(existing.result) };
		}
		return input.applicationId === this.#state.application.applicationId &&
			input.actorId === this.#state.application.applicantId
			? { outcome: "ready", state: structuredClone(this.#state) }
			: { outcome: "unavailable" };
	}

	async commit(
		input: ApplicationRevisionWritePlanV1,
	): ReturnType<ApplicationRevisionTransactionPortV1["commit"]> {
		const plan = snapshotApplicationRevisionWritePlanV1(input);
		const key = scope(
			plan.application.applicationId,
			plan.auditEvent.actorId,
			plan.idempotency.key,
		);
		const existing = this.#completed.get(key);
		if (existing) {
			return existing.requestDigest === plan.idempotency.requestDigest
				? { outcome: "replayed", result: structuredClone(existing.result) }
				: { outcome: "conflict", reason: "idempotency_conflict" };
		}
		if (
			plan.application.applicationId !==
				this.#state.application.applicationId ||
			plan.application.agentId !== this.#state.application.agentId ||
			plan.application.applicantId !== this.#state.application.applicantId ||
			plan.auditEvent.actorId !== this.#state.application.applicantId
		) {
			throw new ApplicationRevisionError("persistence_failed");
		}
		if (plan.expected.managementRevision !== this.#state.management.revision) {
			return { outcome: "conflict", reason: "stale_management" };
		}
		if (
			plan.expected.configurationRevision !== this.#state.configuration.revision
		) {
			return { outcome: "conflict", reason: "stale_configuration" };
		}
		if (
			plan.expected.authorizationRevision !== this.#state.authorizationRevision
		) {
			return { outcome: "conflict", reason: "stale_authorization" };
		}
		if (
			plan.management.transition.from !== this.#state.management.status ||
			((plan.configuration === null ||
				plan.configuration.accessUpdate === null) &&
				(!sameValue(
					plan.management.state.ownerIds,
					this.#state.management.ownerIds,
				) ||
					!sameValue(
						plan.management.state.availability,
						this.#state.management.availability,
					)))
		) {
			throw new ApplicationRevisionError("persistence_failed");
		}

		let draftState = structuredClone(this.#state);
		const draft = structuredClone({
			completed: [...this.#completed.entries()],
			commitCount: this.#commitCount,
			lastPlan: this.#lastPlan,
			history: this.#history,
			outboxCount: this.#outboxCount,
			auditCount: this.#auditCount,
		});
		try {
			this.#failBefore("application");
			draftState = {
				...draftState,
				application: {
					...draftState.application,
					name: plan.application.name,
					description: plan.application.description,
				},
			};

			this.#failBefore("configuration");
			if (plan.configuration) {
				draftState = {
					...draftState,
					configuration: structuredClone(plan.configuration.configuration),
				};
			}

			this.#failBefore("access");
			draftState = {
				...draftState,
				management: structuredClone(plan.management.state),
			};

			this.#failBefore("authorization");
			draftState = {
				...draftState,
				authorizationRevision: plan.nextAuthorizationRevision,
			};

			this.#failBefore("management");
			draftState = {
				...draftState,
				management: structuredClone(plan.management.state),
			};

			this.#failBefore("history");
			draft.history = [
				...draft.history,
				{
					from: plan.management.transition.from as
						| "pending_approval"
						| "rejected",
					to: "pending_approval" as const,
					revision: plan.management.state.revision,
				},
			];

			this.#failBefore("idempotency");
			draft.completed.push([
				key,
				{
					applicationId: plan.application.applicationId,
					agentId: plan.application.agentId,
					actorId: plan.auditEvent.actorId,
					requestDigest: plan.idempotency.requestDigest,
					result: structuredClone(plan.result),
				},
			]);

			this.#failBefore("outbox");
			draft.outboxCount += plan.configuration ? 2 : 1;

			this.#failBefore("audit");
			draft.auditCount += plan.configuration ? 2 : 1;

			this.#failBefore("commit");
			this.#state = draftState;
			this.#completed = new Map(draft.completed);
			this.#commitCount = draft.commitCount + 1;
			this.#lastPlan = structuredClone(plan);
			this.#history = draft.history;
			this.#outboxCount = draft.outboxCount;
			this.#auditCount = draft.auditCount;
			return { outcome: "committed", result: structuredClone(plan.result) };
		} catch (error) {
			if (error instanceof ApplicationRevisionError) throw error;
			throw new ApplicationRevisionError("persistence_failed");
		}
	}

	snapshot(): ApplicationRevisionFakeSnapshotV1 {
		return structuredClone({
			state: this.#state,
			commitCount: this.#commitCount,
			lastPlan: this.#lastPlan,
			idempotencyCount: this.#completed.size,
			history: this.#history,
			outboxCount: this.#outboxCount,
			auditCount: this.#auditCount,
		});
	}

	#failBefore(point: ApplicationRevisionFailurePoint): void {
		if (this.#failurePoint !== point) return;
		this.#failurePoint = undefined;
		throw new Error(`Injected failure before ${point}`);
	}
}
