import { probeResponsesModelV1 } from "./access.js";
import {
	ModelCatalogSnapshotV1Schema,
	type ModelEndpointV1,
	modelIdentifier,
	modelOperationV1,
} from "./catalog.js";
import { probeMessagesModelV1 } from "./messages-access.js";
import {
	type StandardTemplateModelBindingV1,
	standardTemplateModelBindingV1,
} from "./projection.js";

/**
 * 标准模板对每个模型提供的推理档位（ADR-0029）：平台固定，不按模型、端点或模板登记。
 * 模型是否支持某个档位，由保存时的真实请求判定。
 */
export const standardTemplateReasoningLevelsV1 = Object.freeze([
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const);

export interface AgentDefaultRelayKeyCandidateV1 {
	readonly endpointId: string;
	readonly modelId: string;
	readonly reasoningLevels: readonly string[];
}

/** One saved or requested (model, reasoning level) pair to verify with the default Key. */
export interface AgentDefaultRelayKeyModelComboV1 {
	readonly endpointId: string;
	readonly modelId: string;
	readonly reasoningLevel: string;
}

export type AgentDefaultRelayKeyVerificationV1 =
	| "verified"
	| "key_invalid"
	| "incompatible"
	| "unavailable";

/**
 * 部署配置里的模板绑定可能仍带旧的 `reasoningLevels`（ADR-0029 之前要求填写），
 * 读取时兼容并忽略，只把受信绑定字段交给 strict 的绑定校验。
 */
type DeploymentTemplateBindingV1 = StandardTemplateModelBindingV1 & {
	readonly reasoningLevels?: readonly string[];
};

interface RelayInputV1 {
	readonly modelCatalog: {
		readonly revision: string;
		readonly load: (signal: AbortSignal) => Promise<unknown>;
	};
	readonly templateBindings: readonly DeploymentTemplateBindingV1[];
	readonly relayEndpointId: string;
	readonly relayBaseUrl: string;
	readonly fetch?: typeof fetch;
}

function trustedBindings(bindings: readonly DeploymentTemplateBindingV1[]) {
	return bindings.map(
		({ templateId, imageDigest, driver, protocol }) =>
			({ templateId, imageDigest, driver, protocol }) as const,
	);
}

/** The deployment-approved Relay endpoint usable by this exact template/image. */
async function relayEndpoints(
	input: RelayInputV1,
	bindings: readonly StandardTemplateModelBindingV1[],
	source: Parameters<typeof standardTemplateModelBindingV1>[0],
	signal: AbortSignal,
) {
	const binding = standardTemplateModelBindingV1(source, bindings);
	const catalog = ModelCatalogSnapshotV1Schema.parse(
		await input.modelCatalog.load(signal),
	);
	if (
		catalog.revision !== input.modelCatalog.revision ||
		catalog.validUntil <= Date.now()
	)
		throw new Error();
	return {
		binding,
		endpoints: catalog.endpoints.filter(
			(endpoint) =>
				endpoint.endpointId === input.relayEndpointId &&
				endpoint.baseUrl === input.relayBaseUrl &&
				endpoint.available &&
				endpoint.protocol === binding.protocol &&
				endpoint.security.tls === "verify-peer",
		),
	};
}

async function visibleModelIds(
	endpoint: ModelEndpointV1,
	keyValue: string,
	signal: AbortSignal,
	fetcher: typeof fetch,
) {
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
	}
	return [...ids];
}

/** Resolve default-Key candidates: Relay `/models` ids, optionally narrowed by the deployment (ADR-0029). */
export function createAgentDefaultRelayKeyCandidateReaderV1(
	input: RelayInputV1 & {
		readonly validateKey: (
			keyValue: string,
			signal: AbortSignal,
		) => Promise<"valid" | "invalid" | "unavailable">;
	},
) {
	const bindings = trustedBindings(structuredClone(input.templateBindings));
	const fetcher = input.fetch ?? globalThis.fetch;
	return async function read(
		keyValue: string,
		configuration: {
			readonly source: Parameters<typeof standardTemplateModelBindingV1>[0];
		},
		signal: AbortSignal,
	): Promise<readonly AgentDefaultRelayKeyCandidateV1[]> {
		const validity = await input.validateKey(keyValue, signal);
		if (validity !== "valid") throw new Error("RELAY_KEY_VALIDATION_FAILED");
		return modelOperationV1(signal, async () => {
			const { endpoints } = await relayEndpoints(
				input,
				bindings,
				configuration.source,
				signal,
			);
			const candidates: AgentDefaultRelayKeyCandidateV1[] = [];
			for (const endpoint of endpoints) {
				for (const id of await visibleModelIds(
					endpoint,
					keyValue,
					signal,
					fetcher,
				)) {
					if (
						endpoint.allowedModels === null ||
						endpoint.allowedModels.includes(id)
					)
						candidates.push({
							endpointId: endpoint.endpointId,
							modelId: id,
							reasoningLevels: [...standardTemplateReasoningLevelsV1],
						});
				}
			}
			return candidates;
		});
	};
}

/**
 * Save-time verification (ADR-0029): one bounded real request per (model, level)
 * with the default Key, through the template's protocol (Responses for Codex,
 * Messages for the Claude-profile Drivers).
 */
export function createAgentDefaultRelayKeyModelVerifierV1(input: RelayInputV1) {
	const bindings = trustedBindings(structuredClone(input.templateBindings));
	return async function verify(
		keyValue: string,
		configuration: {
			readonly source: Parameters<typeof standardTemplateModelBindingV1>[0];
		},
		combos: readonly AgentDefaultRelayKeyModelComboV1[],
		signal: AbortSignal,
	): Promise<AgentDefaultRelayKeyVerificationV1> {
		if (combos.length > 384) return "incompatible";
		let resolved: Awaited<ReturnType<typeof relayEndpoints>>;
		try {
			resolved = await modelOperationV1(signal, () =>
				relayEndpoints(input, bindings, configuration.source, signal),
			);
		} catch {
			return "unavailable";
		}
		const protocol = resolved.binding.protocol;
		const seen = new Set<string>();
		for (const combo of combos) {
			const key = JSON.stringify([
				combo.endpointId,
				combo.modelId,
				combo.reasoningLevel,
			]);
			if (seen.has(key)) continue;
			seen.add(key);
			const endpoint = resolved.endpoints.find(
				(item) => item.endpointId === combo.endpointId,
			);
			if (!endpoint) return "incompatible";
			let outcome: AgentDefaultRelayKeyVerificationV1;
			const probe = {
				endpoint,
				credential: keyValue,
				modelId: combo.modelId,
				reasoningLevel: combo.reasoningLevel,
				signal,
				...(input.fetch ? { fetch: input.fetch } : {}),
			};
			try {
				outcome = await modelOperationV1(signal, () =>
					protocol === "openai-responses-v1"
						? probeResponsesModelV1({ ...probe, strictEcho: false })
						: probeMessagesModelV1(probe),
				);
			} catch {
				outcome = "unavailable";
			}
			if (outcome !== "verified") return outcome;
		}
		return "verified";
	};
}
