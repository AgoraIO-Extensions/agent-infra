import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type {
	BrowserCapabilityAvailableV1,
	RuntimeOperationFactV2,
} from "@agent-infra/contracts/runtime";
import { createBrowserMcpGatewayV1 } from "./browser-mcp-gateway.js";
import type { RuntimeExternalActionAuthorizer } from "./driver.js";
import type { NativeSessionOptions } from "./session-runtime-driver.js";

export const piPaseoBrowserOperations = [
	"navigate",
	"observe",
	"interact",
] as const;
export type PiPaseoBrowserOperation = (typeof piPaseoBrowserOperations)[number];

export interface PiPaseoBrowserPermit {
	readonly port: number;
	readonly token: string;
	readonly operations: readonly PiPaseoBrowserOperation[];
}

export function piPaseoBrowserTools(
	operations: readonly PiPaseoBrowserOperation[],
) {
	return [
		...operations.map(
			(operation) => `mcp__agent-infra-browser__browser_${operation}`,
		),
		"write_report",
	];
}

export function piPaseoBrowserLaunch(permit: PiPaseoBrowserPermit) {
	return {
		args: [
			"--tools",
			piPaseoBrowserTools(permit.operations).join(","),
			"--extension",
			fileURLToPath(
				new URL("../dist/pi-paseo-browser-policy.mjs", import.meta.url),
			),
		],
		env: {
			AGENT_INFRA_PI_BROWSER_MCP_URL: `http://127.0.0.1:${permit.port}/mcp`,
			AGENT_INFRA_PI_BROWSER_MCP_TOKEN: permit.token,
		},
	};
}

/** Open a Host-owned gateway for this execution. The companion receives only its local endpoint. */
export async function openPiPaseoBrowser(
	session: NativeSessionOptions,
	readCapability: () => BrowserCapabilityAvailableV1 | undefined,
	authorize: RuntimeExternalActionAuthorizer | undefined,
) {
	const context = session.browser;
	const execute = context?.executeTool;
	const record = session.recordOperationFact;
	const capability = readCapability();
	const executionId = session.executionId;
	if (
		!context ||
		!execute ||
		!record ||
		!authorize ||
		!executionId ||
		!capability ||
		context.capabilityVersion !== capability.capabilityVersion ||
		context.binding.imageDigest.split("@").at(-1) !==
			capability.provenance.imageDigest
	) {
		throw new Error("RUNTIME_BROWSER_MCP_UNAVAILABLE");
	}
	const operations = piPaseoBrowserOperations.filter((op) =>
		capability.operations.includes(op),
	);
	if (!operations.length) throw new Error("RUNTIME_BROWSER_MCP_UNAVAILABLE");
	const assertCurrent = () => {
		if (!isDeepStrictEqual(readCapability(), capability))
			throw new Error("RUNTIME_BROWSER_MCP_UNAVAILABLE");
	};
	const gateway = await createBrowserMcpGatewayV1({
		capability: { ...capability, operations },
		executionId,
		context: {
			...context,
			async executeTool(request, signal) {
				signal.throwIfAborted();
				assertCurrent();
				const { operationRef, attemptRef, actionId, binding } = request;
				const toolId = `browser:${request.tool}`;
				const fact = {
					kind: "tool",
					operationRef,
					attemptRef,
					toolId,
					browser: {
						actionId,
						capabilityVersion: binding.capabilityVersion,
						pageRevision: binding.pageRevision,
						sessionGeneration: binding.sessionGeneration,
						resourceFence: binding.resourceFence,
						workloadRevision: binding.workloadRevision,
						imageDigest: binding.imageDigest,
						sideEffect: false,
					},
				} as const;
				await record({ ...fact, phase: "intent" });
				let dispatched = false;
				let startedAt: string | undefined;
				const finish = (phase: "completed" | "failed" | "unknown") =>
					record({
						...fact,
						phase,
						...(startedAt ? { startedAt } : {}),
						finishedAt: new Date().toISOString(),
						...(phase === "unknown"
							? { failureCode: "recovery_unconfirmed" }
							: phase === "failed"
								? { failureCode: "operation_failed" }
								: {}),
					} satisfies RuntimeOperationFactV2);
				try {
					const grant = await authorize({
						kind: "tool",
						nativeSessionRef: session.runtimeSessionRef,
						runtimeOperationId: executionId,
						executionId,
						operationRef,
						attemptRef,
						toolId,
					});
					if (!grant?.revalidate)
						throw new Error("RUNTIME_AUTHORIZATION_DENIED");
					grant.revalidate();
					startedAt = new Date().toISOString();
					await record({ ...fact, phase: "started", startedAt });
					signal.throwIfAborted();
					assertCurrent();
					grant.revalidate();
					context.handoff?.controller.assertAgentAccess();
					dispatched = true;
					const result = await execute(request, signal);
					signal.throwIfAborted();
					grant.revalidate();
					assertCurrent();
					if (
						result.actionId !== actionId ||
						result.operationRef !== operationRef ||
						result.attemptRef !== attemptRef ||
						!isDeepStrictEqual(result.binding, binding) ||
						result.phase === "unknown"
					)
						throw new Error("RUNTIME_ACCEPTANCE_UNKNOWN");
					await finish(result.phase);
					return result;
				} catch (error) {
					try {
						await finish(dispatched ? "unknown" : "failed");
					} finally {
						if (dispatched) await session.markUnknown?.();
					}
					throw error;
				}
			},
		},
	});
	const permit: PiPaseoBrowserPermit = {
		port: Number(new URL(gateway.server.url).port),
		token: gateway.server.headers[0].value.slice("Bearer ".length),
		operations,
	};
	let closing: Promise<void> | undefined;
	return {
		permit,
		close: () => (closing ??= gateway.close().finally(() => context.close?.())),
	};
}
