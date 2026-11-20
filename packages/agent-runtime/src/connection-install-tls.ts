import type { IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { TLSSocket } from "node:tls";

/** RFC 8446 §7.5 exporter bound to one authenticated TLS 1.3 connection. */
export type ConnectionInstallTlsExporterV1 = (
	label: string,
	length: number,
	context?: Uint8Array,
) => Buffer;

function transportUnavailable(): never {
	throw new Error("CONNECTION_INSTALL_TRANSPORT_UNAVAILABLE");
}

function exporterFor(socket: TLSSocket): ConnectionInstallTlsExporterV1 {
	return (label, length, context) => {
		if (
			!/^EXPORTER-[A-Za-z0-9-]{1,128}$/.test(label) ||
			!Number.isSafeInteger(length) ||
			length < 16 ||
			length > 64 ||
			socket.destroyed ||
			socket.getProtocol() !== "TLSv1.3"
		)
			transportUnavailable();
		// TLS 1.3 treats an absent and an empty context identically (RFC 8446 §7.5).
		return socket.exportKeyingMaterial(
			length,
			label,
			context === undefined ? Buffer.alloc(0) : Buffer.from(context),
		);
	};
}

/**
 * Exporter for the server side of an install request. Forwarded headers, plain
 * HTTP and TLS below 1.3 never attest a channel.
 */
export function connectionInstallServerExporterV1(
	socket: unknown,
): ConnectionInstallTlsExporterV1 {
	if (
		!(socket instanceof TLSSocket) ||
		!socket.encrypted ||
		socket.getProtocol() !== "TLSv1.3"
	)
		transportUnavailable();
	return exporterFor(socket);
}

export interface ConnectionInstallTlsResponseV1 {
	readonly status: number;
	readonly headers: IncomingHttpHeaders;
	readonly body: Buffer;
}

/**
 * One POST over a fresh, CA-pinned TLS 1.3 connection to a fixed origin.
 * `prepare` runs after the server is authenticated and before any byte of the
 * request is written, so its body can bind this connection's exporter values.
 * No pooling, redirects, retries or caller-chosen targets.
 */
export async function requestOverConnectionInstallTlsV1(options: {
	readonly origin: string;
	readonly path: string;
	readonly ca: string;
	readonly signal: AbortSignal;
	readonly maxResponseBytes: number;
	readonly timeoutMs?: number;
	readonly prepare: (exporter: ConnectionInstallTlsExporterV1) => {
		readonly body: Uint8Array;
		readonly headers?: Readonly<Record<string, string>>;
	};
	readonly request?: typeof httpsRequest;
	/** Test-only DNS seam; production resolves the fixed Service name. */
	readonly lookup?: import("node:net").LookupFunction;
}): Promise<ConnectionInstallTlsResponseV1> {
	let origin: URL;
	try {
		origin = new URL(options.origin);
	} catch {
		transportUnavailable();
	}
	if (
		origin.protocol !== "https:" ||
		origin.username ||
		origin.password ||
		origin.search ||
		origin.hash ||
		origin.pathname !== "/" ||
		!origin.port ||
		!/^\/[A-Za-z0-9/_-]{1,256}$/.test(options.path) ||
		options.path.includes("//") ||
		!options.ca.includes("-----BEGIN CERTIFICATE-----") ||
		!Number.isSafeInteger(options.maxResponseBytes) ||
		options.maxResponseBytes < 1 ||
		options.maxResponseBytes > 65_536
	)
		transportUnavailable();
	const timeout = AbortSignal.timeout(options.timeoutMs ?? 10_000);
	const signal = AbortSignal.any([options.signal, timeout]);
	if (signal.aborted) transportUnavailable();
	const send = options.request ?? httpsRequest;
	return new Promise<ConnectionInstallTlsResponseV1>((resolve, reject) => {
		let settled = false;
		const fail = (request?: { destroy(): void }) => {
			if (settled) return;
			settled = true;
			request?.destroy();
			reject(new Error("CONNECTION_INSTALL_TRANSPORT_UNAVAILABLE"));
		};
		let request: ReturnType<typeof httpsRequest>;
		try {
			request = send({
				protocol: "https:",
				host: origin.hostname.replace(/^\[|\]$/g, ""),
				port: Number(origin.port),
				servername: origin.hostname,
				path: options.path,
				method: "POST",
				ca: options.ca,
				minVersion: "TLSv1.3",
				maxVersion: "TLSv1.3",
				rejectUnauthorized: true,
				agent: false,
				...(options.lookup ? { lookup: options.lookup } : {}),
				headers: {
					accept: "application/json",
					"content-type": "application/json",
					connection: "close",
				},
			});
		} catch {
			fail();
			return;
		}
		const abort = () => fail(request);
		signal.addEventListener("abort", abort, { once: true });
		request.once("error", () => fail(request));
		request.once("socket", (socket) => {
			if (!(socket instanceof TLSSocket)) return fail(request);
			socket.once("secureConnect", () => {
				try {
					if (!socket.authorized || socket.getProtocol() !== "TLSv1.3")
						return fail(request);
					const exporter = exporterFor(socket);
					const prepared = options.prepare(exporter);
					for (const [name, value] of Object.entries(prepared.headers ?? {})) {
						if (!/^[a-z][a-z0-9-]{0,63}$/.test(name) || /[\r\n]/.test(value))
							return fail(request);
						request.setHeader(name, value);
					}
					request.setHeader("content-length", String(prepared.body.byteLength));
					request.once("response", (response) => {
						const chunks: Buffer[] = [];
						let length = 0;
						response.on("data", (chunk: Buffer) => {
							length += chunk.byteLength;
							if (length > options.maxResponseBytes) {
								response.destroy();
								fail(request);
								return;
							}
							chunks.push(chunk);
						});
						response.once("error", () => fail(request));
						response.once("end", () => {
							if (settled) return;
							const result = {
								status: response.statusCode ?? 0,
								headers: response.headers,
								body: Buffer.concat(chunks),
							};
							settled = true;
							signal.removeEventListener("abort", abort);
							resolve(result);
							socket.end();
						});
					});
					request.end(Buffer.from(prepared.body));
				} catch {
					fail(request);
				}
			});
		});
	});
}
