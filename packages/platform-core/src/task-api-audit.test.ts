import { describe, expect, it, vi } from "vitest";
import {
	createTaskApiAuditV1,
	type TaskApiAuditInputV1,
	taskApiSubscriptionEndAuditIdV1,
} from "./task-api-audit.js";

const input: TaskApiAuditInputV1 = {
	schemaVersion: 1,
	auditId: "audit_server",
	operation: "read",
	phase: "access",
	result: "succeeded",
	reason: "request_accepted",
	principal: { kind: "application", id: "application_trusted" },
	target: {
		kind: "execution",
		agentId: "agent_trusted",
		conversationId: "conversation_trusted",
		executionId: "execution_trusted",
	},
	requestId: "request",
	traceId: "trace",
};

describe("Task API persistent audit", () => {
	it("requires and awaits the writer with a detached finite plan", async () => {
		const write = vi.fn().mockResolvedValue(undefined);
		await createTaskApiAuditV1({
			write,
			renewSubscription: vi.fn().mockResolvedValue(undefined),
			recoverSubscriptions: vi.fn().mockResolvedValue(0),
		}).record(input);
		expect(write).toHaveBeenCalledOnce();
		expect(write.mock.calls[0]?.[0]).toMatchObject({
			...input,
			action: "task.api.access",
			occurredAt: expect.any(Date),
		});
		expect(write.mock.calls[0]?.[0].target).not.toBe(input.target);
		expect(() => createTaskApiAuditV1(undefined as never)).toThrow();
	});
	it("fails closed with a fixed error when persistence fails", async () => {
		const write = vi
			.fn()
			.mockRejectedValue(new Error("private database credential"));
		await expect(
			createTaskApiAuditV1({
				write,
				renewSubscription: vi.fn().mockResolvedValue(undefined),
				recoverSubscriptions: vi.fn().mockResolvedValue(0),
			}).record(input),
		).rejects.toMatchObject({
			code: "unavailable",
			message: "Task API audit persistence is unavailable",
		});
	});
	it("accepts unknown identity and target without request resource IDs", async () => {
		const write = vi.fn().mockResolvedValue(undefined);
		await createTaskApiAuditV1({
			write,
			renewSubscription: vi.fn().mockResolvedValue(undefined),
			recoverSubscriptions: vi.fn().mockResolvedValue(0),
		}).record({
			...input,
			result: "rejected",
			reason: "authentication_required",
			principal: { kind: "unknown" },
			target: { kind: "unknown" },
		});
		expect(write.mock.calls[0]?.[0].target).toEqual({ kind: "unknown" });
	});
	it("rejects dynamic reasons, private metadata, malformed identities and phase context", async () => {
		const write = vi.fn();
		const audit = createTaskApiAuditV1({
			write,
			renewSubscription: vi.fn().mockResolvedValue(undefined),
			recoverSubscriptions: vi.fn().mockResolvedValue(0),
		});
		for (const malformed of [
			{ ...input, reason: "private task body" },
			{ ...input, credential: "private credential" },
			{ ...input, body: "private body" },
			{ ...input, action: "custom.dynamic" },
			{ ...input, principal: { kind: "unknown", id: "caller_claimed" } },
			{ ...input, target: { kind: "unknown", executionId: "caller_claimed" } },
			{ ...input, principal: { kind: "system", id: "system" } },
			{ ...input, phase: "subscription.started" },
			{ ...input, principal: { kind: "unknown" } },
			{ ...input, target: { kind: "unknown" } },
			{ ...input, result: "rejected", principal: { kind: "unknown" } },
			{
				...input,
				operation: "subscribe",
				phase: "subscription.started",
				subscriptionId: "sub",
				result: "rejected",
			},
			{
				...input,
				operation: "subscribe",
				phase: "subscription.started",
				subscriptionId: "sub",
				reason: "stream_ended",
			},
			{
				...input,
				operation: "subscribe",
				phase: "subscription.ended",
				subscriptionId: "sub",
				target: { kind: "agent", agentId: "agent_trusted" },
			},
			{
				...input,
				operation: "subscribe",
				phase: "subscription.ended",
				subscriptionId: "sub",
				result: "rejected",
				principal: { kind: "unknown" },
				target: { kind: "unknown" },
			},
			{ ...input, subscriptionId: "wrong_operation" },
			{ ...input, occurredAt: new Date(Number.NaN) },
			{
				...input,
				principal: {
					get kind() {
						throw new Error("must not run");
					},
					id: "id",
				},
			},
		])
			await expect(
				audit.record(malformed as TaskApiAuditInputV1),
			).rejects.toMatchObject({ code: "invalid_input" });
		expect(write).not.toHaveBeenCalled();
	});
	it("keeps subscription identifiers and correlation across lifecycle records", async () => {
		const write = vi.fn().mockResolvedValue(undefined);
		const audit = createTaskApiAuditV1({
			write,
			renewSubscription: vi.fn().mockResolvedValue(undefined),
			recoverSubscriptions: vi.fn().mockResolvedValue(0),
		});
		for (const phase of [
			"subscription.started",
			"subscription.ended",
		] as const) {
			await audit.record({
				...input,
				auditId: phase,
				operation: "subscribe",
				phase,
				subscriptionId: "subscription_server",
				reason:
					phase === "subscription.started"
						? "request_accepted"
						: "client_disconnected",
			});
		}
		expect(
			write.mock.calls.map(([plan]) => [
				plan.subscriptionId,
				plan.requestId,
				plan.traceId,
			]),
		).toEqual([
			["subscription_server", "request", "trace"],
			["subscription_server", "request", "trace"],
		]);
	});
});

describe("Task API subscription audit recovery boundary", () => {
	it("uses the same end event ID regardless of a fresh audit ID", async () => {
		const write = vi.fn().mockResolvedValue(undefined);
		const audit = createTaskApiAuditV1({
			write,
			renewSubscription: vi.fn(),
			recoverSubscriptions: vi.fn(),
		});
		for (const auditId of ["random_first", "random_second"])
			await audit.record({
				...input,
				auditId,
				operation: "subscribe",
				phase: "subscription.ended",
				subscriptionId: "subscription_server",
				reason: "client_disconnected",
			});
		expect(write.mock.calls.map(([plan]) => plan.auditId)).toEqual([
			taskApiSubscriptionEndAuditIdV1("subscription_server"),
			taskApiSubscriptionEndAuditIdV1("subscription_server"),
		]);
	});
	it("requires and awaits lease renewal and recovery", async () => {
		expect(() => createTaskApiAuditV1({ write: vi.fn() } as never)).toThrow();
		const renewSubscription = vi.fn().mockResolvedValue(undefined);
		const recoverSubscriptions = vi.fn().mockResolvedValue(2);
		const audit = createTaskApiAuditV1({
			write: vi.fn(),
			renewSubscription,
			recoverSubscriptions,
		});
		await audit.renewSubscription("subscription_server");
		expect(renewSubscription).toHaveBeenCalledWith("subscription_server");
		expect(await audit.recoverSubscriptions()).toBe(2);
		await expect(audit.renewSubscription("")).rejects.toMatchObject({
			code: "invalid_input",
		});
		renewSubscription.mockRejectedValueOnce(new Error("private lease error"));
		await expect(
			audit.renewSubscription("subscription_server"),
		).rejects.toMatchObject({
			code: "unavailable",
			message: "Task API audit persistence is unavailable",
		});
		recoverSubscriptions.mockRejectedValueOnce(
			new Error("private recovery error"),
		);
		await expect(audit.recoverSubscriptions()).rejects.toMatchObject({
			code: "unavailable",
			message: "Task API audit persistence is unavailable",
		});
		for (const count of [-1, Number.NaN, 1.5]) {
			recoverSubscriptions.mockResolvedValueOnce(count);
			await expect(audit.recoverSubscriptions()).rejects.toMatchObject({
				code: "unavailable",
			});
		}
	});
	it("allows an unconfirmed end only as a failed subscription end", async () => {
		const write = vi.fn().mockResolvedValue(undefined);
		const audit = createTaskApiAuditV1({
			write,
			renewSubscription: vi.fn(),
			recoverSubscriptions: vi.fn(),
		});
		const unconfirmed = {
			...input,
			operation: "subscribe",
			phase: "subscription.ended",
			result: "failed",
			reason: "subscription_unconfirmed",
			subscriptionId: "subscription_server",
		} as const;
		await audit.record(unconfirmed);
		for (const malformed of [
			{ ...unconfirmed, phase: "access" },
			{ ...unconfirmed, result: "succeeded" },
		])
			await expect(
				audit.record(malformed as TaskApiAuditInputV1),
			).rejects.toMatchObject({ code: "invalid_input" });
		expect(write).toHaveBeenCalledOnce();
	});
});
