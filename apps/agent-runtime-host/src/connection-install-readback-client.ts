import { randomBytes } from "node:crypto";
import type { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { requestOverConnectionInstallTlsV1 } from "@agent-infra/agent-runtime";
import {
	type ConnectionInstallReadbackRequestV1,
	ConnectionInstallReadbackRequestV1Schema,
	ConnectionInstallReadbackResponseV1Schema,
	connectionInstallExporterLabelsV1,
	connectionInstallPathsV1,
	connectionInstallReadbackAuthSchemeV1,
	connectionInstallReadbackResponseHeaderV1,
} from "@agent-infra/contracts/runtime";
import {
	connectionInstallBodyDigestV1,
	connectionInstallReadbackKeyV1,
	connectionInstallReadbackMacV1,
	verifyConnectionInstallReadbackMacV1,
} from "@agent-infra/contracts/runtime/connection-install-node";

/** Host-local facts of one readback; freshness fields are always generated here. */
export type ConnectionInstallReadbackInputV1 = Omit<
	ConnectionInstallReadbackRequestV1,
	"schemaVersion" | "nonce" | "issuedAt" | "expiresAt"
>;

export type ConnectionInstallReadbackOutcomeV1 =
	| "allowed"
	| "denied"
	| "unavailable";

export interface ConnectionInstallReadbackClientV1 {
	readback(
		input: ConnectionInstallReadbackInputV1,
		signal: AbortSignal,
	): Promise<ConnectionInstallReadbackOutcomeV1>;
}

function readbackUnavailable(): never {
	throw new Error("CONNECTION_INSTALL_READBACK_UNAVAILABLE");
}

/**
 * Spec §13.5.6 Worker authoritative readback from the Session Host. Each call is
 * one fresh CA-pinned TLS 1.3 POST to the fixed same-release Worker origin; the
 * install token only keys the channel-bound MAC and is never sent. No retries.
 */
export function createConnectionInstallReadbackClientV1(options: {
	readonly origin: string;
	readonly ca: string;
	readonly installToken: string;
	readonly now?: () => number;
	/** Test-only DNS seam; production resolves the fixed Worker Service. */
	readonly lookup?: LookupFunction;
	readonly request?: typeof httpsRequest;
}): ConnectionInstallReadbackClientV1 {
	let origin: URL;
	try {
		origin = new URL(options.origin);
	} catch {
		readbackUnavailable();
	}
	if (
		origin.protocol !== "https:" ||
		origin.username ||
		origin.password ||
		origin.search ||
		origin.hash ||
		origin.pathname !== "/" ||
		!origin.port ||
		origin.href !== options.origin ||
		!options.ca.includes("-----BEGIN CERTIFICATE-----")
	)
		readbackUnavailable();
	const key = connectionInstallReadbackKeyV1(options.installToken);
	const target = origin.href;
	const ca = options.ca;
	const now = options.now ?? Date.now;
	const lookup = options.lookup;
	const send = options.request;
	return {
		async readback(input, signal) {
			try {
				const issuedAt = now();
				const request = ConnectionInstallReadbackRequestV1Schema.parse({
					...input,
					schemaVersion: 1,
					nonce: randomBytes(32).toString("base64url"),
					issuedAt,
					expiresAt: issuedAt + 30_000,
				});
				const body = Buffer.from(JSON.stringify(request), "utf8");
				const requestDigest = connectionInstallBodyDigestV1(body);
				// Set only after the Worker certificate is authenticated.
				let channel = "";
				const response = await requestOverConnectionInstallTlsV1({
					origin: target,
					path: connectionInstallPathsV1.readback,
					ca,
					signal,
					maxResponseBytes: 4096,
					...(lookup ? { lookup } : {}),
					...(send ? { request: send } : {}),
					prepare: (exporter) => {
						channel = exporter(
							connectionInstallExporterLabelsV1.readback,
							32,
						).toString("base64url");
						return {
							body,
							headers: {
								authorization: `${connectionInstallReadbackAuthSchemeV1} ${connectionInstallReadbackMacV1(key, "request", channel, requestDigest)}`,
							},
						};
					},
				});
				// Only a verified response from the Store readback can deny an installation.
				const proof =
					response.headers[connectionInstallReadbackResponseHeaderV1];
				if (
					response.status !== 200 ||
					!channel ||
					typeof proof !== "string" ||
					!verifyConnectionInstallReadbackMacV1(
						key,
						"response",
						channel,
						connectionInstallBodyDigestV1(response.body),
						proof,
					)
				)
					return "unavailable";
				const result = ConnectionInstallReadbackResponseV1Schema.parse(
					JSON.parse(
						new TextDecoder("utf-8", { fatal: true }).decode(response.body),
					),
				);
				if (
					result.nonce !== request.nonce ||
					result.requestDigest !== requestDigest
				)
					return "unavailable";
				return result.outcome;
			} catch {
				return "unavailable";
			}
		},
	};
}
