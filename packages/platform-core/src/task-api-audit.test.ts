import { describe, expect, it, vi } from "vitest";
import {
	createTaskApiAuditV1,
	type TaskApiAuditRecordInputV1,
} from "./task-api-audit.js";

const input: TaskApiAuditRecordInputV1 = {
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
				audit.record(malformed as TaskApiAuditRecordInputV1),
			).rejects.toMatchObject({ code: "invalid_input" });
		expect(write).not.toHaveBeenCalled();
	});
});
