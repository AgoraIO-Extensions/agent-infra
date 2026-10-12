import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeExecutionGrantClaimsV2 } from "@agent-infra/contracts/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeHostError, runtimeHostErrorDiagnostic } from "./errors.js";
import { FakeRuntimeDriver } from "./fake-runtime-driver.js";
import { FileRuntimeStore } from "./file-runtime-store.js";
import {
	fixtureNow,
	signV3Fixture,
	submitV3Fixture,
	verifyRuntimeV2Fixture,
} from "./grant-v2-fixture.test-support.js";
import {
	applyRuntimeAuthority,
	type RuntimeExecutionAuthority,
	runtimeAuthorizationDenied,
} from "./runtime-authorization.js";
import { RuntimeHost } from "./runtime-host.js";

// Every Runtime authorization denial keeps one external code and message; an
// operator can still tell which check refused it (#1888).

const directories: string[] = [];
beforeEach(() => {
	vi.setSystemTime(fixtureNow);
});
afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

function deniedReason(work: () => unknown) {
	try {
		work();
	} catch (error) {
		expect(error).toBeInstanceOf(RuntimeHostError);
		const denial = error as RuntimeHostError;
		expect(denial).toMatchObject({
			code: "RUNTIME_GRANT_INVALID",
			message:
				"Runtime authorization is unavailable or does not authorize this operation",
			httpStatus: 403,
			retryable: false,
		});
		return runtimeHostErrorDiagnostic(denial);
	}
	throw new Error("expected an authorization denial");
}

async function deniedReasonAsync(work: () => Promise<unknown>) {
	const error = await work().then(
		() => undefined,
		(caught: unknown) => caught,
	);
	if (!error) throw new Error("expected an authorization denial");
	return deniedReason(() => {
		throw error;
	});
}

function businessClaims(
	overrides: Partial<RuntimeExecutionGrantClaimsV2> = {},
	now = fixtureNow,
) {
	const request = signV3Fixture(
		{ ...submitV3Fixture(), hostSessionRef: "host-session" },
		"turn.submit",
		{ now },
	);
	return {
		...verifyRuntimeV2Fixture(request.grant).claims,
		...overrides,
	} as RuntimeExecutionGrantClaimsV2;
}

describe("Runtime authorization denial diagnostics (#1888)", () => {
	it("reports a fixed reason, or the throwing code location when none is named", () => {
		expect(
			deniedReason(() => runtimeAuthorizationDenied("grant-expired")),
		).toBe("grant-expired");
		function unnamedDenialSite() {
			runtimeAuthorizationDenied();
		}
		const located = deniedReason(unnamedDenialSite);
		expect(located).toMatch(
			/^unnamedDenialSite@runtime-authorization-diagnostics\.test\.ts:\d+:\d+$/,
		);
	});

	it("ties every named reason to one denial site", async () => {
		const source = new URL(".", import.meta.url);
		const named = new Map<string, string[]>();
		for (const file of await readdir(source)) {
			if (!file.endsWith(".ts") || /\.test(-support)?\.ts$/.test(file))
				continue;
			const text = await readFile(new URL(file, source), "utf8");
			for (const [, reason] of text.matchAll(
				/runtimeAuthorizationDenied\(\s*"([^"]+)"/g,
			))
				named.set(reason as string, [
					...(named.get(reason as string) ?? []),
					file,
				]);
		}
		expect(named.size).toBeGreaterThan(50);
		expect(
			[...named].filter(([, sites]) => sites.length > 1),
			"a reused reason cannot tell its denial sites apart",
		).toEqual([]);
	});

	it("names each check of the authority applied to a request", () => {
		const claims = businessClaims();
		const authority = (
			overrides: Partial<RuntimeExecutionAuthority> = {},
		): Record<string, RuntimeExecutionAuthority> => ({
			[claims.executionId]: {
				workerId: claims.workerId,
				executionDeliveryFence: claims.operation.executionDeliveryFence,
				authorizationRecordId:
					claims.purpose === "business"
						? claims.authorizationRecordId
						: undefined,
				issuedAt: fixtureNow,
				expiresAt: fixtureNow + 30_000,
				deliveredCursors: [],
				...overrides,
			},
		});
		const cases: [
			string,
			Record<string, RuntimeExecutionAuthority>,
			RuntimeExecutionGrantClaimsV2,
			"prepare" | "query" | "renew",
			number,
		][] = [
			["grant-issued-in-future", authority(), claims, "query", fixtureNow - 1],
			["grant-expired", authority(), claims, "query", fixtureNow + 30_000],
			[
				"authority-worker-mismatch",
				authority({ workerId: "another-worker" }),
				claims,
				"query",
				fixtureNow,
			],
			[
				"authority-fence-regressed",
				authority({ executionDeliveryFence: 2 }),
				claims,
				"query",
				fixtureNow,
			],
			[
				"business-authority-stopped",
				authority({ stopped: true }),
				claims,
				"query",
				fixtureNow,
			],
			[
				"business-control-latched",
				authority({
					control: { controlRecordId: "control-1", reason: "stop" },
				}),
				claims,
				"query",
				fixtureNow,
			],
			[
				"business-control-latched",
				authority({
					control: {
						controlRecordId: "control-1",
						reason: "authorization_revoked",
					},
				}),
				claims,
				"query",
				fixtureNow,
			],
			[
				"business-recovery-latched",
				authority({
					control: { controlRecordId: "control-1", reason: "recovery" },
				}),
				claims,
				"query",
				fixtureNow,
			],
			[
				"authorization-record-mismatch",
				authority({ authorizationRecordId: "another-record" }),
				claims,
				"query",
				fixtureNow,
			],
			["renew-without-authority", {}, claims, "renew", fixtureNow],
			[
				"grant-older-than-authority",
				authority({ issuedAt: fixtureNow + 1 }),
				claims,
				"renew",
				fixtureNow + 1,
			],
		];
		for (const [reason, authorities, request, mode, now] of cases)
			expect(
				deniedReason(() =>
					applyRuntimeAuthority(authorities, request, mode, now),
				),
				reason,
			).toBe(reason);
	});

	it("names each check of an event read or ACK in the durable store", async () => {
		const directory = await mkdtemp(join(tmpdir(), "runtime-denial-"));
		directories.push(directory);
		const driver = await FakeRuntimeDriver.open(join(directory, "driver.json"));
		const store = await FileRuntimeStore.open(join(directory, "host.json"));
		const host = await RuntimeHost.open({
			driver,
			store,
			grantValidation: {
				expectedIssuer: "agent-platform",
				now: () => "2026-08-28T10:00:00Z",
			},
			grantValidationV2: {
				expectedIssuer: "platform-fixture",
				expectedWorkerId: "worker-fixture",
				now: () => fixtureNow,
			},
		});
		try {
			const submit = signV3Fixture(submitV3Fixture(), "turn.submit");
			const accepted = await host.submitTurnV3(
				submit,
				verifyRuntimeV2Fixture(submit.grant),
			);
			const { input: _input, ...request } = submitV3Fixture();
			const eventClaims = (now = fixtureNow) => {
				const query = signV3Fixture(
					{
						...request,
						hostSessionRef: accepted.hostSessionRef,
						consumer: "platform_worker_persistence" as const,
						afterCursor: null,
					},
					"events.persist",
					{ now },
				);
				return verifyRuntimeV2Fixture(query.grant).claims;
			};
			const claims = eventClaims();
			const read = (
				value: RuntimeExecutionGrantClaimsV2,
				cursors: string[],
				now = fixtureNow,
			) => store.recordDeliveredCursors(value, cursors, now);
			const cases: [string, () => Promise<unknown>][] = [
				[
					"event-grant-expired",
					() =>
						read(eventClaims(fixtureNow - 1_000), ["c"], fixtureNow + 29_500),
				],
				[
					"event-authority-expired",
					() =>
						read(eventClaims(fixtureNow + 30_000), ["c"], fixtureNow + 30_000),
				],
				[
					"event-authority-fence-mismatch",
					() =>
						read(
							{
								...claims,
								operation: {
									...claims.operation,
									deliveryFence: 2,
									executionDeliveryFence: 2,
								},
							},
							["c"],
						),
				],
				[
					"event-authority-worker-mismatch",
					() => read({ ...claims, workerId: "another-worker" }, ["c"]),
				],
				[
					"event-authorization-record-mismatch",
					() =>
						read(
							{
								...claims,
								authorizationRecordId: "another-record",
							} as RuntimeExecutionGrantClaimsV2,
							["c"],
						),
				],
				[
					"ack-cursor-undelivered",
					() => store.acknowledgeCursor(claims, "never-delivered", fixtureNow),
				],
				[
					"ack-cursor-unknown",
					async () =>
						store.checkAcknowledgableCursor(claims, "never-delivered"),
				],
			];
			for (const [reason, work] of cases)
				expect(await deniedReasonAsync(work), reason).toBe(reason);
			// The page that would exceed the delivered-cursor bound is refused whole.
			await read(
				claims,
				Array.from({ length: 256 }, (_, index) => `cursor-${index}`),
			);
			expect(await deniedReasonAsync(() => read(claims, ["cursor-256"]))).toBe(
				"delivered-cursor-bound",
			);
		} finally {
			await host.close();
		}
	});
});
