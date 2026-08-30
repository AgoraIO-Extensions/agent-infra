import { expect, it } from "vitest";

import type {
	ApplicationFoundationTransactionV1,
	CommitApplicationFoundationCommandV1,
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
	transaction: ApplicationFoundationTransactionV1;
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
	name: "Operations Assistant",
	description: "Assists with operational workflows",
	sourceReference: "template opaque alpha",
	traceId: "trace opaque alpha",
	submittedAt: new Date("2026-08-30T12:00:00.000Z"),
};

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
		try {
			for (const invalid of [
				{ schemaVersion: 1 },
				{ ...command, applicationId: "" },
				{ ...command, name: "n".repeat(201) },
			]) {
				await expect(
					harness.transaction.commit(
						invalid as CommitApplicationFoundationCommandV1,
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

	it("atomically starts an opaque Agent at monotonic revision one with sanitized correlations", async () => {
		const harness = await createHarness();
		try {
			await expect(harness.transaction.commit(command)).resolves.toEqual({
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
					},
				],
				auditEvents: [
					{
						traceId: command.traceId,
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
		try {
			await harness.transaction.commit(command);
			await expect(harness.transaction.commit(command)).rejects.toMatchObject({
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
			try {
				await harness.failNextBefore(point);
				await expect(harness.transaction.commit(command)).rejects.toMatchObject(
					{
						name: "ApplicationFoundationError",
						code: "persistence_failed",
					},
				);
				await expect(harness.snapshot()).resolves.toEqual(emptySnapshot);
				await expect(
					harness.transaction.commit(command),
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
