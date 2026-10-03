import {
	DelegatedActionResultV1Schema,
	validateDelegatedActionResultV1,
} from "@agent-infra/contracts/pilot";
import { describe, expect, it } from "vitest";

import {
	fakeDelegatedActionFailureV1,
	fakeDelegatedActionSuccessV1,
} from "./delegated.js";

type FailureError = NonNullable<
	NonNullable<Parameters<typeof fakeDelegatedActionFailureV1>[1]>["error"]
>;
type RejectsMismatchedFailure = {
	code: "PROVIDER_REJECTED";
	message: "Connection is unavailable";
	retryable: true;
} extends FailureError
	? false
	: true;
const rejectsMismatchedFailure: RejectsMismatchedFailure = true;
void rejectsMismatchedFailure;

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

const validateIssueOutput = (input: unknown) => {
	if (
		typeof input !== "object" ||
		input === null ||
		Array.isArray(input) ||
		Object.keys(input).length !== 1 ||
		typeof (input as { issueNumber?: unknown }).issueNumber !== "number"
	) {
		throw new Error("Output does not match the Fake Action Schema");
	}
	return input;
};

describe("delegated Action Fakes", () => {
	it("returns a schema-valid, correlated success", () => {
		const result = fakeDelegatedActionSuccessV1(
			request,
			{ issueNumber: 180 },
			validateIssueOutput,
		);

		expect(DelegatedActionResultV1Schema.parse(result)).toEqual(result);
		expect(
			validateDelegatedActionResultV1(request, result, {
				validateOutput: validateIssueOutput,
			}),
		).toEqual(result);
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
		expect(
			validateDelegatedActionResultV1(request, result, {
				validateOutput: validateIssueOutput,
			}),
		).toEqual(result);
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
			fakeDelegatedActionSuccessV1(
				request,
				{ accessToken: "must-not-leave-connection" },
				validateIssueOutput,
			),
		).toThrow();
	});
});
