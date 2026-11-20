/** Internal operational metadata; never a Runtime operation fact or provider error. */
export interface ModelTransportDiagnostic {
	readonly stage: "response_headers" | "response_body";
	readonly errorClass:
		| "dns"
		| "tls"
		| "connect_refused"
		| "connection_reset"
		| "timeout"
		| "UNKNOWN";
	readonly elapsedMs: number;
	readonly upstreamStatus?: number;
}

const codes: Readonly<Record<string, ModelTransportDiagnostic["errorClass"]>> =
	{
		ENOTFOUND: "dns",
		EAI_AGAIN: "dns",
		ECONNREFUSED: "connect_refused",
		ECONNRESET: "connection_reset",
		UND_ERR_SOCKET: "connection_reset",
		ETIMEDOUT: "timeout",
		ESOCKETTIMEDOUT: "timeout",
		UND_ERR_CONNECT_TIMEOUT: "timeout",
		UND_ERR_HEADERS_TIMEOUT: "timeout",
		UND_ERR_BODY_TIMEOUT: "timeout",
		ERR_TLS_HANDSHAKE_TIMEOUT: "timeout",
		ERR_TLS_CERT_ALTNAME_INVALID: "tls",
		CERT_HAS_EXPIRED: "tls",
		DEPTH_ZERO_SELF_SIGNED_CERT: "tls",
		SELF_SIGNED_CERT_IN_CHAIN: "tls",
		UNABLE_TO_VERIFY_LEAF_SIGNATURE: "tls",
		UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "tls",
		ERR_SSL_WRONG_VERSION_NUMBER: "tls",
	};

export function modelTransportErrorClass(
	error: unknown,
): ModelTransportDiagnostic["errorClass"] {
	try {
		let current = error;
		for (
			let depth = 0;
			depth < 4 && current && typeof current === "object";
			depth++
		) {
			const value = current as {
				code?: unknown;
				name?: unknown;
				cause?: unknown;
			};
			const code = value.code;
			if (typeof code === "string" && Object.hasOwn(codes, code))
				return codes[code] ?? "UNKNOWN";
			if (value.name === "TimeoutError") return "timeout";
			current = value.cause;
		}
	} catch {
		// Uninspectable exceptions remain unclassified, never serialized.
	}
	return "UNKNOWN";
}
