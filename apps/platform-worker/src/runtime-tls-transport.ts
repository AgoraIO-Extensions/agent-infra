import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { checkServerIdentity, TLSSocket } from "node:tls";
import { Agent, buildConnector } from "undici";

/** One deployment-owned pool shared by business, control, and signed readiness. */
export function createRuntimeTlsTransport(caBundle: string) {
	let trustExpiresAt = Number.POSITIVE_INFINITY;
	try {
		if (typeof caBundle !== "string" || caBundle.length > 1_048_576)
			throw new Error();
		const certificates = caBundle.match(
			/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
		);
		if (
			!certificates?.length ||
			caBundle
				.replace(
					/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
					"",
				)
				.trim()
		)
			throw new Error();
		for (const pem of certificates) {
			const certificate = new X509Certificate(pem);
			trustExpiresAt = Math.min(
				trustExpiresAt,
				certificate.validToDate.getTime(),
			);
			if (
				!certificate.ca ||
				Date.now() < certificate.validFromDate.getTime() ||
				Date.now() >= certificate.validToDate.getTime()
			)
				throw new Error();
		}
	} catch {
		throw new Error("RUNTIME_TLS_CA_INVALID");
	}
	const connect = buildConnector({
		ca: caBundle,
		rejectUnauthorized: true,
		minVersion: "TLSv1.2",
		maxCachedSessions: 0,
		checkServerIdentity(hostname, certificate) {
			const error = checkServerIdentity(hostname, certificate);
			if (error) return error;
			try {
				const leaf = new X509Certificate(certificate.raw);
				if (
					leaf.ca ||
					!leaf.keyUsage?.includes("1.3.6.1.5.5.7.3.1") ||
					leaf.checkHost(hostname, { subject: "never", wildcards: false }) !==
						hostname
				)
					throw new Error();
			} catch {
				return new Error("RUNTIME_TLS_PEER_INVALID");
			}
		},
	});
	const dispatcher = new Agent({
		connect(options, callback) {
			connect(options, (error, socket) => {
				if (error) return callback(error, null);
				if (!(socket instanceof TLSSocket)) {
					socket.destroy();
					return callback(new Error("RUNTIME_TLS_PEER_INVALID"), null);
				}
				let expiresAt = trustExpiresAt;
				let certificate = socket.getPeerCertificate(true);
				const seen = new Set<string>();
				while (certificate && !seen.has(certificate.fingerprint256)) {
					seen.add(certificate.fingerprint256);
					expiresAt = Math.min(expiresAt, Date.parse(certificate.valid_to));
					certificate = certificate.issuerCertificate;
				}
				const remaining = expiresAt - Date.now();
				if (!Number.isFinite(remaining) || remaining <= 0) {
					socket.destroy();
					return callback(new Error("RUNTIME_TLS_PEER_EXPIRED"), null);
				}
				// Do not keep a POST/SSE connection alive beyond its verified chain.
				const expiry = setTimeout(
					() => socket.destroy(),
					Math.min(remaining, 2_147_483_647),
				);
				expiry.unref();
				socket.once("close", () => clearTimeout(expiry));
				callback(null, socket);
			});
		},
	});
	const runtimeFetch: typeof fetch = async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (
			url.protocol !== "https:" ||
			url.username ||
			url.password ||
			url.search ||
			url.hash
		)
			throw new Error("RUNTIME_TLS_ORIGIN_INVALID");
		// Node bundles a separate undici-types copy; the pinned v7 dispatcher
		// implements its runtime interface (covered by real POST and SSE tests).
		const options: RequestInit = {
			...init,
			redirect: "error",
			dispatcher: dispatcher as unknown as NonNullable<
				RequestInit["dispatcher"]
			>,
		};
		return fetch(input, options);
	};
	return { fetch: runtimeFetch };
}

let deploymentTransport:
	| ReturnType<typeof createRuntimeTlsTransport>
	| undefined;

/** Fixed existing deployment mount; changes take effect only after Worker restart. */
export function runtimeTlsFetch(): typeof fetch {
	if (!deploymentTransport) {
		try {
			deploymentTransport = createRuntimeTlsTransport(
				readFileSync("/var/run/agent-infra/trusted-ca/ca.crt", "utf8"),
			);
		} catch {
			throw new Error("RUNTIME_TLS_CA_INVALID");
		}
	}
	return deploymentTransport.fetch;
}
