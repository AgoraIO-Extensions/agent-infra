import { expect, it } from "vitest";

import {
	type PlatformIdempotencyBoundScopeV1,
	type PlatformIdempotencyPortV1,
	platformIdempotencyV1,
} from "./idempotency.ts";

export interface PlatformIdempotencyConformanceHarness {
	open(
		scope: PlatformIdempotencyBoundScopeV1,
	): PlatformIdempotencyPortV1 | Promise<PlatformIdempotencyPortV1>;
	close(): Promise<void>;
}

const scope = {
	schemaVersion: 1 as const,
	operation: "platform.agent-application.submit.v1" as const,
	resourceType: "agent_application" as const,
	resourceId: "application_conformance",
	actorId: "user_conformance",
};
const result = {
	schemaVersion: 1 as const,
	outcome: "accepted" as const,
	references: [
		{
			resourceType: "agent_application" as const,
			resourceId: scope.resourceId,
			revision: null,
		},
		{
			resourceType: "agent" as const,
			resourceId: "agent_conformance",
			revision: 1,
		},
	],
};

function digest(revision: number): string {
	return platformIdempotencyV1.canonicalRequestDigest({ revision });
}

export function platformIdempotencyPortV1Conformance(
	createHarness: () => Promise<PlatformIdempotencyConformanceHarness>,
): void {
	it("replays the first completed result for an equivalent request", async () => {
		const harness = await createHarness();
		try {
			const port = await harness.open(scope);
			const input = { key: "Replay_A", requestDigest: digest(1) };
			const reserved = await port.reserve(input);
			if (reserved.state !== "reserved")
				throw new Error("Expected reservation");
			expect(
				await port.complete({
					reservationId: reserved.reservationId,
					result,
				}),
			).toEqual({ state: "completed", result });
			expect(
				await port.complete({
					reservationId: reserved.reservationId,
					result: {
						...result,
						outcome: "completed",
						references: [
							{
								resourceType: "agent_application",
								resourceId: scope.resourceId,
								revision: 99,
							},
						],
					},
				}),
			).toEqual({ state: "completed", result });
			expect(await port.reserve(input)).toEqual({
				state: "completed",
				result,
			});
		} finally {
			await harness.close();
		}
	});

	it("keeps mismatched input, scope, and case-sensitive keys independent", async () => {
		const harness = await createHarness();
		try {
			const port = await harness.open(scope);
			expect(
				(await port.reserve({ key: "Scope_A", requestDigest: digest(2) }))
					.state,
			).toBe("reserved");
			expect(
				await port.reserve({ key: "Scope_A", requestDigest: digest(3) }),
			).toEqual({ state: "conflict" });
			expect(
				(await port.reserve({ key: "scope_A", requestDigest: digest(2) }))
					.state,
			).toBe("reserved");

			for (const independentScope of [
				{ ...scope, actorId: "user_other" },
				{ ...scope, resourceId: "application_other" },
			]) {
				const independent = await harness.open(independentScope);
				expect(
					(
						await independent.reserve({
							key: "Scope_A",
							requestDigest: digest(2),
						})
					).state,
				).toBe("reserved");
			}
		} finally {
			await harness.close();
		}
	});

	it("selects one durable reservation across concurrent callers", async () => {
		const harness = await createHarness();
		try {
			const ports = await Promise.all([
				harness.open(scope),
				harness.open(scope),
			]);
			const decisions = await Promise.all(
				ports.map((port) =>
					port.reserve({ key: "Concurrent_A", requestDigest: digest(4) }),
				),
			);
			expect(decisions.map((decision) => decision.state).toSorted()).toEqual([
				"in_progress",
				"reserved",
			]);
		} finally {
			await harness.close();
		}
	});

	it("keeps crash retries in progress until a trusted observation reconciles", async () => {
		const harness = await createHarness();
		try {
			const input = { key: "Crash_A", requestDigest: digest(5) };
			let sideEffects = 0;
			const original = await harness.open(scope);
			if ((await original.reserve(input)).state === "reserved")
				sideEffects += 1;

			const retries = await Promise.all([
				harness.open(scope),
				harness.open(scope),
			]);
			for (const retry of retries) {
				if ((await retry.reserve(input)).state === "reserved") sideEffects += 1;
			}
			expect(sideEffects).toBe(1);
			expect(await retries[0]?.reserve(input)).toEqual({
				state: "in_progress",
			});
			expect(
				await retries[0]?.reconcileObservedCompletion({
					key: input.key,
					requestDigest: digest(6),
					observedResult: result,
				}),
			).toEqual({ state: "conflict" });
			const wrongScope = await harness.open({
				...scope,
				actorId: "user_other",
			});
			expect(
				await wrongScope.reconcileObservedCompletion({
					...input,
					observedResult: result,
				}),
			).toEqual({ state: "conflict" });
			expect(
				await retries[0]?.reconcileObservedCompletion({
					...input,
					observedResult: result,
				}),
			).toEqual({ state: "completed", result });
			expect(
				await retries[1]?.reconcileObservedCompletion({
					...input,
					observedResult: { ...result, outcome: "completed" },
				}),
			).toEqual({ state: "completed", result });
			expect(sideEffects).toBe(1);
		} finally {
			await harness.close();
		}
	});

	it("rejects caller scope fields and non-domain result payloads", async () => {
		const harness = await createHarness();
		try {
			const port = await harness.open(scope);
			await expect(
				port.reserve({
					key: "Reject_A",
					requestDigest: digest(7),
					actorId: "attacker",
					operation: "runtime.submit",
				} as never),
			).rejects.toMatchObject({ code: "invalid_input" });
			const reserved = await port.reserve({
				key: "Reject_A",
				requestDigest: digest(7),
			});
			if (reserved.state !== "reserved")
				throw new Error("Expected reservation");
			await expect(
				port.complete({
					reservationId: reserved.reservationId,
					result: {
						...result,
						providerResponse: { remoteId: "remote" },
					} as never,
				}),
			).rejects.toMatchObject({ code: "invalid_input" });
		} finally {
			await harness.close();
		}
	});
}
