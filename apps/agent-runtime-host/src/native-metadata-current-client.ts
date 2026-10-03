import { isDeepStrictEqual } from "node:util";
import {
	type NativeMetadataCurrentRequestV1,
	NativeMetadataCurrentRequestV1Schema,
	type NativeMetadataCurrentResponseV1,
	NativeMetadataCurrentResponseV1Schema,
} from "@agent-infra/contracts";

/** Relay every current check to the owning Worker instance; no cached authorization. */
export function createRuntimeNativeMetadataCurrentClientV1(options: {
	readonly baseUrl: string;
	readonly serviceToken: string;
	readonly expectedWorkerId: string;
	readonly fetch?: typeof fetch;
}) {
	const config = { ...options };
	let origin: URL;
	try {
		origin = new URL(config.baseUrl);
		if (
			!["http:", "https:"].includes(origin.protocol) ||
			origin.username ||
			origin.password ||
			origin.pathname !== "/" ||
			origin.search ||
			origin.hash ||
			!config.expectedWorkerId ||
			config.expectedWorkerId.includes("\0") ||
			!/^[\x21-\x7e]{1,8192}$/.test(config.serviceToken)
		)
			throw new Error();
	} catch {
		throw new TypeError("Metadata Worker instance configuration is invalid");
	}
	const fetcher = config.fetch ?? fetch;
	return async function current(
		value: NativeMetadataCurrentRequestV1,
		workerId: string,
		signal: AbortSignal,
	): Promise<NativeMetadataCurrentResponseV1> {
		const unavailable = { outcome: "unavailable" } as const;
		if (workerId !== config.expectedWorkerId) return { outcome: "denied" };
		const parsed = NativeMetadataCurrentRequestV1Schema.safeParse(value);
		if (!parsed.success) return unavailable;
		const request = parsed.data;
		// The Host supplies its original context deadline and lifetime signal.
		function assertCurrent() {
			signal.throwIfAborted();
			const now = Date.now();
			if (now < request.readStartedAt || now >= request.expiresAt)
				throw new Error("Metadata current request is unavailable");
		}
		let response: Response | undefined;
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		try {
			assertCurrent();
			response = await fetcher(
				new URL(
					`/internal/platform-worker/v1/native-metadata/reads/${encodeURIComponent(request.readId)}/current`,
					origin,
				),
				{
					method: "POST",
					redirect: "error",
					credentials: "omit",
					cache: "no-store",
					headers: {
						"content-type": "application/json",
						authorization: `Bearer ${config.serviceToken}`,
					},
					body: JSON.stringify(request),
					signal,
				},
			);
			assertCurrent();
			if (
				![200, 403, 503].includes(response.status) ||
				response.redirected ||
				!response.body ||
				!/^application\/json(?:\s*;|$)/i.test(
					response.headers.get("content-type") ?? "",
				)
			)
				return unavailable;
			const length = response.headers.get("content-length");
			if (length && /^\d+$/.test(length) && Number(length) > 65_536)
				return unavailable;
			reader = response.body.getReader();
			const chunks: Uint8Array[] = [];
			let bytes = 0;
			while (true) {
				const chunk = await reader.read();
				assertCurrent();
				if (chunk.value) {
					bytes += chunk.value.byteLength;
					if (bytes > 65_536) return unavailable;
					chunks.push(chunk.value);
				}
				if (chunk.done) break;
			}
			const result = NativeMetadataCurrentResponseV1Schema.parse(
				JSON.parse(
					new TextDecoder("utf-8", { fatal: true }).decode(
						Buffer.concat(chunks, bytes),
					),
				),
			);
			const expectedStatus =
				result.outcome === "allowed"
					? 200
					: result.outcome === "denied"
						? 403
						: 503;
			if (
				response.status !== expectedStatus ||
				(result.outcome === "allowed" &&
					!isDeepStrictEqual(result.request, request))
			)
				return unavailable;
			await reader.cancel().catch(() => undefined);
			reader = undefined;
			response = undefined;
			assertCurrent();
			return result;
		} catch {
			return unavailable;
		} finally {
			if (reader) await reader.cancel().catch(() => undefined);
			else if (response) await response.body?.cancel().catch(() => undefined);
		}
	};
}
