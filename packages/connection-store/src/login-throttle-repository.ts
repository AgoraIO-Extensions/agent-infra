import { randomUUID } from "node:crypto";
import {
	assertLoginAdmission,
	LoginRateLimitedError,
	type LoginThrottleOutcome,
	loginThrottlePolicy,
	nextLoginFailure,
} from "@agent-infra/connection-core";
import { and, eq, gt, lte, sql } from "drizzle-orm";
import type { ConnectionDatabase } from "./database.js";
import { loginThrottleAttempts, loginThrottleFailures } from "./schema.js";

const markerPattern = /^[a-f0-9]{64}$/;
const environmentMarker = "0".repeat(64);

export function createPostgresLoginThrottle(db: ConnectionDatabase) {
	return {
		async begin({
			environment,
			sourceMarker,
			accountMarker,
		}: {
			environment: string;
			sourceMarker: string;
			accountMarker: string;
		}) {
			if (
				!environment ||
				environment.length > 100 ||
				!markerPattern.test(sourceMarker) ||
				!markerPattern.test(accountMarker)
			)
				throw new LoginRateLimitedError();
			const id = randomUUID();
			await db.transaction(async (tx) => {
				await tx.execute(
					sql`select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`agent-infra:connection:login:${environment}`}, 0))`,
				);
				const [clock] = await tx.execute<{ now: string }>(
					sql`select clock_timestamp() as "now"`,
				);
				if (!clock) throw new Error("Connection login clock unavailable");
				const now = new Date(clock.now);
				if (Number.isNaN(now.getTime()))
					throw new Error("Connection login clock invalid");
				await tx
					.delete(loginThrottleAttempts)
					.where(
						and(
							eq(loginThrottleAttempts.environment, environment),
							lte(loginThrottleAttempts.expiresAt, now),
						),
					);
				await tx
					.delete(loginThrottleFailures)
					.where(
						and(
							eq(loginThrottleFailures.environment, environment),
							lte(loginThrottleFailures.windowUntil, now),
						),
					);
				const [source] = await tx
					.select()
					.from(loginThrottleFailures)
					.where(
						and(
							eq(loginThrottleFailures.environment, environment),
							eq(loginThrottleFailures.kind, "source"),
							eq(loginThrottleFailures.marker, sourceMarker),
						),
					);
				const [account] = await tx
					.select()
					.from(loginThrottleFailures)
					.where(
						and(
							eq(loginThrottleFailures.environment, environment),
							eq(loginThrottleFailures.kind, "account"),
							eq(loginThrottleFailures.marker, accountMarker),
						),
					);
				const [environmentFailures] = await tx
					.select()
					.from(loginThrottleFailures)
					.where(
						and(
							eq(loginThrottleFailures.environment, environment),
							eq(loginThrottleFailures.kind, "environment"),
							eq(loginThrottleFailures.marker, environmentMarker),
						),
					);
				const [counts] = await tx
					.select({
						total: sql<number>`count(*)::integer`,
						source: sql<number>`count(*) filter (where ${loginThrottleAttempts.sourceMarker} = ${sourceMarker})::integer`,
						account: sql<number>`count(*) filter (where ${loginThrottleAttempts.accountMarker} = ${accountMarker})::integer`,
					})
					.from(loginThrottleAttempts)
					.where(
						and(
							eq(loginThrottleAttempts.environment, environment),
							gt(loginThrottleAttempts.expiresAt, now),
						),
					);
				if (!counts) throw new LoginRateLimitedError();
				assertLoginAdmission(
					{
						sourceNextAllowedAt: source?.nextAllowedAt?.getTime(),
						accountNextAllowedAt: account?.nextAllowedAt?.getTime(),
						environmentNextAllowedAt:
							environmentFailures?.nextAllowedAt?.getTime(),
						sourceInFlight: counts.source,
						accountInFlight: counts.account,
						environmentInFlight: counts.total,
					},
					now.getTime(),
				);
				await tx.insert(loginThrottleAttempts).values({
					id,
					environment,
					sourceMarker,
					accountMarker,
					expiresAt: new Date(now.getTime() + loginThrottlePolicy.leaseMs),
				});
			});
			return async (outcome: LoginThrottleOutcome) => {
				await db.transaction(async (tx) => {
					await tx.execute(
						sql`select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`agent-infra:connection:login:${environment}`}, 0))`,
					);
					const [attempt] = await tx
						.delete(loginThrottleAttempts)
						.where(
							and(
								eq(loginThrottleAttempts.id, id),
								eq(loginThrottleAttempts.environment, environment),
							),
						)
						.returning({ id: loginThrottleAttempts.id });
					if (!attempt) return;
					if (outcome === "succeeded") {
						await tx
							.delete(loginThrottleFailures)
							.where(
								and(
									eq(loginThrottleFailures.environment, environment),
									eq(loginThrottleFailures.kind, "account"),
									eq(loginThrottleFailures.marker, accountMarker),
								),
							);
						return;
					}
					if (outcome === "unavailable") return;
					const [clock] = await tx.execute<{ now: string }>(
						sql`select clock_timestamp() as "now"`,
					);
					if (!clock) throw new Error("Connection login clock unavailable");
					const now = new Date(clock.now);
					if (Number.isNaN(now.getTime()))
						throw new Error("Connection login clock invalid");
					for (const [kind, marker, threshold] of [
						["source", sourceMarker, 3],
						["account", accountMarker, 3],
						[
							"environment",
							environmentMarker,
							loginThrottlePolicy.environmentBackoffThreshold,
						],
					] as const) {
						const [previous] = await tx
							.select()
							.from(loginThrottleFailures)
							.where(
								and(
									eq(loginThrottleFailures.environment, environment),
									eq(loginThrottleFailures.kind, kind),
									eq(loginThrottleFailures.marker, marker),
								),
							);
						const next = nextLoginFailure(
							previous
								? {
										failures: previous.failures,
										windowUntil: previous.windowUntil.getTime(),
									}
								: undefined,
							now.getTime(),
							threshold,
						);
						const values = {
							environment,
							kind,
							marker,
							failures: next.failures,
							windowUntil: new Date(next.windowUntil),
							nextAllowedAt:
								next.nextAllowedAt === null
									? null
									: new Date(next.nextAllowedAt),
						};
						await tx
							.insert(loginThrottleFailures)
							.values(values)
							.onConflictDoUpdate({
								target: [
									loginThrottleFailures.environment,
									loginThrottleFailures.kind,
									loginThrottleFailures.marker,
								],
								set: values,
							});
					}
				});
			};
		},
	};
}
