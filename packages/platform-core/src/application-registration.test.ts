import { describe, expect, it, vi } from "vitest";
import { createApplicationRegistrationUseCaseV1 } from "./application-registration.js";
import type { ApplicationRegistrationTransactionV1 } from "./application-registration-contract.js";

const request = { userId: "alice", requestId: "request_1", traceId: "trace_1" };
const metadata = {
	applicationId: "app_1",
	name: "Service",
	responsibleUserId: "alice",
	status: "active" as const,
	authorizationRevision: "app_revision",
	createdAt: "2030-01-01T00:00:00.000Z",
	updatedAt: "2030-01-01T00:00:00.000Z",
};
const user = {
	schemaVersion: 1 as const,
	userId: "alice",
	accountStatus: "active" as const,
	organizationIds: [],
	authorizationRevision: "user_revision",
};
function setup() {
	const resolveUser = vi.fn(async (_id: string): Promise<unknown> => user);
	const transaction = {
		lockUserDisabled: vi.fn(async () => false),
		lockIdempotency: vi.fn<
			ApplicationRegistrationTransactionV1["lockIdempotency"]
		>(async () => null),
		readOwn: vi.fn(async () => metadata),
		insert: vi.fn<ApplicationRegistrationTransactionV1["insert"]>(
			async (input) => ({ ...metadata, ...input }),
		),
		completeIdempotency: vi.fn(async () => {}),
		recordAudit: vi.fn(async () => {}),
	};
	const store = {
		execute: async <T>(
			work: (tx: ApplicationRegistrationTransactionV1) => Promise<T>,
		) => work(transaction),
		recordAudit: vi.fn(async () => {}),
	};
	return {
		useCase: createApplicationRegistrationUseCaseV1({
			store,
			userDirectory: { resolveUser },
		}),
		transaction,
		resolveUser,
		store,
	};
}
describe("application self-registration Core boundary", () => {
	it("snapshots name and server actor before dependency awaits", async () => {
		const { useCase, transaction } = setup();
		const context = { ...request };
		const command = { name: "Service" };
		transaction.lockUserDisabled.mockImplementation(async () => {
			context.userId = "bob";
			command.name = "Changed";
			return false;
		});
		const result = await useCase.register(context, "key_1", command);
		expect(result.metadata).toMatchObject({
			name: "Service",
			responsibleUserId: "alice",
			status: "active",
		});
		expect(transaction.insert).toHaveBeenCalledWith(
			expect.objectContaining({ responsibleUserId: "alice", name: "Service" }),
		);
		expect(transaction.completeIdempotency).toHaveBeenCalledWith(
			request,
			"key_1",
			expect.stringMatching(/^[a-f0-9]{64}$/),
			result.metadata,
		);
	});
	it.each([
		null,
		{ name: " " },
		{ name: "a\0b" },
		{ name: "\ud800" },
		{ name: "a".repeat(201) },
		{ name: "Service", userId: "bob" },
		{
			get name() {
				throw new Error("private input");
			},
		},
	])(
		"rejects malformed or delegated commands without writing",
		async (command) => {
			const { useCase, transaction, store } = setup();
			await expect(
				useCase.register(request, "key_1", command),
			).rejects.toMatchObject({ code: "invalid_input" });
			expect(transaction.insert).not.toHaveBeenCalled();
			expect(store.recordAudit).toHaveBeenCalledWith(
				expect.objectContaining({ userId: "alice", outcome: "rejected" }),
			);
		},
	);
	it("rechecks current identity after the final registration audit await", async () => {
		const { useCase, transaction, resolveUser } = setup();
		transaction.recordAudit.mockImplementation(async () => {
			resolveUser.mockResolvedValue({
				...user,
				authorizationRevision: "changed",
			});
		});
		await expect(
			useCase.register(request, "key_1", { name: "Service" }),
		).rejects.toMatchObject({ code: "unavailable" });
		expect(resolveUser).toHaveBeenCalledTimes(2);
	});

	it("does not interpret an application ID as a natural person", async () => {
		const { useCase, transaction, resolveUser } = setup();
		resolveUser.mockResolvedValue({ ...user, principalType: "application" });
		await expect(
			useCase.register(request, "key_1", { name: "Service" }),
		).rejects.toMatchObject({
			code: "unavailable",
		});
		expect(transaction.readOwn).not.toHaveBeenCalled();
	});
	it("normalizes secret dependency faults and keeps audit refusal fail closed", async () => {
		const { useCase, transaction, store } = setup();
		transaction.insert.mockRejectedValue(new Error("PRIVATE_SQL_SENTINEL"));
		store.recordAudit.mockRejectedValue(new Error("PRIVATE_AUDIT_SENTINEL"));
		await expect(
			useCase.register(request, "key_1", { name: "Service" }),
		).rejects.toMatchObject({
			code: "unavailable",
			message: "Application governance operation failed",
		});
	});
});
