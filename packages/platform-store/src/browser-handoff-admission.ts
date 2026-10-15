import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
	BrowserHandoffAdmissionDecisionV1,
	BrowserHandoffAdmissionPlanV1,
	BrowserHandoffAdmissionStateV1,
	BrowserHandoffAdmissionTransactionPortV1,
	BrowserHandoffCommandV1,
} from "@agent-infra/platform-core";
import type { Transaction } from "./conversation-dispatch-common.js";
import {
	completeIdempotency,
	readIdempotency,
	reserveIdempotency,
} from "./conversation-execution-sql.js";
import postgres from "./observed-postgres.js";

function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function text(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function counter(value: unknown, minimum: number): value is number {
	return (
		typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
	);
}

function admittedCommand(value: unknown): value is BrowserHandoffCommandV1 {
	const command = record(value);
	if (command?.schemaVersion !== 1 || !text(command.command)) return false;
	if (
		command.command === "take_over" ||
		command.command === "return_to_agent" ||
		command.command === "revoke"
	)
		return (
			Object.keys(command).length === 3 &&
			text(command.handoffId) &&
			!Object.hasOwn(command, "confirmationId")
		);
	if (command.command === "pause")
		return (
			Object.keys(command).length === 3 &&
			text(command.handoffId) &&
			!Object.hasOwn(command, "confirmationId")
		);
	if (
		command.command === "confirm_side_effect" ||
		command.command === "reject_side_effect" ||
		command.command === "cancel_side_effect"
	)
		return (
			Object.keys(command).length === 3 &&
			text(command.confirmationId) &&
			!Object.hasOwn(command, "handoffId")
		);
	return false;
}

function parsePlan(
	value: unknown,
	request: Parameters<BrowserHandoffAdmissionTransactionPortV1["admit"]>[0],
): BrowserHandoffAdmissionPlanV1 {
	const plan = record(value);
	const outbox = record(plan?.outbox);
	const payload = record(outbox?.payload);
	const result = record(plan?.result);
	const idempotency = record(plan?.idempotency);
	const command = plan?.command;
	if (
		plan?.schemaVersion !== 1 ||
		plan.kind !== "browser-handoff" ||
		plan.conversationId !== request.command.conversationId ||
		plan.agentId !== request.authority.agentId ||
		plan.actorId !== request.authority.actorId ||
		plan.channelId !== request.authority.channelId ||
		!text(plan.executionId) ||
		!text(plan.turnId) ||
		!counter(plan.sessionGeneration, 1) ||
		!counter(plan.deliveryFence, 0) ||
		!text(plan.hostSessionRef) ||
		!admittedCommand(command) ||
		!isDeepStrictEqual(command, request.command.command) ||
		outbox?.id !==
			`conversation:browser-handoff:${digest({
				conversationId: plan.conversationId,
				actorId: plan.actorId,
				idempotencyKey: request.command.idempotencyKey,
			})}` ||
		outbox.operation !== "conversation.browser.handoff.v1" ||
		!text(outbox.requestId) ||
		!text(outbox.traceId) ||
		payload?.schemaVersion !== 1 ||
		payload.conversationId !== plan.conversationId ||
		payload.agentId !== plan.agentId ||
		payload.actorId !== plan.actorId ||
		payload.channelId !== plan.channelId ||
		payload.executionId !== plan.executionId ||
		payload.turnId !== plan.turnId ||
		payload.sessionGeneration !== plan.sessionGeneration ||
		payload.deliveryFence !== plan.deliveryFence ||
		!admittedCommand(payload.command) ||
		!isDeepStrictEqual(payload.command, command) ||
		result?.schemaVersion !== 1 ||
		result.status !== "submitted" ||
		result.conversationId !== plan.conversationId ||
		result.executionId !== plan.executionId ||
		result.command !== command.command ||
		idempotency?.scopeType !== "conversation" ||
		idempotency.scopeId !== plan.conversationId ||
		idempotency.actorId !== plan.actorId ||
		idempotency.key !== request.command.idempotencyKey ||
		idempotency.requestDigest !== request.requestDigest
	)
		throw new Error("BROWSER_HANDOFF_IDEMPOTENCY_INVALID");
	return plan as BrowserHandoffAdmissionPlanV1;
}

/**
 * Store transaction for Browser handoff admission. It owns only the existing
 * Conversation/idempotency/outbox tables; Worker lease and Runtime authority
 * remain separate consumers of the committed outbox row.
 */
export class PostgresBrowserHandoffAdmissionTransactionV1
	implements BrowserHandoffAdmissionTransactionPortV1
{
	readonly #client: ReturnType<typeof postgres>;

	constructor(options: { readonly databaseUrl: string }) {
		this.#client = postgres(options.databaseUrl, { max: 10 });
	}

	/** Read the current binding for API preflight; admission rechecks it in one transaction. */
	async read(
		conversationId: string,
	): Promise<BrowserHandoffAdmissionStateV1 | null> {
		return this.#client.begin(async (transaction) => {
			const conversations = await transaction<
				{
					id: string;
					agent_id: string;
					actor_id: string;
					channel_id: string;
					session_generation: number | string;
					host_session_ref: string | null;
					authorization_revision: string;
					status: "ready" | "active" | "unavailable";
				}[]
			>`
				select id, agent_id, actor_id, channel_id, session_generation,
					host_session_ref, authorization_revision, status
				from platform.conversations
				where id = ${conversationId}
				limit 1
			`;
			const conversation = conversations[0];
			if (conversation?.status !== "active" || !conversation?.host_session_ref)
				return null;
			const executions = await transaction<
				{
					execution_id: string;
					turn_id: string;
					session_generation: number | string;
					delivery_fence: number | string;
					status: "submitted" | "processing" | "unknown";
					agent_id: string;
					actor_id: string;
					channel_id: string;
					authorization_revision: string;
				}[]
			>`
				select execution_id, turn_id, session_generation, delivery_fence, status,
					agent_id, actor_id, channel_id, authorization_revision
				from platform.conversation_executions
				where conversation_id = ${conversation.id}
					and status in ('submitted', 'processing', 'unknown')
				order by created_at desc
				limit 1
			`;
			const execution = executions[0];
			if (
				!execution ||
				execution.agent_id !== conversation.agent_id ||
				execution.actor_id !== conversation.actor_id ||
				execution.channel_id !== conversation.channel_id ||
				execution.authorization_revision !==
					conversation.authorization_revision ||
				String(execution.session_generation) !==
					String(conversation.session_generation)
			)
				return null;
			return {
				conversation: {
					schemaVersion: 1,
					conversationId: conversation.id,
					agentId: conversation.agent_id,
					actorId: conversation.actor_id,
					channelId: conversation.channel_id,
					sessionGeneration: Number(conversation.session_generation),
					hostSessionRef: conversation.host_session_ref,
					authorizationRevision: conversation.authorization_revision,
					status: "active",
				},
				activeExecution: {
					executionId: execution.execution_id,
					turnId: execution.turn_id,
					sessionGeneration: Number(execution.session_generation),
					deliveryFence: Number(execution.delivery_fence),
					status: execution.status,
				},
			};
		});
	}

	async admit(
		request: Parameters<BrowserHandoffAdmissionTransactionPortV1["admit"]>[0],
		decide: Parameters<BrowserHandoffAdmissionTransactionPortV1["admit"]>[1],
		isAuthorized: Parameters<
			BrowserHandoffAdmissionTransactionPortV1["admit"]
		>[2],
	): Promise<BrowserHandoffAdmissionDecisionV1> {
		return this.#client.begin(async (transaction) =>
			this.#admitInTransaction(transaction, request, decide, isAuthorized),
		);
	}

	async #admitInTransaction(
		transaction: Transaction,
		request: Parameters<BrowserHandoffAdmissionTransactionPortV1["admit"]>[0],
		decide: Parameters<BrowserHandoffAdmissionTransactionPortV1["admit"]>[1],
		isAuthorized: Parameters<
			BrowserHandoffAdmissionTransactionPortV1["admit"]
		>[2],
	): Promise<BrowserHandoffAdmissionDecisionV1> {
		const scope = {
			scopeType: "conversation",
			scopeId: request.command.conversationId,
			actorId: request.authority.actorId,
			commandType: "browser.handoff",
			key: request.command.idempotencyKey,
		};
		// Keep the lock order aligned with Conversation execution admission and
		// dispatch: Agent governance, Conversation, then command state.
		const agents = await transaction<{ readonly id: string }[]>`
			select id from platform.agents
			where id = ${request.authority.agentId}
			for share
		`;
		if (!agents[0]) return { outcome: "denied", reason: "authorization_lost" };
		const conversations = await transaction<
			{
				id: string;
				agent_id: string;
				actor_id: string;
				channel_id: string;
				session_generation: number | string;
				host_session_ref: string | null;
				authorization_revision: string;
				status: "ready" | "active" | "unavailable";
			}[]
		>`
			select id, agent_id, actor_id, channel_id, session_generation,
				host_session_ref, authorization_revision, status
			from platform.conversations
			where id = ${request.command.conversationId}
			for update
		`;
		const conversation = conversations[0];
		if (
			!conversation ||
			conversation.agent_id !== request.authority.agentId ||
			conversation.actor_id !== request.authority.actorId ||
			conversation.channel_id !== request.authority.channelId ||
			conversation.authorization_revision !==
				request.authority.authorizationRevision ||
			!conversation.host_session_ref ||
			conversation.status === "unavailable"
		)
			return { outcome: "denied", reason: "authorization_lost" };
		const existing = await readIdempotency(transaction, scope);
		if (existing) {
			if (existing.request_digest !== request.requestDigest)
				return { outcome: "conflict", reason: "idempotency_conflict" };
			if (existing.status !== "completed")
				return { outcome: "unavailable", reason: "conversation_unavailable" };
			if (!(await isAuthorized()))
				return { outcome: "denied", reason: "authorization_lost" };
			return {
				outcome: "replayed",
				plan: parsePlan(existing.result, request),
			};
		}
		if (conversation.status !== "active")
			return { outcome: "unavailable", reason: "conversation_unavailable" };

		const executions = await transaction<
			{
				execution_id: string;
				turn_id: string;
				session_generation: number | string;
				delivery_fence: number | string;
				status: "submitted" | "processing" | "unknown";
				agent_id: string;
				actor_id: string;
				channel_id: string;
				authorization_revision: string;
			}[]
		>`
			select execution_id, turn_id, session_generation, delivery_fence, status,
				agent_id, actor_id, channel_id, authorization_revision
			from platform.conversation_executions
			where conversation_id = ${conversation.id}
				and status in ('submitted', 'processing', 'unknown')
			order by created_at desc
			limit 1
			for update
		`;
		const execution = executions[0];
		if (
			!execution ||
			execution.agent_id !== conversation.agent_id ||
			execution.actor_id !== conversation.actor_id ||
			execution.channel_id !== conversation.channel_id ||
			execution.authorization_revision !==
				conversation.authorization_revision ||
			String(execution.session_generation) !==
				String(conversation.session_generation)
		)
			return { outcome: "unavailable", reason: "conversation_unavailable" };
		const state: BrowserHandoffAdmissionStateV1 = {
			conversation: {
				schemaVersion: 1,
				conversationId: conversation.id,
				agentId: conversation.agent_id,
				actorId: conversation.actor_id,
				channelId: conversation.channel_id,
				sessionGeneration: Number(conversation.session_generation),
				hostSessionRef: conversation.host_session_ref,
				authorizationRevision: conversation.authorization_revision,
				status: conversation.status === "active" ? "active" : "ready",
			},
			activeExecution: {
				executionId: execution.execution_id,
				turnId: execution.turn_id,
				sessionGeneration: Number(execution.session_generation),
				deliveryFence: Number(execution.delivery_fence),
				status: execution.status,
			},
		};
		const decision = await decide(state);
		if ("outcome" in decision) return decision;
		if (!(await isAuthorized()))
			return { outcome: "denied", reason: "authorization_lost" };
		const reservationId = await reserveIdempotency(transaction, {
			...scope,
			requestDigest: request.requestDigest,
			occurredAt: new Date(),
		});
		if (!reservationId) {
			const raced = await readIdempotency(transaction, scope);
			if (!raced || raced.request_digest !== request.requestDigest)
				return { outcome: "conflict", reason: "idempotency_conflict" };
			if (raced.status !== "completed")
				return { outcome: "unavailable", reason: "conversation_unavailable" };
			if (!(await isAuthorized()))
				return { outcome: "denied", reason: "authorization_lost" };
			return {
				outcome: "replayed",
				plan: parsePlan(raced.result, request),
			};
		}
		await transaction`
			insert into platform.outbox_items
				(id, scope_type, scope_id, operation, payload, trace_id, request_id,
				 available_at, created_at, updated_at)
			values
				(${decision.outbox.id}, 'conversation', ${decision.conversationId},
				 ${decision.outbox.operation}, ${transaction.json(decision.outbox.payload)},
				 ${decision.outbox.traceId}, ${decision.outbox.requestId},
				 clock_timestamp(), clock_timestamp(), clock_timestamp())
		`;
		await transaction`
			insert into platform.conversation_audit_events
				(id, conversation_id, execution_id, agent_id, actor_id, action,
				 trace_id, request_id, occurred_at)
			values
				(${randomUUID()}, ${decision.conversationId}, ${decision.executionId},
				 ${decision.agentId}, ${decision.actorId},
				 'conversation.browser_handoff.accepted', ${decision.outbox.traceId},
				 ${decision.outbox.requestId}, clock_timestamp())
		`;
		await completeIdempotency(transaction, reservationId, decision, new Date());
		return { outcome: "accepted", plan: decision };
	}

	close(): Promise<void> {
		return this.#client.end();
	}
}
