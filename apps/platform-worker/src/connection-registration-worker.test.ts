import { planConnectionConsumerRegistrationV1 } from "@agent-infra/platform-core";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	pending: vi.fn(),
	beginAttempt: vi.fn(),
	current: vi.fn(),
	complete: vi.fn(),
	deferBeforeSend: vi.fn(),
	claim: vi.fn(),
	renew: vi.fn(),
	markSucceeded: vi.fn(),
	markFailed: vi.fn(),
	scheduleRetry: vi.fn(),
}));
vi.mock("@agent-infra/platform-store", () => ({
	PostgresConnectionConsumerRegistrationStoreV1: class {
		pending = mocks.pending;
		beginAttempt = mocks.beginAttempt;
		current = mocks.current;
		complete = mocks.complete;
		deferBeforeSend = mocks.deferBeforeSend;
		close = async () => {};
	},
	createPostgresOutboxStore: () => ({
		claim: mocks.claim,
		renew: mocks.renew,
		markSucceeded: mocks.markSucceeded,
		markFailed: mocks.markFailed,
		scheduleRetry: mocks.scheduleRetry,
		close: async () => {},
	}),
}));

import { createConnectionConsumerRegistrationWorkerV1 } from "./connection-registration-worker.js";

const policy = {
	schemaVersion: 1 as const,
	sourceNamespace: "controlled-worker-test",
	revision: "policy-1",
	callbackUrl: "https://platform.example.test/connection/callback",
	resource: "https://connection.example.test/mcp",
	scope: "mcp:tools",
};
const intent = planConnectionConsumerRegistrationV1({
	policy,
	platformAgentId: "agent-a",
	platformOwnerId: "owner-a",
	consumerName: "Agent A",
});
const register = vi.fn();
const reconcile = vi.fn();
beforeEach(() => {
	vi.clearAllMocks();
	mocks.pending.mockResolvedValue([intent.operationId]);
	mocks.claim.mockImplementation(async (input) => ({
		...input,
		scopeId: "agent-a",
		deliveryFence: 1n,
	}));
	mocks.renew.mockResolvedValue({});
	mocks.current.mockResolvedValue(true);
	mocks.complete.mockResolvedValue(true);
	mocks.beginAttempt.mockResolvedValue({
		outcome: "deliver",
		mode: "register",
		intent,
	});
});

it("uses no adapter by default and retries the original pending outbox", async () => {
	mocks.beginAttempt.mockResolvedValue({ outcome: "pending" });
	const worker = createConnectionConsumerRegistrationWorkerV1({
		databaseUrl: "unused",
		policy,
	});
	await worker.runOnce();
	expect(mocks.beginAttempt).toHaveBeenCalledWith(expect.anything(), false);
	expect(mocks.scheduleRetry).toHaveBeenCalledWith(
		expect.objectContaining({
			itemId: intent.operationId,
			deliveryFence: 1n,
			errorCode: "CONNECTION_REGISTRATION_PENDING",
		}),
	);
	expect(mocks.markFailed).not.toHaveBeenCalled();
	expect(mocks.markSucceeded).not.toHaveBeenCalled();
	await worker.close();
});

it("reconciles unknown operations without resending register", async () => {
	mocks.beginAttempt.mockResolvedValue({
		outcome: "deliver",
		mode: "reconcile",
		intent,
	});
	reconcile.mockResolvedValue({
		outcome: "unknown",
		failureCode: "RECEIPT_UNCONFIRMED",
	});
	const worker = createConnectionConsumerRegistrationWorkerV1({
		databaseUrl: "unused",
		policy,
		adapter: { register, reconcile },
	});
	await worker.runOnce();
	expect(register).not.toHaveBeenCalled();
	expect(reconcile).toHaveBeenCalledWith(intent, expect.any(AbortSignal));
	expect(mocks.complete).toHaveBeenCalledWith(expect.anything(), {
		outcome: "unknown",
		failureCode: "RECEIPT_UNCONFIRMED",
	});
	expect(mocks.markSucceeded).not.toHaveBeenCalled();
	await worker.close();
});

it("does not call the adapter after original authority or lease is lost", async () => {
	mocks.current.mockResolvedValue(false);
	const worker = createConnectionConsumerRegistrationWorkerV1({
		databaseUrl: "unused",
		policy,
		adapter: { register, reconcile },
	});
	await worker.runOnce();
	expect(register).not.toHaveBeenCalled();
	expect(reconcile).not.toHaveBeenCalled();
	expect(mocks.markSucceeded).not.toHaveBeenCalled();
	await worker.close();
});

it("records thrown or malformed results as unknown and never reports registered", async () => {
	register.mockResolvedValue({
		outcome: "registered",
		receipt: { consumerId: "unverified", serviceSecret: "forbidden" },
	});
	const worker = createConnectionConsumerRegistrationWorkerV1({
		databaseUrl: "unused",
		policy,
		adapter: { register, reconcile },
	});
	await worker.runOnce();
	expect(mocks.complete).toHaveBeenCalledWith(expect.anything(), {
		outcome: "unknown",
		failureCode: "CONNECTION_REGISTRATION_UNAVAILABLE",
	});
	expect(mocks.scheduleRetry).toHaveBeenCalledOnce();
	expect(mocks.markSucceeded).not.toHaveBeenCalled();
	await worker.close();
});

it("requires a persisted exact receipt before finishing only its registration outbox", async () => {
	register.mockResolvedValue({
		outcome: "registered",
		receipt: {
			schemaVersion: 1,
			operationId: intent.operationId,
			sourceNamespace: intent.sourceNamespace,
			sourceKey: intent.sourceKey,
			requestDigest: intent.requestDigest,
			consumerId: "actual-consumer",
			consumerRevision: "1",
			registrationId: "actual-registration",
		},
	});
	const worker = createConnectionConsumerRegistrationWorkerV1({
		databaseUrl: "unused",
		policy,
		adapter: { register, reconcile },
	});
	mocks.complete.mockResolvedValue(false);
	await worker.runOnce();
	expect(mocks.markSucceeded).not.toHaveBeenCalled();
	mocks.complete.mockResolvedValue(true);
	await worker.runOnce();
	expect(mocks.markSucceeded).toHaveBeenCalledWith(
		expect.objectContaining({ itemId: intent.operationId, deliveryFence: 1n }),
	);
	await worker.close();
});

it("bounds an unresponsive adapter by aborting the original attempt into unknown", async () => {
	register.mockImplementation(() => new Promise(() => {}));
	const worker = createConnectionConsumerRegistrationWorkerV1({
		databaseUrl: "unused",
		policy,
		adapter: { register, reconcile },
		timeoutMs: 10,
	});
	await worker.runOnce();
	expect(register.mock.calls[0]?.[1].aborted).toBe(true);
	expect(mocks.complete).toHaveBeenCalledWith(expect.anything(), {
		outcome: "unknown",
		failureCode: "CONNECTION_REGISTRATION_UNAVAILABLE",
	});
	expect(mocks.scheduleRetry).toHaveBeenCalledOnce();
	await worker.close();
});

it("stop aborts an in-flight adapter without blocking maintenance shutdown", async () => {
	register.mockImplementation(() => new Promise(() => {}));
	const worker = createConnectionConsumerRegistrationWorkerV1({
		databaseUrl: "unused",
		policy,
		adapter: { register, reconcile },
	});
	const run = worker.runOnce();
	await vi.waitFor(() => expect(register).toHaveBeenCalledOnce());
	worker.stop();
	await run;
	expect(register.mock.calls[0]?.[1].aborted).toBe(true);
	expect(mocks.markSucceeded).not.toHaveBeenCalled();
	await worker.close();
});
