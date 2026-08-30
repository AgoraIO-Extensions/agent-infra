import { expect, it } from "vitest";

import {
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

const command: CommitApplicationFoundationCommandV1 = {
	schemaVersion: 1,
	applicationId: "application opaque alpha",
	agentId: "agent opaque alpha",
	applicantId: "user opaque alpha",
	requestId: "request opaque alpha",
	name: "Operations Assistant",
	description: "Assists with operational workflows",
	sourceReference: "template opaque alpha",
	traceId: "trace opaque alpha",
	submittedAt: new Date("2026-08-30T12:00:00.000Z"),
};
const supplementaryNameCharacter = "\u{1f600}";

const emptySnapshot: ApplicationFoundationSnapshot = {
	agents: [],
	applications: [],
	configurationRevisions: [],
	owners: [],
	outboxIntents: [],
	auditEvents: [],
};

export function applicationFoundationTransactionConformance(
	createHarness: () => Promise<ApplicationFoundationConformanceHarness>,
): void {
	it("rejects invalid commands without crossing the transaction seam", async () => {
		const harness = await createHarness();
		const useCase = createApplicationFoundationUseCaseV1(harness.transaction);
		try {
			for (const invalid of [
				{ schemaVersion: 1 },
				{ ...command, applicationId: "" },
				{ ...command, requestId: "" },
				{ ...command, name: "n".repeat(201) },
				{ ...command, name: supplementaryNameCharacter.repeat(201) },
			]) {
				await expect(
					useCase.submit(invalid as CommitApplicationFoundationCommandV1),
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

	it("counts supplementary Unicode code points as one name character", async () => {
		const harness = await createHarness();
		const useCase = createApplicationFoundationUseCaseV1(harness.transaction);
		const name = supplementaryNameCharacter.repeat(101);
		try {
			await expect(useCase.submit({ ...command, name })).resolves.toMatchObject(
				{
					applicationId: command.applicationId,
					agentId: command.agentId,
				},
			);
			await expect(harness.snapshot()).resolves.toMatchObject({
				applications: [{ name }],
			});
		} finally {
			await harness.close();
		}
	});

	it("atomically starts an opaque Agent at monotonic revision one with sanitized correlations", async () => {
		const harness = await createHarness();
		const useCase = createApplicationFoundationUseCaseV1(harness.transaction);
		try {
			await expect(useCase.submit(command)).resolves.toEqual({
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
					},
				],
				applications: [
					{
						applicationId: command.applicationId,
						agentId: command.agentId,
						applicantId: command.applicantId,
						name: command.name,
						description: command.description,
						status: "pending_approval",
						traceId: command.traceId,
						requestId: command.requestId,
					},
				],
				configurationRevisions: [
					{
						agentId: command.agentId,
						revision: 1,
						sourceReference: command.sourceReference,
					},
				],
				owners: [{ agentId: command.agentId, ownerId: command.applicantId }],
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
					},
				],
				auditEvents: [
					{
						traceId: command.traceId,
						requestId: command.requestId,
						agentId: command.agentId,
						actorType: "user",
						actorId: command.applicantId,
						action: "agent.application.submitted",
						targetType: "agent_application",
						targetId: command.applicationId,
						outcome: "succeeded",
					},
				],
			});
		} finally {
			await harness.close();
		}
	});

	it("maps duplicate opaque IDs to a domain conflict", async () => {
		const harness = await createHarness();
		const useCase = createApplicationFoundationUseCaseV1(harness.transaction);
		try {
			await useCase.submit(command);
			await expect(useCase.submit(command)).rejects.toMatchObject({
				name: "ApplicationFoundationError",
				code: "conflict",
			});
		} finally {
			await harness.close();
		}
	});

	for (const point of applicationFoundationFailurePoints) {
		it(`rolls back every write when ${point} fails`, async () => {
			const harness = await createHarness();
			const useCase = createApplicationFoundationUseCaseV1(harness.transaction);
			try {
				await harness.failNextBefore(point);
				await expect(useCase.submit(command)).rejects.toMatchObject({
					name: "ApplicationFoundationError",
					code: "persistence_failed",
				});
				await expect(harness.snapshot()).resolves.toEqual(emptySnapshot);
				await expect(useCase.submit(command)).resolves.toMatchObject({
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
