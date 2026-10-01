import { createPublicKey } from "node:crypto";
import { ConversationRuntimeHostError } from "@agent-infra/platform-core";
import type { ConversationRuntimeOptionsV2 } from "./conversation-runtime.js";
import { createPlatformNativeMetadataCurrentClientV1 } from "./native-metadata-current-client.js";
import type { PlatformNativeMetadataWorkerOptionsV1 } from "./native-metadata-deployment.js";
import { createWorkerNativeMetadataProofSignerV1 } from "./native-metadata-proof-signer.js";
import { createWorkerNativeMetadataHostClientV1 } from "./runtime-host-client.js";

export interface ProductionNativeMetadataWorkerInputV1 {
	readonly hostname: string;
	readonly port: number;
	readonly maxActiveReads: number;
	readonly signing: Parameters<
		typeof createWorkerNativeMetadataProofSignerV1
	>[0];
	readonly apiSources: ReadonlyMap<
		string,
		{
			readonly origin: string;
			readonly apiToWorkerToken: string;
			readonly workerToApiToken: string;
		}
	>;
	/** Exact trusted Host instance mapping, supplied by deployment code, never public wire fields. */
	readonly agents: ReadonlyMap<
		string,
		{
			readonly hostServiceId: string;
			readonly origin: string;
			readonly workerToHostToken: string;
			readonly hostToWorkerToken: string;
		}
	>;
	readonly fetch?: typeof fetch;
}

/** Pure endpoint resolution: metadata must not observe readiness or start a business Execution. */
export function createProductionNativeMetadataWorkerOptionsV1(
	input: ProductionNativeMetadataWorkerInputV1,
	execution: {
		readonly signing: ConversationRuntimeOptionsV2["signing"];
		readonly serviceToken: string;
	},
	signal: AbortSignal,
): PlatformNativeMetadataWorkerOptionsV1 {
	try {
		signal.throwIfAborted();
		if (
			input.signing.workerId !== execution.signing.workerId ||
			input.signing.keyVersion === execution.signing.keyId ||
			createPublicKey(input.signing.privateKey)
				.export({ type: "spki", format: "der" })
				.equals(
					createPublicKey(execution.signing.privateKey).export({
						type: "spki",
						format: "der",
					}),
				) ||
			input.apiSources.size === 0 ||
			input.agents.size === 0 ||
			!input.hostname ||
			!Number.isSafeInteger(input.port) ||
			input.port < 1 ||
			input.port > 65_535 ||
			!Number.isSafeInteger(input.maxActiveReads) ||
			input.maxActiveReads < 1
		)
			throw new Error();
		const tokens = new Set([execution.serviceToken]);
		function token(value: string) {
			if (
				typeof value !== "string" ||
				!/^[\x21-\x7e]{1,8192}$/.test(value) ||
				tokens.has(value)
			)
				throw new Error();
			tokens.add(value);
			return value;
		}
		function identity(value: string) {
			if (typeof value !== "string" || !/^[\x21-\x7e]{1,256}$/.test(value))
				throw new Error();
			return value;
		}
		function origin(value: string) {
			const url = new URL(value);
			if (
				!["http:", "https:"].includes(url.protocol) ||
				url.username ||
				url.password ||
				url.pathname !== "/" ||
				url.search ||
				url.hash
			)
				throw new Error();
			return url.origin;
		}
		const apiSources = new Map<string, string>();
		const currentSources = new Map<
			string,
			{ baseUrl: string; serviceToken: string }
		>();
		for (const [source, config] of input.apiSources) {
			identity(source);
			apiSources.set(source, token(config.apiToWorkerToken));
			currentSources.set(source, {
				baseUrl: origin(config.origin),
				serviceToken: token(config.workerToApiToken),
			});
		}
		const hosts = new Map<string, string>();
		const agents = new Map<
			string,
			{
				hostServiceId: string;
				client: ReturnType<typeof createWorkerNativeMetadataHostClientV1>;
			}
		>();
		for (const [agentId, config] of input.agents) {
			identity(agentId);
			identity(config.hostServiceId);
			if (hosts.has(config.hostServiceId)) throw new Error();
			hosts.set(config.hostServiceId, token(config.hostToWorkerToken));
			agents.set(agentId, {
				hostServiceId: config.hostServiceId,
				client: createWorkerNativeMetadataHostClientV1({
					baseUrl: origin(config.origin),
					serviceToken: token(config.workerToHostToken),
					fetch: input.fetch,
				}),
			});
		}
		const current = createPlatformNativeMetadataCurrentClientV1({
			apiSources: currentSources,
			fetch: input.fetch,
		});
		const signProof = createWorkerNativeMetadataProofSignerV1({
			...input.signing,
		});
		return {
			hostname: input.hostname,
			port: input.port,
			apiSources,
			hosts,
			runtime: {
				maxActiveReads: input.maxActiveReads,
				current,
				signProof,
				async resolveHost(scope, readSignal) {
					readSignal.throwIfAborted();
					const host = agents.get(scope.agentId);
					if (!host)
						throw new ConversationRuntimeHostError(
							"NATIVE_METADATA_UNAVAILABLE",
							false,
						);
					return host;
				},
			},
		};
	} catch {
		throw new Error("Native metadata Worker deployment is invalid");
	}
}
