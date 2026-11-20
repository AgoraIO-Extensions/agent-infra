import { createServer } from "node:http";
import { Writable } from "node:stream";
import { expect, it } from "vitest";
import { startObservability } from "./index.js";
import {
	createNativeAdmissionTelemetry,
	projectNativeAdmission,
} from "./native-admission.js";

it("retains the earliest fixed failure through rewrapping and accepts only narrow SQLSTATE", () => {
	const values: unknown[] = [];
	const telemetry = createNativeAdmissionTelemetry((v) => values.push(v));
	telemetry.protocol(1);
	telemetry.observe({
		stage: "store.lock",
		phase: "failed",
		elapsedMs: 5,
		error: new Error("private", {
			cause: { code: "55P03", message: "PRIVATE_CANARY" },
		}),
	});
	telemetry.observe({
		stage: "metadata.first",
		phase: "failed",
		elapsedMs: 8,
		error: new Error("repackaged PRIVATE_CANARY"),
	});
	expect(values).toHaveLength(2);
	for (const value of values)
		expect(projectNativeAdmission(value)).toMatchObject({
			reason: "store",
			sqlState: "55P03",
			protocolVersion: 1,
		});
	expect(JSON.stringify(values)).not.toContain("PRIVATE_CANARY");
	expect(
		projectNativeAdmission({
			...(values[0] as object),
			sqlState: "SECRET",
			body: "PRIVATE_CANARY",
		}),
	).not.toHaveProperty("sqlState");
});

it("leaves unlocated failures UNKNOWN and distinguishes the first cancellation source", () => {
	for (const source of ["client_abort", "internal_deadline"] as const) {
		const values: unknown[] = [];
		const telemetry = createNativeAdmissionTelemetry((v) => values.push(v));
		telemetry.cancel(source);
		telemetry.cancel(
			source === "client_abort" ? "internal_deadline" : "client_abort",
		);
		telemetry.observe({
			stage: "delivery",
			phase: "failed",
			elapsedMs: 20,
			error: new Error("private"),
		});
		expect(projectNativeAdmission(values[0])).toMatchObject({
			reason: source,
			cancelSource: source,
		});
	}
	const values: unknown[] = [];
	createNativeAdmissionTelemetry((v) => values.push(v)).observe({
		stage: "delivery",
		phase: "failed",
		elapsedMs: 1,
		error: new Error("PRIVATE_CANARY"),
	});
	expect(projectNativeAdmission(values[0])).toMatchObject({
		reason: "UNKNOWN",
		cancelSource: "UNKNOWN",
	});
});

it("drops private canaries from real logs and exported Trace attributes", async () => {
	const exports: string[] = [];
	const logs: string[] = [];
	const collector = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		exports.push(Buffer.concat(chunks).toString());
		response.end();
	});
	await new Promise<void>((resolve) =>
		collector.listen(0, "127.0.0.1", resolve),
	);
	const address = collector.address();
	if (!address || typeof address === "string")
		throw new Error("No test collector");
	const telemetry = startObservability({
		service: "platform-api",
		otlpEndpoint: `http://127.0.0.1:${address.port}`,
		output: new Writable({
			write(chunk, _encoding, done) {
				logs.push(String(chunk));
				done();
			},
		}),
	});
	try {
		telemetry.record({
			stage: "dependency",
			outcome: "failed",
			traceId: "123e4567-e89b-42d3-a456-426614174003",
			nativeAdmission: {
				stage: "metadata.second",
				phase: "failed",
				protocolVersion: 1,
				elapsedMs: 23,
				reason: "dependency",
				cancelSource: "UNKNOWN",
				parameters: "PRIVATE_PARAMETERS",
				skill: "PRIVATE_SKILL",
				dn: "PRIVATE_DN",
				userId: "PRIVATE_USER",
				cookie: "PRIVATE_COOKIE",
				message: "PRIVATE_MESSAGE",
				stack: "PRIVATE_STACK",
				sqlState: "PRIVATE_SQL",
			},
		});
		const stages = createNativeAdmissionTelemetry((value) =>
			telemetry.record({
				stage: "dependency",
				outcome: "completed",
				nativeAdmission: value,
			}),
		);
		stages.observe({
			stage: "store.lock",
			phase: "started",
			observationId: 10,
			elapsedMs: 0,
		});
		stages.cancel("internal_deadline");
		stages.observe({
			stage: "store.lock",
			phase: "completed",
			observationId: 10,
			elapsedMs: 100,
		});
		await telemetry.close();
		expect(logs.join("")).toContain("metadata.second");
		expect(exports.join("")).toContain("metadata.second");
		expect(logs.join("")).toContain("completed_after_cancel");
		expect(exports.join("")).toContain("completed_after_cancel");
		for (const output of [...logs, ...exports])
			expect(output).not.toContain("PRIVATE_");
	} finally {
		await telemetry.close();
		await new Promise<void>((resolve) => collector.close(() => resolve()));
	}
}, 10_000);

it.each([401, 403])(
	"does not call an identity rejection %s a dependency failure",
	(status) => {
		const values: unknown[] = [];
		createNativeAdmissionTelemetry((v) => values.push(v)).observe({
			stage: "identity.initial",
			phase: "failed",
			elapsedMs: 1,
			error: Object.assign(new Error("PRIVATE_CANARY"), { status }),
		});
		expect(projectNativeAdmission(values[0])).toMatchObject({
			reason: "UNKNOWN",
		});
		expect(JSON.stringify(values)).not.toContain("PRIVATE_CANARY");
	},
);

it.each(["client_abort", "internal_deadline"] as const)(
	"retains completion after %s without calling it ok",
	(source) => {
		const values: unknown[] = [];
		const telemetry = createNativeAdmissionTelemetry((v) => values.push(v));
		telemetry.observe({
			stage: "store.lock",
			phase: "started",
			observationId: 101,
			elapsedMs: 0,
		});
		telemetry.cancel(source);
		telemetry.observe({
			stage: "store.lock",
			phase: "completed",
			observationId: 101,
			elapsedMs: 150,
		});
		expect(projectNativeAdmission(values.at(-1))).toMatchObject({
			nativeAdmissionPhase: "completed",
			elapsedMs: 150,
			reason: "completed_after_cancel",
			cancelSource: source,
		});
	},
);
