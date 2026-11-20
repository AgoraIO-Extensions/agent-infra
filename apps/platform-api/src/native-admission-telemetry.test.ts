import type { OperationalEvent } from "@agent-infra/observability";
import {
	createHttpNativeAdmissionTelemetry,
	createHttpObservability,
} from "@agent-infra/observability/http";
import { observeNativeAdmissionV1 } from "@agent-infra/platform-core";
import { Hono } from "hono";
import { expect, it } from "vitest";

const identity = {
	schemaVersion: 1 as const,
	userId: "synthetic-user",
	displayName: "Synthetic",
	accountStatus: "active" as const,
	organizationIds: [],
	roles: ["employee" as const],
	authorizationRevision: "auth-1",
};

import { createRuntimeNativeMetadataRequestContextV1 } from "./runtime-native-metadata-request-context.js";

it.each(["client_abort", "internal_deadline"] as const)(
	"keeps %s distinct on the original request without changing the 503",
	async (source) => {
		const events: OperationalEvent[] = [];
		const app = new Hono();
		app.use("*", createHttpObservability({ record: (e) => events.push(e) }));
		app.get("/probe", async (c) => {
			let now = 1000;
			const abort = new AbortController();
			const request = createRuntimeNativeMetadataRequestContextV1({
				signal: abort.signal,
				authenticate: async () => identity,
				now: () => now,
				admissionTelemetry: true,
			});
			request.setAdmissionProtocolVersion?.(1);
			try {
				await request.authenticate();
				const entered = Promise.withResolvers<void>();
				const pending = observeNativeAdmissionV1(
					request.observeAdmission,
					"metadata.first",
					() =>
						request.run(async () => {
							entered.resolve();
							await new Promise<void>(() => {});
						}),
				);
				await entered.promise;
				if (source === "client_abort") abort.abort();
				else {
					now += 30_001;
					try {
						request.assertCurrent();
					} catch {
						/* Exercise the original deadline rejection. */
					}
				}
				await pending;
				return c.json({ outcome: "accepted" }, 202);
			} catch {
				return c.json({ outcome: "unavailable" }, 503);
			} finally {
				request.close();
			}
		});
		expect((await app.request("/probe")).status).toBe(503);
		expect(events).toContainEqual(
			expect.objectContaining({
				stage: "http",
				nativeAdmission: expect.objectContaining({
					stage: "metadata.first",
					reason: source,
					cancelSource: source,
					protocolVersion: 1,
				}),
			}),
		);
		expect(new Set(events.map((e) => e.traceId)).size).toBe(1);
	},
);

it("replaces an unlocated failure only with the first fixed classification", async () => {
	const events: OperationalEvent[] = [];
	const app = new Hono();
	app.use("*", createHttpObservability({ record: (e) => events.push(e) }));
	app.get("/probe", (c) => {
		const observer = createHttpNativeAdmissionTelemetry();
		observer.protocol(1);
		observer.observe({
			stage: "delivery",
			phase: "failed",
			elapsedMs: 1,
			error: new Error("PRIVATE_CANARY"),
		});
		observer.observe({
			stage: "store.query",
			phase: "failed",
			elapsedMs: 2,
			error: Object.assign(new Error("PRIVATE_CANARY"), { code: "55P03" }),
		});
		observer.observe({
			stage: "metadata.second",
			phase: "failed",
			elapsedMs: 3,
			error: new Error("PRIVATE_CANARY"),
		});
		return c.json({ outcome: "unavailable" }, 503);
	});
	await app.request("/probe");
	expect(events).toContainEqual(
		expect.objectContaining({
			stage: "http",
			nativeAdmission: expect.objectContaining({
				stage: "store.query",
				reason: "store",
				sqlState: "55P03",
			}),
		}),
	);
	expect(JSON.stringify(events)).not.toContain("PRIVATE_CANARY");
});

it("records cancellation delivered outside the original async HTTP context", async () => {
	const events: OperationalEvent[] = [];
	const entered = Promise.withResolvers<void>();
	const abort = new AbortController();
	const app = new Hono();
	app.use("*", createHttpObservability({ record: (e) => events.push(e) }));
	app.get("/external", async (c) => {
		const request = createRuntimeNativeMetadataRequestContextV1({
			signal: abort.signal,
			authenticate: async () => identity,
			admissionTelemetry: true,
		});
		request.setAdmissionProtocolVersion?.(1);
		try {
			await observeNativeAdmissionV1(
				request.observeAdmission,
				"metadata.first",
				() =>
					request.run(async () => {
						entered.resolve();
						await new Promise<void>(() => {});
					}),
			);
			return c.text("unexpected");
		} catch {
			return c.json({ outcome: "unavailable" }, 503);
		} finally {
			request.close();
		}
	});
	const response = app.request("/external");
	await entered.promise;
	abort.abort();
	expect((await response).status).toBe(503);
	expect(events).toContainEqual(
		expect.objectContaining({
			stage: "http",
			nativeAdmission: expect.objectContaining({
				stage: "metadata.first",
				reason: "client_abort",
				cancelSource: "client_abort",
			}),
		}),
	);
	expect(new Set(events.map((e) => e.traceId)).size).toBe(1);
});
