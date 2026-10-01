import { timingSafeEqual } from "node:crypto";

import { type RuntimeHost, RuntimeHostError } from "@agent-infra/agent-runtime";
import {
	type ExecutionGrantV1,
	RuntimeAuthorizationRenewRequestV3Schema,
	RuntimeCapabilitiesRequestV1Schema,
	RuntimeEventAckRequestV3Schema,
	RuntimeEventPersistRequestV3Schema,
	type RuntimeExecutionGrantV2,
	RuntimeGenerationCancelRequestV1Schema,
	RuntimeGenerationCancelRequestV3Schema,
	RuntimeNativeMetadataBindingRequestV1Schema,
	RuntimeNativeMetadataBindingResponseV1Schema,
	RuntimeNativeMetadataReadRequestV1Schema,
	RuntimeNativeMetadataReadResponseV1Schema,
	RuntimeReplayRequestV1Schema,
	RuntimeStatusRequestV1Schema,
	RuntimeStatusRequestV2Schema,
	RuntimeStatusRequestV3Schema,
	RuntimeStopRequestV1Schema,
	RuntimeStopRequestV3Schema,
	RuntimeSubmitTurnRequestV1Schema,
	RuntimeSubmitTurnRequestV2Schema,
	RuntimeSubmitTurnRequestV3Schema,
	RuntimeSupplementRequestV1Schema,
	RuntimeSupplementRequestV3Schema,
	type VerifiedExecutionGrantV1,
	type VerifiedRuntimeExecutionGrantV2,
	WorkloadReadinessRequestV1Schema,
} from "@agent-infra/contracts/runtime";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export const runtimeHostService = "agent-runtime-host";

interface RuntimeHostAppOptions {
	/** Dedicated metadata transport credential identifies the verifier's exact Worker. */
	nativeMetadata?: { readonly workerId: string; readonly serviceToken: string };
	/** Identity authenticated by this deployment's service token. Never a caller field. */
	runtimeWorkerId?: string;
	verifyGrantV2?: (
		grant: RuntimeExecutionGrantV2,
	) =>
		| VerifiedRuntimeExecutionGrantV2
		| Promise<VerifiedRuntimeExecutionGrantV2>;
	/** The transport token authenticates this deployment-provisioned Worker identity. */
	readinessWorkerId?: string;
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
	if (
		options.nativeMetadata &&
		(!options.nativeMetadata.workerId ||
			!options.nativeMetadata.serviceToken ||
			options.nativeMetadata.serviceToken === options.serviceToken)
	)
		throw new Error("Metadata service identity configuration is invalid");
	const app = new Hono<{ Variables: { metadataSignal: AbortSignal } }>();

	app.get("/healthz", (context) =>
		context.json({ service: runtimeHostService, status: "ok" }),
	);

	app.use("/internal/runtime/*", async (context, next) => {
		const expectedToken = context.req.path.startsWith(
			"/internal/runtime/native-metadata/",
		)
			? options.nativeMetadata?.serviceToken
			: options.serviceToken;
		if (
			!expectedToken ||
			!authorized(context.req.header("authorization"), expectedToken)
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

	app.use("/internal/runtime/native-metadata/*", async (context, next) => {
		context.set("metadataSignal", context.req.raw.signal);
		await next();
	});
	app.use(
		"/internal/runtime/native-metadata/*",
		bodyLimit({
			maxSize: 65_536,
			onError: () => {
				throw new RuntimeHostError(
					"RUNTIME_REQUEST_INVALID",
					"Runtime request is invalid",
					400,
				);
			},
		}),
	);
	if (options.nativeMetadata) {
		app.post(
			"/internal/runtime/native-metadata/v1/binding",
			async (context) => {
				const request = context.req.raw;
				const signal = context.get("metadataSignal");
				const workerId = options.nativeMetadata?.workerId;
				if (!workerId || new URL(request.url).search)
					throw new RuntimeHostError(
						"RUNTIME_REQUEST_INVALID",
						"Runtime request is invalid",
						400,
					);
				const body = await parseBody(
					request,
					RuntimeNativeMetadataBindingRequestV1Schema,
				);
				signal.throwIfAborted();
				const result = RuntimeNativeMetadataBindingResponseV1Schema.parse(
					await options.host.resolveNativeMetadataBindingV1(
						body,
						workerId,
						signal,
					),
				);
				signal.throwIfAborted();
				return context.json(result);
			},
		);
		app.post("/internal/runtime/native-metadata/v1/read", async (context) => {
			const request = context.req.raw;
			const signal = context.get("metadataSignal");
			const workerId = options.nativeMetadata?.workerId;
			if (!workerId || new URL(request.url).search)
				throw new RuntimeHostError(
					"RUNTIME_REQUEST_INVALID",
					"Runtime request is invalid",
					400,
				);
			const body = await parseBody(
				request,
				RuntimeNativeMetadataReadRequestV1Schema,
			);
			signal.throwIfAborted();
			const result = RuntimeNativeMetadataReadResponseV1Schema.parse(
				await options.host.readNativeMetadataV1(body, workerId, signal),
			);
			signal.throwIfAborted();
			return context.json(result);
		});
	}

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
	app.post("/internal/runtime/v1/readiness", async (context) => {
		if (!options.readinessWorkerId)
			throw new RuntimeHostError(
				"RUNTIME_READINESS_UNAVAILABLE",
				"Workload readiness is not configured",
				503,
				true,
			);
		const request = await parseBody(
			context.req.raw,
			WorkloadReadinessRequestV1Schema,
		);
		return context.json(
			await options.host.readiness(
				request,
				options.readinessWorkerId,
				context.req.raw.signal,
			),
		);
	});
	app.post("/internal/runtime/v2/turns", async (context) => {
		const request = await parseBody(
			context.req.raw,
			RuntimeSubmitTurnRequestV2Schema,
		);
		return context.json(
			await options.host.submitTurnV2(
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
	app.post("/internal/runtime/v2/status", async (context) => {
		const request = await parseBody(
			context.req.raw,
			RuntimeStatusRequestV2Schema,
		);
		return context.json(
			await options.host.recoverStatusV2(
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

	async function verifyV2(grant: RuntimeExecutionGrantV2) {
		if (!options.verifyGrantV2 || !options.runtimeWorkerId)
			throw new RuntimeHostError(
				"RUNTIME_GRANT_INVALID",
				"Runtime authorization is not configured",
				403,
			);
		const verified = await options.verifyGrantV2(grant);
		if (verified.claims.workerId !== options.runtimeWorkerId)
			throw new RuntimeHostError(
				"RUNTIME_GRANT_INVALID",
				"Runtime authorization does not match this deployment",
				403,
			);
		return verified;
	}
	function v3Route<T extends { grant: RuntimeExecutionGrantV2 }>(
		path: string,
		parser: Parser<T>,
		invoke: (
			request: T,
			verification: VerifiedRuntimeExecutionGrantV2,
			signal: AbortSignal,
		) => Promise<{ schemaVersion: 3 }>,
	) {
		app.post(`/internal/runtime/v3/${path}`, async (context) => {
			const request = await parseBody(context.req.raw, parser);
			return context.json(
				await invoke(
					request,
					await verifyV2(request.grant),
					context.req.raw.signal,
				),
			);
		});
	}
	v3Route("turns", RuntimeSubmitTurnRequestV3Schema, (request, verification) =>
		options.host.submitTurnV3(request, verification),
	);
	v3Route(
		"instructions",
		RuntimeSupplementRequestV3Schema,
		(request, verification) => options.host.supplementV3(request, verification),
	);
	v3Route("stops", RuntimeStopRequestV3Schema, (request, verification) =>
		options.host.stopV3(request, verification),
	);
	v3Route(
		"status",
		RuntimeStatusRequestV3Schema,
		(request, verification, signal) =>
			options.host.recoverStatusV3(request, verification, signal),
	);
	v3Route(
		"original-binding",
		RuntimeStatusRequestV3Schema,
		(request, verification) =>
			options.host.readOriginalBinding(request, verification),
	);
	v3Route(
		"generations/cancel",
		RuntimeGenerationCancelRequestV3Schema,
		(request, verification) =>
			options.host.cancelGenerationV3(request, verification),
	);
	v3Route(
		"authorizations/renew",
		RuntimeAuthorizationRenewRequestV3Schema,
		(request, verification) =>
			options.host.renewAuthorizationV3(request, verification),
	);
	v3Route(
		"events/ack",
		RuntimeEventAckRequestV3Schema,
		(request, verification) =>
			options.host.acknowledgeEventsV3(request, verification),
	);
	app.post("/internal/runtime/v3/events/stream", async (context) => {
		const request = await parseBody(
			context.req.raw,
			RuntimeEventPersistRequestV3Schema,
		);
		const abort = new AbortController();
		const signal = AbortSignal.any([context.req.raw.signal, abort.signal]);
		const events = await options.host.streamEventsV3(
			request,
			await verifyV2(request.grant),
			signal,
		);
		return streamSSE(
			context,
			async (stream) => {
				stream.onAbort(() => abort.abort());
				try {
					for await (const event of events) {
						await stream.writeSSE({
							id: event.cursor,
							event: event.type,
							data: JSON.stringify(event),
						});
					}
				} finally {
					abort.abort();
				}
			},
			async () => {
				abort.abort();
			},
		);
	});

	app.onError((error, context) => {
		const readinessRequest =
			context.req.path === "/internal/runtime/v1/readiness";
		const runtimeError =
			error instanceof RuntimeHostError
				? error
				: readinessRequest && context.req.raw.signal.aborted
					? new RuntimeHostError(
							"RUNTIME_READINESS_UNAVAILABLE",
							"Runtime request was interrupted",
							503,
							true,
						)
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
