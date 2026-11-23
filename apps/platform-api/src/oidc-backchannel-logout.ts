import type { OidcLogoutEvent } from "@agent-infra/platform-store";
import { createRemoteJWKSet, errors, jwtVerify } from "jose";
import type { Configuration } from "openid-client";

export const backchannelLogoutPath = "/auth/oidc/backchannel-logout";
const eventName = "http://schemas.openid.net/event/backchannel-logout";

async function readToken(request: Request) {
	if (
		request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
		"application/x-www-form-urlencoded"
	)
		return null;
	const maxBytes = 32768;
	if (Number(request.headers.get("content-length")) > maxBytes) return null;
	const reader = request.body?.getReader();
	if (!reader) return null;
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		void reader.cancel().catch(() => {});
	}, 5000);
	const chunks: Uint8Array[] = [];
	let bytes = 0;

	try {
		while (true) {
			const item = await reader.read();
			if (timedOut) return null;
			if (item.done) break;
			bytes += item.value.byteLength;
			if (bytes > maxBytes) {
				void reader.cancel().catch(() => {});
				return null;
			}
			chunks.push(item.value);
		}
		const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
		const tokens = form.getAll("logout_token");
		return tokens.length === 1 ? tokens[0] : null;
	} finally {
		clearTimeout(timer);
		reader.releaseLock();
	}
}

export function createBackchannelLogout(input: {
	issuer: string;
	clientId: string;
	configuration: () => Promise<Configuration>;
	logout: (notice: OidcLogoutEvent) => Promise<void>;
}) {
	let keys: ReturnType<typeof createRemoteJWKSet> | undefined;
	return async (request: Request) => {
		if (request.method !== "POST") return 405;
		const raw = await readToken(request);
		if (!raw) return 400;
		if (!keys) {
			const metadata = (await input.configuration()).serverMetadata();
			if (metadata.issuer !== input.issuer || !metadata.jwks_uri) return 503;
			const url = new URL(metadata.jwks_uri);
			if (url.protocol !== "https:" || url.username || url.password || url.hash)
				return 503;
			keys = createRemoteJWKSet(url, { timeoutDuration: 5000 });
		}
		let notice: OidcLogoutEvent;
		try {
			const { payload } = await jwtVerify(raw, keys, {
				algorithms: ["RS256"],
				issuer: input.issuer,
				audience: input.clientId,
				requiredClaims: ["iat", "jti", "sub", "events"],
				maxTokenAge: 600,
			});
			const events = payload.events;
			if (
				!events ||
				typeof events !== "object" ||
				Array.isArray(events) ||
				!Object.hasOwn(events, eventName) ||
				"nonce" in payload ||
				typeof payload.jti !== "string" ||
				!payload.jti.trim() ||
				payload.jti.length > 255 ||
				typeof payload.sub !== "string" ||
				!payload.sub.trim() ||
				payload.sub.length > 255 ||
				typeof payload.iat !== "number" ||
				!Number.isSafeInteger(payload.iat)
			)
				return 400;
			const event = (events as Record<string, unknown>)[eventName];
			if (!event || typeof event !== "object" || Array.isArray(event))
				return 400;
			notice = {
				issuer: input.issuer,
				subject: payload.sub,
				jti: payload.jti,
				issuedAt: payload.iat,
			};
		} catch (error) {
			if (
				error instanceof errors.JWTClaimValidationFailed ||
				error instanceof errors.JWTExpired ||
				error instanceof errors.JWSSignatureVerificationFailed ||
				error instanceof errors.JWTInvalid ||
				error instanceof errors.JWSInvalid ||
				error instanceof errors.JOSEAlgNotAllowed ||
				error instanceof errors.JWKSNoMatchingKey ||
				error instanceof errors.JOSENotSupported
			)
				return 400;
			throw error;
		}
		await input.logout(notice);
		return 200;
	};
}
