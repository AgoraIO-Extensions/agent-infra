import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export const corePodAdmissionPath = "/internal/runtime/v1/core-pod-admission";
const lifetimeMs = 60_000;

function mac(key: string, ...parts: string[]) {
	return createHmac("sha256", key)
		.update(JSON.stringify(parts))
		.digest("base64url");
}
export function coreProbeToken(key: string, uid: string, nonce: string) {
	return mac(key, "core-probe-v1", uid, nonce);
}

function valid(token: string, key: string, uid: string, boot?: string) {
	const [instance, expires, signature, ...extra] = token.split(".");
	const remaining = Number(expires) - Date.now();
	if (
		extra.length ||
		!instance ||
		(boot && boot !== instance) ||
		!Number.isSafeInteger(Number(expires)) ||
		remaining <= 0 ||
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

/** Admission belongs to one Host boot. Only a successful kernel probe renews it. */
export function admittedCorePod(
	key: string,
	uid: string,
	install: () => Promise<void>,
) {
	const boot = randomUUID();
	let expires = 0;
	let pending: Promise<void> | undefined;
	return {
		probeToken: (nonce: string) => coreProbeToken(key, uid, nonce),
		async issue(nonce: string) {
			if (Date.now() >= expires) {
				pending ??= install()
					.then(() => {
						expires = Date.now() + lifetimeMs;
					})
					.finally(() => {
						pending = undefined;
					});
				await pending;
			}
			const token = [
				boot,
				expires,
				mac(key, "core-landlock-v1", uid, boot, String(expires)),
			].join(".");
			return { token, proof: mac(key, "core-response-v1", uid, nonce, token) };
		},
		accepts(token: string) {
			return valid(token, key, uid, boot);
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
			valid(token, key, uid) &&
			response.headers.get("x-core-proof") ===
				mac(key, "core-response-v1", uid, nonce, token)
		)
			return token;
	}
	throw new Error("CORE_POD_ADMISSION_UNAVAILABLE");
}
