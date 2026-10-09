import {
	createPrivateKey,
	type KeyObject,
	timingSafeEqual,
	X509Certificate,
} from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { TLSSocket } from "node:tls";
import {
	RuntimeHostError,
	standardOAuthUnavailable as unavailable,
	validateStandardMcpToken,
} from "@agent-infra/agent-runtime";
import {
	RuntimeOAuthAuthorizedRequestV1Schema,
	RuntimeOAuthCallbackRequestV1Schema,
	RuntimeOAuthConfigurationV1Schema,
	RuntimeOAuthScopeV1Schema,
	RuntimePrincipalV1Schema,
} from "@agent-infra/contracts/runtime";
import type { HttpBindings } from "@hono/node-server";
import { Hono } from "hono";
import type { RuntimeConnectionConsumerProfile } from "./connection-consumer-profile.js";
import {
	createProtectedRuntimeOAuthClient,
	type ProtectedRuntimeOAuthClient,
} from "./runtime-oauth-client.js";
import { createRuntimeOAuthGrantVerifier } from "./runtime-oauth-grant.js";
import { readProtectedStandardMcpBytes } from "./standard-mcp-files.js";
import { assertStandardMcpProcessProtection } from "./standard-mcp-protection.js";

export type RuntimeOAuthAssembly =
	| { status: "unavailable" }
	| {
			status: "available";
			client: ProtectedRuntimeOAuthClient;
			key: string;
			cert: string;
			callbackServiceToken: string;
			port: number;
			runtimeOrigin: string;
	  };

/** No deployment input means no login receiver. Invalid input closes only this capability. */
export async function prepareRuntimeOAuth(options: {
	environment: NodeJS.ProcessEnv;
	dataDirectory: string;
	target: RuntimeConnectionConsumerProfile | undefined;
	key: KeyObject;
	keyId: string;
	issuer: string;
	workerId: string | undefined;
	agentId: string | undefined;
	serviceToken: string;
	store?: Pick<
		import("@agent-infra/agent-runtime").FileRuntimeStore,
		"resolveOriginalExecutionBinding" | "assertOriginalExecutionBindingCurrent"
	>;
}): Promise<RuntimeOAuthAssembly | undefined> {
	const environment = { ...options.environment };
	const serviceToken = options.serviceToken;
	const targetSnapshot = options.target
		? structuredClone(options.target)
		: undefined;
	const file = environment.AGENT_INFRA_RUNTIME_CONNECTION_OAUTH_FILE;
	if (file === undefined) return undefined;
	try {
		if (
			!file ||
			targetSnapshot?.status !== "available" ||
			!options.agentId ||
			!options.workerId ||
			!options.store
		)
			unavailable();
		if (!isAbsolute(file) || resolve(file) !== file) unavailable();
		const descriptor = await open(
			file,
			constants.O_RDONLY | constants.O_NONBLOCK,
		);
		let text: string;
		try {
			const stat = await descriptor.stat();
			if (!stat.isFile() || stat.size < 1 || stat.size > 8192) unavailable();
			const bytes = Buffer.alloc(8193);
			let length = 0;
			while (length < bytes.length) {
				const part = await descriptor.read(
					bytes,
					length,
					bytes.length - length,
					length,
				);
				if (!part.bytesRead) break;
				length += part.bytesRead;
			}
			if (length > 8192) unavailable();
			text = new TextDecoder("utf-8", { fatal: true }).decode(
				bytes.subarray(0, length),
			);
		} finally {
			await descriptor.close();
		}
		const configuration = RuntimeOAuthConfigurationV1Schema.parse(
			JSON.parse(text),
		);
		const target = structuredClone(targetSnapshot);
		const runtime = new URL(configuration.runtimeOrigin);
		const issuer = new URL(configuration.issuer);
		if (
			runtime.pathname !== "/" ||
			!runtime.port ||
			Number(runtime.port) < 1024 ||
			issuer.origin !== target.profile.publicOrigin ||
			issuer.pathname !== "/" ||
			configuration.configFingerprint !== target.configFingerprint ||
			configuration.source.ref !== target.source.ref ||
			configuration.source.revision !== target.source.revision ||
			configuration.resource !== target.url
		)
			unavailable();
		for (const endpoint of [
			configuration.authorizationEndpoint,
			configuration.tokenEndpoint,
			configuration.revocationEndpoint,
		])
			if (new URL(endpoint).origin !== issuer.origin) unavailable();
		const scope = RuntimeOAuthScopeV1Schema.parse({
			agentId: options.agentId,
			sandboxId: environment.AGENT_INFRA_RUNTIME_SANDBOX_ID,
			podUid: environment.AGENT_INFRA_RUNTIME_POD_UID,
			sessionGeneration: Number(
				environment.AGENT_INFRA_RUNTIME_SESSION_GENERATION,
			),
			configFingerprint: target.configFingerprint,
			source: target.source,
			oauthConfiguration: {
				ref: configuration.ref,
				revision: configuration.revision,
			},
		});
		// Do not read TLS keys, PKCE or token material before real process protection.
		assertStandardMcpProcessProtection();
		const tls = join(
			options.dataDirectory,
			"codex-driver.json.native",
			"conversations",
			"standard-mcp-oauth",
			"tls",
		);
		const cert = await readProtectedStandardMcpBytes(tls, "server.crt", 16384);
		const key = await readProtectedStandardMcpBytes(tls, "server.key", 16384);
		const callbackServiceToken = validateStandardMcpToken(
			await readProtectedStandardMcpBytes(tls, "callback.auth", 4096),
		);
		assertStandardMcpProcessProtection();
		if (!serviceToken || callbackServiceToken === serviceToken) unavailable();
		const certificate = new X509Certificate(cert);
		const hostname = runtime.hostname.replace(/^\[|\]$/g, "");
		if (
			!(certificate.checkHost(hostname) || certificate.checkIP(hostname)) ||
			!certificate.checkPrivateKey(createPrivateKey(key)) ||
			Date.parse(certificate.validFrom) > Date.now() ||
			Date.parse(certificate.validTo) <= Date.now()
		)
			unavailable();
		const principal = RuntimePrincipalV1Schema.parse(
			JSON.parse(environment.AGENT_INFRA_RUNTIME_PRINCIPAL ?? "null"),
		);
		if (principal.kind !== "user") unavailable();
		const client = await createProtectedRuntimeOAuthClient({
			dataDirectory: options.dataDirectory,
			store: options.store,
			configuration,
			target,
			scope,
			verifyGrant: createRuntimeOAuthGrantVerifier({
				key: options.key,
				keyId: options.keyId,
				issuer: options.issuer,
				workerId: options.workerId,
				scope,
				principal: { kind: "user", id: principal.id },
			}),
		});
		assertStandardMcpProcessProtection();
		return {
			status: "available",
			client,
			key,
			cert,
			callbackServiceToken,
			port: Number(runtime.port),
			runtimeOrigin: runtime.origin,
		};
	} catch {
		return { status: "unavailable" };
	}
}

async function boundedJson(request: Request) {
	const reader = request.body?.getReader();
	if (!reader) unavailable();
	let length = 0;
	const chunks: Uint8Array[] = [];
	try {
		for (;;) {
			const part = await reader.read();
			assertStandardMcpProcessProtection();
			if (part.done) break;
			length += part.value.byteLength;
			if (length > 32768) unavailable();
			chunks.push(part.value);
		}
		return JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
		);
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}
function authorized(header: string | undefined, expected: string) {
	if (!header?.startsWith("Bearer ")) return false;
	const actual = Buffer.from(header.slice(7));
	const trusted = Buffer.from(expected);
	return actual.length === trusted.length && timingSafeEqual(actual, trusted);
}
/** Dedicated HTTPS protocol entry. Forwarded headers and caller URLs never attest TLS. */
export function createRuntimeOAuthApp(
	assembly: Extract<RuntimeOAuthAssembly, { status: "available" }>,
	serviceToken: string,
) {
	const callbackServiceToken = validateStandardMcpToken(
		assembly.callbackServiceToken,
	);
	if (!serviceToken || callbackServiceToken === serviceToken) unavailable();
	const app = new Hono<{ Bindings: HttpBindings }>();
	app.use("*", async (context, next) => {
		const socket = context.env.incoming?.socket;
		if (
			!(socket instanceof TLSSocket) ||
			!socket.encrypted ||
			context.req.header("host") !== new URL(assembly.runtimeOrigin).host ||
			!authorized(
				context.req.header("authorization"),
				context.req.path === "/internal/runtime/oauth/v1/callback"
					? callbackServiceToken
					: serviceToken,
			)
		)
			unavailable();
		assertStandardMcpProcessProtection();
		context.header("cache-control", "no-store");
		context.header("referrer-policy", "no-referrer");
		await next();
	});
	app.post("/internal/runtime/oauth/v1/callback", async (context) => {
		const request = RuntimeOAuthCallbackRequestV1Schema.parse(
			await boundedJson(context.req.raw),
		);
		return context.json(await assembly.client.callback(request));
	});
	for (const command of ["begin", "confirm", "status"] as const) {
		app.post(`/internal/runtime/oauth/v1/${command}`, async (context) => {
			const request = RuntimeOAuthAuthorizedRequestV1Schema.parse(
				await boundedJson(context.req.raw),
			);
			if (request.command !== command) unavailable();
			return context.json(await assembly.client.authorized(request));
		});
	}
	app.onError((error, context) =>
		context.json(
			{
				schemaVersion: 1,
				code:
					error instanceof RuntimeHostError
						? error.code
						: "CONNECTION_OAUTH_UNAVAILABLE",
				message: "Connection authorization is unavailable",
				retryable: false,
				traceId: crypto.randomUUID(),
			},
			error instanceof RuntimeHostError && error.httpStatus === 403 ? 403 : 503,
		),
	);
	return app;
}
