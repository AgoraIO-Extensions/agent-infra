import type { RuntimeOAuthConfigurationV1 } from "@agent-infra/contracts/runtime";
import { exchangeAuthorization } from "@modelcontextprotocol/sdk/client/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { RuntimeHostError } from "./errors.js";
import { validateStandardMcpToken } from "./standard-mcp-client.js";

const registrationId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Register one protected native OAuth client for one Agent installation. */
export async function registerStandardOAuthClient(options: {
	issuer: string;
	registrationEndpoint: string;
	redirectUri: string;
	scope: "mcp";
	signal: AbortSignal;
	assertCurrent: () => void;
	fetch?: FetchLike;
}) {
	const issuer = new URL(options.issuer);
	const endpoint = new URL(options.registrationEndpoint);
	const redirect = new URL(options.redirectUri);
	if (
		issuer.protocol !== "https:" ||
		issuer.pathname !== "/" ||
		issuer.search ||
		issuer.hash ||
		endpoint.origin !== issuer.origin ||
		endpoint.search ||
		endpoint.hash ||
		redirect.username ||
		redirect.password ||
		redirect.search ||
		redirect.hash ||
		!(
			redirect.protocol === "https:" ||
			(redirect.protocol === "http:" &&
				["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname))
		)
	)
		standardOAuthUnavailable();
	const signal = AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]);
	try {
		if (signal.aborted) standardOAuthUnavailable();
		options.assertCurrent();
		const response = await (options.fetch ?? fetch)(endpoint, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				client_name: "Codex",
				redirect_uris: [options.redirectUri],
				grant_types: ["authorization_code", "refresh_token"],
				token_endpoint_auth_method: "none",
				response_types: ["code"],
				scope: options.scope,
				application_type: "native",
			}),
			redirect: "error",
			signal,
		});
		options.assertCurrent();
		if (response.status !== 201 || response.redirected)
			standardOAuthUnavailable();
		const text = await response.text();
		options.assertCurrent();
		if (text.length > 16_384) standardOAuthUnavailable();
		const value: unknown = JSON.parse(text);
		if (!value || typeof value !== "object" || Array.isArray(value))
			standardOAuthUnavailable();
		const record = value as Record<string, unknown>;
		const expectedKeys = [
			"application_type",
			"client_id",
			"client_id_issued_at",
			"client_name",
			"grant_types",
			"redirect_uris",
			"response_types",
			"scope",
			"token_endpoint_auth_method",
		].sort();
		if (Object.keys(record).sort().join(",") !== expectedKeys.join(","))
			standardOAuthUnavailable();
		if (
			record.application_type !== "native" ||
			record.client_name !== "Codex" ||
			record.scope !== options.scope ||
			record.token_endpoint_auth_method !== "none" ||
			!registrationId.test(String(record.client_id)) ||
			!Number.isSafeInteger(record.client_id_issued_at) ||
			!Array.isArray(record.grant_types) ||
			!Array.isArray(record.response_types) ||
			!Array.isArray(record.redirect_uris) ||
			JSON.stringify(record.grant_types) !==
				JSON.stringify(["authorization_code", "refresh_token"]) ||
			JSON.stringify(record.response_types) !== JSON.stringify(["code"]) ||
			JSON.stringify(record.redirect_uris) !==
				JSON.stringify([options.redirectUri])
		)
			standardOAuthUnavailable();
		return String(record.client_id);
	} catch {
		standardOAuthUnavailable();
	}
}

export function standardOAuthUnavailable(): never {
	throw new RuntimeHostError(
		"CONNECTION_OAUTH_UNAVAILABLE",
		"Connection authorization is unavailable",
		503,
		false,
	);
}

/** One fixed-target SDK token exchange. Registration is a separate bounded step. */
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

/** One fixed-target OAuth refresh. No discovery, rotation retry or redirect. */
export async function refreshStandardOAuthToken(options: {
	configuration: RuntimeOAuthConfigurationV1;
	refreshToken: string;
	signal: AbortSignal;
	assertCurrent: () => void;
	fetch?: FetchLike;
}) {
	const configuration = structuredClone(options.configuration);
	const refreshToken = validateStandardMcpToken(options.refreshToken);
	let endpoint: URL;
	try {
		endpoint = new URL(configuration.tokenEndpoint);
	} catch {
		standardOAuthUnavailable();
	}
	if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password)
		standardOAuthUnavailable();
	const signal = AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]);
	const assertCurrent = () => {
		if (signal.aborted) standardOAuthUnavailable();
		options.assertCurrent();
	};
	try {
		assertCurrent();
		const response = await (options.fetch ?? fetch)(
			configuration.tokenEndpoint,
			{
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					grant_type: "refresh_token",
					refresh_token: refreshToken,
					client_id: configuration.clientId,
					resource: configuration.resource,
				}),
				redirect: "error",
				signal,
			},
		);
		assertCurrent();
		if (response.status !== 200) standardOAuthUnavailable();
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
		const body = JSON.parse(Buffer.concat(parts).toString("utf8")) as {
			access_token?: unknown;
			refresh_token?: unknown;
			token_type?: unknown;
			expires_in?: unknown;
			scope?: unknown;
		};
		const accessToken = validateStandardMcpToken(body.access_token);
		const expiresIn = body.expires_in;
		if (
			typeof body.token_type !== "string" ||
			body.token_type.toLowerCase() !== "bearer" ||
			typeof expiresIn !== "number" ||
			!Number.isSafeInteger(expiresIn) ||
			!expiresIn ||
			expiresIn < 1 ||
			expiresIn > 31_536_000 ||
			(body.scope !== undefined && body.scope !== configuration.scope)
		)
			standardOAuthUnavailable();
		if (body.refresh_token !== undefined)
			validateStandardMcpToken(body.refresh_token);
		return {
			accessToken,
			refreshToken:
				body.refresh_token === undefined
					? undefined
					: (body.refresh_token as string),
			expiresAt: Date.now() + (expiresIn as number) * 1000,
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
	let endpoint: URL;
	try {
		endpoint = new URL(configuration.revocationEndpoint);
	} catch {
		standardOAuthUnavailable();
	}
	if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password)
		standardOAuthUnavailable();
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
		const response = await (options.fetch ?? fetch)(endpoint, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body,
			redirect: "error",
			signal,
		});
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
