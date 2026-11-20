import type { OperationalEvent } from "@agent-infra/observability";
import { createHttpObservability } from "@agent-infra/observability/http";
import { observeNativeAdmissionV1 } from "@agent-infra/platform-core";
import { Hono } from "hono";

import { expect, it } from "vitest";
import {
	openPostgresTestClient,
	startPostgresTestDatabase,
} from "../../../packages/platform-store/src/postgres-test.js";
import { createRuntimeNativeMetadataRequestContextV1 } from "./runtime-native-metadata-request-context.js";

it("retains a real Store lock completion after the HTTP deadline with an explicit late reason", async () => {
	const database = await startPostgresTestDatabase("native-late");
	const sql = openPostgresTestClient(database, 3);
	const held = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const events: OperationalEvent[] = [];
	let completion: Promise<unknown> | undefined;
	let blocker: Promise<unknown> | undefined;
	try {
		await sql`create table late_probe(value integer)`;
		blocker = sql.begin(async (tx) => {
			await tx`lock table late_probe in access exclusive mode`;
			held.resolve();
			await release.promise;
		});
		await held.promise;
		const app = new Hono();
		app.use("*", createHttpObservability({ record: (e) => events.push(e) }));
		app.get("/probe", async (c) => {
			const context = createRuntimeNativeMetadataRequestContextV1({
				signal: new AbortController().signal,
				authenticate: async () => ({
					schemaVersion: 1,
					userId: "synthetic",
					displayName: "Synthetic",
					accountStatus: "active",
					organizationIds: [],
					roles: ["employee"],
					authorizationRevision: "one",
				}),
				admissionTelemetry: true,
			});
			context.setAdmissionProtocolVersion?.(1);
			context.limit(Date.now() + 100);
			const pending = observeNativeAdmissionV1(
				context.observeAdmission,
				"store.lock",
				async () => {
					entered.resolve();
					return sql`select * from late_probe`;
				},
			);
			completion = pending;
			try {
				await context.run(() => pending);
				return c.text("unexpected");
			} catch {
				return c.json({ outcome: "unavailable" }, 503);
			} finally {
				context.close();
			}
		});
		const response = app.request("/probe");
		await entered.promise;
		// Confirm the SQL actually waits for the conflicting lock before the deadline.
		await expect
			.poll(async () =>
				Number(
					(
						await sql`select count(*) as n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like 'select * from late_probe%'`
					)[0]?.n,
				),
			)
			.toBe(1);
		expect((await response).status).toBe(503);
		const summary = events.find((e) => e.stage === "http");
		expect(summary?.nativeAdmission).toMatchObject({
			reason: "internal_deadline",
		});
		release.resolve();
		await blocker;
		await completion;
		const late = events
			.filter((e) => e.stage === "dependency")
			.map(
				(e) =>
					e.nativeAdmission as {
						stage: string;
						phase: string;
						reason: string;
						cancelSource: string;
						elapsedMs: number;
					},
			)
			.find((e) => e.stage === "store.lock" && e.phase === "completed");
		expect(late).toMatchObject({
			reason: "completed_after_cancel",
			cancelSource: "internal_deadline",
			protocolVersion: 1,
		});
		expect(late?.elapsedMs).toBeGreaterThanOrEqual(80);
		expect(new Set(events.map((e) => e.traceId)).size).toBe(1);
		expect(summary?.nativeAdmission).toMatchObject({
			phase: "failed",
			reason: "internal_deadline",
		});
	} finally {
		release.resolve();
		await blocker?.catch(() => {});
		await completion?.catch(() => {});
		await sql.end();
		await database.stop();
	}
}, 30_000);
