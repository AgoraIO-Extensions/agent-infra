import {
	DelegatedActionResultV1Schema,
	validateDelegatedActionResultV1,
} from "@agent-infra/contracts/pilot";
import { describe, expect, it } from "vitest";

import {
	fakeDelegatedActionFailureV1,
	fakeDelegatedActionSuccessV1,
} from "./delegated.js";

const request = {
	schemaVersion: 1,
	requestId: "request-connection-1",
	idempotencyKey: "tool.call_1",
	grant: {
		schemaVersion: 1,
		format: "compact-jws",
		token: "header.payload.signature",
	},
	action: {
		actionId: "github.issues.read",
		actionVersion: "v3",
		arguments: { issueNumber: 180 },
	},
	traceId: "trace-connection-1",
} as const;

describe("delegated Action Fakes", () => {
	it("returns a schema-valid, correlated success", () => {
		const result = fakeDelegatedActionSuccessV1(request, { issueNumber: 180 });

		expect(DelegatedActionResultV1Schema.parse(result)).toEqual(result);
		expect(validateDelegatedActionResultV1(request, result)).toEqual(result);
		expect(result).toMatchObject({
			requestId: request.requestId,
			idempotencyKey: request.idempotencyKey,
			traceId: request.traceId,
			actionId: request.action.actionId,
			actionVersion: request.action.actionVersion,
			callId: `call-${request.requestId}`,
			status: "succeeded",
			completedAt: "2026-08-28T10:00:01Z",
		});
	});

	it("returns a schema-valid, correlated retryable failure", () => {
		const result = fakeDelegatedActionFailureV1(request);

		expect(DelegatedActionResultV1Schema.parse(result)).toEqual(result);
		expect(validateDelegatedActionResultV1(request, result)).toEqual(result);
		expect(result).toMatchObject({
			requestId: request.requestId,
			idempotencyKey: request.idempotencyKey,
			traceId: request.traceId,
			actionId: request.action.actionId,
			actionVersion: request.action.actionVersion,
			callId: null,
			status: "failed",
			completedAt: "2026-08-28T10:00:01Z",
			error: {
				code: "CONNECTION_UNAVAILABLE",
				retryable: true,
				traceId: request.traceId,
			},
		});
	});

	it("rejects credential-like successful output", () => {
		expect(() =>
			fakeDelegatedActionSuccessV1(request, {
				accessToken: "must-not-leave-connection",
			}),
		).toThrow();
	});
});
