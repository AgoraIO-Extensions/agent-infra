import type { IncomingMessage } from "node:http";
import type { TLSSocket } from "node:tls";

import type { WorkloadAuthenticator } from "./app";

const verifiedThumbprintHeader = "x-connection-verified-client-thumbprint";

type AppFetch = (request: Request) => Response | Promise<Response>;

export function createMtlsBoundFetch(appFetch: AppFetch) {
	return async (
		request: Request,
		environment: { incoming: IncomingMessage },
	) => {
		const socket = environment.incoming.socket as TLSSocket;
		if (!socket.authorized) {
			return Response.json(
				{ error: "WORKLOAD_MTLS_REQUIRED" },
				{ status: 401 },
			);
		}
		const certificate = socket.getPeerCertificate();
		if (!certificate.fingerprint256) {
			return Response.json(
				{ error: "WORKLOAD_CERTIFICATE_MISSING" },
				{ status: 401 },
			);
		}
		const headers = new Headers(request.headers);
		headers.set(
			verifiedThumbprintHeader,
			`sha256:${certificate.fingerprint256.replaceAll(":", "").toLowerCase()}`,
		);
		return appFetch(new Request(request, { headers }));
	};
}

export const mtlsWorkloadAuthenticator: WorkloadAuthenticator = {
	authenticate: async (request) => {
		const certificateThumbprint = request.headers.get(verifiedThumbprintHeader);
		if (!certificateThumbprint?.startsWith("sha256:")) {
			throw new Error("Verified workload mTLS identity is required");
		}
		return { certificateThumbprint };
	},
};
