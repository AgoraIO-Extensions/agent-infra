import type { OperationalEvent } from "@agent-infra/observability";
import { createHttpObservability } from "@agent-infra/observability/http";
import { observeNativeAdmissionV1 } from "@agent-infra/platform-core";
import { Hono } from "hono";
import { expect, it } from "vitest";
import { createRuntimeNativeMetadataRequestContextV1 } from "./runtime-native-metadata-request-context.js";

it.each([
	"commands-first",
	"skills-first",
	"near-simultaneous",
	"timeout-and-dependency",
	"shared-deadline",
] as const)("attributes concurrent metadata failure: %s", async (scenario) => {
	const events: OperationalEvent[] = [];
	const commands = Promise.withResolvers<void>();
	const skills = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	let count = 0;
	let clock = 1000;
	let expire = () => {};
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
			now: () => clock,
		});
		context.setAdmissionProtocolVersion?.(1);
		expire = () => {
			clock += 30001;
			try {
				context.assertCurrent();
			} catch {}
		};
		const read = (
			stage: "metadata.commands" | "metadata.skills",
			gate: Promise<void>,
		) =>
			observeNativeAdmissionV1(context.observeAdmission, stage, () =>
				context.run(async () => {
					if (++count === 2) entered.resolve();
					await gate;
				}),
			);
		try {
			await Promise.all([
				read("metadata.commands", commands.promise),
				read("metadata.skills", skills.promise),
			]);
			return c.text("unexpected");
		} catch {
			return c.json({ outcome: "unavailable" }, 503);
		} finally {
			context.close();
		}
	});
	const response = app.request("/probe");
	await entered.promise;
	const error = Object.assign(new Error("PRIVATE_CANARY"), {
		code: "ECONNRESET",
	});
	if (scenario === "shared-deadline") expire();
	else if (scenario === "skills-first") skills.reject(error);
	else
		commands.reject(
			scenario === "timeout-and-dependency"
				? new DOMException("PRIVATE_CANARY", "TimeoutError")
				: error,
		);
	if (scenario === "near-simultaneous" || scenario === "timeout-and-dependency")
		skills.reject(error);
	expect((await response).status).toBe(503);
	const expected =
		scenario === "shared-deadline"
			? "UNKNOWN"
			: scenario === "skills-first"
				? "metadata.skills"
				: "metadata.commands";
	expect(events).toContainEqual(
		expect.objectContaining({
			stage: "http",
			nativeAdmission: expect.objectContaining({
				stage: expected,
				reason:
					scenario === "shared-deadline" ? "internal_deadline" : "dependency",
				cancelSource:
					scenario === "shared-deadline" ? "internal_deadline" : "UNKNOWN",
				protocolVersion: 1,
			}),
		}),
	);
	expect(new Set(events.map((e) => e.traceId)).size).toBe(1);
	expect(JSON.stringify(events)).not.toContain("PRIVATE_CANARY");
});
