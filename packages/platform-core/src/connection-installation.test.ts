import { describe, expect, it } from "vitest";
import {
	type ConnectionInstallationCommandFactV1,
	type ConnectionInstallationCurrentV1,
	type ConnectionInstallationSavedV1,
	type ConnectionInstallationTransactionV1,
	createConnectionInstallationAuthorizationV1,
} from "./connection-installation.js";

function fixture() {
	let current: ConnectionInstallationCurrentV1 | null = {
		user: {
			schemaVersion: 1,
			userId: "alice",
			accountStatus: "active",
			organizationIds: ["eng"],
			authorizationRevision: "identity-r1",
		},
		agent: {
			schemaVersion: 1,
			agentId: "agent-a",
			applicationId: "application-a",
			applicantId: "owner",
			status: "available",
			revision: 1,
			approvalRevision: 1,
			decisionReason: null,
			serviceAvailability: "ready",
			desiredState: "running",
			workloadRevision: 1,
			fence: 1,
			ownerIds: ["owner"],
			availability: [{ kind: "user", userId: "alice" }],
			failureCode: null,
		},
		boundary: {
			schemaVersion: 1,
			principal: { kind: "user", id: "alice" },
			agentId: "agent-a",
			channelId: "web",
			identityRevision: "identity-r1",
			agentAuthorizationRevision: "agent-r1",
			accessSources: [{ kind: "user", userId: "alice" }],
		},
		agentAuthorizationRevision: "agent-r1",
		reference: {
			agentId: "agent-a",
			conversationId: "conversation-a",
			executionId: "execution-a",
			sessionGeneration: 1,
		},
		scope: {
			agentId: "agent-a",
			sandboxId: "sandbox-a",
			podUid: "pod-a",
			sessionGeneration: 1,
			configFingerprint: "a".repeat(64),
			source: { ref: "profile", revision: "r1" },
			oauthConfiguration: { ref: "oauth", revision: "r1" },
		},
	};
	let now = 1000;
	const records = new Map<string, ConnectionInstallationSavedV1>();
	const receipts = new Map<string, { digest: string; id: string }>();
	const commands: ConnectionInstallationCommandFactV1[] = [];
	let failAudit = false;
	const operations: ConnectionInstallationTransactionV1 = {
		hasUnresolvedSend: async (id) =>
			commands.some(
				(row) =>
					row.authorizationId === id &&
					["sending", "unknown"].includes(row.status),
			),
		commandAllowed: async (id, command) =>
			commands.some((value) => {
				const row = value as {
					authorizationId: string;
					command: string;
					status: string;
				};
				return (
					row.authorizationId === id &&
					row.command === command &&
					row.status === "pending"
				);
			}),
		current: async () => current,
		read: async (userId, id) =>
			records.get(id)?.authorization.principal.id === userId
				? records.get(id)!
				: null,
		now: async () => now,
		receipt: async (userId, key, command, digest) => {
			const row = receipts.get(`${userId}:${command}:${key}`);
			if (!row) return null;
			if (row.digest !== digest) throw Error("conflict");
			return records.get(row.id)!.authorization;
		},
		save: async (record) => {
			records.set(record.authorization.authorizationId, record);
		},
		command: async (command) => {
			commands.push(command);
		},
		completeReceipt: async (userId, key, command, digest, id) => {
			receipts.set(`${userId}:${command}:${key}`, { digest, id });
		},
		audit: async () => {
			if (failAudit) throw Error("private upstream error");
		},
	};
	const useCase = createConnectionInstallationAuthorizationV1({
		store: {
			transaction: async (work) => {
				const snapshot = structuredClone([...records]);
				const count = commands.length;
				try {
					return await work(operations);
				} catch (error) {
					records.clear();
					for (const [id, row] of snapshot) records.set(id, row);
					commands.length = count;
					throw error;
				}
			},
		},
	});
	const request = {
		userId: "alice",
		identityRevision: "identity-r1",
		requestId: "request-a",
		traceId: "trace-a",
		idempotencyKey: "key-a",
	};
	return {
		useCase,
		request,
		commands,
		records,
		get current() {
			return current;
		},
		set current(value) {
			current = value;
		},
		advance: () => {
			now = 700000;
		},
		failAudit: () => {
			failAudit = true;
		},
	};
}
describe("platform installation confirmation", () => {
	it.each(["sending", "unknown", "completed"] as const)(
		"does not enqueue a second confirm after %s, even with a fresh key",
		async (status) => {
			const f = fixture();
			const begun = await f.useCase.execute({
				...f.request,
				command: "begin",
				executionId: "execution-a",
			});
			const confirm = {
				...f.request,
				command: "confirm" as const,
				authorizationId: begun.authorizationId,
			};
			await f.useCase.execute(confirm);
			f.commands[1] = { ...f.commands[1]!, status };
			const retry = f.useCase.execute({
				...confirm,
				idempotencyKey: "fresh-key",
			});
			if (status === "completed")
				await expect(retry).resolves.toMatchObject({ status: "confirmed" });
			else await expect(retry).rejects.toMatchObject({ code: "conflict" });
			expect(f.commands).toHaveLength(2);
			expect(
				await f.useCase.authorize(
					{
						principal: begun.principal,
						reference: begun.reference,
						scope: begun.scope,
						authorizationId: begun.authorizationId,
						command: "confirm",
					},
					new AbortController().signal,
					async () => {},
				),
			).toBeNull();
			await expect(f.useCase.execute(confirm)).resolves.toMatchObject({
				status: "confirmed",
			});
		},
	);
	it("keeps confirmation explicit and immutable across an idempotent browser flow", async () => {
		const f = fixture();
		const begun = await f.useCase.execute({
			...f.request,
			command: "begin",
			executionId: "execution-a",
		});
		expect(begun.status).toBe("awaiting_confirmation");
		expect(
			await f.useCase.execute({
				...f.request,
				command: "begin",
				executionId: "execution-a",
			}),
		).toEqual(begun);
		const input = {
			principal: begun.principal,
			reference: begun.reference,
			scope: begun.scope,
			authorizationId: begun.authorizationId,
			command: "confirm" as const,
		};
		expect(
			await f.useCase.authorize(
				input,
				new AbortController().signal,
				async () => {},
			),
		).toBeNull();
		const confirmed = await f.useCase.execute({
			...f.request,
			command: "confirm",
			authorizationId: begun.authorizationId,
		});
		expect(confirmed.confirmationRevision).toBe(begun.confirmationRevision);
		expect(
			await f.useCase.authorize(
				input,
				new AbortController().signal,
				async () => {},
			),
		).toMatchObject({ revision: begun.confirmationRevision });
		expect(f.commands).toHaveLength(2);
	});
	it("denies a different user even when that user names an existing Execution", async () => {
		const f = fixture();
		await expect(
			f.useCase.execute({
				...f.request,
				userId: "bob",
				command: "begin",
				executionId: "execution-a",
			}),
		).rejects.toMatchObject({ code: "denied" });
		expect(f.records.size).toBe(0);
	});
	it("does not substitute Agent Owner authority for the original user", async () => {
		const f = fixture();
		await expect(
			f.useCase.execute({
				...f.request,
				userId: "owner",
				command: "begin",
				executionId: "execution-a",
			}),
		).rejects.toMatchObject({ code: "denied" });
	});
	it("rechecks expiry and access on replay", async () => {
		const f = fixture();
		await f.useCase.execute({
			...f.request,
			command: "begin",
			executionId: "execution-a",
		});
		f.advance();
		await expect(
			f.useCase.execute({
				...f.request,
				command: "begin",
				executionId: "execution-a",
			}),
		).rejects.toMatchObject({ code: "denied" });
	});
	it("rolls back confirmation and command facts when the audit cannot commit", async () => {
		const f = fixture();
		f.failAudit();
		await expect(
			f.useCase.execute({
				...f.request,
				command: "begin",
				executionId: "execution-a",
			}),
		).rejects.toMatchObject({ code: "unavailable" });
		expect(f.records.size).toBe(0);
		expect(f.commands).toHaveLength(0);
	});
	it("fails closed after finalCheck revokes the original confirmation", async () => {
		const f = fixture();
		const begun = await f.useCase.execute({
			...f.request,
			command: "begin",
			executionId: "execution-a",
		});
		const input = {
			principal: begun.principal,
			reference: begun.reference,
			scope: begun.scope,
			authorizationId: begun.authorizationId,
			command: "begin" as const,
		};
		expect(
			await f.useCase.authorize(
				input,
				new AbortController().signal,
				async () => {
					f.current = null;
				},
			),
		).toBeNull();
	});
	it("does not authorize another Agent, Pod, generation, config or application", async () => {
		const f = fixture();
		const begun = await f.useCase.execute({
			...f.request,
			command: "begin",
			executionId: "execution-a",
		});
		for (const scope of [
			{ ...begun.scope, agentId: "other" },
			{ ...begun.scope, podUid: "other" },
			{ ...begun.scope, sessionGeneration: 2 },
			{ ...begun.scope, configFingerprint: "b".repeat(64) },
		])
			expect(
				await f.useCase.authorize(
					{
						principal: begun.principal,
						reference: begun.reference,
						scope,
						authorizationId: begun.authorizationId,
						command: "begin",
					},
					new AbortController().signal,
					async () => {},
				),
			).toBeNull();
		expect(
			await f.useCase.authorize(
				{
					principal: { kind: "application", id: "alice" },
					reference: begun.reference,
					scope: begun.scope,
					authorizationId: begun.authorizationId,
					command: "begin",
				},
				new AbortController().signal,
				async () => {},
			),
		).toBeNull();
	});
});
