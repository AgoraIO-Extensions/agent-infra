import type { RuntimeOAuthConfigurationV1 } from "@agent-infra/contracts/runtime";
import { exchangeAuthorization } from "@modelcontextprotocol/sdk/client/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { RuntimeHostError } from "./errors.js";
import { validateStandardMcpToken } from "./standard-mcp-client.js";

export function standardOAuthUnavailable(): never {
	throw new RuntimeHostError(
		"CONNECTION_OAUTH_UNAVAILABLE",
		"Connection authorization is unavailable",
		503,
		false,
	);
}

/** One fixed-target SDK token exchange. No discovery, registration or retry. */
export async function exchangeStandardOAuthCode(options: {
	configuration: RuntimeOAuthConfigurationV1;
	code: string;
	verifier: string;
	signal: AbortSignal;
	assertCurrent: () => void;
	fetch?: FetchLike;
}) {
	const configuration = structuredClone(options.configuration);

	let sent = false;
	const signal = AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]);
	const assertCurrent = () => {
		if (signal.aborted) standardOAuthUnavailable();
		options.assertCurrent();
	};
	try {
		assertCurrent();
		const tokens = await exchangeAuthorization(configuration.issuer, {
			metadata: {
				issuer: configuration.issuer,
				authorization_endpoint: configuration.authorizationEndpoint,
				token_endpoint: configuration.tokenEndpoint,
				response_types_supported: ["code"],
				token_endpoint_auth_methods_supported: ["none"],
			},
			clientInformation: { client_id: configuration.clientId },
			authorizationCode: options.code,
			codeVerifier: options.verifier,
			redirectUri: configuration.callbackUrl,
			fetchFn: async (input, init) => {
				assertCurrent();
				if (
					sent ||
					String(input) !== configuration.tokenEndpoint ||
					init?.method !== "POST" ||
					!(init.body instanceof URLSearchParams)
				)
					standardOAuthUnavailable();
				sent = true;
				const body = new URLSearchParams(init.body);
				// Preserve the approved resource's exact bytes, including legal encoded paths.
				body.set("resource", configuration.resource);
				const response = await (options.fetch ?? fetch)(input, {
					...init,
					body,
					redirect: "error",
					signal,
				});
				assertCurrent();
				if (response.status >= 300 && response.status < 400)
					standardOAuthUnavailable();
				const reader = response.body?.getReader();
				if (!reader) standardOAuthUnavailable();
				const parts: Uint8Array[] = [];
				let length = 0;
				try {
					for (;;) {
						const part = await reader.read();
						assertCurrent();
						if (part.done) break;
						length += part.value.byteLength;
						if (length > 16_384) standardOAuthUnavailable();
						parts.push(part.value);
					}
				} finally {
					await reader.cancel().catch(() => undefined);
					reader.releaseLock();
				}
				assertCurrent();
				return new Response(Buffer.concat(parts).toString("utf8"), {
					status: response.status,
					headers: { "content-type": "application/json" },
				});
			},
		});
		assertCurrent();
		validateStandardMcpToken(tokens.access_token);
		if (
			tokens.token_type.toLowerCase() !== "bearer" ||
			!Number.isSafeInteger(tokens.expires_in) ||
			!tokens.expires_in ||
			tokens.expires_in < 1 ||
			tokens.expires_in > 31_536_000 ||
			(tokens.scope !== undefined && tokens.scope !== configuration.scope)
		)
			standardOAuthUnavailable();
		if (tokens.refresh_token !== undefined)
			validateStandardMcpToken(tokens.refresh_token);
		return {
			accessToken: tokens.access_token,
			refreshToken: tokens.refresh_token,
			expiresAt: Date.now() + tokens.expires_in * 1000,
		};
	} catch {
		standardOAuthUnavailable();
	}
}

/**
 * Revoke one token at the fixed deployment endpoint. This is deliberately a
 * one-shot operation: shutdown cleanup may swallow a network failure, but it
 * never retries or sends a token to a different endpoint.
 */
export async function revokeStandardOAuthToken(options: {
	configuration: RuntimeOAuthConfigurationV1;
	token: string;
	tokenTypeHint: "access_token" | "refresh_token";
	signal: AbortSignal;
	assertCurrent: () => void;
	fetch?: FetchLike;
}) {
	const configuration = structuredClone(options.configuration);
	const token = validateStandardMcpToken(options.token);
	const signal = AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]);
	const assertCurrent = () => {
		if (signal.aborted) standardOAuthUnavailable();
		options.assertCurrent();
	};
	try {
		assertCurrent();
		const body = new URLSearchParams({
			token,
			token_type_hint: options.tokenTypeHint,
			client_id: configuration.clientId,
		});
		const response = await (options.fetch ?? fetch)(
			configuration.revocationEndpoint,
			{
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body,
				redirect: "error",
				signal,
			},
		);
		assertCurrent();
		if (response.status !== 200) standardOAuthUnavailable();
		const reader = response.body?.getReader();
		if (!reader) return;
		let length = 0;
		try {
			for (;;) {
				const part = await reader.read();
				assertCurrent();
				if (part.done) break;
				length += part.value.byteLength;
				if (length > 16_384) standardOAuthUnavailable();
			}
		} finally {
			await reader.cancel().catch(() => undefined);
			reader.releaseLock();
		}
		assertCurrent();
	} catch {
		standardOAuthUnavailable();
	}
}
