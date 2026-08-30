import { timingSafeEqual } from "node:crypto";

import { type RuntimeHost, RuntimeHostError } from "@agent-infra/agent-runtime";
import {
	type ExecutionGrantV1,
	RuntimeCapabilitiesRequestV1Schema,
	RuntimeGenerationCancelRequestV1Schema,
	RuntimeReplayRequestV1Schema,
	RuntimeStatusRequestV1Schema,
	RuntimeStopRequestV1Schema,
	RuntimeSubmitTurnRequestV1Schema,
	RuntimeSupplementRequestV1Schema,
	type VerifiedExecutionGrantV1,
} from "@agent-infra/contracts/runtime";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export const runtimeHostService = "agent-runtime-host";

interface RuntimeHostAppOptions {
	host: RuntimeHost;
	serviceToken: string;
	verifyGrant: (
		grant: ExecutionGrantV1,
	) => VerifiedExecutionGrantV1 | Promise<VerifiedExecutionGrantV1>;
}

interface Parser<T> {
	safeParse(value: unknown): { success: true; data: T } | { success: false };
}

async function parseBody<T>(request: Request, parser: Parser<T>) {
	const value = await request.json().catch(() => undefined);
	const parsed = parser.safeParse(value);
	if (!parsed.success) {
		throw new RuntimeHostError(
			"RUNTIME_REQUEST_INVALID",
			"Runtime request is invalid",
			400,
		);
	}
	return parsed.data;
}

function authorized(header: string | undefined, expectedToken: string) {
	if (!header?.startsWith("Bearer ")) return false;
	const supplied = Buffer.from(header.slice("Bearer ".length));
	const expected = Buffer.from(expectedToken);
	return (
		supplied.length === expected.length && timingSafeEqual(supplied, expected)
	);
}

export function createRuntimeHostApp(options: RuntimeHostAppOptions) {
	const app = new Hono();

	app.get("/healthz", (context) =>
		context.json({ service: runtimeHostService, status: "ok" }),
	);

	app.use("/internal/runtime/*", async (context, next) => {
		if (
			!authorized(context.req.header("authorization"), options.serviceToken)
		) {
			return context.json(
				{
					schemaVersion: 1,
					code: "RUNTIME_SERVICE_UNAUTHORIZED",
					message: "Runtime service authentication failed",
					retryable: false,
					traceId: context.req.header("x-trace-id") ?? crypto.randomUUID(),
				},
				401,
			);
		}
		await next();
	});

	app.post("/internal/runtime/v1/turns", async (context) => {
		const request = await parseBody(
			context.req.raw,
			RuntimeSubmitTurnRequestV1Schema,
		);
		return context.json(
			await options.host.submitTurn(
				request,
				await options.verifyGrant(request.grant),
			),
		);
	});
	app.post("/internal/runtime/v1/instructions", async (context) => {
		const request = await parseBody(
			context.req.raw,
			RuntimeSupplementRequestV1Schema,
		);
		return context.json(
			await options.host.supplement(
				request,
				await options.verifyGrant(request.grant),
			),
		);
	});
	app.post("/internal/runtime/v1/stops", async (context) => {
		const request = await parseBody(
			context.req.raw,
			RuntimeStopRequestV1Schema,
		);
		return context.json(
			await options.host.stop(
				request,
				await options.verifyGrant(request.grant),
			),
		);
	});
	app.post("/internal/runtime/v1/status", async (context) => {
		const request = await parseBody(
			context.req.raw,
			RuntimeStatusRequestV1Schema,
		);
		return context.json(
			await options.host.status(
				request,
				await options.verifyGrant(request.grant),
			),
		);
	});
	app.post("/internal/runtime/v1/capabilities", async (context) => {
		const request = await parseBody(
			context.req.raw,
			RuntimeCapabilitiesRequestV1Schema,
		);
		return context.json(
			await options.host.capabilities(
				request,
				await options.verifyGrant(request.grant),
			),
		);
	});
	app.post("/internal/runtime/v1/events/replay", async (context) => {
		const request = await parseBody(
			context.req.raw,
			RuntimeReplayRequestV1Schema,
		);
		const replay = await options.host.replay(
			request,
			await options.verifyGrant(request.grant),
		);
		return streamSSE(context, async (stream) => {
			for (const event of replay.events) {
				await stream.writeSSE({
					id: event.cursor,
					event: event.type,
					data: JSON.stringify(event),
				});
			}
		});
	});
	app.post("/internal/runtime/v1/events/stream", async (context) => {
		const request = await parseBody(
			context.req.raw,
			RuntimeReplayRequestV1Schema,
		);
		const events = await options.host.streamEvents(
			request,
			await options.verifyGrant(request.grant),
			context.req.raw.signal,
		);
		return streamSSE(context, async (stream) => {
			for await (const event of events) {
				await stream.writeSSE({
					id: event.cursor,
					event: event.type,
					data: JSON.stringify(event),
				});
			}
		});
	});
	app.post("/internal/runtime/v1/generations/cancel", async (context) => {
		const request = await parseBody(
			context.req.raw,
			RuntimeGenerationCancelRequestV1Schema,
		);
		return context.json(
			await options.host.cancelGeneration(
				request,
				await options.verifyGrant(request.grant),
			),
		);
	});

	app.onError((error, context) => {
		const runtimeError =
			error instanceof RuntimeHostError
				? error
				: new RuntimeHostError(
						"RUNTIME_INTERNAL_ERROR",
						"Runtime request failed",
						500,
						true,
					);
		return context.json(
			{
				schemaVersion: 1,
				code: runtimeError.code,
				message: runtimeError.message,
				retryable: runtimeError.retryable,
				traceId: context.req.header("x-trace-id") ?? crypto.randomUUID(),
			},
			runtimeError.httpStatus as ContentfulStatusCode,
		);
	});

	return app;
}
