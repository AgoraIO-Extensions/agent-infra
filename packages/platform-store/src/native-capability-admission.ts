import { isDeepStrictEqual } from "node:util";
import type {
	ConversationExecutionAuthorityV1,
	ConversationExecutionConversationStateV1,
	FileRecordV1,
	NativeCapabilityAdmissionDecisionV1,
	NativeCapabilityAdmissionRequest,
	NativeCapabilityAdmissionStateV1,
	NativeCapabilityAdmissionTransactionPortV1,
	NativeCapabilityInvocationPlanV1,
	NativeTextInputV1,
} from "@agent-infra/platform-core";
import {
	bindNativeTextInputFileV1,
	nativeCapabilityParametersDigestV1,
	parseNativeCapabilityAttachmentsV1,
} from "@agent-infra/platform-core";

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
	/** Available, currently unbound input files for Invocation V2 tests. */
	readonly files?: readonly FileRecordV1[];
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
	readonly #files = new Map<string, FileRecordV1>();
	#tail: Promise<void> = Promise.resolve();

	constructor(options: FakeNativeCapabilityAdmissionStoreOptionsV1) {
		this.#conversation = structuredClone(options.conversation);
		this.#authorizationRevision =
			options.authorizationRevision ??
			options.conversation.authorizationRevision;
		this.#activeExecution = options.activeExecution ?? null;
		for (const file of options.files ?? [])
			this.#files.set(file.fileId, structuredClone(file));
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

	get files(): readonly FileRecordV1[] {
		return [...this.#files.values()].map((file) => structuredClone(file));
	}

	async admitNativeCapability(
		request: {
			readonly command: NativeCapabilityAdmissionRequest;
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
		isCurrent: (
			plan: NativeCapabilityInvocationPlanV1,
			conversation: ConversationExecutionConversationStateV1,
		) => boolean,
		isAuthorized: () => Promise<boolean>,
	): Promise<NativeCapabilityAdmissionDecisionV1> {
		return this.#serialize(() =>
			this.#admitNativeCapability(request, decide, isCurrent, isAuthorized),
		);
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
			readonly command: NativeCapabilityAdmissionRequest;
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
		isCurrent: (
			plan: NativeCapabilityInvocationPlanV1,
			conversation: ConversationExecutionConversationStateV1,
		) => boolean,
		isAuthorized: () => Promise<boolean>,
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
			if (!(await isAuthorized()))
				return { outcome: "denied", reason: "authorization_lost" };
			if (this.#authorizationRevision !== authority.authorizationRevision)
				return { outcome: "denied", reason: "authorization_lost" };
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
			inputFiles: {
				getFile: async (fileId) =>
					structuredClone(this.#files.get(fileId) ?? null),
			},
		});
		if ("outcome" in decision) return decision;
		if (this.#authorizationRevision !== authority.authorizationRevision)
			return { outcome: "denied", reason: "authorization_lost" };
		if (this.#activeExecution) return { outcome: "busy" };
		if (!isCurrent(decision, this.#conversation)) return { outcome: "stale" };
		this.#validatePlan(decision, request);
		this.#bindInputs(decision, command);
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
			readonly command: NativeCapabilityAdmissionRequest;
			readonly authority: ConversationExecutionAuthorityV1;
			readonly requestDigest: string;
		},
	): void {
		const command = request.command;
		let attachments: readonly NativeTextInputV1[] | undefined;
		let outboxAttachments: readonly NativeTextInputV1[] | undefined;
		try {
			attachments =
				plan.attachments === undefined
					? undefined
					: parseNativeCapabilityAttachmentsV1(plan.attachments);
			outboxAttachments =
				plan.outbox.payload.attachments === undefined
					? undefined
					: parseNativeCapabilityAttachmentsV1(plan.outbox.payload.attachments);
		} catch {
			throw new Error("Native capability admission plan is invalid");
		}
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
			plan.outbox.payload.capabilitySourceVersion !==
				plan.capability.source.version ||
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
			plan.outbox.payload.capabilitySourceVersion !==
				plan.capability.source.version ||
			plan.outbox.payload.parameters !== plan.parameters ||
			plan.outbox.payload.parametersDigest !== plan.parametersDigest ||
			(command.schemaVersion === 2
				? !attachments ||
					attachments.length !== command.attachments.length ||
					attachments.some(
						(entry, index) => entry.fileId !== command.attachments[index],
					) ||
					!isDeepStrictEqual(outboxAttachments, attachments) ||
					plan.capability.kind !== "skill"
				: attachments !== undefined || outboxAttachments !== undefined) ||
			plan.result.executionId !== plan.executionId ||
			plan.result.conversationId !== plan.conversationId ||
			plan.idempotency.key !== command.idempotencyKey ||
			plan.idempotency.requestDigest !== request.requestDigest
		)
			throw new Error("Native capability admission plan is invalid");
	}

	#bindInputs(
		plan: NativeCapabilityInvocationPlanV1,
		command: NativeCapabilityAdmissionRequest,
	): void {
		if (plan.attachments === undefined) {
			if (command.schemaVersion !== 1)
				throw new Error("Native capability admission plan is invalid");
			return;
		}
		if (command.schemaVersion !== 2)
			throw new Error("Native capability admission plan is invalid");
		const scope = {
			actorId: this.#conversation.actorId,
			agentId: this.#conversation.agentId,
			channelId: this.#conversation.channelId,
			conversationId: this.#conversation.conversationId,
		};
		const now = new Date();
		for (let index = 0; index < plan.attachments.length; index += 1) {
			const attachment = plan.attachments[index];
			if (!attachment || attachment.fileId !== command.attachments[index])
				throw new Error("Native capability admission plan is invalid");
			const file = bindNativeTextInputFileV1(
				this.#files.get(attachment.fileId) ?? null,
				scope,
				{
					executionId: plan.executionId,
					sessionGeneration: plan.sessionGeneration,
				},
				now,
			);
			if (
				file.descriptor.sha256 !== attachment.sha256 ||
				file.descriptor.sizeBytes !== attachment.byteLength ||
				file.descriptor.mediaType !== attachment.mediaType
			)
				throw new Error("Native capability admission plan is invalid");
			this.#files.set(file.fileId, structuredClone(file));
		}
	}
}
