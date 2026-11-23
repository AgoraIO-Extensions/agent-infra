/**
 * Input schemas of the Connection MCP tool list, copied without descriptions or
 * credentials from agora-connector main `ea078465ea20304395c08e503eecd672374341e6`
 * (`apps/connection-api/src/app.ts` `openConnectorMcpTools` and
 * `call-recovery.ts` `callRecoveryTools`). The Claude conversion must accept every
 * one of them; refresh this list when Connection changes its published tools.
 */
export const connectionToolInputSchemas: readonly {
	readonly name: string;
	readonly inputSchema: Record<string, unknown>;
}[] = [
	{
		name: "inspect_call_recovery",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["callId"],
			properties: {
				callId: {
					type: "string",
					pattern: "^call-[A-Za-z0-9-]{1,120}$",
				},
			},
		},
	},
	{
		name: "preview_call_recovery",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["callId", "idempotencyKey"],
			properties: {
				callId: {
					type: "string",
				},
				idempotencyKey: {
					type: "string",
					minLength: 8,
					maxLength: 200,
				},
			},
		},
	},
	{
		name: "confirm_call_recovery",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["operationId", "confirmationToken", "decision"],
			properties: {
				operationId: {
					type: "string",
				},
				confirmationToken: {
					type: "string",
				},
				decision: {
					const: "APPROVE",
					type: "string",
				},
			},
		},
	},
	{
		name: "get_call_recovery_operation",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["operationId"],
			properties: {
				operationId: {
					type: "string",
				},
			},
		},
	},
	{
		name: "report_capability_gap",
		inputSchema: {
			additionalProperties: false,
			type: "object",
			properties: {
				provider: {
					type: "string",
					maxLength: 64,
					description: "Provider slug, or other if unknown",
				},
				summary: {
					type: "string",
					minLength: 4,
					maxLength: 500,
				},
				idempotencyKey: {
					type: "string",
					minLength: 8,
					maxLength: 200,
				},
				sourceCallId: {
					type: "string",
					pattern: "^call-[A-Za-z0-9-]{1,115}$",
					description:
						"Optional original Call ID, not business content. The server verifies the same user, client, instance and provider. This is a locator, not proof of success or authorization. Omit when discovery produced no Call.",
				},
			},
			required: ["provider", "summary", "idempotencyKey"],
		},
	},
	{
		name: "list_apps",
		inputSchema: {
			additionalProperties: false,
			properties: {
				query: {
					type: "string",
				},
			},
			type: "object",
		},
	},
	{
		name: "list_connections",
		inputSchema: {
			additionalProperties: false,
			properties: {
				service: {
					type: "string",
				},
			},
			type: "object",
		},
	},
	{
		name: "search_actions",
		inputSchema: {
			additionalProperties: false,
			properties: {
				intent: {
					type: "string",
					minLength: 4,
					maxLength: 200,
				},
				limit: {
					default: 20,
					maximum: 50,
					minimum: 1,
					type: "integer",
				},
				query: {
					type: "string",
				},
				service: {
					type: "string",
				},
			},
			type: "object",
		},
	},
	{
		name: "get_action_guide",
		inputSchema: {
			additionalProperties: false,
			properties: {
				actionId: {
					minLength: 1,
					type: "string",
				},
			},
			required: ["actionId"],
			type: "object",
		},
	},
	{
		name: "execute_action",
		inputSchema: {
			additionalProperties: false,
			properties: {
				actionId: {
					minLength: 1,
					type: "string",
				},
				input: {
					additionalProperties: true,
					type: "object",
				},
			},
			required: ["actionId"],
			type: "object",
		},
	},
];
