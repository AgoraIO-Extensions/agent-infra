import {
	type ConnectionApplicationService,
	ConnectionError,
	type DelegatedAssertionBinding,
	type GitHubActionName,
	OAuthProtocolError,
} from "@agent-infra/connection-core";
import { Hono } from "hono";

import {
	type ConnectionOAuthServerOptions,
	createConnectionOAuthApp,
} from "./oauth-routes";

export const connectionApiService = "connection-api";

export type ConnectionAccessTokenVerifier = {
	verifyAccessToken(
		authorization: string | undefined,
	): Promise<{ consumerId: string; instanceId: string; principalId: string }>;
};

export type ConnectionManagementIdentityVerifier = {
	principalFromAuthorization(
		authorization: string | undefined,
	): Promise<string>;
};

export type DelegatedIdentityVerifier = {
	verifyDelegatedAssertion(
		assertion: string | undefined,
		binding: {
			action: GitHubActionName;
			actionVersionId: string;
			args: Record<string, unknown>;
			deadlineAt: string;
			idempotencyKey: string | undefined;
		},
	): Promise<DelegatedAssertionBinding & { workload: string }>;
};

export type ConnectionAppOptions = {
	accessTokens?: ConnectionAccessTokenVerifier;
	delegatedIdentity?: DelegatedIdentityVerifier;
	directMcpEnabled?: boolean;
	githubProviderEnabled?: boolean;
	githubOAuthRedirectUri?: string;
	managementIdentity?: ConnectionManagementIdentityVerifier;
	oauthServer?: ConnectionOAuthServerOptions;
	service?: ConnectionApplicationService;
};

function actionFromRoute(value: string): GitHubActionName {
	if (!/^[a-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) {
		throw new ConnectionError("INVALID_REQUEST", "Unknown action");
	}
	return value;
}

function actionFromVersionId(value: string): GitHubActionName {
	const separator = value.lastIndexOf("@");
	if (separator <= 0) {
		throw new ConnectionError("INVALID_REQUEST", "Unknown action version");
	}
	return actionFromRoute(value.slice(0, separator));
}

async function parseJson(request: Request): Promise<unknown> {
	try {
		return await request.json();
	} catch {
		throw new ConnectionError(
			"INVALID_REQUEST",
			"Action arguments must be valid JSON",
		);
	}
}

function errorStatus(error: ConnectionError) {
	if (error.code === "AUTHENTICATION_FAILED") return 401;
	if (error.code === "INVALID_REQUEST") return 400;
	if (error.code === "IDEMPOTENCY_CONFLICT") return 409;
	if (error.code === "PROVIDER_UNCERTAIN") return 202;
	if (error.code === "PROVIDER_FAILED") return 502;
	return 403;
}

function requireService(service: ConnectionApplicationService | undefined) {
	if (!service) {
		throw new ConnectionError(
			"PROVIDER_FAILED",
			"Connection application is not configured",
		);
	}
	return service;
}

function requireAccessTokens(options: ConnectionAppOptions) {
	if (!options.accessTokens) {
		throw new ConnectionError(
			"AUTHENTICATION_FAILED",
			"Connection access token is required",
		);
	}
	return options.accessTokens;
}

async function managementPrincipal(
	options: ConnectionAppOptions,
	authorization: string | undefined,
) {
	if (!options.managementIdentity) {
		throw new ConnectionError(
			"AUTHENTICATION_FAILED",
			"Connection management identity is required",
		);
	}
	return options.managementIdentity.principalFromAuthorization(authorization);
}

function githubOAuthRedirectUri(options: ConnectionAppOptions) {
	const redirectUri =
		options.githubOAuthRedirectUri ??
		process.env.CONNECTION_GITHUB_REDIRECT_URI;
	if (!redirectUri) {
		throw new ConnectionError(
			"PROVIDER_FAILED",
			"GitHub OAuth redirect URI is not configured",
		);
	}
	return redirectUri;
}

type JsonRpcRequest = {
	id?: string | number | null;
	jsonrpc?: string;
	method?: string;
	params?: unknown;
};

function mcpError(id: JsonRpcRequest["id"], code: number, message: string) {
	return { error: { code, message }, id: id ?? null, jsonrpc: "2.0" };
}

function mcpResult(id: JsonRpcRequest["id"], result: unknown) {
	return { id: id ?? null, jsonrpc: "2.0", result };
}

const openConnectorMcpTools = [
	{
		description: "List available provider apps with authorized action counts.",
		inputSchema: {
			additionalProperties: false,
			properties: { query: { type: "string" } },
			type: "object",
		},
		name: "list_apps",
		title: "List Apps",
	},
	{
		description:
			"List configured provider connections and safe account profiles.",
		inputSchema: {
			additionalProperties: false,
			properties: { service: { type: "string" } },
			type: "object",
		},
		name: "list_connections",
		title: "List Connections",
	},
	{
		description:
			"Search authorized catalog actions before requesting an action guide.",
		inputSchema: {
			additionalProperties: false,
			properties: {
				limit: { default: 20, maximum: 50, minimum: 1, type: "integer" },
				query: { type: "string" },
				service: { type: "string" },
			},
			type: "object",
		},
		name: "search_actions",
		title: "Search Actions",
	},
	{
		description:
			"Return one authorized action's deterministic guide and input schema.",
		inputSchema: {
			additionalProperties: false,
			properties: { actionId: { minLength: 1, type: "string" } },
			required: ["actionId"],
			type: "object",
		},
		name: "get_action_guide",
		title: "Get Action Guide",
	},
	{
		description:
			"Execute one authorized provider action by id with a JSON input object.",
		inputSchema: {
			additionalProperties: false,
			properties: {
				actionId: { minLength: 1, type: "string" },
				input: { additionalProperties: true, type: "object" },
			},
			required: ["actionId"],
			type: "object",
		},
		name: "execute_action",
		title: "Execute Action",
	},
] as const;

const mcpServerInstructions = [
	"Use Connection to discover and execute authorized provider actions through a fixed tool set.",
	"Start with list_apps or search_actions, and use list_connections to inspect the account selected by the current Connection grant.",
	"Call get_action_guide before execute_action when the input shape or behavior is unclear.",
	"Connection resolves the current user, consumer, grant, account, and credential; never pass selectors or provider credentials.",
	"For actions that affect external systems, confirm user intent and reuse the guide's idempotencyKey for retries.",
].join("\n");

function mcpToolPayload(value: unknown) {
	return {
		content: [{ text: JSON.stringify(value), type: "text" }],
		structuredContent: value,
	};
}

function validateMcpToolInput(
	tool: (typeof openConnectorMcpTools)[number],
	input: Record<string, unknown>,
) {
	const properties = tool.inputSchema.properties as Record<string, unknown>;
	const unknownKey = Object.keys(input).find((key) => !(key in properties));
	if (unknownKey) return `Unknown ${tool.name} argument: ${unknownKey}`;
	for (const key of ["query", "service"] as const) {
		if (key in input && typeof input[key] !== "string") {
			return `${key} must be a string`;
		}
	}
	if (
		"limit" in input &&
		(!Number.isInteger(input.limit) ||
			(input.limit as number) < 1 ||
			(input.limit as number) > 50)
	) {
		return "limit must be an integer between 1 and 50";
	}
	if (
		"actionId" in properties &&
		(typeof input.actionId !== "string" || input.actionId.length === 0)
	) {
		return "actionId is required";
	}
	if (
		"input" in input &&
		(typeof input.input !== "object" ||
			input.input === null ||
			Array.isArray(input.input))
	) {
		return "input must be an object";
	}
	return undefined;
}

function asMcpRequest(value: unknown): JsonRpcRequest {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new ConnectionError(
			"INVALID_REQUEST",
			"MCP request must be an object",
		);
	}
	const request = value as JsonRpcRequest;
	if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
		throw new ConnectionError(
			"INVALID_REQUEST",
			"MCP request must use JSON-RPC 2.0",
		);
	}
	return request;
}

export function createConnectionApp(options: ConnectionAppOptions = {}) {
	const app = new Hono();
	const directEnabled =
		Boolean(options.accessTokens) && (options.directMcpEnabled ?? true);
	const providerEnabled =
		Boolean(options.managementIdentity && options.service) &&
		(options.githubProviderEnabled ?? true);

	app.onError((error, context) => {
		if (error instanceof OAuthProtocolError) {
			return context.json(
				{ code: error.error, error: error.message },
				error.status === 401 ? 401 : 400,
			);
		}
		if (error instanceof ConnectionError) {
			const response = context.json(
				{ code: error.code, error: error.message },
				errorStatus(error),
			);
			return response;
		}
		return context.json(
			{ code: "INTERNAL_ERROR", error: "Unexpected Connection error" },
			500,
		);
	});

	app.get("/healthz", (context) =>
		context.json({ service: connectionApiService, status: "ok" }),
	);

	app.get("/", (context) =>
		context.json({
			health: "/healthz",
			service: connectionApiService,
			ui: process.env.CONNECTION_WEB_URL ?? "http://localhost:3001",
		}),
	);

	if (options.oauthServer) {
		app.route("/", createConnectionOAuthApp(options.oauthServer));
	}

	if (options.managementIdentity && options.service) {
		app.get("/api/overview", async (context) =>
			context.json(
				await requireService(options.service).overview(
					await managementPrincipal(
						options,
						context.req.header("authorization"),
					),
				),
			),
		);
	}

	if (directEnabled) {
		app.get("/.well-known/oauth-protected-resource/mcp", (context) => {
			if (!options.oauthServer) return context.notFound();
			return context.json({
				authorization_servers: [options.oauthServer.issuer],
				resource: options.oauthServer.resource,
				scopes_supported: ["mcp"],
			});
		});
	}

	if (directEnabled) {
		app.post("/mcp", async (context) => {
			let request: JsonRpcRequest;
			try {
				request = asMcpRequest(await parseJson(context.req.raw));
			} catch (error) {
				const message =
					error instanceof ConnectionError
						? error.message
						: "Invalid MCP request";
				return context.json(mcpError(null, -32600, message));
			}
			let identity: Awaited<
				ReturnType<ConnectionAccessTokenVerifier["verifyAccessToken"]>
			>;
			try {
				identity = await requireAccessTokens(options).verifyAccessToken(
					context.req.header("authorization"),
				);
			} catch (error) {
				if (
					error instanceof ConnectionError ||
					error instanceof OAuthProtocolError
				) {
					if (options.oauthServer)
						context.header(
							"www-authenticate",
							`Bearer resource_metadata="${new URL("/.well-known/oauth-protected-resource/mcp", options.oauthServer.resource).toString()}"`,
						);
					throw error;
				}
				throw error;
			}
			try {
				if (request.method === "notifications/initialized")
					return context.body(null, 204);
				if (request.method === "initialize") {
					return context.json(
						mcpResult(request.id, {
							capabilities: { tools: {} },
							instructions: mcpServerInstructions,
							protocolVersion: "2024-11-05",
							serverInfo: { name: "connection", version: "0.1.0" },
						}),
					);
				}
				if (request.method === "tools/list") {
					return context.json(
						mcpResult(request.id, {
							tools: openConnectorMcpTools.map((tool) => ({
								...tool,
								annotations: {
									destructiveHint: tool.name === "execute_action",
									idempotentHint: tool.name !== "execute_action",
									openWorldHint: true,
									readOnlyHint: tool.name !== "execute_action",
								},
							})),
						}),
					);
				}
				if (request.method === "tools/call") {
					if (!options.service) {
						return context.json(
							mcpError(request.id, -32601, "Connection tool is not available"),
						);
					}
					const service = options.service;
					const params = request.params;
					if (
						typeof params !== "object" ||
						params === null ||
						Array.isArray(params)
					) {
						return context.json(
							mcpError(request.id, -32602, "tools/call requires parameters"),
						);
					}
					const toolName = (params as { name?: unknown }).name;
					const tool = openConnectorMcpTools.find(
						(entry) => entry.name === toolName,
					);
					if (!tool)
						return context.json(
							mcpError(request.id, -32602, "Unknown Connection tool"),
						);
					const args = (params as { arguments?: unknown }).arguments ?? {};
					if (
						typeof args !== "object" ||
						args === null ||
						Array.isArray(args)
					) {
						return context.json(
							mcpError(request.id, -32602, "Tool arguments must be an object"),
						);
					}
					const input = args as Record<string, unknown>;
					const invalidInput = validateMcpToolInput(tool, input);
					if (invalidInput) {
						return context.json(mcpError(request.id, -32602, invalidInput));
					}
					if (tool.name === "list_apps") {
						return context.json(
							mcpResult(
								request.id,
								mcpToolPayload({
									apps: await service.listDirectAppsForIdentity(
										identity,
										typeof input.query === "string" ? input.query : undefined,
									),
								}),
							),
						);
					}
					if (tool.name === "list_connections") {
						return context.json(
							mcpResult(
								request.id,
								mcpToolPayload({
									connections: await service.listDirectConnectionsForIdentity(
										identity,
										typeof input.service === "string"
											? input.service
											: undefined,
									),
								}),
							),
						);
					}
					if (tool.name === "search_actions") {
						return context.json(
							mcpResult(
								request.id,
								mcpToolPayload({
									actions: await service.searchDirectActionsForIdentity(
										identity,
										{
											...(typeof input.limit === "number"
												? { limit: input.limit }
												: {}),
											...(typeof input.query === "string"
												? { query: input.query }
												: {}),
											...(typeof input.service === "string"
												? { service: input.service }
												: {}),
										},
									),
								}),
							),
						);
					}
					if (tool.name === "get_action_guide") {
						const actionId = input.actionId;
						if (typeof actionId !== "string")
							return context.json(
								mcpError(request.id, -32602, "actionId is required"),
							);
						return context.json(
							mcpResult(
								request.id,
								mcpToolPayload(
									await service.getDirectActionGuideForIdentity(
										identity,
										actionId,
									),
								),
							),
						);
					}
					if (tool.name === "execute_action") {
						const actionId = input.actionId;
						if (typeof actionId !== "string")
							return context.json(
								mcpError(request.id, -32602, "actionId is required"),
							);
						const actionInput = input.input ?? {};
						const result = await service.executeDirectActionForIdentity(
							identity,
							actionId,
							actionInput,
						);
						return context.json(mcpResult(request.id, mcpToolPayload(result)));
					}
					return context.json(
						mcpError(request.id, -32601, "MCP method not found"),
					);
				}
				return context.json(
					mcpError(request.id, -32601, "MCP method not found"),
				);
			} catch (error) {
				if (error instanceof ConnectionError)
					return context.json(mcpError(request.id, -32001, error.message));
				throw error;
			}
		});
	}

	if (providerEnabled)
		app.post("/api/github/oauth/start", async (context) => {
			return context.json(
				await requireService(options.service).startGithubOAuth(
					await managementPrincipal(
						options,
						context.req.header("authorization"),
					),
					githubOAuthRedirectUri(options),
				),
			);
		});

	if (providerEnabled)
		app.get("/oauth/github/callback", async (context) => {
			await requireService(options.service).completeGithubOAuth(
				context.req.query("code") ?? "",
				context.req.query("state") ?? "",
			);
			return context.redirect(
				process.env.CONNECTION_WEB_URL ?? "http://localhost:3001",
				302,
			);
		});

	if (options.delegatedIdentity && options.service) {
		const delegatedIdentity = options.delegatedIdentity;
		app.post("/connection/internal/v1/action-calls", async (context) => {
			const body = await parseJson(context.req.raw);
			if (
				typeof body !== "object" ||
				body === null ||
				Array.isArray(body) ||
				typeof (body as { actionVersionId?: unknown }).actionVersionId !==
					"string" ||
				typeof (body as { args?: unknown }).args !== "object" ||
				(body as { args?: unknown }).args === null ||
				Array.isArray((body as { args?: unknown }).args) ||
				typeof (body as { deadlineAt?: unknown }).deadlineAt !== "string"
			) {
				throw new ConnectionError(
					"INVALID_REQUEST",
					"Delegated calls require actionVersionId, args, and deadlineAt",
				);
			}
			const actionVersionId = (body as { actionVersionId: string })
				.actionVersionId;
			const action = actionFromVersionId(actionVersionId);
			const args = (body as { args: Record<string, unknown> }).args;
			const deadlineAt = (body as { deadlineAt: string }).deadlineAt;
			const idempotencyKey = context.req.header("idempotency-key");
			const assertion = await delegatedIdentity.verifyDelegatedAssertion(
				context.req.header("delegated-assertion"),
				{
					action,
					actionVersionId,
					args,
					deadlineAt,
					idempotencyKey,
				},
			);
			return context.json(
				await requireService(options.service).invokeDelegated(
					assertion,
					action,
					args,
					idempotencyKey,
				),
			);
		});
	}

	if (options.managementIdentity && options.service)
		app.post("/api/grants/:grantId/revoke", async (context) => {
			await requireService(options.service).revokeGrant(
				await managementPrincipal(options, context.req.header("authorization")),
				context.req.param("grantId"),
			);
			return context.body(null, 204);
		});

	if (options.managementIdentity && options.service)
		app.post("/api/connections/:connectionId/disconnect", async (context) => {
			await requireService(options.service).disconnectConnection(
				await managementPrincipal(options, context.req.header("authorization")),
				context.req.param("connectionId"),
			);
			return context.body(null, 204);
		});

	return app;
}
