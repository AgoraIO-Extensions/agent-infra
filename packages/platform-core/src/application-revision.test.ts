import { describe, expect, it } from "vitest";
import {
	applicationRevisionActorContextV1,
	applicationRevisionAdmissionsV1,
	applicationRevisionCommandV1,
	applicationRevisionStateV1,
	applicationRevisionTransactionConformance,
} from "./application-revision.conformance.ts";
import {
	ApplicationRevisionError,
	type ApplicationRevisionTransactionPortV1,
	type ApplicationRevisionWritePlanV1,
	createApplicationRevisionUseCaseV1,
	snapshotApplicationRevisionWritePlanV1,
} from "./application-revision.ts";
import { FakeApplicationRevisionTransactionV1 } from "./fake-application-revision.ts";

function createUseCase(transaction: ApplicationRevisionTransactionPortV1) {
	return createApplicationRevisionUseCaseV1(
		{ transaction, ...applicationRevisionAdmissionsV1() },
		{ now: () => new Date("2026-09-02T04:00:00.000Z") },
	);
}

describe("Application revision transaction conformance", () => {
	applicationRevisionTransactionConformance(async (state) => {
		const transaction = new FakeApplicationRevisionTransactionV1(
			state ?? applicationRevisionStateV1,
		);
		return {
			transaction,
			snapshot: async () => transaction.snapshot(),
			failNextBefore: (point) => transaction.failNextBefore(point),
			advanceManagementRevision: () => transaction.advanceManagementRevision(),
			advanceConfigurationRevision: () =>
				transaction.advanceConfigurationRevision(),
			setAuthorizationRevision: (revision) =>
				transaction.setAuthorizationRevision(revision),
			close: async () => {},
		};
	});
});

describe("Application revision input and plan boundary", () => {
	it("rejects command and actor accessors without reading them", async () => {
		for (const target of ["command", "actor"] as const) {
			let getterReads = 0;
			let reads = 0;
			let commits = 0;
			const transaction: ApplicationRevisionTransactionPortV1 = {
				async read() {
					reads += 1;
					return { outcome: "unavailable" };
				},
				async commit() {
					commits += 1;
					throw new Error("must not commit");
				},
			};
			const command = { ...applicationRevisionCommandV1 };
			const actor = { ...applicationRevisionActorContextV1 };
			Object.defineProperty(
				target === "command" ? command : actor,
				"requestId",
				{
					enumerable: true,
					get() {
						getterReads += 1;
						return "sensitive-staged-request";
					},
				},
			);
			if (target === "actor") {
				Object.defineProperty(actor, "userId", {
					enumerable: true,
					get() {
						getterReads += 1;
						return "sensitive-staged-user";
					},
				});
			}
			await expect(
				createUseCase(transaction).revise(command, actor as never),
			).rejects.toMatchObject({ code: "invalid_command" });
			expect(getterReads).toBe(0);
			expect(reads).toBe(0);
			expect(commits).toBe(0);
		}
	});

	it("sanitizes Proxy input before the transaction Port", async () => {
		let trapCalls = 0;
		let reads = 0;
		const command = new Proxy(applicationRevisionCommandV1, {
			ownKeys() {
				trapCalls += 1;
				throw new Error("sensitive proxy trap");
			},
		});
		await expect(
			createUseCase({
				async read() {
					reads += 1;
					return { outcome: "unavailable" };
				},
				async commit() {
					throw new Error("must not commit");
				},
			}).revise(command, applicationRevisionActorContextV1),
		).rejects.toMatchObject({ code: "invalid_command" });
		expect(trapCalls).toBe(0);
		expect(reads).toBe(0);
	});

	it("rejects malicious Store state without calling admissions or commit", async () => {
		let getterReads = 0;
		let commits = 0;
		const state = {
			...applicationRevisionStateV1,
			application: Object.defineProperty(
				{ ...applicationRevisionStateV1.application },
				"agentId",
				{
					enumerable: true,
					get() {
						getterReads += 1;
						return "staged-agent";
					},
				},
			),
		};
		await expect(
			createUseCase({
				async read() {
					return { outcome: "ready", state } as never;
				},
				async commit() {
					commits += 1;
					throw new Error("must not commit");
				},
			}).revise(
				applicationRevisionCommandV1,
				applicationRevisionActorContextV1,
			),
		).rejects.toMatchObject({ code: "persistence_failed" });
		expect(getterReads).toBe(0);
		expect(commits).toBe(0);
	});

	it("rejects an empty pending edit without a commit", async () => {
		const transaction = new FakeApplicationRevisionTransactionV1(
			applicationRevisionStateV1,
		);
		await expect(
			createUseCase(transaction).revise(
				{
					...applicationRevisionCommandV1,
					name: applicationRevisionStateV1.application.name,
					description: applicationRevisionStateV1.application.description,
					environment: applicationRevisionStateV1.configuration.environment,
				},
				applicationRevisionActorContextV1,
			),
		).rejects.toMatchObject({ code: "no_change" });
		expect(transaction.snapshot().commitCount).toBe(0);
	});

	it("snapshots a write plan without invoking malicious accessors or Proxy traps", async () => {
		const transaction = new FakeApplicationRevisionTransactionV1(
			applicationRevisionStateV1,
		);
		await createUseCase(transaction).revise(
			applicationRevisionCommandV1,
			applicationRevisionActorContextV1,
		);
		const valid = transaction.snapshot().lastPlan;
		if (!valid) throw new Error("Expected a captured write plan");

		let getterReads = 0;
		const application = Object.defineProperty(
			{ ...valid.application },
			"name",
			{
				enumerable: true,
				get() {
					getterReads += 1;
					return "sensitive staged name";
				},
			},
		);
		expect(() =>
			snapshotApplicationRevisionWritePlanV1({ ...valid, application }),
		).toThrow(ApplicationRevisionError);
		expect(getterReads).toBe(0);

		let trapCalls = 0;
		const proxy = new Proxy(valid, {
			ownKeys() {
				trapCalls += 1;
				throw new Error("sensitive plan trap");
			},
		});
		expect(() =>
			snapshotApplicationRevisionWritePlanV1(
				proxy as ApplicationRevisionWritePlanV1,
			),
		).toThrow(ApplicationRevisionError);
		expect(trapCalls).toBe(0);
	});
});
