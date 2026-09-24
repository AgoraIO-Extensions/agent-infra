import { describe, expect, it } from "vitest";

import { actionCallNamespaceKey, actionRequestDigest } from "./calls.js";
import { createGrant } from "./grants.js";
import {
	authorizeActionCall,
	ConnectionAuthorizationDenied,
	reserveActionCall,
	transitionActionCall,
} from "./ports.js";
import type { ActionCallRecord, ActionCallRequest } from "./types.js";

const request: ActionCallRequest = {
	requestId: "request-ports-1",
	idempotencyKey: "ports-key-1",
	principalId: "principal-a",
	consumerId: "consumer-a",
	consumerInstanceId: "instance-a",
	actorId: null,
	grantId: "grant-a",
	connectionId: "connection-a",
	actionVersionId: "action-a@1",
	arguments: { repositoryId: 7 },
};

const grant = createGrant({
	id: request.grantId,
	principalId: request.principalId,
	consumerId: request.consumerId,
	consumerInstanceId: request.consumerInstanceId,
	connectionId: request.connectionId,
	credentialVersionId: "credential-a-v1",
	actionVersionIds: [request.actionVersionId],
	principalRecoveryGeneration: 3,
});

function callRecord(): ActionCallRecord {
	return {
		id: "call-ports-1",
		requestId: request.requestId,
		traceId: "trace-ports-1",
		callId: "call-ref-ports-1",
		idempotencyKey: request.idempotencyKey,
		namespaceKey: actionCallNamespaceKey(request),
		principalId: request.principalId,
		consumerId: request.consumerId,
		consumerInstanceId: request.consumerInstanceId,
		actorId: "__consumer_actor__",
		grantId: request.grantId,
		connectionId: request.connectionId,
		credentialVersionId: "credential-a-v1",
		actionVersionId: request.actionVersionId,
		requestDigest: actionRequestDigest(request),
		status: "created",
	};
}

describe("Connection repository ports", () => {
	it("denies a cross-principal, cross-instance, or stale-generation lookup", async () => {
		const repository = {
			findActiveGrant: async (
				context: Parameters<
					NonNullable<
						Parameters<typeof authorizeActionCall>[0]["findActiveGrant"]
					>
				>[0],
			) =>
				context.principalId === grant.principalId &&
				context.consumerInstanceId === grant.consumerInstanceId &&
				context.principalRecoveryGeneration === 3
					? grant
					: undefined,
		};
		expect(await authorizeActionCall(repository, request, 3)).toBe(grant);
		await expect(
			authorizeActionCall(
				repository,
				{ ...request, principalId: "principal-b" },
				3,
			),
		).rejects.toBeInstanceOf(ConnectionAuthorizationDenied);
		await expect(
			authorizeActionCall(
				repository,
				{ ...request, consumerInstanceId: "instance-b" },
				3,
			),
		).rejects.toBeInstanceOf(ConnectionAuthorizationDenied);
		await expect(
			authorizeActionCall(repository, request, 4),
		).rejects.toBeInstanceOf(ConnectionAuthorizationDenied);
	});

	it("reuses the same request and hides idempotency conflicts", async () => {
		const record = callRecord();
		let stored: ActionCallRecord | undefined;
		const repository = {
			findByIdempotency: async () => stored,
			insert: async (next: ActionCallRecord) => {
				stored = next;
			},
			transition: async () => true,
		};
		expect(await reserveActionCall(repository, record, request, grant)).toBe(
			record,
		);
		expect(
			await reserveActionCall(
				repository,
				{ ...record, id: "other" },
				request,
				grant,
			),
		).toBe(record);
		await expect(
			reserveActionCall(
				repository,
				{ ...record, id: "third" },
				{ ...request, arguments: { repositoryId: 8 } },
				grant,
			),
		).rejects.toBeInstanceOf(ConnectionAuthorizationDenied);
		await expect(
			reserveActionCall(
				repository,
				{ ...record, credentialVersionId: "credential-b-v1" },
				request,
				grant,
			),
		).rejects.toBeInstanceOf(ConnectionAuthorizationDenied);
	});

	it("uses a compare-and-set transition and rejects an illegal transition", async () => {
		const repository = {
			findByIdempotency: async () => undefined,
			insert: async () => {},
			transition: async (
				_id: string,
				from: "created",
				to: "submission_started",
			) => from === "created" && to === "submission_started",
		};
		await expect(
			transitionActionCall(
				repository,
				"call-1",
				"created",
				"submission_started",
			),
		).resolves.toBeUndefined();
		await expect(
			transitionActionCall(
				repository,
				"call-1",
				"provider_succeeded",
				"result_pending",
			),
		).rejects.toThrow(/invalid ActionCall/);
	});
});
