import { modelOperationV1 } from "./catalog.js";
import {
	observeRelayStageV1,
	type RelayStageObserverV1,
} from "./relay-stage.js";

type ValidationResult = "valid" | "invalid" | "unavailable";
function isBillingUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			url.href === value &&
			url.pathname === "/v1/sub2api/billing" &&
			!url.username &&
			!url.password &&
			!url.search &&
			!url.hash
		);
	} catch {
		return false;
	}
}

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
		for (;;) {
			const chunk = await modelOperationV1(signal, () => reader.read());
			if (chunk.done) break;
			bytes += chunk.value.byteLength;
			if (bytes > 16_384) throw new Error("BILLING_UNAVAILABLE");
			body += decoder.decode(chunk.value, { stream: true });
		}
		body += decoder.decode();
	} finally {
		void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
	const value: unknown = JSON.parse(body);
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("BILLING_UNAVAILABLE");
	const billing = value as Record<string, unknown>;
	if (
		billing.object !== "sub2api.key_billing" ||
		billing.schema_version !== 1 ||
		billing.billing_scope !== "token"
	)
		throw new Error("BILLING_UNAVAILABLE");
}

/** Authentication-only validation for the reviewed Relay billing adapter. */
export function createPersonalRelayKeyValidatorV1(input: {
	readonly profile: "sub2api-key-billing-v1";
	readonly billingUrl: string;
	readonly fetch?: typeof fetch;
	readonly timeoutMs?: number;
	readonly observe?: RelayStageObserverV1;
}): (keyValue: string, signal?: AbortSignal) => Promise<ValidationResult> {
	const fetcher = input.fetch ?? globalThis.fetch;
	const approvedBillingUrl = input.billingUrl;
	const timeoutMs = input.timeoutMs ?? 10_000;
	return async (keyValue, parentSignal) => {
		if (!/^[\x21-\x7e]{16,8192}$/.test(keyValue)) return "invalid";
		if (
			input.profile !== "sub2api-key-billing-v1" ||
			!isBillingUrl(approvedBillingUrl) ||
			!Number.isSafeInteger(timeoutMs) ||
			timeoutMs < 1 ||
			timeoutMs > 10_000
		)
			return "unavailable";
		const signal = parentSignal
			? AbortSignal.any([parentSignal, AbortSignal.timeout(timeoutMs)])
			: AbortSignal.timeout(timeoutMs);
		try {
			return await observeRelayStageV1(
				input.observe,
				"billing",
				signal,
				async (status) => {
					const response = await modelOperationV1(signal, () =>
						fetcher(approvedBillingUrl, {
							method: "GET",
							headers: {
								Authorization: `Bearer ${keyValue}`,
								Accept: "application/json",
							},
							redirect: "error",
							signal,
						}),
					);
					status(response.status);
					if (
						response.redirected ||
						(response.url && response.url !== approvedBillingUrl)
					) {
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
					return "valid" as const;
				},
				(value) =>
					value === "valid"
						? "completed"
						: value === "invalid"
							? "rejected"
							: "failed",
			);
		} catch {
			return "unavailable";
		}
	};
}
