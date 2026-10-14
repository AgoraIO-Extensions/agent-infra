import { Buffer } from "node:buffer";
import {
	type NativeMetadataCurrentRequestV1,
	NativeMetadataCurrentRequestV1Schema,
	type NativeMetadataCurrentResponseV1,
	NativeMetadataCurrentResponseV1Schema,
} from "@agent-infra/contracts/runtime";

const currentPath = "internal/platform/v1/native-metadata/current";
const maximumRequestBytes = 64 * 1024;
const maximumResponseBytes = 64 * 1024;
const transportTimeoutMs = 10_000;
const maximumSourceRefLength = 256;

function endpoint(baseUrl: string) {
	let origin: URL;
	try {
		origin = new URL(baseUrl);
	} catch {
		throw new TypeError("Platform API base URL is invalid");
	}
	if (
		origin.protocol !== "http:" ||
		origin.username ||
		origin.password ||
		(origin.pathname !== "/" && origin.pathname !== "") ||
		origin.search ||
		origin.hash
	)
		throw new TypeError("Platform API base URL is invalid");
	return new URL(currentPath, `${origin.origin}/`);
}

function unavailable(): NativeMetadataCurrentResponseV1 {
	return { outcome: "unavailable" };
}

function currentRequestPayload(value: NativeMetadataCurrentRequestV1) {
	const scope = value.scope;
	return JSON.stringify({
		schemaVersion: value.schemaVersion,
		readId: value.readId,
		selector: value.selector,
		scope: {
			schemaVersion: scope.schemaVersion,
			principal: { kind: scope.principal.kind, id: scope.principal.id },
			agentId: scope.agentId,
			channelId: scope.channelId,
			conversationId: scope.conversationId,
			executionId: scope.executionId,
			sessionGeneration: scope.sessionGeneration,
			authorizationRevision: scope.authorizationRevision,
		},
		readStartedAt: value.readStartedAt,
		expiresAt: value.expiresAt,
		requestId: value.requestId,
		traceId: value.traceId,
		phase: value.phase,
		originalHostScopeRef: value.originalHostScopeRef,
	});
}

async function responseText(response: Response) {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("PLATFORM_API_UNAVAILABLE");
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const next = await reader.read();
			if (next.value) {
				bytes += next.value.byteLength;
				if (bytes > maximumResponseBytes)
					throw new Error("PLATFORM_API_UNAVAILABLE");
				chunks.push(next.value);
			}
			if (next.done) break;
		}
		return new TextDecoder("utf-8", { fatal: true }).decode(
			Buffer.concat(chunks, bytes),
		);
	} finally {
		await reader.cancel().catch(() => undefined);
	}
}

export interface PlatformApiNativeMetadataCurrentClientOptionsV1 {
	readonly baseUrl: string;
	readonly serviceToken: string;
	readonly fetch?: typeof fetch;
	readonly transportTimeoutMs?: number;
}

/**
 * Authenticated Worker → fixed Platform API current-confirmation transport.
 *
 * The Platform API origin and service token are deployment inputs. The
 * request itself can only carry the already bound current-confirmation DTO;
 * it cannot select an origin, identity or authorization material.
 */
export function createPlatformApiNativeMetadataCurrentClientV1(
	options: PlatformApiNativeMetadataCurrentClientOptionsV1,
) {
	if (!/^[\x21-\x7e]{1,8192}$/.test(options.serviceToken))
		throw new TypeError("Platform API service token is invalid");
	const url = endpoint(options.baseUrl);
	const fetcher = options.fetch ?? fetch;
	const timeoutMs = options.transportTimeoutMs ?? transportTimeoutMs;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)
		throw new TypeError("Platform API transport timeout is invalid");
	return {
		async check(input: {
			readonly request: NativeMetadataCurrentRequestV1;
			readonly apiRequestSourceRef: string;
			readonly signal?: AbortSignal;
		}): Promise<NativeMetadataCurrentResponseV1> {
			if (input.signal?.aborted) return unavailable();
			let request: NativeMetadataCurrentRequestV1;
			if (
				typeof input.apiRequestSourceRef !== "string" ||
				input.apiRequestSourceRef.length < 1 ||
				input.apiRequestSourceRef.length > maximumSourceRefLength
			)
				return unavailable();
			try {
				request = NativeMetadataCurrentRequestV1Schema.parse(input.request);
			} catch {
				return unavailable();
			}
			const body = JSON.stringify({
				apiRequestSourceRef: input.apiRequestSourceRef,
				request,
			});
			if (Buffer.byteLength(body, "utf8") > maximumRequestBytes)
				return unavailable();
			const signal = input.signal
				? AbortSignal.any([input.signal, AbortSignal.timeout(timeoutMs)])
				: AbortSignal.timeout(timeoutMs);
			let response: Response | undefined;
			try {
				response = await fetcher(url, {
					method: "POST",
					redirect: "error",
					credentials: "omit",
					headers: {
						authorization: `Bearer ${options.serviceToken}`,
						"content-type": "application/json",
						accept: "application/json",
						"x-trace-id": request.traceId,
					},
					body,
					signal,
				});
				if (signal.aborted) {
					await response.body?.cancel().catch(() => undefined);
					return unavailable();
				}
				if (
					response.redirected ||
					!/^application\/json(?:\s*;|$)/i.test(
						response.headers.get("content-type") ?? "",
					)
				) {
					await response.body?.cancel().catch(() => undefined);
					return unavailable();
				}
				const result = NativeMetadataCurrentResponseV1Schema.parse(
					JSON.parse(await responseText(response)),
				);
				if (signal.aborted) return unavailable();
				// An allowed response must come from the authenticated success status;
				// all other statuses remain fail-closed even if their body is shaped
				// like an allowed response.
				if (
					result.outcome === "allowed" &&
					(response.status !== 200 ||
						result.request.phase !== request.phase ||
						currentRequestPayload(result.request) !==
							currentRequestPayload(request))
				)
					return unavailable();
				return result;
			} catch {
				await response?.body?.cancel().catch(() => undefined);
				return unavailable();
			}
		},
	};
}
