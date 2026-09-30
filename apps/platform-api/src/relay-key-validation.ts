import {
	type ModelCatalogAdapterV1,
	ModelEndpointV1Schema,
	modelIdentifier,
	modelOperationV1,
} from "@agent-infra/model-catalog";

type ValidationResult = "valid" | "invalid" | "unavailable";

async function readModelList(
	response: Response,
	signal: AbortSignal,
): Promise<boolean> {
	if (
		!/^application\/json(?:\s*;|$)/i.test(
			response.headers.get("content-type") ?? "",
		) ||
		!response.body
	)
		throw new Error("MODEL_LIST_UNAVAILABLE");
	const reader = response.body.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let body = "";
	let bytes = 0;
	try {
		while (true) {
			const chunk = await modelOperationV1(signal, () => reader.read());
			if (chunk.done) break;
			bytes += chunk.value.byteLength;
			if (bytes > 262_144) throw new Error("MODEL_LIST_UNAVAILABLE");
			body += decoder.decode(chunk.value, { stream: true });
		}
		body += decoder.decode();
	} finally {
		void reader.cancel().catch(() => {});
	}
	const parsed: unknown = JSON.parse(body);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		throw new Error("MODEL_LIST_UNAVAILABLE");
	const list = parsed as Record<string, unknown>;
	if (
		list.object !== "list" ||
		!Array.isArray(list.data) ||
		list.data.length > 1024 ||
		list.data.some(
			(item: unknown) =>
				!item ||
				typeof item !== "object" ||
				Array.isArray(item) ||
				!modelIdentifier.safeParse((item as Record<string, unknown>).id)
					.success,
		)
	)
		throw new Error("MODEL_LIST_UNAVAILABLE");
	return list.data.length > 0;
}

/** A read-only Key check against one deployment-approved, authenticated Relay route. */
export function createPersonalRelayKeyValidatorV1(input: {
	readonly catalog: ModelCatalogAdapterV1;
	readonly endpointId: string;
	readonly catalogRevision: string;
	readonly profile: "sub2api-v1-model-list";
	readonly modelsUrl: string;
	readonly fetch?: typeof fetch;
	readonly timeoutMs?: number;
}): (keyValue: string) => Promise<ValidationResult> {
	const fetcher = input.fetch ?? globalThis.fetch;
	return async (keyValue) => {
		if (!/^[\x21-\x7e]{16,8192}$/.test(keyValue)) return "invalid";
		const signal = AbortSignal.timeout(input.timeoutMs ?? 10_000);
		try {
			if (input.profile !== "sub2api-v1-model-list") return "unavailable";
			const endpoint = ModelEndpointV1Schema.parse(
				await modelOperationV1(signal, () =>
					input.catalog.resolve(
						{
							endpointId: input.endpointId,
							catalogRevision: input.catalogRevision,
						},
						{ signal },
					),
				),
			);
			const base = new URL(endpoint.baseUrl);
			const modelsUrl = new URL(input.modelsUrl);
			if (
				endpoint.endpointId !== input.endpointId ||
				!endpoint.available ||
				endpoint.protocol !== "openai-responses-v1" ||
				(endpoint.authentication !== undefined &&
					endpoint.authentication !== "bearer") ||
				endpoint.security.tls !== "verify-peer" ||
				endpoint.security.redirects !== "reject" ||
				base.protocol !== "https:" ||
				!base.pathname.replace(/\/$/, "").endsWith("/v1") ||
				modelsUrl.href !== `${endpoint.baseUrl.replace(/\/$/, "")}/models`
			)
				return "unavailable";
			const url = modelsUrl.href;
			const response = await modelOperationV1(signal, () =>
				fetcher(url, {
					method: "GET",
					headers: {
						Authorization: `Bearer ${keyValue}`,
						Accept: "application/json",
					},
					redirect: "error",
					signal,
				}),
			);
			if (response.redirected || (response.url && response.url !== url)) {
				void response.body?.cancel().catch(() => {});
				return "unavailable";
			}
			if (response.status !== 200) {
				void response.body?.cancel().catch(() => {});
				return response.status === 401 || response.status === 403
					? "invalid"
					: "unavailable";
			}
			return (await readModelList(response, signal)) ? "valid" : "unavailable";
		} catch {
			return "unavailable";
		}
	};
}
