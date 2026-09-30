import { modelOperationV1 } from "@agent-infra/model-catalog";

type ValidationResult = "valid" | "invalid" | "unavailable";
const approvedBillingUrl = "https://sub2api.la3.agoralab.co/v1/sub2api/billing";

async function readBillingResponse(
	response: Response,
	signal: AbortSignal,
): Promise<void> {
	if (
		!/^application\/json(?:\s*;|$)/i.test(
			response.headers.get("content-type") ?? "",
		) ||
		!response.body
	)
		throw new Error("BILLING_UNAVAILABLE");
	const reader = response.body.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let body = "";
	let bytes = 0;
	try {
		while (true) {
			const chunk = await modelOperationV1(signal, () => reader.read());
			if (chunk.done) break;
			bytes += chunk.value.byteLength;
			if (bytes > 16_384) throw new Error("BILLING_UNAVAILABLE");
			body += decoder.decode(chunk.value, { stream: true });
		}
		body += decoder.decode();
	} finally {
		void reader.cancel().catch(() => {});
	}
	const parsed: unknown = JSON.parse(body);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		throw new Error("BILLING_UNAVAILABLE");
	const billing = parsed as Record<string, unknown>;
	if (
		billing.object !== "sub2api.key_billing" ||
		billing.schema_version !== 1 ||
		billing.billing_scope !== "token"
	)
		throw new Error("BILLING_UNAVAILABLE");
}

/** This route proves authentication only; it skips quota and expiry enforcement. */
export function createPersonalRelayKeyValidatorV1(input: {
	readonly profile: "sub2api-key-billing-v1";
	readonly billingUrl: string;
	readonly fetch?: typeof fetch;
	readonly timeoutMs?: number;
}): (keyValue: string) => Promise<ValidationResult> {
	const fetcher = input.fetch ?? globalThis.fetch;
	return async (keyValue) => {
		if (!/^[\x21-\x7e]{16,8192}$/.test(keyValue)) return "invalid";
		const signal = AbortSignal.timeout(input.timeoutMs ?? 10_000);
		try {
			if (
				input.profile !== "sub2api-key-billing-v1" ||
				input.billingUrl !== approvedBillingUrl
			)
				return "unavailable";
			const url = approvedBillingUrl;
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
			await readBillingResponse(response, signal);
			return "valid";
		} catch {
			return "unavailable";
		}
	};
}
