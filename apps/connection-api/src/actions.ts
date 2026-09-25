import { randomUUID } from "node:crypto";
import {
	ClientAuthorizationDenied,
	ConnectionAuthorizationDenied,
	DirectActionConflict,
	findDirectActionCall,
	InvalidDpopProof,
	reserveDirectActionCall,
} from "@agent-infra/connection-core";
import {
	DirectActionRequestV1Schema,
	DirectPayloadMaximumByteLengthV1,
} from "@agent-infra/contracts/pilot";
import Ajv2020 from "ajv/dist/2020.js";
import type { Context, Hono } from "hono";
import {
	authenticateDirectClient,
	type ConnectionClientDependencies,
} from "./client.js";

const noStore = { "Cache-Control": "no-store" };
const validator = new Ajv2020({ strict: false });

class InvalidActionRequest extends Error {}

function actionError(context: Context, error: unknown) {
	const status =
		error instanceof InvalidActionRequest || error instanceof SyntaxError
			? 400
			: error instanceof ClientAuthorizationDenied ||
					error instanceof InvalidDpopProof
				? 401
				: error instanceof DirectActionConflict
					? 409
					: error instanceof ConnectionAuthorizationDenied
						? 403
						: 503;
	const code = {
		400: "INVALID_REQUEST",
		401: "AUTHENTICATION_REQUIRED",
		403: "CONNECTION_AUTHORIZATION_REQUIRED",
		409: "ACTION_UNAVAILABLE",
		503: "CONNECTION_UNAVAILABLE",
	} as const;
	return context.json(
		{
			schemaVersion: 1,
			code: code[status],
			message: status === 503 ? "Connection unavailable" : "Action unavailable",
			traceId: randomUUID(),
			retryable: status === 503,
		},
		status,
		noStore,
	);
}

async function readActionBody(context: Context) {
	const contentType = context.req.header("content-type") ?? "";
	if (!/^application\/json(?:;|$)/i.test(contentType))
		throw new InvalidActionRequest();
	const declaredLength = context.req.header("content-length");
	if (
		declaredLength &&
		(!/^\d+$/.test(declaredLength) ||
			Number(declaredLength) > DirectPayloadMaximumByteLengthV1)
	)
		throw new InvalidActionRequest();
	const reader = context.req.raw.body?.getReader();
	if (!reader) throw new InvalidActionRequest();
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > DirectPayloadMaximumByteLengthV1) {
			await reader.cancel();
			throw new InvalidActionRequest();
		}
		chunks.push(value);
	}
	try {
		return JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
		);
	} catch {
		throw new InvalidActionRequest();
	}
}

export function addConnectionActionRoutes(
	app: Hono,
	client: ConnectionClientDependencies,
) {
	const authority = client.authority;
	if (!authority) throw new Error("Connection Action authority is required");

	app.post("/api/v1/actions", async (context) => {
		try {
			const credential = await authenticateDirectClient(context, client);
			const parsed = DirectActionRequestV1Schema.safeParse(
				await readActionBody(context),
			);
			if (!parsed.success) throw new InvalidActionRequest();
			const body = parsed.data;
			const version = await authority.findPublishedActionVersion({
				providerId: body.action.providerId,
				actionId: body.action.actionId,
				version: body.action.actionVersion,
			});
			if (!version) throw new ConnectionAuthorizationDenied();
			let validateArguments: ReturnType<typeof validator.compile>;
			try {
				validateArguments = validator.compile(version.inputSchema);
			} catch {
				throw new Error("Published Action schema is invalid");
			}
			if (!validateArguments(body.action.arguments))
				throw new InvalidActionRequest();
			const record = await reserveDirectActionCall(authority, {
				caller: credential,
				audience: client.audience,
				requestId: body.requestId,
				idempotencyKey: body.idempotencyKey,
				traceId: body.traceId,
				actionVersionId: version.id,
				effect: version.effect,
				arguments: body.action.arguments,
			});
			return context.json(
				{
					schemaVersion: 1,
					requestId: record.requestId,
					idempotencyKey: record.idempotencyKey,
					traceId: record.traceId,
					callId: record.callId,
					status: "reserved",
				},
				202,
				noStore,
			);
		} catch (error) {
			return actionError(context, error);
		}
	});

	app.get("/api/v1/actions/:callId", async (context) => {
		try {
			const credential = await authenticateDirectClient(context, client);
			const callId = context.req.param("callId");
			if (callId.length > 128) throw new InvalidActionRequest();
			const record = await findDirectActionCall(
				authority,
				credential,
				client.audience,
				callId,
			);
			if (!record)
				return context.json(
					{
						schemaVersion: 1,
						code: "RESOURCE_UNAVAILABLE",
						message: "Action unavailable",
						traceId: randomUUID(),
						retryable: false,
					},
					404,
					noStore,
				);
			return context.json(
				{
					schemaVersion: 1,
					requestId: record.requestId,
					idempotencyKey: record.idempotencyKey,
					traceId: record.traceId,
					callId: record.callId,
					status: record.status,
				},
				200,
				noStore,
			);
		} catch (error) {
			return actionError(context, error);
		}
	});
}
