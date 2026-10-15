import type { BrowserCommandRequestV1 } from "@agent-infra/contracts/pilot";
import {
	type BrowserHandoffAdmissionDecisionV1,
	type BrowserHandoffAdmissionRequestV1,
	type BrowserHandoffCommandV1,
	createBrowserHandoffAdmissionUseCaseV1,
} from "@agent-infra/platform-core";
import {
	type PostgresBrowserHandoffAdmissionTransactionV1 as BrowserHandoffStoreV1,
	PostgresBrowserHandoffAdmissionTransactionV1,
} from "@agent-infra/platform-store";
import type {
	ConversationAuthorization,
	ConversationBrowserCommandDecisionV1,
	ConversationBrowserCommandPortV1,
} from "./http/conversation-routes.js";
import type { IdentityContext } from "./http/identity.js";

type AdmittedBrowserCommand = BrowserHandoffCommandV1;

function exactCommandKeys(
	value: Record<string, unknown>,
	identityKey: "handoffId" | "confirmationId",
) {
	const keys = Reflect.ownKeys(value);
	return (
		keys.length === 3 &&
		keys.every(
			(key) =>
				typeof key === "string" &&
				["schemaVersion", "command", identityKey].includes(key),
		)
	);
}

function validIdentity(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function admittedCommand(
	command: BrowserCommandRequestV1,
): AdmittedBrowserCommand | undefined {
	if (!command || typeof command !== "object") return undefined;
	const value = command as unknown as Record<string, unknown>;
	if (value.schemaVersion !== 1 || typeof value.command !== "string")
		return undefined;
	if (
		(value.command === "take_over" ||
			value.command === "return_to_agent" ||
			value.command === "revoke") &&
		exactCommandKeys(value, "handoffId") &&
		validIdentity(value.handoffId)
	)
		return {
			schemaVersion: 1,
			command: value.command,
			handoffId: value.handoffId,
		};
	if (
		value.command === "pause" &&
		exactCommandKeys(value, "handoffId") &&
		validIdentity(value.handoffId)
	)
		return {
			schemaVersion: 1,
			command: "pause",
			handoffId: value.handoffId,
		};
	if (
		(value.command === "confirm_side_effect" ||
			value.command === "reject_side_effect" ||
			value.command === "cancel_side_effect") &&
		exactCommandKeys(value, "confirmationId") &&
		validIdentity(value.confirmationId)
	)
		return {
			schemaVersion: 1,
			command: value.command,
			confirmationId: value.confirmationId,
		};
	return undefined;
}

function decision(
	result: BrowserHandoffAdmissionDecisionV1,
	conversationId: string,
): ConversationBrowserCommandDecisionV1 {
	if (result.outcome === "accepted" || result.outcome === "replayed") {
		return {
			outcome: result.outcome,
			conversationId,
			executionId: result.plan.executionId,
			...("handoffId" in result.plan.command && result.plan.command.handoffId
				? { handoffId: result.plan.command.handoffId }
				: {}),
			...("confirmationId" in result.plan.command &&
			result.plan.command.confirmationId
				? { confirmationId: result.plan.command.confirmationId }
				: {}),
		};
	}
	if (result.outcome === "denied") return { outcome: "denied", conversationId };
	if (result.outcome === "conflict")
		return { outcome: "conflict", conversationId };
	if (result.outcome === "stale" || result.outcome === "busy")
		return { outcome: "stale", conversationId };
	return { outcome: "unavailable", conversationId };
}

/**
 * Assemble the API-side Browser handoff admission port. The Store owns the
 * durable outbox/idempotency transaction; this adapter only maps server
 * identity and the public command shape into the Core use case.
 */
export function createPostgresBrowserCommandAdmissionV1(input: {
	readonly databaseUrl: string;
	readonly authorization: ConversationAuthorization;
}): ConversationBrowserCommandPortV1 & {
	readonly store: BrowserHandoffStoreV1;
} {
	const store = new PostgresBrowserHandoffAdmissionTransactionV1({
		databaseUrl: input.databaseUrl,
	});
	return {
		store,
		async invoke(request) {
			const command = admittedCommand(request.command);
			if (!command)
				return {
					outcome: "unavailable",
					conversationId: request.conversationId,
				};
			const authorize = async (identity: IdentityContext) => {
				try {
					const current = await input.authorization.authorize(identity, {
						schemaVersion: 1,
						operation: "conversation.read",
						conversationId: request.conversationId,
					});
					return current.outcome === "allowed"
						? { outcome: "allowed" as const, authority: current.authority }
						: { outcome: "denied" as const };
				} catch {
					return { outcome: "denied" as const };
				}
			};
			const admission = createBrowserHandoffAdmissionUseCaseV1({
				authorization: {
					authorize: () => authorize(request.identity),
				},
				state: { read: (conversationId) => store.read(conversationId) },
				transaction: store,
			});
			const admissionRequest: BrowserHandoffAdmissionRequestV1 = {
				schemaVersion: 1,
				conversationId: request.conversationId,
				command,
				idempotencyKey: request.idempotencyKey,
				requestId: request.requestId,
				traceId: request.traceId,
			};
			try {
				const result = await admission.admit(admissionRequest);
				return decision(result, request.conversationId);
			} catch {
				return {
					outcome: "unavailable",
					conversationId: request.conversationId,
				};
			}
		},
	};
}
