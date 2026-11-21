import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { SessionSandboxConnectionInstallBootstrapV1 } from "./connection-install-bootstrap.js";

/**
 * The gate's publication descriptor contract every projected contract is bound to; equal to
 * `connectionManualPublicationContractV1` of the Store (tested). Kept here so the Session
 * adapter does not load the Store package.
 */
export const connectionManualPublicationDescriptorV1 = Object.freeze({
	ref: "connection-mcp-publication",
	revision: "1",
});

/** Worker deployment input: the approved dynamic publication contract (non-secret JSON). */
export const connectionManualPublicationContractEnvironmentV1 =
	"AGENT_INFRA_CONNECTION_MANUAL_PUBLICATION_CONTRACT";

export type ConnectionManualPublicationContractInputV1 =
	| { readonly status: "absent" }
	| { readonly status: "invalid" }
	| { readonly status: "valid"; readonly contract: string };

const contractId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function plain(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
	return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}
function id(value: unknown) {
	return typeof value === "string" && contractId.test(value);
}

/**
 * #4199 C2 (Spec §13.5.6 动态安装的 reader 与可见起点): the same rules as the Host's
 * `parseRuntimeOAuthDynamicPublicationContractV1`, plus the descriptor binding the Host
 * checks before publishing (`contract.ref`/`revision` equal the gate's publication
 * contract). Anything else is `invalid`: the Worker projects nothing rather than handing
 * a Host a contract it would refuse or a looser one.
 */
export function parseConnectionManualPublicationContractV1(
	raw: string | undefined,
	descriptor: { readonly ref: string; readonly revision: string },
): ConnectionManualPublicationContractInputV1 {
	if (raw === undefined || raw === "") return { status: "absent" };
	const invalid = { status: "invalid" } as const;
	if (Buffer.byteLength(raw) > 65_536) return invalid;
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return invalid;
	}
	if (
		!plain(value) ||
		!exactKeys(value, ["serviceRef", "contract", "toolDeclarations"]) ||
		!id(value.serviceRef)
	)
		return invalid;
	const { contract, toolDeclarations: declarations } = value;
	if (
		!plain(contract) ||
		!exactKeys(contract, ["ref", "revision", "serverInfo", "tools"]) ||
		!id(contract.ref) ||
		!id(contract.revision) ||
		contract.ref !== descriptor.ref ||
		contract.revision !== descriptor.revision ||
		!plain(contract.serverInfo) ||
		!exactKeys(contract.serverInfo, ["name", "version"]) ||
		!id(contract.serverInfo.name) ||
		!id(contract.serverInfo.version) ||
		!Array.isArray(contract.tools) ||
		contract.tools.length < 1 ||
		contract.tools.length > 32 ||
		!Array.isArray(declarations) ||
		declarations.length !== contract.tools.length
	)
		return invalid;
	const names = new Set<string>();
	for (const tool of contract.tools as unknown[]) {
		if (!plain(tool) || !id(tool.name) || names.has(tool.name as string))
			return invalid;
		names.add(tool.name as string);
	}
	const declared = new Set<string>();
	for (const declaration of declarations as unknown[]) {
		if (
			!plain(declaration) ||
			!exactKeys(declaration, ["name", "description", "inputSchema"]) ||
			typeof declaration.name !== "string" ||
			!names.has(declaration.name) ||
			declared.has(declaration.name) ||
			typeof declaration.description !== "string" ||
			declaration.description.length > 1024 ||
			!plain(declaration.inputSchema)
		)
			return invalid;
		declared.add(declaration.name);
	}
	return { status: "valid", contract: raw };
}

/** Session Pod annotation carrying `connectionManualPublicationProofV1`. */
export const connectionManualPublicationProofAnnotationV1 =
	"agent-infra.agora.io/connection-publication-proof";

/**
 * #4199 C2 (Spec §13.5.6 工具声明): the Worker's proof of the declaration decision it made for
 * one Session Pod: the approved contract's digest, or none, bound to the namespace, Sandbox,
 * generation and resource fence, keyed by the Worker's deployment service token. A Pod cannot
 * prove a contract the Worker did not decide for that Sandbox incarnation.
 */
export function connectionManualPublicationProofV1(
	key: string,
	binding: {
		readonly namespace: string;
		readonly sandboxId: string;
		readonly generation: number;
		readonly resourceFence: number;
		readonly contract?: string;
	},
) {
	return createHmac("sha256", key)
		.update(
			JSON.stringify([
				"connection-publication-proof/v1",
				binding.namespace,
				binding.sandboxId,
				binding.generation,
				binding.resourceFence,
				binding.contract === undefined
					? null
					: createHash("sha256").update(binding.contract).digest("hex"),
			]),
		)
		.digest("base64url");
}

/** Constant-time check of a live Pod's proof. */
export function connectionManualPublicationProofMatchesV1(
	proof: unknown,
	key: string,
	binding: Parameters<typeof connectionManualPublicationProofV1>[1],
) {
	if (typeof proof !== "string") return false;
	const expected = Buffer.from(
		connectionManualPublicationProofV1(key, binding),
	);
	const actual = Buffer.from(proof);
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** The per-Agent fact the projection needs; never the association's credential. */
export interface ConnectionManualPublicationV1 {
	readonly contract: string;
	readonly associated: (agentId: string) => Promise<boolean>;
}

/**
 * #4199 C2 (Spec §13.5.6 工具声明): only a running Session render of an Agent that
 * currently has a verified Owner manual association carries the contract to its Host,
 * which declares the tools at `thread/start`. Drain, stop and cleanup renders, Sessions
 * without the install bootstrap (gate closed, non-Codex, custom) and Agents without an
 * association get nothing. A failed read is `unavailable`, never a guess either way.
 */
export async function withConnectionManualPublicationV1<
	T extends {
		readonly agentId: string;
		readonly namespace: string;
		readonly sandboxId: string;
		readonly generation: number;
		readonly resourceFence: number;
		readonly connectionInstallBootstrap?: SessionSandboxConnectionInstallBootstrapV1;
	},
>(
	allocation: T,
	publication: ConnectionManualPublicationV1 | undefined,
	render: {
		readonly desiredState: "running" | "stopped";
		readonly requireCurrentTemplateTrust: boolean;
	},
	unavailable: () => never,
	/** The deployment service token the decision proof is keyed by. */
	proofKey: string,
): Promise<T> {
	const bootstrap = allocation.connectionInstallBootstrap;
	if (
		!publication ||
		!bootstrap ||
		render.desiredState !== "running" ||
		!render.requireCurrentTemplateTrust
	)
		return allocation;
	let associated: boolean;
	try {
		associated = (await publication.associated(allocation.agentId)) === true;
	} catch {
		unavailable();
	}
	if (!associated) return allocation;
	return {
		...allocation,
		connectionInstallBootstrap: {
			...bootstrap,
			publicationContract: publication.contract,
			publicationProof: connectionManualPublicationProofV1(proofKey, {
				namespace: allocation.namespace,
				sandboxId: allocation.sandboxId,
				generation: allocation.generation,
				resourceFence: allocation.resourceFence,
				contract: publication.contract,
			}),
		},
	};
}
