import { createHash, type KeyObject, randomUUID, sign } from "node:crypto";
import {
	canonicalRuntimeRequestSigningPayload,
	type RuntimeOAuthAuthorizedRequestV1,
	RuntimeOAuthAuthorizedRequestV1Schema,
	type RuntimeOAuthConfigurationV1,
	RuntimeOAuthConfigurationV1Schema,
	type RuntimeOAuthGrantClaimsV1,
	RuntimeOAuthGrantClaimsV1Schema,
	type RuntimeOAuthResponseV1,
	RuntimeOAuthResponseV1Schema,
} from "@agent-infra/contracts/runtime";
import { ConversationRuntimeHostError } from "@agent-infra/platform-core";

export function installationUnavailable(): never {
	throw new ConversationRuntimeHostError(
		"CONNECTION_INSTALLATION_UNAVAILABLE",
		false,
	);
}
export type WorkerInstallationAuthorization = Pick<
	RuntimeOAuthGrantClaimsV1,
	"principal" | "reference" | "authorizationId" | "command"
> & {
	readonly scope: import("@agent-infra/contracts/runtime").RuntimeOAuthScopeV1;
	readonly revision: string;
};
export interface WorkerConnectionInstallationOptions {
	/** Trusted, deployment-approved nonsecret snapshot. No caller config overlay. */
	readonly configuration: RuntimeOAuthConfigurationV1;
	/** Platform's independent current browser confirmation, never business authorization alone. */
	readonly authorize: (
		input: Omit<WorkerInstallationAuthorization, "revision">,
		signal: AbortSignal,
		finalCheck: () => Promise<void>,
	) => Promise<WorkerInstallationAuthorization | null>;
}

/** Actual ConversationRuntime caller owns current authorization and route checks. */
export async function sendRuntimeOAuthRequest(options: {
	request: RuntimeOAuthAuthorizedRequestV1;
	principal: RuntimeOAuthGrantClaimsV1["principal"];
	configuration: RuntimeOAuthConfigurationV1;
	serviceToken: string;
	signing: {
		issuer: string;
		workerId: string;
		keyId: string;
		privateKey: KeyObject;
		now?: () => number;
	};
	assertCurrent: () => Promise<void>;
	signal: AbortSignal;
	fetch?: typeof fetch;
}): Promise<RuntimeOAuthResponseV1> {
	try {
		const request = RuntimeOAuthAuthorizedRequestV1Schema.parse(
			options.request,
		);
		const configuration = RuntimeOAuthConfigurationV1Schema.parse(
			options.configuration,
		);
		const signing = { ...options.signing };
		if (
			signing.privateKey.type !== "private" ||
			signing.privateKey.asymmetricKeyType !== "ed25519" ||
			options.principal.kind !== "user"
		)
			installationUnavailable();
		const signal = AbortSignal.any([
			options.signal,
			AbortSignal.timeout(10_000),
		]);
		await options.assertCurrent();
		signal.throwIfAborted();
		const issuedAt = (signing.now ?? Date.now)();
		const { grant: _grant, ...unsigned } = request;
		const claims = RuntimeOAuthGrantClaimsV1Schema.parse({
			...unsigned,
			schemaVersion: 1,
			purpose: "connection_installation",
			audience: "runtime_connection_client",
			issuer: signing.issuer,
			workerId: signing.workerId,
			principal: options.principal,
			confirmationRevision: request.confirmationRevision,
			grantId: randomUUID(),
			issuedAt,
			expiresAt: issuedAt + 30_000,
			requestDigest: createHash("sha256")
				.update(canonicalRuntimeRequestSigningPayload(request))
				.digest("hex"),
		});
		const header = Buffer.from(
			JSON.stringify({
				alg: "EdDSA",
				kid: signing.keyId,
				typ: "runtime-connection-installation+jws",
			}),
		).toString("base64url");
		const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
		const input = `${header}.${payload}`;
		const grant = {
			schemaVersion: 1 as const,
			format: "runtime-connection-installation-jws" as const,
			token: `${input}.${sign(null, Buffer.from(input, "ascii"), signing.privateKey).toString("base64url")}`,
		};
		const body = JSON.stringify({ ...request, grant });
		if (Buffer.byteLength(body) > 32_768) installationUnavailable();
		const origin = new URL(configuration.runtimeOrigin);
		if (
			origin.protocol !== "https:" ||
			origin.pathname !== "/" ||
			origin.search ||
			origin.hash ||
			origin.username ||
			origin.password
		)
			installationUnavailable();
		const response = await (options.fetch ?? fetch)(
			new URL(`internal/runtime/oauth/v1/${request.command}`, origin),
			{
				method: "POST",
				headers: {
					authorization: `Bearer ${options.serviceToken}`,
					"content-type": "application/json",
				},
				body,
				redirect: "error",
				signal,
			},
		);
		if (response.status !== 200 || response.redirected)
			installationUnavailable();
		const reader = response.body?.getReader();
		if (!reader) installationUnavailable();
		let length = 0;
		const chunks: Uint8Array[] = [];
		try {
			for (;;) {
				const chunk = await reader.read();
				signal.throwIfAborted();
				if (chunk.done) break;
				length += chunk.value.byteLength;
				if (length > 16_384) installationUnavailable();
				chunks.push(chunk.value);
			}
		} finally {
			await reader.cancel().catch(() => undefined);
			reader.releaseLock();
		}
		const result = RuntimeOAuthResponseV1Schema.parse(
			JSON.parse(
				new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
			),
		);
		if (result.authorizationId !== request.authorizationId)
			installationUnavailable();
		if (
			request.command === "begin" &&
			result.phase === "awaiting_callback" &&
			!result.authorizationUrl
		)
			installationUnavailable();
		if (request.command !== "begin" && result.authorizationUrl)
			installationUnavailable();
		if (result.authorizationUrl) {
			const url = new URL(result.authorizationUrl);
			const expected = new URL(configuration.authorizationEndpoint);
			const keys = [...url.searchParams.keys()].sort().join(",");
			if (
				keys !==
					"client_id,code_challenge,code_challenge_method,redirect_uri,resource,response_type,scope,state" ||
				url.searchParams.get("client_id") !== configuration.clientId ||
				url.searchParams.get("redirect_uri") !== configuration.callbackUrl ||
				url.searchParams.get("resource") !== configuration.resource ||
				url.searchParams.get("response_type") !== "code" ||
				url.searchParams.get("scope") !== configuration.scope ||
				url.searchParams.get("code_challenge_method") !== "S256" ||
				!/^[a-f0-9]{64}$/.test(url.searchParams.get("state") ?? "") ||
				!/^[A-Za-z0-9_-]{43}$/.test(
					url.searchParams.get("code_challenge") ?? "",
				)
			)
				installationUnavailable();
			if (
				request.command !== "begin" ||
				result.phase !== "awaiting_callback" ||
				url.origin !== expected.origin ||
				url.pathname !== expected.pathname ||
				url.username ||
				url.password ||
				url.hash
			)
				installationUnavailable();
		}
		await options.assertCurrent();
		signal.throwIfAborted();
		return result;
	} catch (error) {
		if (
			error instanceof ConversationRuntimeHostError &&
			error.code !== "CONNECTION_INSTALLATION_UNAVAILABLE"
		)
			throw error;
		if (options.signal.aborted)
			throw new ConversationRuntimeHostError("RUNTIME_INTERRUPTED", true);
		installationUnavailable();
	}
}
