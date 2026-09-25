import { randomUUID } from "node:crypto";
import {
	ClientAuthorizationDenied,
	ConnectionAuthorizationDenied,
	consumerActorSentinel,
	DirectActionConflict,
	findDirectActionCall,
	InvalidDirectActionArguments,
	InvalidDpopProof,
	reservePublishedDirectActionCall,
	reservePublishedDirectMcpActionCall,
} from "@agent-infra/connection-core";
import {
	DirectActionRequestV1Schema,
	DirectMcpClientRequestMetaV1Schema,
	DirectMcpExecuteActionArgumentsV1Schema,
	DirectMcpExecuteActionRequestV1Schema,
	DirectPayloadMaximumByteLengthV1,
} from "@agent-infra/contracts/pilot";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
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
		error instanceof InvalidActionRequest ||
		error instanceof InvalidDirectActionArguments ||
		error instanceof SyntaxError
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

function validateActionArguments(
	schema: Record<string, unknown>,
	argumentsValue: unknown,
): boolean {
	let validate: ReturnType<typeof validator.compile>;
	try {
		validate = validator.compile(schema);
	} catch {
		throw new Error("Published Action schema is invalid");
	}
	return Boolean(validate(argumentsValue));
}

export function addConnectionActionRoutes(
	app: Hono,
	client: ConnectionClientDependencies,
) {
	const authority = client.authority;
	if (!authority) throw new Error("Connection Action authority is required");

	app.get("/api/client/identity", async (context) => {
		try {
			const caller = await authenticateDirectClient(context, client);
			return context.json(
				{
					principal: { type: "user", key: caller.principalId },
					actorId: caller.actorId ?? consumerActorSentinel,
					consumerId: caller.consumerId,
					clientId: caller.consumerInstanceId,
					issuer: client.auth.publicOrigin,
					resource: client.audience,
					revision: caller.credentialId,
					expiresAt: caller.credentialExpiresAt,
				},
				200,
				noStore,
			);
		} catch (error) {
			return actionError(context, error);
		}
	});

	app.get("/api/client/calls/:callRef", async (context) => {
		try {
			const caller = await authenticateDirectClient(
				context,
				client,
				"calls:read",
			);
			const callRef = context.req.param("callRef");
			if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(callRef))
				throw new InvalidActionRequest();
			const record = await findDirectActionCall(
				authority,
				caller,
				client.audience,
				callRef,
				"calls:read",
			);
			if (!record?.mcpBinding)
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
					callRef: record.callId,
					operationNonce: record.mcpBinding.operationNonce,
					requestDigestVersion: record.mcpBinding.requestDigestVersion,
					requestDigest: record.mcpBinding.requestDigest,
					principal: { type: "user", key: record.principalId },
					actorId: record.actorId,
					actionVersionId: record.actionVersionId,
					attemptNonces: record.mcpBinding.attemptNonces,
					consumerId: record.consumerId,
					clientId: record.consumerInstanceId,
				},
				200,
				noStore,
			);
		} catch (error) {
			return actionError(context, error);
		}
	});

	app.all("/mcp", async (context) => {
		try {
			const caller = await authenticateDirectClient(context, client);
			const body =
				context.req.method === "POST"
					? await readActionBody(context)
					: undefined;
			if (Array.isArray(body)) throw new InvalidActionRequest();
			if (
				body &&
				typeof body === "object" &&
				!Array.isArray(body) &&
				"method" in body &&
				body.method === "tools/call" &&
				"params" in body &&
				typeof body.params === "object" &&
				body.params !== null &&
				"name" in body.params &&
				body.params.name === "execute_action" &&
				!DirectMcpExecuteActionRequestV1Schema.safeParse(body).success
			)
				throw new InvalidActionRequest();
			const server = new McpServer({
				name: "agent-infra-connection",
				version: "1.0.0",
			});
			server.registerTool(
				"execute_action",
				{
					description: "Reserve an authorized Connection ActionCall",
					inputSchema: DirectMcpExecuteActionArgumentsV1Schema,
				},
				async (argumentsValue, extra) => {
					try {
						const binding = DirectMcpClientRequestMetaV1Schema.parse(
							extra._meta?.["connection.clientRequest/v1"],
						);
						const record = await reservePublishedDirectMcpActionCall(
							authority,
							{
								caller,
								audience: client.audience,
								selector: {
									providerId: argumentsValue.providerId,
									actionId: argumentsValue.actionId,
									version: argumentsValue.actionVersion,
								},
								arguments: argumentsValue.input,
								meta: binding,
								validateArguments: validateActionArguments,
							},
						);
						if (!record.mcpBinding)
							throw new Error("MCP receipt binding missing");
						return {
							content: [{ type: "text" as const, text: "Action reserved" }],
							structuredContent: { callId: record.callId, status: "RESERVED" },
							_meta: {
								"connection.receipt/v1": {
									callRef: record.callId,
									operationNonce: binding.operationNonce,
									attemptNonce: binding.attemptNonce,
									requestDigestVersion: "connection-request-v1",
									requestDigest: record.mcpBinding.requestDigest,
									principal: { type: "user", key: record.principalId },
									actorId: record.actorId,
									actionVersionId: record.actionVersionId,
								},
							},
						};
					} catch (error) {
						const code =
							error instanceof DirectActionConflict
								? "ACTION_CONFLICT"
								: error instanceof InvalidDirectActionArguments
									? "INVALID_ARGUMENTS"
									: error instanceof ConnectionAuthorizationDenied
										? "ACTION_UNAVAILABLE"
										: "CONNECTION_UNAVAILABLE";
						return {
							isError: true,
							content: [{ type: "text" as const, text: code }],
						};
					}
				},
			);
			const transport = new WebStandardStreamableHTTPServerTransport({
				enableJsonResponse: true,
			});
			await server.connect(transport);
			const response = await transport.handleRequest(context.req.raw, {
				...(context.req.method === "POST" ? { parsedBody: body } : {}),
			});
			response.headers.set("Cache-Control", "no-store");
			return response;
		} catch (error) {
			return actionError(context, error);
		}
	});

	app.post("/api/v1/actions", async (context) => {
		try {
			const credential = await authenticateDirectClient(context, client);
			const parsed = DirectActionRequestV1Schema.safeParse(
				await readActionBody(context),
			);
			if (!parsed.success) throw new InvalidActionRequest();
			const body = parsed.data;
			const record = await reservePublishedDirectActionCall(authority, {
				caller: credential,
				audience: client.audience,
				requestId: body.requestId,
				idempotencyKey: body.idempotencyKey,
				traceId: body.traceId,
				selector: {
					providerId: body.action.providerId,
					actionId: body.action.actionId,
					version: body.action.actionVersion,
				},
				arguments: body.action.arguments,
				validateArguments: validateActionArguments,
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
