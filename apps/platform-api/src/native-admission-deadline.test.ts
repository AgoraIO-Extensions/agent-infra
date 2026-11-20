import type { OperationalEvent } from "@agent-infra/observability";
import { createHttpObservability } from "@agent-infra/observability/http";
import { observeNativeAdmissionV1 } from "@agent-infra/platform-core";
import { Hono } from "hono";
import { expect, it } from "vitest";
import { createRuntimeNativeMetadataRequestContextV1 } from "./runtime-native-metadata-request-context.js";

it.each(["shared-timer", "prior-commands-failure", "external-abort"] as const)(
	"attributes real shared deadline: %s",
	async (scenario) => {
		const events: OperationalEvent[] = [];
		const entered = Promise.withResolvers<void>();
		const abort = new AbortController();
		let count = 0;
		const app = new Hono();
		app.use("*", createHttpObservability({ record: (e) => events.push(e) }));
		app.get("/probe", async (c) => {
			const context = createRuntimeNativeMetadataRequestContextV1({
				signal: abort.signal,
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
			const read = (stage: "metadata.commands" | "metadata.skills") =>
				observeNativeAdmissionV1(context.observeAdmission, stage, async () => {
					if (stage === "metadata.skills") context.limit(Date.now() + 100);
					if (++count === 2) entered.resolve();
					if (
						scenario === "prior-commands-failure" &&
						stage === "metadata.commands"
					)
						throw new Error("PRIVATE_CANARY");
					return context.run(async () => new Promise<void>(() => {}));
				});
			// Keep the observational failure and the outstanding peer until the real deadline.
			try {
				await Promise.allSettled([
					read("metadata.commands"),
					read("metadata.skills"),
				]);
				return c.json({ outcome: "unavailable" }, 503);
			} finally {
				context.close();
			}
		});
		const response = app.request("/probe");
		await entered.promise;
		if (scenario === "external-abort") abort.abort();
		expect((await response).status).toBe(503);
		const summary = events.find((e) => e.stage === "http")?.nativeAdmission as {
			stage: string;
			reason: string;
			cancelSource: string;
		};
		expect(summary.stage).toBe(
			scenario === "prior-commands-failure" ? "metadata.commands" : "UNKNOWN",
		);
		expect(summary.reason).toBe(
			scenario === "prior-commands-failure"
				? "dependency"
				: scenario === "external-abort"
					? "client_abort"
					: "internal_deadline",
		);
		if (scenario === "shared-timer")
			expect(summary.cancelSource).toBe("internal_deadline");
		expect(new Set(events.map((e) => e.traceId)).size).toBe(1);
		expect(events[0]?.traceId).toBeTruthy();
		expect(JSON.stringify(events)).not.toContain("PRIVATE_CANARY");
	},
);
