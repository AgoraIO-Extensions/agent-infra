import type {
	ConversationExecutionAuthorityV1,
	ConversationExecutionConversationStateV1,
	NativeCapabilityAdmissionDecisionV1,
	NativeCapabilityAdmissionRequestV1,
	NativeCapabilityAdmissionStateV1,
	NativeCapabilityAdmissionTransactionPortV1,
	NativeCapabilityInvocationPlanV1,
} from "@agent-infra/platform-core";
import { nativeCapabilityParametersDigestV1 } from "@agent-infra/platform-core";

interface IdempotencyRecord {
	readonly requestDigest: string;
	readonly plan: NativeCapabilityInvocationPlanV1;
}

function freeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value))
		return value;
	Object.freeze(value);
	for (const child of Object.values(value)) freeze(child);
	return value;
}

export interface FakeNativeCapabilityAdmissionStoreOptionsV1 {
	readonly conversation: ConversationExecutionConversationStateV1;
	readonly authorizationRevision?: string;
	readonly activeExecution?: NativeCapabilityAdmissionStateV1["activeExecution"];
}

/**
 * A deterministic transaction-port fake for the native capability seam.
 *
 * Production callers will replace this port with the Conversation Store
 * transaction. The fake deliberately owns the same lock/idempotency/replay
 * ordering so Core tests cannot accidentally bypass Store semantics.
 */
export class FakeNativeCapabilityAdmissionStoreV1
	implements NativeCapabilityAdmissionTransactionPortV1
{
	#conversation: ConversationExecutionConversationStateV1;
	#authorizationRevision: string;
	#activeExecution: NativeCapabilityAdmissionStateV1["activeExecution"];
	readonly #idempotency = new Map<string, IdempotencyRecord>();
	readonly #plans = new Map<string, NativeCapabilityInvocationPlanV1>();
	#tail: Promise<void> = Promise.resolve();

	constructor(options: FakeNativeCapabilityAdmissionStoreOptionsV1) {
		this.#conversation = structuredClone(options.conversation);
		this.#authorizationRevision =
			options.authorizationRevision ??
			options.conversation.authorizationRevision;
		this.#activeExecution = options.activeExecution ?? null;
	}

	setAuthorizationRevision(revision: string): void {
		this.#authorizationRevision = revision;
	}

	setActiveExecution(
		activeExecution: NativeCapabilityAdmissionStateV1["activeExecution"],
	): void {
		this.#activeExecution = activeExecution;
	}

	get plans(): readonly NativeCapabilityInvocationPlanV1[] {
		return [...this.#plans.values()].map((plan) =>
			freeze(structuredClone(plan)),
		);
	}

	async admitNativeCapability(
		request: {
			readonly command: NativeCapabilityAdmissionRequestV1;
			readonly authority: ConversationExecutionAuthorityV1;
			readonly requestDigest: string;
		},
		decide: (state: NativeCapabilityAdmissionStateV1) => Promise<
			| NativeCapabilityInvocationPlanV1
			| Extract<
					NativeCapabilityAdmissionDecisionV1,
					{
						readonly outcome: Exclude<
							NativeCapabilityAdmissionDecisionV1["outcome"],
							"accepted" | "replayed" | "conflict"
						>;
					}
			  >
		>,
	): Promise<NativeCapabilityAdmissionDecisionV1> {
		return this.#serialize(() => this.#admitNativeCapability(request, decide));
	}

	#serialize<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.#tail;
		let release = () => {};
		this.#tail = new Promise<void>((resolve) => {
			release = resolve;
		});
		return previous.then(operation).finally(release);
	}

	async #admitNativeCapability(
		request: {
			readonly command: NativeCapabilityAdmissionRequestV1;
			readonly authority: ConversationExecutionAuthorityV1;
			readonly requestDigest: string;
		},
		decide: (state: NativeCapabilityAdmissionStateV1) => Promise<
			| NativeCapabilityInvocationPlanV1
			| Extract<
					NativeCapabilityAdmissionDecisionV1,
					{
						readonly outcome: Exclude<
							NativeCapabilityAdmissionDecisionV1["outcome"],
							"accepted" | "replayed" | "conflict"
						>;
					}
			  >
		>,
	): Promise<NativeCapabilityAdmissionDecisionV1> {
		const authority = request.authority;
		const command = request.command;
		if (
			this.#conversation.conversationId !== command.conversationId ||
			this.#conversation.agentId !== authority.agentId ||
			this.#conversation.actorId !== authority.actorId ||
			this.#conversation.channelId !== authority.channelId
		)
			return { outcome: "denied", reason: "authorization_lost" };
		if (this.#authorizationRevision !== authority.authorizationRevision)
			return { outcome: "denied", reason: "authorization_lost" };

		const idempotencyKey = JSON.stringify([
			command.conversationId,
			authority.actorId,
			command.idempotencyKey,
		]);
		const existing = this.#idempotency.get(idempotencyKey);
		if (existing) {
			if (existing.requestDigest !== request.requestDigest)
				return { outcome: "conflict", reason: "idempotency_conflict" };
			return {
				outcome: "replayed",
				result: freeze(structuredClone(existing.plan.result)),
				plan: freeze(structuredClone(existing.plan)),
			};
		}

		const decision = await decide({
			conversation: structuredClone(this.#conversation),
			activeExecution: this.#activeExecution
				? { ...this.#activeExecution }
				: null,
			authorizationRevision: this.#authorizationRevision,
		});
		if ("outcome" in decision) return decision;
		if (this.#authorizationRevision !== authority.authorizationRevision)
			return { outcome: "denied", reason: "authorization_lost" };
		this.#validatePlan(decision, request);
		const plan = freeze(structuredClone(decision));
		this.#idempotency.set(idempotencyKey, {
			requestDigest: request.requestDigest,
			plan,
		});
		this.#plans.set(plan.executionId, plan);
		this.#activeExecution = {
			executionId: plan.executionId,
			status: "submitted",
		};
		return {
			outcome: "accepted",
			result: freeze(structuredClone(plan.result)),
			plan: freeze(structuredClone(plan)),
		};
	}

	#validatePlan(
		plan: NativeCapabilityInvocationPlanV1,
		request: {
			readonly command: NativeCapabilityAdmissionRequestV1;
			readonly authority: ConversationExecutionAuthorityV1;
			readonly requestDigest: string;
		},
	): void {
		const command = request.command;
		if (
			plan.schemaVersion !== 1 ||
			plan.kind !== "native-capability" ||
			plan.conversationId !== command.conversationId ||
			plan.agentId !== request.authority.agentId ||
			plan.actorId !== request.authority.actorId ||
			plan.channelId !== request.authority.channelId ||
			plan.authorizationRevision !== request.authority.authorizationRevision ||
			plan.capability.id !== command.capabilityId ||
			plan.capability.directoryRevision !== command.directoryRevision ||
			plan.parameters.length > 16 * 1024 ||
			plan.parameters !== command.parameters ||
			plan.parametersDigest !==
				nativeCapabilityParametersDigestV1(command.parameters) ||
			plan.outbox.id !== `conversation:native-capability:${plan.executionId}` ||
			plan.outbox.payload.executionId !== plan.executionId ||
			plan.outbox.payload.conversationId !== plan.conversationId ||
			plan.outbox.payload.agentId !== plan.agentId ||
			plan.outbox.payload.actorId !== plan.actorId ||
			plan.outbox.payload.channelId !== plan.channelId ||
			plan.outbox.payload.capabilityId !== plan.capability.id ||
			plan.outbox.payload.directoryRevision !==
				plan.capability.directoryRevision ||
			plan.outbox.payload.parametersDigest !== plan.parametersDigest ||
			plan.result.executionId !== plan.executionId ||
			plan.result.conversationId !== plan.conversationId ||
			plan.idempotency.key !== command.idempotencyKey ||
			plan.idempotency.requestDigest !== request.requestDigest
		)
			throw new Error("Native capability admission plan is invalid");
	}
}
