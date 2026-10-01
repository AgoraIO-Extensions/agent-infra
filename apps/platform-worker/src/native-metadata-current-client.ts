import { isDeepStrictEqual } from "node:util";
import {
	type NativeMetadataCurrentRequestV1,
	NativeMetadataCurrentRequestV1Schema,
	type NativeMetadataCurrentResponseV1,
	NativeMetadataCurrentResponseV1Schema,
} from "@agent-infra/contracts";

/** Exact original API instances are deployment facts; no caller can supply a URL. */
export function createPlatformNativeMetadataCurrentClientV1(options: {
	readonly apiSources: ReadonlyMap<
		string,
		{ readonly baseUrl: string; readonly serviceToken: string }
	>;
	readonly fetch?: typeof fetch;
}) {
	if (options.apiSources.size === 0)
		throw new TypeError("Metadata API source map is empty");
	const sources = new Map<string, { origin: URL; serviceToken: string }>();
	for (const [sourceRef, input] of options.apiSources) {
		let origin: URL;
		try {
			origin = new URL(input.baseUrl);
		} catch {
			throw new TypeError("Metadata API source configuration is invalid");
		}
		if (
			!sourceRef ||
			sourceRef.includes("\0") ||
			!["http:", "https:"].includes(origin.protocol) ||
			origin.username ||
			origin.password ||
			origin.pathname !== "/" ||
			origin.search ||
			origin.hash ||
			!/^[\x21-\x7e]{1,8192}$/.test(input.serviceToken)
		)
			throw new TypeError("Metadata API source configuration is invalid");
		sources.set(sourceRef, { origin, serviceToken: input.serviceToken });
	}
	const fetcher = options.fetch ?? fetch;
	return async function current(
		apiSourceRef: string,
		value: NativeMetadataCurrentRequestV1,
		signal: AbortSignal,
	): Promise<NativeMetadataCurrentResponseV1> {
		const unavailable = { outcome: "unavailable" } as const;
		const source = sources.get(apiSourceRef);
		const parsed = NativeMetadataCurrentRequestV1Schema.safeParse(value);
		if (!source || !parsed.success) return unavailable;
		const request = parsed.data;
		// The owning Worker supplies its original fixed-deadline signal, never a new read.
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
					`/internal/platform-api/v1/native-metadata/reads/${encodeURIComponent(request.readId)}/current`,
					source.origin,
				),
				{
					method: "POST",
					redirect: "error",
					credentials: "omit",
					cache: "no-store",
					headers: {
						"content-type": "application/json",
						authorization: `Bearer ${source.serviceToken}`,
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
