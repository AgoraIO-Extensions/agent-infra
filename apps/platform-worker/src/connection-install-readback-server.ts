import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { connectionInstallServerExporterV1 } from "@agent-infra/agent-runtime";
import {
	ConnectionHostInstallTargetV1Schema,
	type ConnectionInstallReadbackRequestV1,
	ConnectionInstallReadbackRequestV1Schema,
	type ConnectionInstallReadbackResponseV1,
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
import { WorkloadKubernetesError } from "./kubernetes-client.js";

const namespacePattern = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const sandboxIdPattern = /^[\x21-\x7e]{1,256}$/;

/**
 * Per-Sandbox install readback token (Spec §13.5.6 "Worker 权威回读"). The
 * purpose differs from the `session-sandbox-v1` transport token, so neither can
 * stand in for the other; it is written only to that Sandbox's private Host
 * input and the Worker recomputes it for every readback.
 */
export function sessionSandboxConnectionInstallTokenV1(
	deploymentServiceToken: string,
	namespace: string,
	sandboxId: string,
): string {
	if (
		typeof deploymentServiceToken !== "string" ||
		!deploymentServiceToken ||
		typeof namespace !== "string" ||
		!namespacePattern.test(namespace) ||
		typeof sandboxId !== "string" ||
		!sandboxIdPattern.test(sandboxId)
	)
		throw new WorkloadKubernetesError("policy");
	return createHmac("sha256", deploymentServiceToken)
		.update(`session-sandbox-connection-install-v1\0${namespace}\0${sandboxId}`)
		.digest("base64url");
}

type ConnectionInstallReadbackOutcomeV1 =
	ConnectionInstallReadbackResponseV1["outcome"];

export interface ConnectionInstallReadbackServerV1 {
	readonly server: Server;
	/** Resolves with the bound port. */
	listen(): Promise<number>;
	close(): Promise<void>;
}

const maxRequestBytes = 16_384;
const maxProofLifetimeMs = 30_000;
const allowedClockSkewMs = 1_000;
const readbackTimeoutMs = 10_000;
const macPattern = /^[A-Za-z0-9_-]{43}$/;
const errorBody = Buffer.from("{}");

async function readBody(request: IncomingMessage): Promise<Buffer | undefined> {
	const declared = request.headers["content-length"];
	if (declared !== undefined && !(Number(declared) <= maxRequestBytes))
		return undefined;
	const chunks: Buffer[] = [];
	let length = 0;
	for await (const chunk of request) {
		const bytes = chunk as Buffer;
		length += bytes.byteLength;
		if (length > maxRequestBytes) return undefined;
		chunks.push(bytes);
	}
	return Buffer.concat(chunks);
}

function parseRequest(
	raw: Buffer,
): ConnectionInstallReadbackRequestV1 | undefined {
	try {
		const result = ConnectionInstallReadbackRequestV1Schema.safeParse(
			JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)),
		);
		return result.success ? result.data : undefined;
	} catch {
		return undefined;
	}
}

function bounded<T>(run: () => Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		if (signal.aborted) {
			reject(new Error("CONNECTION_INSTALL_READBACK_UNAVAILABLE"));
			return;
		}
		const abort = () =>
			reject(new Error("CONNECTION_INSTALL_READBACK_UNAVAILABLE"));
		signal.addEventListener("abort", abort, { once: true });
		Promise.resolve()
			.then(run)
			.then(
				(value) => {
					signal.removeEventListener("abort", abort);
					resolve(value);
				},
				(error: unknown) => {
					signal.removeEventListener("abort", abort);
					reject(error);
				},
			);
	});
}

/** Fixed bodies only: nothing from the request is echoed and nothing is logged. */
function finish(
	response: ServerResponse,
	status: number,
	body: Buffer = errorBody,
	headers: Readonly<Record<string, string>> = {},
): void {
	try {
		if (response.headersSent || response.writableEnded) {
			response.destroy();
			return;
		}
		response.writeHead(status, {
			"content-type": "application/json",
			"content-length": String(body.byteLength),
			"cache-control": "no-store",
			connection: "close",
			...(status === 405 ? { allow: "POST" } : {}),
			...headers,
		});
		response.end(body);
	} catch {
		response.destroy();
	}
}

/**
 * Host → Worker authoritative readback listener (Spec §13.5.6). A Session Host
 * proves its per-Sandbox install token with a MAC bound to this TLS 1.3
 * connection's exporter and a single-use nonce; the Worker answers from
 * Platform Store facts through `readback` and binds its answer to the same
 * channel. 403 means the proof itself failed; every authenticated request
 * gets 200 with allowed, denied or unavailable.
 */
export function createConnectionInstallReadbackServerV1(options: {
	readonly key: string;
	readonly cert: string;
	readonly port: number;
	readonly host?: string;
	readonly deploymentServiceToken: string;
	/** Session Sandbox namespace; fixes the Host name `sandbox-<id>.<namespace>.svc`. */
	readonly namespace: string;
	readonly deploymentIdentity: string;
	readonly readback: (
		request: ConnectionInstallReadbackRequestV1,
		signal: AbortSignal,
	) => Promise<ConnectionInstallReadbackOutcomeV1>;
	readonly now?: () => number;
	readonly maxReplayEntries?: number;
}): ConnectionInstallReadbackServerV1 {
	const {
		port,
		host,
		deploymentServiceToken,
		namespace,
		deploymentIdentity,
		readback,
	} = options;
	const now = options.now ?? Date.now;
	const maxReplayEntries = options.maxReplayEntries ?? 4_096;
	if (
		typeof readback !== "function" ||
		typeof options.key !== "string" ||
		!options.key.includes("PRIVATE KEY-----") ||
		typeof options.cert !== "string" ||
		!options.cert.includes("-----BEGIN CERTIFICATE-----") ||
		typeof deploymentServiceToken !== "string" ||
		!deploymentServiceToken ||
		typeof namespace !== "string" ||
		!namespacePattern.test(namespace) ||
		!ConnectionHostInstallTargetV1Schema.shape.deploymentIdentity.safeParse(
			deploymentIdentity,
		).success ||
		!Number.isInteger(port) ||
		port < 0 ||
		port > 65_535 ||
		(host !== undefined && (typeof host !== "string" || !host)) ||
		typeof now !== "function" ||
		!Number.isSafeInteger(maxReplayEntries) ||
		maxReplayEntries < 1
	)
		throw new TypeError(
			"Connection install readback server options are invalid",
		);
	const lifetime = new AbortController();
	/** `${sandboxId}\0${nonce}` → expiresAt of the proof that used it. */
	const replay = new Map<string, number>();

	function readbackKey(sandboxId: string): Buffer | undefined {
		try {
			return connectionInstallReadbackKeyV1(
				sessionSandboxConnectionInstallTokenV1(
					deploymentServiceToken,
					namespace,
					sandboxId,
				),
			);
		} catch {
			return undefined;
		}
	}

	function remember(
		request: ConnectionInstallReadbackRequestV1,
		current: number,
	): "fresh" | "replayed" | "full" {
		const entry = `${request.target.sandboxId}\0${request.nonce}`;
		const seen = replay.get(entry);
		if (seen !== undefined && seen > current) return "replayed";
		if (seen === undefined && replay.size >= maxReplayEntries) {
			for (const [stored, expiresAt] of replay)
				if (expiresAt <= current) replay.delete(stored);
			if (replay.size >= maxReplayEntries) return "full";
		}
		replay.set(entry, request.expiresAt);
		return "fresh";
	}

	async function decide(
		request: ConnectionInstallReadbackRequestV1,
	): Promise<ConnectionInstallReadbackOutcomeV1> {
		const signal = AbortSignal.any([
			AbortSignal.timeout(readbackTimeoutMs),
			lifetime.signal,
		]);
		try {
			const outcome = await bounded(() => readback(request, signal), signal);
			return outcome === "allowed" || outcome === "denied"
				? outcome
				: "unavailable";
		} catch {
			return "unavailable";
		}
	}

	async function handle(request: IncomingMessage, response: ServerResponse) {
		let key: Buffer | undefined;
		try {
			if (request.url !== connectionInstallPathsV1.readback)
				return finish(response, 404);
			if (request.method !== "POST") return finish(response, 405);
			let channel: string;
			try {
				channel = connectionInstallServerExporterV1(request.socket)(
					connectionInstallExporterLabelsV1.readback,
					32,
				).toString("base64url");
			} catch {
				return finish(response, 503);
			}
			const raw = await readBody(request);
			if (!raw) return finish(response, 413);
			const authorization = request.headers.authorization;
			const prefix = `${connectionInstallReadbackAuthSchemeV1} `;
			const mac =
				typeof authorization === "string" && authorization.startsWith(prefix)
					? authorization.slice(prefix.length)
					: "";
			const parsed = macPattern.test(mac) ? parseRequest(raw) : undefined;
			if (
				!parsed ||
				parsed.target.deploymentIdentity !== deploymentIdentity ||
				new URL(parsed.target.runtimeOrigin).hostname !==
					`sandbox-${parsed.target.sandboxId}.${namespace}.svc`
			)
				return finish(response, 403);
			key = readbackKey(parsed.target.sandboxId);
			const requestDigest = connectionInstallBodyDigestV1(raw);
			if (
				!key ||
				!verifyConnectionInstallReadbackMacV1(
					key,
					"request",
					channel,
					requestDigest,
					mac,
				)
			)
				return finish(response, 403);
			const current = now();
			if (
				!Number.isSafeInteger(current) ||
				parsed.issuedAt > current + allowedClockSkewMs ||
				current >= parsed.expiresAt ||
				parsed.expiresAt <= parsed.issuedAt ||
				parsed.expiresAt - parsed.issuedAt > maxProofLifetimeMs
			)
				return finish(response, 403);
			const remembered = remember(parsed, current);
			if (remembered === "replayed") return finish(response, 403);
			if (remembered === "full") return finish(response, 503);
			const nonce = parsed.nonce;
			const outcome = await decide(parsed);
			const body = Buffer.from(
				JSON.stringify(
					ConnectionInstallReadbackResponseV1Schema.parse({
						schemaVersion: 1,
						outcome,
						nonce,
						requestDigest,
					}),
				),
				"utf8",
			);
			return finish(response, 200, body, {
				[connectionInstallReadbackResponseHeaderV1]:
					connectionInstallReadbackMacV1(
						key,
						"response",
						channel,
						connectionInstallBodyDigestV1(body),
					),
			});
		} catch {
			return finish(response, 503);
		} finally {
			key?.fill(0);
		}
	}

	let server: Server;
	try {
		server = createServer(
			{
				key: options.key,
				cert: options.cert,
				minVersion: "TLSv1.3",
				maxVersion: "TLSv1.3",
			},
			(request, response) => {
				void handle(request, response);
			},
		);
	} catch {
		throw new TypeError(
			"Connection install readback server TLS material is invalid",
		);
	}
	server.headersTimeout = 15_000;
	server.requestTimeout = 15_000;
	return {
		server,
		listen() {
			return new Promise<number>((resolve, reject) => {
				const onError = (error: Error) => {
					server.off("listening", onListening);
					reject(error);
				};
				const onListening = () => {
					server.off("error", onError);
					resolve((server.address() as AddressInfo).port);
				};
				server.once("error", onError);
				server.once("listening", onListening);
				server.listen(port, host);
			});
		},
		close() {
			lifetime.abort();
			return new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (
						!error ||
						(error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING"
					)
						resolve();
					else reject(error);
				});
				server.closeAllConnections();
			});
		},
	};
}
