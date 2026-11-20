import { createServer } from "node:http";
import { Writable } from "node:stream";
import { expect, it } from "vitest";
import { startObservability } from "./index.js";
import { projectModelTransport } from "./model-transport.js";

it("projects only fixed transport classes, stages and observed HTTP status", () => {
	let reads = 0;
	expect(
		projectModelTransport({
			get stage() {
				return ++reads === 1 ? "response_headers" : "PRIVATE_CANARY";
			},
			errorClass: "UNKNOWN",
			elapsedMs: 1,
		}),
	).toEqual({
		modelTransportStage: "response_headers",
		modelTransportErrorClass: "UNKNOWN",
		modelTransportElapsedMs: 1,
	});
	expect(reads).toBe(1);

	expect(
		projectModelTransport({
			stage: "response_headers",
			errorClass: "dns",
			elapsedMs: 7,
			upstreamStatus: 503,
		}),
	).not.toHaveProperty("modelTransportHttpStatus");

	for (const errorClass of [
		"dns",
		"tls",
		"connect_refused",
		"connection_reset",
		"timeout",
		"UNKNOWN",
	]) {
		expect(
			projectModelTransport({
				stage: "response_body",
				errorClass,
				elapsedMs: 7,
				upstreamStatus: 200,
				message: "PRIVATE_CANARY",
			}),
		).toEqual({
			modelTransportStage: "response_body",
			modelTransportErrorClass: errorClass,
			modelTransportElapsedMs: 7,
			modelTransportHttpStatus: 200,
		});
	}
	expect(
		projectModelTransport({
			stage: "response_headers",
			errorClass: "UNKNOWN",
			elapsedMs: 7,
			upstreamStatus: "PRIVATE_CANARY",
		}),
	).not.toHaveProperty("modelTransportHttpStatus");
	for (const patch of [
		{ stage: "PRIVATE_CANARY" },
		{ errorClass: "PRIVATE_CANARY" },
		{ elapsedMs: -1 },
		{ elapsedMs: Number.POSITIVE_INFINITY },
	]) {
		expect(
			projectModelTransport({
				stage: "response_headers",
				errorClass: "UNKNOWN",
				elapsedMs: 7,
				...patch,
			}),
		).toBeUndefined();
	}
});

it("keeps content and exception canaries out of real Pino and OTLP transport diagnostics", async () => {
	const exports: Buffer[] = [];
	const logs: string[] = [];
	const collector = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		exports.push(Buffer.concat(chunks));
		response.end();
	});
	await new Promise<void>((resolve) =>
		collector.listen(0, "127.0.0.1", resolve),
	);
	const address = collector.address();
	if (!address || typeof address === "string")
		throw new Error("missing collector");
	const telemetry = startObservability({
		service: "agent-runtime-host",
		otlpEndpoint: `http://127.0.0.1:${address.port}`,
		output: new Writable({
			write(chunk, _encoding, done) {
				logs.push(String(chunk));
				done();
			},
		}),
	});
	const canaries = [
		"PRIVATE_KEY",
		"PRIVATE_TOKEN",
		"PRIVATE_COOKIE",
		"PRIVATE_REQUEST_BODY",
		"PRIVATE_RESPONSE_BODY",
		"PRIVATE_QUERY",
		"PRIVATE_ERROR",
		"PRIVATE_STACK",
	];
	try {
		telemetry.record({
			stage: "model",
			outcome: "unknown",
			code: "OPERATION_UNKNOWN",
			executionId: "123e4567-e89b-42d3-a456-426614174004",
			operationRef: "123e4567-e89b-42d3-a456-426614174005",
			modelTransport: {
				stage: "response_headers",
				errorClass: "tls",
				elapsedMs: 17,
				private: canaries,
				message: canaries[6],
				stack: canaries[7],
				url: `https://model.invalid/?key=${canaries[0]}&q=${canaries[5]}`,
				headers: { authorization: canaries[1], cookie: canaries[2] },
				request: canaries[3],
				response: canaries[4],
			},
		});
		// A malformed diagnostic cannot smuggle an arbitrary exception class or HTTP status.
		telemetry.record({
			stage: "model",
			outcome: "unknown",
			modelTransport: {
				stage: "response_headers",
				errorClass: canaries[6],
				elapsedMs: 1,
				upstreamStatus: canaries[0],
			},
		});
	} finally {
		await telemetry.close();
		await new Promise<void>((resolve) => collector.close(() => resolve()));
	}
	const output = logs.join("");
	expect(output).toContain('"modelTransportErrorClass":"tls"');
	expect(output).toContain('"modelTransportStage":"response_headers"');
	expect(output).toContain(
		'"executionId":"123e4567-e89b-42d3-a456-426614174004"',
	);
	expect(output).not.toContain("modelTransportHttpStatus");
	const otlp = Buffer.concat(exports).toString();
	expect(otlp).toContain("modelTransportErrorClass");
	expect(otlp).toContain("123e4567-e89b-42d3-a456-426614174005");
	for (const canary of canaries) {
		expect(output).not.toContain(canary);
		expect(otlp).not.toContain(canary);
	}
});
