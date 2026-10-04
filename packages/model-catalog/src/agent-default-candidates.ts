import {
	type AgentDefaultRelayKeyDependenciesV1,
	AgentDefaultRelayKeyErrorV1,
} from "@agent-infra/platform-core";
import type { admitAgentDefaultModelsV1 } from "./agent-default-admission.js";
import {
	ModelCatalogSnapshotV1Schema,
	modelIdentifier,
	modelOperationV1,
	reasoningLevel,
} from "./catalog.js";
import { standardTemplateModelBindingV1 } from "./projection.js";

/** Only deployment-owned endpoints and exact template/image bindings enter this adapter. */
export function createAgentDefaultRelayKeyModelCandidatesV1(input: {
	readonly modelCatalog: {
		readonly revision: string;
		readonly load: (signal: AbortSignal) => Promise<unknown>;
	};
	readonly templateBindings: readonly Parameters<
		typeof admitAgentDefaultModelsV1
	>[0]["template"][];
	readonly relayEndpointId: string;
	readonly relayBaseUrl: string;
	readonly fetch?: typeof fetch;
}): AgentDefaultRelayKeyDependenciesV1["candidates"] {
	const bindings = structuredClone(input.templateBindings);
	const fetcher = input.fetch ?? globalThis.fetch;
	return async (keyValue, configuration) => {
		try {
			const signal = AbortSignal.timeout(10_000);
			return await modelOperationV1(signal, async () => {
				const binding = standardTemplateModelBindingV1(
					configuration.source,
					bindings.map(({ reasoningLevels: _levels, ...binding }) => binding),
				);
				const templateReasoning = bindings.find(
					(template) =>
						template.templateId === binding.templateId &&
						template.imageDigest === binding.imageDigest,
				)?.reasoningLevels;
				if (
					!templateReasoning?.length ||
					templateReasoning.length > 32 ||
					templateReasoning.some(
						(level) => !reasoningLevel.safeParse(level).success,
					)
				)
					throw new Error();
				const catalog = ModelCatalogSnapshotV1Schema.parse(
					await input.modelCatalog.load(signal),
				);
				if (
					catalog.revision !== input.modelCatalog.revision ||
					catalog.validUntil <= Date.now()
				)
					throw new Error();
				const candidates = [];
				for (const endpoint of catalog.endpoints) {
					if (
						endpoint.endpointId !== input.relayEndpointId ||
						endpoint.baseUrl !== input.relayBaseUrl ||
						!endpoint.available ||
						endpoint.protocol !== binding.protocol ||
						endpoint.security.tls !== "verify-peer"
					)
						continue;
					const reasoningLevels = endpoint.capabilities.reasoningLevels.filter(
						(level) => templateReasoning.includes(level),
					);
					if (!reasoningLevels.length) continue;
					const url = `${endpoint.baseUrl.replace(/\/$/, "")}/models`;
					const response = await fetcher(url, {
						method: "GET",
						redirect: "error",
						signal,
						headers:
							endpoint.authentication === "api-key"
								? { "x-api-key": keyValue, Accept: "application/json" }
								: {
										Authorization: `Bearer ${keyValue}`,
										Accept: "application/json",
									},
					});
					if (
						!response.ok ||
						response.redirected ||
						(response.url && response.url !== url) ||
						!/^application\/json(?:\s*;|$)/i.test(
							response.headers.get("content-type") ?? "",
						) ||
						!response.body
					) {
						void response.body?.cancel().catch(() => {});
						throw new Error();
					}
					const reader = response.body.getReader();
					const decoder = new TextDecoder("utf-8", { fatal: true });
					let body = "";
					let size = 0;
					try {
						for (;;) {
							const chunk = await modelOperationV1(signal, () => reader.read());
							if (chunk.done) break;
							size += chunk.value.byteLength;
							if (size > 1_048_576) throw new Error();
							body += decoder.decode(chunk.value, { stream: true });
						}
						body += decoder.decode();
					} finally {
						void reader.cancel().catch(() => {});
						reader.releaseLock();
					}
					const value: unknown = JSON.parse(body);
					if (
						!value ||
						typeof value !== "object" ||
						!("data" in value) ||
						!Array.isArray(value.data) ||
						value.data.length > 1024
					)
						throw new Error();
					const ids = new Set<string>();
					for (const model of value.data) {
						if (!model || typeof model !== "object") throw new Error();
						const id = modelIdentifier.parse(model.id);
						if (ids.has(id)) throw new Error();
						ids.add(id);
						if (
							endpoint.allowedModels === null ||
							endpoint.allowedModels.includes(id)
						)
							candidates.push({
								endpointId: endpoint.endpointId,
								modelId: id,
								reasoningLevels,
							});
					}
				}
				return candidates;
			});
		} catch (error) {
			if (error instanceof AgentDefaultRelayKeyErrorV1) throw error;
			throw new AgentDefaultRelayKeyErrorV1("unavailable");
		}
	};
}
