import { expect, it } from "vitest";

import {
	ApplicationFoundationError,
	type ApplicationFoundationTransactionPortV1,
	type CommitApplicationFoundationCommandV1,
	createApplicationFoundationUseCaseV1,
} from "./application-foundation.ts";
import type { ApplicationFoundationSnapshot } from "./fake-application-foundation.ts";

export const applicationFoundationFailurePoints = [
	"agent",
	"application",
	"configuration_revision",
	"owner",
	"outbox",
	"audit",
	"commit",
] as const;

export type ApplicationFoundationFailurePoint =
	(typeof applicationFoundationFailurePoints)[number];

export interface ApplicationFoundationConformanceHarness {
	transaction: ApplicationFoundationTransactionPortV1;
	failNextBefore(
		point: ApplicationFoundationFailurePoint,
	): Promise<void> | void;
	snapshot(): Promise<ApplicationFoundationSnapshot>;
	close(): Promise<void>;
}

const command: CommitApplicationFoundationCommandV1 = Object.freeze({
	schemaVersion: 1,
	applicationId: "application opaque alpha",
	agentId: "agent opaque alpha",
	requestId: "request opaque alpha",
	name: "Operations Assistant",
	description: "Assists with operational workflows",
	sourceReference: "template opaque alpha",
	traceId: "trace opaque alpha",
});
const serverInstant = new Date("2026-08-30T12:00:00.000Z");
const fixedNow = () => new Date(serverInstant.valueOf());
const actorContext = Object.freeze({
	schemaVersion: 1 as const,
	userId: "user opaque alpha",
});
const supplementaryNameCharacter = "\u{1f600}";
const commandTextFields = [
	"applicationId",
	"agentId",
	"requestId",
	"name",
	"description",
	"sourceReference",
	"traceId",
] as const;

const emptySnapshot: ApplicationFoundationSnapshot = {
	agents: [],
	applications: [],
	configurationRevisions: [],
	owners: [],
	outboxIntents: [],
	auditEvents: [],
};

function createUseCase(transaction: ApplicationFoundationTransactionPortV1) {
	return createApplicationFoundationUseCaseV1(transaction, { now: fixedNow });
}

export function applicationFoundationTransactionConformance(
	createHarness: () => Promise<ApplicationFoundationConformanceHarness>,
): void {
	it("rejects invalid commands without crossing the transaction seam", async () => {
		const harness = await createHarness();
		const useCase = createUseCase(harness.transaction);
		try {
			for (const invalid of [
				{ schemaVersion: 1 },
				{ ...command, applicationId: "" },
				{ ...command, requestId: "" },
				{ ...command, name: "n".repeat(201) },
				{ ...command, name: supplementaryNameCharacter.repeat(201) },
				{ ...command, applicantId: "caller forged user" },
				{
					...command,
					submittedAt: new Date("2099-01-01T00:00:00.000Z"),
				},
			]) {
				await expect(
					useCase.submit(
						invalid as CommitApplicationFoundationCommandV1,
						actorContext,
					),
				).rejects.toMatchObject({
					name: "ApplicationFoundationError",
					code: "invalid_command",
				});
			}
			await expect(harness.snapshot()).resolves.toEqual(emptySnapshot);
		} finally {
			await harness.close();
		}
	});

	it("rejects invalid actor context before persistence", async () => {
		const harness = await createHarness();
		const useCase = createUseCase(harness.transaction);
		try {
			for (const invalid of [
				{ schemaVersion: 1 },
				{ schemaVersion: 1, userId: "" },
				{ schemaVersion: 2, userId: actorContext.userId },
				{ ...actorContext, applicantId: "caller forged user" },
				Object.defineProperty({ schemaVersion: 1 }, "userId", {
					enumerable: true,
					get() {
						throw new ApplicationFoundationError("conflict");
					},
				}),
			]) {
				await expect(
					useCase.submit(command, invalid as never),
				).rejects.toMatchObject({
					name: "ApplicationFoundationError",
					code: "invalid_command",
				});
			}
			await expect(harness.snapshot()).resolves.toEqual(emptySnapshot);
		} finally {
			await harness.close();
		}
	});

	it("rejects embedded NUL in every captured text value", async () => {
		const harness = await createHarness();
		const useCase = createUseCase(harness.transaction);
		try {
			for (const field of commandTextFields) {
				await expect(
					useCase.submit(
						{ ...command, [field]: `${command[field]}\0forged` },
						actorContext,
					),
				).rejects.toMatchObject({
					name: "ApplicationFoundationError",
					code: "invalid_command",
				});
			}
			await expect(
				useCase.submit(command, {
					...actorContext,
					userId: `${actorContext.userId}\0forged`,
				}),
			).rejects.toMatchObject({
				name: "ApplicationFoundationError",
				code: "invalid_command",
			});
			await expect(harness.snapshot()).resolves.toEqual(emptySnapshot);
		} finally {
			await harness.close();
		}
	});

	it("accepts ordinary Unicode in every captured text value", async () => {
		const harness = await createHarness();
		const useCase = createUseCase(harness.transaction);
		const unicodeCommand: CommitApplicationFoundationCommandV1 = {
			...command,
			applicationId: "application-\u5e94\u7528-\u{1f600}",
			agentId: "agent-\u667a\u80fd-\u{1f680}",
			requestId: "request-\u8bf7\u6c42-\u03b1",
			name: "\u8fd0\u7ef4\u52a9\u624b \u{1f642}",
			description:
				"\u5904\u7406\u53ef\u89c2\u6d4b\u7684\u8fd0\u7ef4\u6d41\u7a0b",
			sourceReference: "template-\u6a21\u677f-\u03b2",
			traceId: "trace-\u8ffd\u8e2a-\u03b3",
		};
		const unicodeActor = {
			...actorContext,
			userId: "user-\u7528\u6237-\u{1f9d1}",
		};
		try {
			await expect(
				useCase.submit(unicodeCommand, unicodeActor),
			).resolves.toMatchObject({
				applicationId: unicodeCommand.applicationId,
				agentId: unicodeCommand.agentId,
			});
			await expect(harness.snapshot()).resolves.toMatchObject({
				applications: [
					{
						applicantId: unicodeActor.userId,
						name: unicodeCommand.name,
						description: unicodeCommand.description,
					},
				],
			});
		} finally {
			await harness.close();
		}
	});

	it("counts supplementary Unicode code points as one name character", async () => {
		const harness = await createHarness();
		const useCase = createUseCase(harness.transaction);
		const name = supplementaryNameCharacter.repeat(101);
		try {
			await expect(
				useCase.submit({ ...command, name }, actorContext),
			).resolves.toMatchObject({
				applicationId: command.applicationId,
				agentId: command.agentId,
			});
			await expect(harness.snapshot()).resolves.toMatchObject({
				applications: [{ name }],
			});
		} finally {
			await harness.close();
		}
	});

	it("atomically starts an opaque Agent at monotonic revision one with sanitized correlations", async () => {
		const harness = await createHarness();
		const useCase = createUseCase(harness.transaction);
		try {
			await expect(useCase.submit(command, actorContext)).resolves.toEqual({
				schemaVersion: 1,
				applicationId: command.applicationId,
				agentId: command.agentId,
				configurationRevision: 1,
				status: "pending_approval",
			});
			await expect(harness.snapshot()).resolves.toEqual({
				agents: [
					{
						agentId: command.agentId,
						currentConfigurationRevision: 1,
						createdAt: serverInstant,
					},
				],
				applications: [
					{
						applicationId: command.applicationId,
						agentId: command.agentId,
						applicantId: actorContext.userId,
						name: command.name,
						description: command.description,
						status: "pending_approval",
						traceId: command.traceId,
						requestId: command.requestId,
						submittedAt: serverInstant,
					},
				],
				configurationRevisions: [
					{
						agentId: command.agentId,
						revision: 1,
						sourceReference: command.sourceReference,
						createdAt: serverInstant,
					},
				],
				owners: [
					{
						agentId: command.agentId,
						ownerId: actorContext.userId,
						createdAt: serverInstant,
					},
				],
				outboxIntents: [
					{
						scopeType: "agent",
						scopeId: command.agentId,
						operation: "agent.application.submitted.v1",
						payload: {
							schemaVersion: 1,
							applicationId: command.applicationId,
							agentId: command.agentId,
							configurationRevision: 1,
						},
						traceId: command.traceId,
						requestId: command.requestId,
						availableAt: serverInstant,
					},
				],
				auditEvents: [
					{
						traceId: command.traceId,
						requestId: command.requestId,
						agentId: command.agentId,
						actorType: "user",
						actorId: actorContext.userId,
						action: "agent.application.submitted",
						targetType: "agent_application",
						targetId: command.applicationId,
						outcome: "succeeded",
						occurredAt: serverInstant,
					},
				],
			});
		} finally {
			await harness.close();
		}
	});

	it("maps duplicate opaque IDs to a domain conflict", async () => {
		const harness = await createHarness();
		const useCase = createUseCase(harness.transaction);
		try {
			await useCase.submit(command, actorContext);
			await expect(useCase.submit(command, actorContext)).rejects.toMatchObject(
				{
					name: "ApplicationFoundationError",
					code: "conflict",
				},
			);
		} finally {
			await harness.close();
		}
	});

	for (const point of applicationFoundationFailurePoints) {
		it(`rolls back every write when ${point} fails`, async () => {
			const harness = await createHarness();
			const useCase = createUseCase(harness.transaction);
			try {
				await harness.failNextBefore(point);
				const error = await useCase.submit(command, actorContext).then(
					() => expect.fail("Expected foundation persistence to fail"),
					(reason: unknown) => reason,
				);
				expect(error).toMatchObject({
					name: "ApplicationFoundationError",
					code: "persistence_failed",
					message: "Application foundation persistence failed",
				});
				expect(error).not.toHaveProperty("cause");
				expect(String(error).toLowerCase()).not.toContain("injected");
				await expect(harness.snapshot()).resolves.toEqual(emptySnapshot);
				await expect(
					useCase.submit(command, actorContext),
				).resolves.toMatchObject({
					applicationId: command.applicationId,
					agentId: command.agentId,
					configurationRevision: 1,
				});
			} finally {
				await harness.close();
			}
		});
	}
}
