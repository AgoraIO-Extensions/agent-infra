import { describe, expect, it } from "vitest";

import { applicationFoundationTransactionConformance } from "./application-foundation.conformance.ts";
import {
	type ApplicationFoundationWritePlanV1,
	createApplicationFoundationUseCaseV1,
} from "./application-foundation.ts";
import { FakeApplicationFoundationTransactionV1 } from "./fake-application-foundation.ts";

describe("Application foundation use case", () => {
	it("copies the submitted instant before awaiting persistence", async () => {
		const originalInstant = "2026-08-30T12:00:00.000Z";
		const submittedAt = new Date(originalInstant);
		const observedPlans: ApplicationFoundationWritePlanV1[] = [];
		let releasePersistence = () => {};
		const persistenceDelay = new Promise<void>((resolve) => {
			releasePersistence = resolve;
		});
		const useCase = createApplicationFoundationUseCaseV1({
			async commit(plan) {
				await persistenceDelay;
				observedPlans.push(plan);
			},
		});

		const result = useCase.submit({
			schemaVersion: 1,
			applicationId: "application date copy",
			agentId: "agent date copy",
			applicantId: "user date copy",
			requestId: "request date copy",
			name: "Date Copy Agent",
			description: "Verifies timestamp ownership",
			sourceReference: "source date copy",
			traceId: "trace date copy",
			submittedAt,
		});
		submittedAt.setTime(new Date("2030-01-01T00:00:00.000Z").valueOf());
		releasePersistence();

		await expect(result).resolves.toMatchObject({
			applicationId: "application date copy",
			agentId: "agent date copy",
		});
		const plan = observedPlans[0];
		if (!plan) throw new Error("Persistence did not observe the write plan");
		for (const timestamp of [
			plan.agent.createdAt,
			plan.application.submittedAt,
			plan.configurationRevision.createdAt,
			plan.owner.createdAt,
			plan.outboxIntent.occurredAt,
			plan.auditEvent.occurredAt,
		]) {
			expect(timestamp.toISOString()).toBe(originalInstant);
		}
	});
});

describe("Fake application foundation transaction", () => {
	applicationFoundationTransactionConformance(async () => {
		const transaction = new FakeApplicationFoundationTransactionV1();
		return {
			transaction,
			failNextBefore: (point) => transaction.failNextBefore(point),
			snapshot: () => Promise.resolve(transaction.snapshot()),
			close: () => Promise.resolve(),
		};
	});
});
