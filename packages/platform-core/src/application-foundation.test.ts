import { describe, expect, it } from "vitest";

import {
	applicationFoundationActorContextV1,
	applicationFoundationAdmissionDependenciesV1,
	applicationFoundationCommandV1,
	applicationFoundationTransactionConformance,
} from "./application-foundation.conformance.ts";
import {
	ApplicationFoundationError,
	type ApplicationFoundationTransactionPortV1,
	type ApplicationFoundationWritePlanV1,
	createApplicationFoundationUseCaseV1,
} from "./application-foundation.ts";
import { FakeApplicationFoundationTransactionV1 } from "./fake-application-foundation.ts";

const serverInstant = "2026-08-30T12:00:00.000Z";
const errorBrand = Symbol.for(
	"@agent-infra/platform-core/ApplicationFoundationErrorV1",
);

function readyTransaction(
	transaction: Pick<ApplicationFoundationTransactionPortV1, "commit">,
): ApplicationFoundationTransactionPortV1 {
	return {
		async read() {
			return { outcome: "ready" };
		},
		commit: (plan) => transaction.commit(plan),
	};
}

function createUseCase(
	transaction: Pick<ApplicationFoundationTransactionPortV1, "commit">,
) {
	return createApplicationFoundationUseCaseV1(
		{
			transaction: readyTransaction(transaction),
			...applicationFoundationAdmissionDependenciesV1(),
		},
		{ now: () => new Date(serverInstant) },
	);
}

function immutableBrandedError(
	message: string,
	code = "conflict",
	name = "ApplicationFoundationError",
): Error & { code: string } {
	const error = Object.assign(new Error(message), { name, code });
	Object.defineProperty(error, errorBrand, { value: true });
	return error;
}

async function rejectedBeforePersistence(
	command: unknown,
	context: unknown,
): Promise<{ error: unknown; clockCalls: number; commitCalls: number }> {
	let clockCalls = 0;
	let commitCalls = 0;
	const useCase = createApplicationFoundationUseCaseV1(
		{
			...applicationFoundationAdmissionDependenciesV1(),
			transaction: readyTransaction({
				async commit(plan) {
					commitCalls += 1;
					return { outcome: "committed", result: plan.result };
				},
			}),
		},
		{
			now: () => {
				clockCalls += 1;
				return new Date(serverInstant);
			},
		},
	);
	const error = await useCase.submit(command as never, context as never).then(
		() => expect.fail("Expected rejection before persistence"),
		(reason: unknown) => reason,
	);
	return { error, clockCalls, commitCalls };
}

describe("Application foundation use case", () => {
	it("rejects a staged actor getter without reading it", async () => {
		let getterReads = 0;
		const context = Object.defineProperty(
			{ ...applicationFoundationActorContextV1 },
			"userId",
			{
				enumerable: true,
				get() {
					getterReads += 1;
					return `staged-user-${getterReads}`;
				},
			},
		);
		const { error, commitCalls } = await rejectedBeforePersistence(
			applicationFoundationCommandV1,
			context,
		);
		expect(error).toMatchObject({ code: "invalid_command" });
		expect(getterReads).toBe(0);
		expect(commitCalls).toBe(0);
	});

	it("rejects staged command correlation getters without reading them", async () => {
		let getterReads = 0;
		const command = { ...applicationFoundationCommandV1 };
		for (const field of ["requestId", "traceId"] as const) {
			Object.defineProperty(command, field, {
				enumerable: true,
				get() {
					getterReads += 1;
					return `${field}-${getterReads}`;
				},
			});
		}
		const { error, commitCalls } = await rejectedBeforePersistence(
			command,
			applicationFoundationActorContextV1,
		);
		expect(error).toMatchObject({ code: "invalid_command" });
		expect(getterReads).toBe(0);
		expect(commitCalls).toBe(0);
	});

	it("does not reread an accessor after validation", async () => {
		let getterReads = 0;
		const command = { ...applicationFoundationCommandV1 };
		Object.defineProperty(command, "requestId", {
			enumerable: true,
			get() {
				getterReads += 1;
				if (getterReads <= 2) return "request before persistence";
				throw new Error("sensitive post-validation failure");
			},
		});
		const { error, commitCalls } = await rejectedBeforePersistence(
			command,
			applicationFoundationActorContextV1,
		);
		expect(error).toMatchObject({ code: "invalid_command" });
		expect(String(error)).not.toContain("sensitive");
		expect(getterReads).toBe(0);
		expect(commitCalls).toBe(0);
	});

	it("rejects a staged availability getter without reading it", async () => {
		let getterReads = 0;
		const availability = [
			Object.defineProperty({ userId: "staged availability user" }, "kind", {
				enumerable: true,
				get() {
					getterReads += 1;
					return "user";
				},
			}),
		];
		const { error, commitCalls } = await rejectedBeforePersistence(
			{ ...applicationFoundationCommandV1, availability },
			applicationFoundationActorContextV1,
		);
		expect(error).toMatchObject({ code: "invalid_command" });
		expect(getterReads).toBe(0);
		expect(commitCalls).toBe(0);
	});

	it.each([
		[
			"command ownKeys",
			new Proxy(applicationFoundationCommandV1, {
				ownKeys() {
					throw new Error("sensitive command ownKeys trap");
				},
			}),
			applicationFoundationActorContextV1,
		],
		[
			"command descriptor",
			new Proxy(applicationFoundationCommandV1, {
				getOwnPropertyDescriptor() {
					throw new Error("sensitive command descriptor trap");
				},
			}),
			applicationFoundationActorContextV1,
		],
		[
			"context ownKeys",
			applicationFoundationCommandV1,
			new Proxy(applicationFoundationActorContextV1, {
				ownKeys() {
					throw new Error("sensitive context ownKeys trap");
				},
			}),
		],
		[
			"context descriptor",
			applicationFoundationCommandV1,
			new Proxy(applicationFoundationActorContextV1, {
				getOwnPropertyDescriptor() {
					throw new Error("sensitive context descriptor trap");
				},
			}),
		],
	])("sanitizes a %s before the Port", async (_name, command, context) => {
		const { error, clockCalls, commitCalls } = await rejectedBeforePersistence(
			command,
			context,
		);
		expect(error).toMatchObject({ code: "invalid_command" });
		expect(String(error)).not.toContain("sensitive");
		expect(clockCalls).toBe(0);
		expect(commitCalls).toBe(0);
	});

	it("rejects caller-supplied time before reading the server clock", async () => {
		const { error, clockCalls, commitCalls } = await rejectedBeforePersistence(
			{ ...applicationFoundationCommandV1, submittedAt: new Date() },
			applicationFoundationActorContextV1,
		);
		expect(error).toMatchObject({ code: "invalid_command" });
		expect(clockCalls).toBe(0);
		expect(commitCalls).toBe(0);
	});

	it("accepts ordinary frozen command and actor objects", async () => {
		let commits = 0;
		const useCase = createUseCase({
			async commit(plan) {
				commits += 1;
				return { outcome: "committed", result: plan.result };
			},
		});
		await expect(
			useCase.submit(
				Object.freeze({ ...applicationFoundationCommandV1 }),
				Object.freeze({ ...applicationFoundationActorContextV1 }),
			),
		).resolves.toMatchObject({
			applicationId: applicationFoundationCommandV1.applicationId,
			agentId: applicationFoundationCommandV1.agentId,
		});
		expect(commits).toBe(1);
	});

	it("produces one immutable-time canonical write plan", async () => {
		let captured: ApplicationFoundationWritePlanV1 | undefined;
		const clockDate = new Date(serverInstant);
		const useCase = createApplicationFoundationUseCaseV1(
			{
				...applicationFoundationAdmissionDependenciesV1(),
				transaction: readyTransaction({
					async commit(plan) {
						captured = plan;
						clockDate.setUTCFullYear(2099);
						return { outcome: "committed", result: plan.result };
					},
				}),
			},
			{ now: () => clockDate },
		);

		await expect(
			useCase.submit(
				applicationFoundationCommandV1,
				applicationFoundationActorContextV1,
			),
		).resolves.toMatchObject({ configurationRevision: 1 });
		if (!captured) throw new Error("Expected a captured write plan");
		expect(captured.agent.authorizationRevision).toBe("authorization_9");
		expect(captured.access.ownerIds).toEqual([
			"owner_01",
			"user co-owner beta",
		]);
		expect(captured.access.availability).toEqual([
			{ kind: "organization", organizationId: "organization alpha" },
			{ kind: "user", userId: "user available beta" },
		]);
		expect(captured.idempotency).toEqual({
			key: "application-submit-alpha",
			requestDigest: "b".repeat(64),
		});
		for (const timestamp of [
			captured.agent.createdAt,
			captured.application.submittedAt,
			captured.configurationRevision.createdAt,
			captured.access.createdAt,
			captured.outboxIntent.occurredAt,
			captured.auditEvent.occurredAt,
		]) {
			expect(timestamp.toISOString()).toBe(serverInstant);
		}
	});

	it.each([
		Object.assign(new ApplicationFoundationError("invalid_command"), {
			cause: new Error("sensitive invalid command cause"),
		}),
		Object.assign(
			immutableBrandedError(
				"Application foundation invalid command",
				"invalid_command",
			),
			{ sensitive: "sensitive cross-bundle invalid command detail" },
		),
		new Error("sensitive infrastructure detail"),
		{ code: "23505", detail: "sensitive SQL detail" },
		{ outcome: "replayed", result: { plaintext: "sensitive" } },
		{ outcome: "unknown" },
	])("sanitizes malformed or failed transaction output", async (failure) => {
		const transaction: Pick<ApplicationFoundationTransactionPortV1, "commit"> =
			{
				async commit() {
					if (failure instanceof Error || !("outcome" in failure))
						throw failure;
					return failure as never;
				},
			};
		const error = await createUseCase(transaction)
			.submit(
				applicationFoundationCommandV1,
				applicationFoundationActorContextV1,
			)
			.then(
				() => expect.fail("Expected transaction failure"),
				(reason: unknown) => reason,
			);

		expect(error).toEqual(expect.any(ApplicationFoundationError));
		expect(error).toMatchObject({
			code: "persistence_failed",
			message: "Application foundation persistence failed",
		});
		expect(error).not.toHaveProperty("cause");
		expect(String(error)).not.toContain("sensitive");
	});

	it("maps only bounded transaction conflicts", async () => {
		for (const [reason, code] of [
			["duplicate", "conflict"],
			["idempotency_conflict", "idempotency_conflict"],
		] as const) {
			const transaction: Pick<
				ApplicationFoundationTransactionPortV1,
				"commit"
			> = {
				async commit() {
					return { outcome: "conflict", reason };
				},
			};
			await expect(
				createUseCase(transaction).submit(
					applicationFoundationCommandV1,
					applicationFoundationActorContextV1,
				),
			).rejects.toMatchObject({ code });
		}
	});

	it.each([
		[
			"same-bundle conflict",
			Object.assign(new ApplicationFoundationError("conflict"), {
				cause: new Error("sensitive conflict cause"),
				sensitive: "sensitive conflict detail",
			}),
			"conflict",
		],
		[
			"cross-bundle idempotency conflict",
			Object.assign(
				immutableBrandedError(
					"Application foundation idempotency conflict",
					"idempotency_conflict",
				),
				{ sensitive: "sensitive conflict detail" },
			),
			"idempotency_conflict",
		],
	])("preserves only a canonical %s", async (_name, failure, code) => {
		const error = await createUseCase({
			async commit() {
				throw failure;
			},
		})
			.submit(
				applicationFoundationCommandV1,
				applicationFoundationActorContextV1,
			)
			.then(
				() => expect.fail("Expected a canonical conflict"),
				(reason: unknown) => reason,
			);
		expect(error).not.toBe(failure);
		expect(error).toMatchObject({ code });
		expect(error).not.toHaveProperty("cause");
		expect(error).not.toHaveProperty("sensitive");
	});

	it.each([
		immutableBrandedError("sensitive noncanonical message"),
		immutableBrandedError(
			"Application foundation conflict",
			"conflict",
			"ForgedApplicationFoundationError",
		),
		immutableBrandedError("Application foundation forged", "forged"),
		Object.assign(new Error("Application foundation conflict"), {
			name: "ApplicationFoundationError",
			code: "conflict",
			[errorBrand]: true,
		}),
	])("rejects a forged transaction error brand", async (failure) => {
		await expect(
			createUseCase({
				async commit() {
					throw failure;
				},
			}).submit(
				applicationFoundationCommandV1,
				applicationFoundationActorContextV1,
			),
		).rejects.toMatchObject({ code: "persistence_failed" });
	});

	it.each([
		[
			"throwing clock",
			() => {
				throw new Error("sensitive clock failure");
			},
		],
		["invalid clock", () => new Date(Number.NaN)],
		["proxied clock", () => new Proxy(new Date(serverInstant), {})],
		["invalid Date internal slot", () => Object.create(Date.prototype)],
	])("rejects a %s without crossing persistence", async (_name, now) => {
		let commits = 0;
		const useCase = createApplicationFoundationUseCaseV1(
			{
				...applicationFoundationAdmissionDependenciesV1(),
				transaction: readyTransaction({
					async commit(plan) {
						commits += 1;
						return { outcome: "committed", result: plan.result };
					},
				}),
			},
			{ now },
		);
		await expect(
			useCase.submit(
				applicationFoundationCommandV1,
				applicationFoundationActorContextV1,
			),
		).rejects.toMatchObject({ code: "persistence_failed" });
		expect(commits).toBe(0);
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
