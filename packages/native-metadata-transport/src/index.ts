import { Buffer } from "node:buffer";

/** Fixed native-metadata POST transport. Callers retain deadlines, DTOs and authorization. */
export function createNativeMetadataJsonTransport(options: {
	readonly baseUrl: string;
	readonly path: string;
	readonly allowBasePath?: boolean;
	readonly peer: string;
	readonly serviceToken: string;
	readonly maximumResponseBytes: number;
	readonly strictJson: boolean;
	readonly fetch?: typeof fetch;
}) {
	if (!/^[\x21-\x7e]{1,8192}$/.test(options.serviceToken))
		throw new TypeError(`${options.peer} service token is invalid`);
	let origin: URL;
	try {
		origin = new URL(options.baseUrl);
	} catch {
		throw new TypeError(`${options.peer} base URL is invalid`);
	}
	if (
		origin.protocol !== "http:" ||
		origin.username ||
		origin.password ||
		origin.search ||
		origin.hash ||
		(!options.allowBasePath &&
			origin.pathname !== "/" &&
			origin.pathname !== "")
	)
		throw new TypeError(`${options.peer} base URL is invalid`);
	const url = new URL(
		options.path,
		options.allowBasePath
			? `${origin.href.replace(/\/$/, "")}/`
			: `${origin.origin}/`,
	);
	const fetcher = options.fetch ?? fetch;
	return async (
		body: string,
		input: {
			readonly signal?: AbortSignal;
			readonly traceId?: string;
			/** Only Platform current confirmation consumes denied bodies from non-success responses. */
			readonly allowErrorStatus?: boolean;
			readonly checkAborted?: boolean;
		} = {},
	): Promise<{ status: number; value: unknown }> => {
		let response: Response | undefined;
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		try {
			response = await fetcher(url, {
				method: "POST",
				redirect: "error",
				credentials: "omit",
				headers: {
					authorization: `Bearer ${options.serviceToken}`,
					"content-type": "application/json",
					accept: "application/json",
					...(input.traceId === undefined
						? {}
						: { "x-trace-id": input.traceId }),
				},
				body,
				signal: input.signal,
			});
			if (
				(input.checkAborted && input.signal?.aborted) ||
				response.redirected ||
				(!input.allowErrorStatus && !response.ok) ||
				(options.strictJson &&
					!/^application\/json(?:\s*;|$)/i.test(
						response.headers.get("content-type") ?? "",
					))
			)
				throw new Error("NATIVE_METADATA_TRANSPORT_UNAVAILABLE");
			reader = response.body?.getReader();
			if (!reader) throw new Error("NATIVE_METADATA_TRANSPORT_UNAVAILABLE");
			const chunks: Uint8Array[] = [];
			let bytes = 0;
			for (;;) {
				const next = await reader.read();
				if (next.value) {
					bytes += next.value.byteLength;
					if (bytes > options.maximumResponseBytes)
						throw new Error("NATIVE_METADATA_TRANSPORT_UNAVAILABLE");
					chunks.push(next.value);
				}
				if (next.done) break;
			}
			const buffer = Buffer.concat(chunks, bytes);
			const text = options.strictJson
				? new TextDecoder("utf-8", { fatal: true }).decode(buffer)
				: buffer.toString("utf8");
			return { status: response.status, value: JSON.parse(text) };
		} finally {
			if (reader) await reader.cancel().catch(() => undefined);
			else await response?.body?.cancel().catch(() => undefined);
		}
	};
}

/** Report fixed metadata stages and the server-generated trace ID only. */
export function logNativeMetadataHop(
	hop:
		| "api.read"
		| "api.current"
		| "worker.read"
		| "worker.api-current"
		| "host.read",
	step:
		| "scope"
		| "registry"
		| "authorization"
		| "revalidation"
		| "gateway"
		| "delivery"
		| "binding"
		| "current-before"
		| "proof"
		| "target"
		| "host"
		| "current-after"
		| "replica"
		| "transport"
		| "context"
		| "driver"
		| "target.parse"
		| "target.scope"
		| "target.verified"
		| "target.identity"
		| "target.route"
		| "target.cancelled",
	traceId: unknown,
	outcome: "ok" | "unavailable" | "started",
	elapsedMs?: number,
) {
	const trace =
		typeof traceId === "string" &&
		/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(traceId)
			? traceId
			: undefined;
	try {
		console.info(
			JSON.stringify({
				event: "native_metadata",
				hop,
				step,
				traceId: trace,
				outcome,
				...(Number.isSafeInteger(elapsedMs) && (elapsedMs as number) >= 0
					? { elapsedMs }
					: {}),
				...(outcome === "unavailable"
					? { code: "NATIVE_METADATA_HOP_UNAVAILABLE" }
					: {}),
			}),
		);
	} catch {
		// Diagnostic output must not affect authorization or request cleanup.
	}
}
