import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, open, realpath, unlink } from "node:fs/promises";
import { join } from "node:path";
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
		"mcp__agent-infra-browser__write_report",
	];
}

export function piPaseoBrowserLaunch(
	permit: PiPaseoBrowserPermit,
	skillRead = false,
) {
	return {
		args: [
			"--tools",
			[
				...piPaseoBrowserTools(permit.operations),
				...(skillRead ? ["read"] : []),
			].join(","),
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

async function writeWorkspaceReport(
	cwd: string,
	args: Record<string, unknown>,
	revalidate: () => void,
) {
	const { path, content } = args;
	if (
		typeof path !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.txt$/.test(path) ||
		typeof content !== "string" ||
		Buffer.byteLength(content) > 65_536 ||
		Object.keys(args).length !== 2 ||
		(await realpath(cwd)) !== cwd
	)
		return undefined;
	const directory = await open(
		cwd,
		constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
	);
	const root =
		process.platform === "linux" ? "/proc/self/fd/" + directory.fd : cwd;
	const temporary = join(root, ".report-" + randomUUID());
	try {
		const file = await open(temporary, "wx", 0o600);
		try {
			try {
				await file.writeFile(content);
			} finally {
				await file.close();
			}
			if ((await realpath(root)) !== cwd) return undefined;
			revalidate();
			await link(temporary, join(root, path));
			return path;
		} finally {
			await unlink(temporary);
		}
	} finally {
		await directory.close();
	}
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
		const current = readCapability();
		if (
			!current ||
			context.isCurrent?.() === false ||
			current.capabilityVersion !== capability.capabilityVersion ||
			!isDeepStrictEqual(current.provenance, capability.provenance) ||
			!isDeepStrictEqual(current.policy, capability.policy) ||
			!operations.every((op) => current.operations.includes(op))
		)
			throw new Error("RUNTIME_BROWSER_MCP_UNAVAILABLE");
	};

	type ToolFact = Extract<RuntimeOperationFactV2, { kind: "tool" }>;
	const runTool = async <T>(
		fact: Pick<ToolFact, "toolId" | "operationRef" | "attemptRef" | "browser">,
		signal: AbortSignal,
		dispatch: (revalidate: () => void) => Promise<{
			value: T;
			phase: "completed" | "failed";
			failureCode?: ToolFact["failureCode"];
		}>,
	): Promise<T> => {
		signal.throwIfAborted();
		assertCurrent();
		const base = { ...fact, kind: "tool" as const };
		await record({ ...base, phase: "intent" });
		let dispatched = false;
		let startedAt: string | undefined;
		try {
			const grant = await authorize({
				kind: "tool",
				nativeSessionRef: session.runtimeSessionRef,
				runtimeOperationId: executionId,
				executionId,
				operationRef: fact.operationRef,
				attemptRef: fact.attemptRef,
				toolId: fact.toolId,
			});
			const revalidateGrant = grant?.revalidate?.bind(grant);
			if (!revalidateGrant) throw new Error("RUNTIME_AUTHORIZATION_DENIED");
			revalidateGrant();
			startedAt = new Date().toISOString();
			await record({ ...base, phase: "started", startedAt });
			signal.throwIfAborted();
			assertCurrent();
			revalidateGrant();
			context.handoff?.controller.assertAgentAccess();
			dispatched = true;
			const result = await dispatch(() => {
				signal.throwIfAborted();
				assertCurrent();
				revalidateGrant();
			});
			signal.throwIfAborted();
			revalidateGrant();
			assertCurrent();
			await record({
				...base,
				phase: result.phase,
				startedAt,
				finishedAt: new Date().toISOString(),
				...(result.phase === "failed"
					? { failureCode: result.failureCode ?? "operation_failed" }
					: {}),
			});
			return result.value;
		} catch (error) {
			try {
				await record({
					...base,
					phase: dispatched ? "unknown" : "failed",
					...(startedAt ? { startedAt } : {}),
					finishedAt: new Date().toISOString(),
					failureCode: dispatched ? "recovery_unconfirmed" : "operation_failed",
				});
			} finally {
				if (dispatched) await session.markUnknown?.();
			}
			throw error;
		}
	};
	const gateway = await createBrowserMcpGatewayV1({
		capability: { ...capability, operations },
		executionId,
		async writeReport(args, signal) {
			const path = await runTool(
				{
					toolId: "workspace:write_report",
					operationRef: randomUUID(),
					attemptRef: randomUUID(),
				},
				signal,
				async (revalidate) => {
					let publishing = false;
					try {
						const path = await writeWorkspaceReport(session.cwd, args, () => {
							revalidate();
							publishing = true;
						});
						return { value: path, phase: path ? "completed" : "failed" };
					} catch (error) {
						const code = (error as NodeJS.ErrnoException).code;
						if (
							!publishing ||
							code === "EEXIST" ||
							code === "ENOSPC" ||
							code === "EDQUOT"
						)
							return { value: undefined, phase: "failed" };
						throw error;
					}
				},
			);
			if (!path) throw new Error("RUNTIME_WORKSPACE_ACCESS_DENIED");
			return path;
		},
		context: {
			...context,
			executeTool: (request, signal) => {
				const { operationRef, attemptRef, actionId, binding } = request;
				// Bind the observed target classification before intent. Live dispatch checks the control again.
				const browser = {
					actionId,
					capabilityVersion: binding.capabilityVersion,
					pageRevision: binding.pageRevision,
					sessionGeneration: binding.sessionGeneration,
					resourceFence: binding.resourceFence,
					workloadRevision: binding.workloadRevision,
					imageDigest: binding.imageDigest,
					sideEffect:
						request.tool === "browser_interact" &&
						(context.observedSideEffect?.(request) ?? true),
				};
				return runTool(
					{
						operationRef,
						attemptRef,
						toolId: `browser:${request.tool}`,
						browser,
					},
					signal,
					async (revalidate) => {
						if (browser.sideEffect)
							return {
								value: {
									actionId,
									operationRef,
									attemptRef,
									binding,
									phase: "failed" as const,
									contentItems: [],
									success: false,
									failureCode: "BROWSER_SIDE_EFFECTS_UNAVAILABLE",
								},
								phase: "failed",
								failureCode: "authorization_denied",
							};
						const result = await execute(request, signal, revalidate);
						if (
							result.actionId !== actionId ||
							result.operationRef !== operationRef ||
							result.attemptRef !== attemptRef ||
							!isDeepStrictEqual(result.binding, binding) ||
							result.phase === "unknown"
						)
							throw new Error("RUNTIME_ACCEPTANCE_UNKNOWN");
						return {
							value: result,
							phase: result.phase,
							...(result.failureCode?.startsWith("BROWSER_SIDE_EFFECT") ||
							result.failureCode === "BROWSER_ACTION_AUTHORIZATION_REQUIRED"
								? { failureCode: "authorization_denied" as const }
								: {}),
						};
					},
				);
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
