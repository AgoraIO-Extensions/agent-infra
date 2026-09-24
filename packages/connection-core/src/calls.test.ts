import { describe, expect, it } from "vitest";

import {
	actionCallNamespaceKey,
	actionRequestDigest,
	assertActionCallTransition,
	decideActionCallReplay,
} from "./calls.js";

const request = {
	requestId: "request-1",
	idempotencyKey: "key-1",
	principalId: "principal-a",
	consumerId: "consumer-a",
	consumerInstanceId: "instance-a",
	actorId: null,
	grantId: "grant-a",
	connectionId: "connection-a",
	actionVersionId: "github.create_pull_request@v1",
	arguments: { base: "main", head: "feature", repositoryId: 7 },
} as const;

describe("Connection ActionCall invariants", () => {
	it("uses a non-null consumer namespace for consumers without actors", () => {
		expect(actionCallNamespaceKey(request)).toContain("__consumer_actor__");
	});

	it("canonicalizes argument key order for the request digest", () => {
		expect(actionRequestDigest(request)).toBe(
			actionRequestDigest({
				...request,
				arguments: { repositoryId: 7, head: "feature", base: "main" },
			}),
		);
	});

	it("rejects non-JSON argument values instead of hashing them ambiguously", () => {
		expect(() =>
			actionRequestDigest({ ...request, arguments: { value: undefined } }),
		).toThrow(/JSON values/);
		expect(() =>
			actionRequestDigest({ ...request, arguments: { value: Number.NaN } }),
		).toThrow(/finite numbers/);
	});

	it("reuses an identical call and rejects another principal or request", () => {
		const record = {
			id: "call-1",
			requestId: request.requestId,
			callId: "call-ref-1",
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
			status: "created" as const,
		};
		expect(decideActionCallReplay(record, request)).toEqual({
			kind: "reuse",
			record,
		});
		expect(
			decideActionCallReplay(record, {
				...request,
				principalId: "principal-b",
			}),
		).toEqual({ kind: "conflict", reason: "namespace" });
		expect(
			decideActionCallReplay(record, {
				...request,
				arguments: { ...request.arguments, head: "other" },
			}),
		).toEqual({ kind: "conflict", reason: "request" });
		expect(
			decideActionCallReplay(record, { ...request, grantId: "grant-b" }),
		).toEqual({ kind: "conflict", reason: "request" });
	});

	it("does not allow terminal states to transition", () => {
		expect(() =>
			assertActionCallTransition("created", "submission_started"),
		).not.toThrow();
		expect(() =>
			assertActionCallTransition("provider_succeeded", "result_pending"),
		).toThrow(/invalid ActionCall transition/);
	});
});
