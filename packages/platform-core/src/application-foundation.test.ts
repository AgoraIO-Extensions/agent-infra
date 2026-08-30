import { describe, expect, it } from "vitest";

import { applicationFoundationTransactionConformance } from "./application-foundation.conformance.ts";
import {
	type ApplicationFoundationActorContextV1,
	ApplicationFoundationError,
	type ApplicationFoundationWritePlanV1,
	type CommitApplicationFoundationCommandV1,
	createApplicationFoundationUseCaseV1,
} from "./application-foundation.ts";
import { FakeApplicationFoundationTransactionV1 } from "./fake-application-foundation.ts";

const validCommand = () =>
	Object.freeze({
		schemaVersion: 1 as const,
		applicationId: "application core errors",
		agentId: "agent core errors",
		requestId: "request core errors",
		name: "Core Error Agent",
		description: "Verifies Core error normalization",
		sourceReference: "source core errors",
		traceId: "trace core errors",
		submittedAt: new Date("2026-08-30T12:00:00.000Z"),
	});
const actorContext = () =>
	Object.freeze({
		schemaVersion: 1 as const,
		userId: "user core errors",
	});
const errorBrand = Symbol.for(
	"@agent-infra/platform-core/ApplicationFoundationErrorV1",
);

async function normalizedPortFailure(failure: unknown): Promise<unknown> {
	const useCase = createApplicationFoundationUseCaseV1({
		async commit() {
			throw failure;
		},
	});
	return useCase.submit(validCommand(), actorContext()).then(
		() => expect.fail("Expected the transaction Port to fail"),
		(reason: unknown) => reason,
	);
}

async function rejectedBeforePort(
	command: unknown,
	context: unknown,
): Promise<{ error: unknown; portCalls: number }> {
	let portCalls = 0;
	const useCase = createApplicationFoundationUseCaseV1({
		async commit() {
			portCalls += 1;
		},
	});
	const error = await useCase
		.submit(
			command as CommitApplicationFoundationCommandV1,
			context as ApplicationFoundationActorContextV1,
		)
		.then(
			() => expect.fail("Expected input parsing to fail before the Port"),
			(reason: unknown) => reason,
		);
	return { error, portCalls };
}

function expectInvalidCommand(error: unknown): void {
	expect(error).toMatchObject({
		name: "ApplicationFoundationError",
		code: "invalid_command",
		message: "Application foundation invalid command",
	});
}

function immutableBrandedError(
	message: string,
	code = "conflict",
	name = "ApplicationFoundationError",
): Error & { code: string } {
	const error = Object.assign(new Error(message), {
		name,
		code,
	});
	Object.defineProperty(error, errorBrand, { value: true });
	return error;
}

describe("Application foundation use case", () => {
	it("rejects a staged actor getter before it can split persisted identity", async () => {
		let getterReads = 0;
		const context = Object.defineProperty({ schemaVersion: 1 }, "userId", {
			enumerable: true,
			get() {
				getterReads += 1;
				return `staged-user-${getterReads}`;
			},
		});
		const { error, portCalls } = await rejectedBeforePort(
			validCommand(),
			context,
		);

		expectInvalidCommand(error);
		expect(getterReads).toBe(0);
		expect(portCalls).toBe(0);
	});

	it("rejects staged command correlation getters before persistence", async () => {
		let getterReads = 0;
		const command = { ...validCommand() };
		for (const field of ["requestId", "traceId"] as const) {
			Object.defineProperty(command, field, {
				enumerable: true,
				get() {
					getterReads += 1;
					return `${field}-${getterReads}`;
				},
			});
		}
		const { error, portCalls } = await rejectedBeforePort(
			command,
			actorContext(),
		);

		expectInvalidCommand(error);
		expect(getterReads).toBe(0);
		expect(portCalls).toBe(0);
	});

	it("does not reread an accessor that throws after old validation", async () => {
		let getterReads = 0;
		const command = { ...validCommand() };
		Object.defineProperty(command, "requestId", {
			enumerable: true,
			get() {
				getterReads += 1;
				if (getterReads <= 2) return "request before persistence";
				throw new Error("sensitive post-validation failure");
			},
		});
		const { error, portCalls } = await rejectedBeforePort(
			command,
			actorContext(),
		);

		expectInvalidCommand(error);
		expect(String(error)).not.toContain("sensitive");
		expect(getterReads).toBe(0);
		expect(portCalls).toBe(0);
	});

	it.each([
		[
			"command ownKeys",
			new Proxy(validCommand(), {
				ownKeys() {
					throw new Error("sensitive command ownKeys trap");
				},
			}),
			actorContext(),
		],
		[
			"command descriptor",
			new Proxy(validCommand(), {
				getOwnPropertyDescriptor() {
					throw new Error("sensitive command descriptor trap");
				},
			}),
			actorContext(),
		],
		[
			"context ownKeys",
			validCommand(),
			new Proxy(actorContext(), {
				ownKeys() {
					throw new Error("sensitive context ownKeys trap");
				},
			}),
		],
		[
			"context descriptor",
			validCommand(),
			new Proxy(actorContext(), {
				getOwnPropertyDescriptor() {
					throw new Error("sensitive context descriptor trap");
				},
			}),
		],
	])("sanitizes a %s trap before the Port", async (_name, command, context) => {
		const { error, portCalls } = await rejectedBeforePort(command, context);

		expectInvalidCommand(error);
		expect(String(error)).not.toContain("sensitive");
		expect(portCalls).toBe(0);
	});

	it("accepts ordinary frozen command and actor objects", async () => {
		let portCalls = 0;
		const useCase = createApplicationFoundationUseCaseV1({
			async commit() {
				portCalls += 1;
			},
		});

		await expect(
			useCase.submit(validCommand(), actorContext()),
		).resolves.toMatchObject({
			applicationId: "application core errors",
			agentId: "agent core errors",
		});
		expect(portCalls).toBe(1);
	});

	it.each([
		["raw Error", new Error("sensitive infrastructure detail")],
		["SQL-like object", { code: "XX000", detail: "sensitive SQL detail" }],
		[
			"plain forged brand",
			{
				name: "ApplicationFoundationError",
				message: "Application foundation conflict",
				code: "conflict",
				[errorBrand]: true,
			},
		],
		[
			"mutable Error brand",
			Object.assign(new Error("Application foundation conflict"), {
				name: "ApplicationFoundationError",
				code: "conflict",
				[errorBrand]: true,
			}),
		],
		[
			"noncanonical-message branded Error",
			immutableBrandedError("sensitive noncanonical message"),
		],
		[
			"noncanonical-name branded Error",
			immutableBrandedError(
				"Application foundation conflict",
				"conflict",
				"ForgedApplicationFoundationError",
			),
		],
		[
			"unsupported-code branded Error",
			immutableBrandedError("Application foundation forged", "forged"),
		],
	])("sanitizes a %s from the transaction Port", async (_name, failure) => {
		const error = await normalizedPortFailure(failure);

		expect(error).toBeInstanceOf(ApplicationFoundationError);
		expect(error).not.toBe(failure);
		expect(error).toMatchObject({
			name: "ApplicationFoundationError",
			code: "persistence_failed",
			message: "Application foundation persistence failed",
		});
		expect(error).not.toHaveProperty("cause");
		expect(String(error)).not.toContain("sensitive");
	});

	it("preserves only the code from a canonical domain conflict", async () => {
		const conflict = Object.assign(new ApplicationFoundationError("conflict"), {
			cause: new Error("sensitive conflict cause"),
			sensitive: "sensitive conflict detail",
		});
		const error = await normalizedPortFailure(conflict);

		expect(error).toBeInstanceOf(ApplicationFoundationError);
		expect(error).not.toBe(conflict);
		expect(error).toMatchObject({
			name: "ApplicationFoundationError",
			code: "conflict",
			message: "Application foundation conflict",
		});
		expect(error).not.toHaveProperty("cause");
		expect(error).not.toHaveProperty("sensitive");
	});

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

		const result = useCase.submit(
			{
				schemaVersion: 1,
				applicationId: "application date copy",
				agentId: "agent date copy",
				requestId: "request date copy",
				name: "Date Copy Agent",
				description: "Verifies timestamp ownership",
				sourceReference: "source date copy",
				traceId: "trace date copy",
				submittedAt,
			},
			{
				schemaVersion: 1,
				userId: "user date copy",
			},
		);
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
