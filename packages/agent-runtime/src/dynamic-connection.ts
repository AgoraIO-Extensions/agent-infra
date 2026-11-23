import { isDeepStrictEqual } from "node:util";
import type { RuntimeOriginalExecutionRef } from "./runtime-authorization.js";
import {
	StandardMcpClient,
	type StandardMcpClientOptions,
	standardMcpDigest,
} from "./standard-mcp-client.js";

/**
 * §13.5.6 动态安装的 reader 与可见起点 (ADR-0048). A Codex Thread declares
 * these tools at `thread/start`; Claude, ACP and Pi declare them when the Execution opens its MCP server.  before any installation exists; each
 * Execution then resolves its target and input through the Host's reader. A
 * refusal answers the call with a fixed result and sends nothing to Connection.
 */
export interface DynamicConnectionClientV1 {
	readonly declared: {
		readonly contract: { readonly ref: string; readonly revision: string };
		readonly tools: readonly {
			readonly name: string;
			readonly description: string;
			readonly inputSchema: Readonly<Record<string, unknown>>;
		}[];
	};
	readonly resolveTarget: (
		reference: RuntimeOriginalExecutionRef,
		signal: AbortSignal,
	) => Promise<StandardMcpClientOptions["target"]>;
	readonly resolveInput: StandardMcpClientOptions["resolveInput"];
	readonly fetch?: StandardMcpClientOptions["fetch"];
}

/**
 * Thrown by the Host reader (`resolveTarget`/`resolveInput`) before any
 * Connection request. It carries no credential, installation or permit
 * identifier; the Driver answers the call with the fixed result and never
 * retries.
 */
export class DynamicConnectionRefusalV1 extends Error {
	constructor(readonly reason: "authorization_required" | "unavailable") {
		super(
			reason === "authorization_required"
				? "Connection authorization on the platform is required"
				: "Connection is unavailable",
		);
		this.name = "DynamicConnectionRefusalV1";
	}
}

/** The fixed results of §13.5.6 for a call no usable installation backs. */
export const dynamicConnectionRefusalsV1 = Object.freeze({
	authorization_required: Object.freeze({
		reason: "connection_authorization_required",
		message: "需要先在平台完成 Connection 授权",
	}),
	unavailable: Object.freeze({
		reason: "connection_unavailable",
		message: "Connection 暂时不可用",
	}),
});

/** Same shape and aliases as `StandardMcpClient.toolDefinitions`. */
export function declaredConnectionDefinitions(
	declared: DynamicConnectionClientV1["declared"],
) {
	return [
		{
			type: "namespace" as const,
			name: "connection",
			description: "Approved Connection tools",
			tools: declared.tools.map((tool) => ({
				type: "function" as const,
				name: `mcp_${standardMcpDigest(tool.name).slice(0, 32)}`,
				description: `${tool.name}: ${tool.description}`,
				inputSchema: structuredClone(tool.inputSchema) as Record<
					string,
					unknown
				>,
			})),
		},
	];
}

export function declaredConnectionFingerprint(
	declared: DynamicConnectionClientV1["declared"],
) {
	return standardMcpDigest([
		declaredConnectionDefinitions(declared),
		declared.contract,
	]);
}

export type DynamicConnectionOpenV1 =
	| { readonly client: StandardMcpClient }
	| { readonly refusal: keyof typeof dynamicConnectionRefusalsV1 };

/**
 * §13.5.6 per-Execution reader for Claude, ACP and Pi. It resolves the
 * Execution's installation through the Host reader and opens the protected
 * client. Anything short of an installation whose discovery equals the
 * declared tools yields a fixed refusal decided before any Connection
 * request; the declaration itself never changes.
 */
export async function openDynamicConnectionV1(
	options: DynamicConnectionClientV1,
	reference: RuntimeOriginalExecutionRef,
	signal: AbortSignal,
): Promise<DynamicConnectionOpenV1> {
	let client: StandardMcpClient | undefined;
	try {
		const target = await options.resolveTarget(
			structuredClone(reference),
			signal,
		);
		client = await StandardMcpClient.open(
			{
				target,
				resolveInput: options.resolveInput,
				...(options.fetch ? { fetch: options.fetch } : {}),
			},
			reference,
			signal,
		);
	} catch (error) {
		return {
			refusal:
				error instanceof DynamicConnectionRefusalV1
					? error.reason
					: "unavailable",
		};
	}
	if (
		!isDeepStrictEqual(client.contractSource, options.declared.contract) ||
		!isDeepStrictEqual(
			client.toolDefinitions,
			declaredConnectionDefinitions(options.declared),
		)
	) {
		await client.close().catch(() => {});
		return { refusal: "unavailable" };
	}
	return { client };
}

/**
 * The loopback bridge input for one Execution: a protected client, or the
 * declared tools with a fixed refusal (§13.5.6). Static and dynamic inputs
 * never coexist.
 */
export async function resolveConnectionForBridgeV1(
	options: {
		readonly standardConnectionClient?: StandardMcpClientOptions;
		readonly dynamicConnectionClient?: DynamicConnectionClientV1;
	},
	reference: RuntimeOriginalExecutionRef,
	signal: AbortSignal,
): Promise<
	| { readonly client: StandardMcpClient }
	| {
			readonly declared: DynamicConnectionClientV1["declared"];
			readonly refusal: keyof typeof dynamicConnectionRefusalsV1;
	  }
> {
	if (options.standardConnectionClient && options.dynamicConnectionClient)
		throw new Error("CONNECTION_STANDARD_CLIENT_UNAVAILABLE");
	if (options.dynamicConnectionClient) {
		const opened = await openDynamicConnectionV1(
			options.dynamicConnectionClient,
			reference,
			signal,
		);
		return "client" in opened
			? opened
			: {
					declared: options.dynamicConnectionClient.declared,
					refusal: opened.refusal,
				};
	}
	if (!options.standardConnectionClient)
		throw new Error("CONNECTION_STANDARD_CLIENT_UNAVAILABLE");
	return {
		client: await StandardMcpClient.open(
			options.standardConnectionClient,
			reference,
			signal,
		),
	};
}
