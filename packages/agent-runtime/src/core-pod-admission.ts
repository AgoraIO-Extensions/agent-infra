import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export const corePodAdmissionPath = "/internal/runtime/v1/core-pod-admission";
const lifetimeMs = 60_000;
const sendMarginMs = 10_000;

function mac(key: string, ...parts: string[]) {
	return createHmac("sha256", key)
		.update(JSON.stringify(parts))
		.digest("base64url");
}
export function coreProbeToken(key: string, uid: string, nonce: string) {
	return mac(key, "core-probe-v1", uid, nonce);
}

function valid(
	token: string,
	key: string,
	uid: string,
	boot?: string,
	minimumRemainingMs = 0,
) {
	const [instance, expires, signature, ...extra] = token.split(".");
	const remaining = Number(expires) - Date.now();
	if (
		extra.length ||
		!instance ||
		(boot && boot !== instance) ||
		!Number.isSafeInteger(Number(expires)) ||
		remaining <= minimumRemainingMs ||
		remaining > lifetimeMs ||
		!signature ||
		!expires
	)
		return false;
	const expected = Buffer.from(
		mac(key, "core-landlock-v1", uid, instance, expires),
	);
	const supplied = Buffer.from(signature);
	return (
		supplied.length === expected.length && timingSafeEqual(expected, supplied)
	);
}

/** The live id comes from the initialized, contained RPC used by the business driver. */
export function admittedCorePod(
	key: string,
	uid: string,
	currentProcess: () => string | undefined,
) {
	let expires = 0;
	return {
		probeToken: (nonce: string) => coreProbeToken(key, uid, nonce),
		async issue(nonce: string) {
			const instance = currentProcess();
			if (!instance) throw new Error("CORE_NATIVE_PROCESS_UNAVAILABLE");
			if (expires - Date.now() <= sendMarginMs * 2)
				expires = Date.now() + lifetimeMs;
			const token = [
				instance,
				expires,
				mac(key, "core-landlock-v1", uid, instance, String(expires)),
			].join(".");
			return { token, proof: mac(key, "core-response-v1", uid, nonce, token) };
		},
		accepts(token: string) {
			const instance = currentProcess();
			return !!instance && valid(token, key, uid, instance);
		},
	};
}

export async function requestCorePodAdmission(
	baseUrl: string,
	key: string,
	uid: string,
	fetcher: typeof fetch,
	signal?: AbortSignal,
) {
	const nonce = randomUUID();
	const timeout = AbortSignal.timeout(3000);
	const response = await fetcher(new URL(corePodAdmissionPath, baseUrl), {
		method: "POST",
		redirect: "error",
		cache: "no-store",
		headers: {
			authorization: `Bearer ${coreProbeToken(key, uid, nonce)}`,
			"x-core-challenge": nonce,
		},
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	});
	if (response.ok) {
		const token = response.headers.get("x-core-admission");
		if (
			token &&
			valid(token, key, uid, undefined, sendMarginMs) &&
			response.headers.get("x-core-proof") ===
				mac(key, "core-response-v1", uid, nonce, token)
		)
			return token;
	}
	throw new Error("CORE_POD_ADMISSION_UNAVAILABLE");
}
