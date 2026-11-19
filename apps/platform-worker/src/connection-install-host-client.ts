import { createHash, KeyObject, randomUUID, sign } from "node:crypto";
import type { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { isDeepStrictEqual } from "node:util";
import {
	type ConnectionHostSupplyBindingV1,
	type ConnectionInstallTlsExporterV1,
	encodeConnectionHostSupplyAadV1,
	requestOverConnectionInstallTlsV1,
	sealConnectionHostSupplyV1,
} from "@agent-infra/agent-runtime";
import {
	type ConnectionHostInstallTargetV1,
	ConnectionHostSupplyClaimsV1Schema,
	ConnectionHostSupplyRequestV1Schema,
	ConnectionHostSupplyResponseV1Schema,
	ConnectionInstallBeginStatusRequestV1Schema,
	ConnectionInstallCommandClaimsV1Schema,
	ConnectionInstallCommandRequestV1Schema,
	type ConnectionInstallCommandResponseV1,
	ConnectionInstallCommandResponseV1Schema,
	ConnectionInstallFirstBeginGrantClaimsV1Schema,
	ConnectionInstallFirstBeginRequestV1Schema,
	ConnectionRegistrationKeyV1Schema,
	type ConnectionRegistrationReceiptV1,
	ConnectionRegistrationReceiptV1Schema,
	type ConnectionRegistrationTemplateV1,
	ConnectionRegistrationTemplateV1Schema,
	canonicalRuntimeRequestSigningPayload,
	connectionInstallExporterLabelsV1,
	connectionInstallJwsTypesV1,
	connectionInstallPathsV1,
	type RuntimeOAuthAuthorizedRequestV1,
	RuntimeOAuthAuthorizedRequestV1Schema,
	type RuntimeOAuthConfigurationV1,
	RuntimeOAuthConfigurationV1Schema,
	type RuntimeOAuthResponseV1,
	RuntimeOAuthResponseV1Schema,
} from "@agent-infra/contracts/runtime";
import {
	connectionInstallConfigurationDigestV1,
	connectionInstallRequestDigestV1,
	connectionRegistrationKeyHashV1,
	connectionRegistrationReceiptDigestV1,
	connectionRegistrationTemplateDigestV1,
	matchConnectionRegistrationReceiptV1,
} from "@agent-infra/contracts/runtime/connection-install-node";
import { ConversationRuntimeHostError } from "@agent-infra/platform-core";

/** Worker runtime grant signing identity; the Host holds the matching public key. */
export interface ConnectionInstallWorkerSigningV1 {
	readonly issuer: string;
	readonly workerId: string;
	readonly keyId: string;
	/** Ed25519 private key. */
	readonly privateKey: KeyObject;
	readonly now?: () => number;
}

type ConnectionInstallHostTargetV1 = Omit<
	ConnectionHostInstallTargetV1,
	"runtimeOrigin"
>;

/**
 * Worker → Session Host install commands of the first manual Owner Connection
 * OAuth install (Spec §13.5.5–§13.5.7). Every method opens one fresh, CA-pinned
 * TLS 1.3 connection to `template.target.runtimeOrigin`, signs a single-use
 * JWS bound to that connection's exporter and never retries or redirects.
 * Any failure throws `CONNECTION_INSTALLATION_UNAVAILABLE`; callers keep the
 * command unknown.
 */
export interface ConnectionInstallHostClientV1 {
	/** Delivers the service credential only as AES-256-GCM ciphertext under the exporter key. */
	supply(
		input: {
			readonly template: ConnectionRegistrationTemplateV1;
			readonly attemptId: string;
			readonly credential: Uint8Array;
			/** Current trusted Store facts; must equal the template target. */
			readonly target: ConnectionInstallHostTargetV1;
		},
		signal: AbortSignal,
	): Promise<void>;
	command(
		input: {
			readonly command: "prepare" | "status" | "revoke";
			readonly commandId: string;
			readonly attemptId: string;
			readonly attemptOwner: string;
			readonly template: ConnectionRegistrationTemplateV1;
			readonly supplyAttemptId: string;
			readonly registrationKey: string;
			/** Revoke only: the receipt-confirmed client and instance. */
			readonly expected?: {
				readonly consumerId: string;
				readonly clientId: string;
				readonly instanceId: string;
			};
		},
		signal: AbortSignal,
	): Promise<ConnectionInstallCommandResponseV1>;
	/** The single begin that fixes the configuration on the Host and creates the link. */
	firstBegin(
		input: {
			readonly commandId: string;
			readonly attemptId: string;
			readonly attemptOwner: string;
			readonly template: ConnectionRegistrationTemplateV1;
			readonly supplyAttemptId: string;
			readonly receipt: ConnectionRegistrationReceiptV1;
			readonly configuration: RuntimeOAuthConfigurationV1;
			readonly request: Omit<RuntimeOAuthAuthorizedRequestV1, "grant">;
			readonly principal: { readonly kind: "user"; readonly id: string };
		},
		signal: AbortSignal,
	): Promise<RuntimeOAuthResponseV1>;
	/** Read-only recovery of the consumed first begin; `configuration` only validates the link. */
	beginStatus(
		input: {
			readonly commandId: string;
			readonly attemptId: string;
			readonly attemptOwner: string;
			readonly beginCommandId: string;
			readonly template: ConnectionRegistrationTemplateV1;
			readonly supplyAttemptId: string;
			readonly registrationKey: string;
			readonly configuration: RuntimeOAuthConfigurationV1;
		},
		signal: AbortSignal,
	): Promise<RuntimeOAuthResponseV1>;
}

const maxRequestBytes = 32_768;
const maxResponseBytes = 16_384;
const maxCredentialBytes = 8_192;
const grantLifetimeMs = 30_000;
/** Shape-only stand-in while validating an unsigned body; never sent. */
const unsignedGrant = "unsigned.unsigned.unsigned";

function unavailable(): never {
	throw new ConversationRuntimeHostError(
		"CONNECTION_INSTALLATION_UNAVAILABLE",
		false,
	);
}

/** The manual install configuration is a standard pre-registered client: no PAT, no DCR. */
function isStandardConfiguration(
	configuration: RuntimeOAuthConfigurationV1,
	template: ConnectionRegistrationTemplateV1,
): boolean {
	return (
		configuration.patBinding === undefined &&
		!("clientRegistration" in configuration) &&
		configuration.runtimeOrigin === template.target.runtimeOrigin
	);
}

/** Same link checks as `sendRuntimeOAuthRequest` for a standard (non-PAT) begin. */
function assertAuthorizationLink(
	result: RuntimeOAuthResponseV1,
	authorizationId: string,
	configuration: RuntimeOAuthConfigurationV1,
): void {
	if (
		result.authorizationId !== authorizationId ||
		result.phase !== "awaiting_callback" ||
		!result.authorizationUrl ||
		result.callbackStateHash !== undefined
	)
		unavailable();
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
		!/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("code_challenge") ?? "") ||
		url.origin !== expected.origin ||
		url.pathname !== expected.pathname ||
		url.username ||
		url.password ||
		url.hash
	)
		unavailable();
}

export function createConnectionInstallHostClientV1(options: {
	/** Deployment trust for Session Host install certificates. */
	readonly ca: string;
	readonly signing: ConnectionInstallWorkerSigningV1;
	/** Test-only seams; production resolves and connects to the fixed Service. */
	readonly lookup?: LookupFunction;
	readonly request?: typeof httpsRequest;
}): ConnectionInstallHostClientV1 {
	const signing = { ...options.signing };
	const ca = options.ca;
	if (
		typeof ca !== "string" ||
		!ca.includes("-----BEGIN CERTIFICATE-----") ||
		!(signing.privateKey instanceof KeyObject) ||
		signing.privateKey.type !== "private" ||
		signing.privateKey.asymmetricKeyType !== "ed25519" ||
		typeof signing.issuer !== "string" ||
		!signing.issuer ||
		typeof signing.workerId !== "string" ||
		!signing.workerId ||
		typeof signing.keyId !== "string" ||
		!signing.keyId ||
		(signing.now !== undefined && typeof signing.now !== "function")
	)
		throw new TypeError("Connection install Host client options are invalid");
	const privateKey = signing.privateKey;
	const now = signing.now ?? Date.now;
	const { lookup, request } = options;

	function jws(typ: string, claims: unknown): string {
		const header = Buffer.from(
			JSON.stringify({ alg: "EdDSA", kid: signing.keyId, typ }),
		).toString("base64url");
		const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
		const input = `${header}.${payload}`;
		return `${input}.${sign(null, Buffer.from(input, "ascii"), privateKey).toString("base64url")}`;
	}

	/** Claims shared by every Worker → Host install JWS; issued inside `prepare`. */
	function installClaims(channelBinding: string, requestDigest: string) {
		const issuedAt = now();
		return {
			schemaVersion: 1 as const,
			audience: "runtime_connection_install" as const,
			issuer: signing.issuer,
			workerId: signing.workerId,
			grantId: randomUUID(),
			issuedAt,
			expiresAt: issuedAt + grantLifetimeMs,
			channelBinding,
			requestDigest,
		};
	}

	/**
	 * One POST; `body` runs after the server is authenticated and before any
	 * request byte is written, so everything it signs binds this connection.
	 */
	async function send(
		origin: string,
		path: string,
		signal: AbortSignal,
		body: (
			channelBinding: string,
			exporter: ConnectionInstallTlsExporterV1,
		) => unknown,
	): Promise<unknown> {
		const response = await requestOverConnectionInstallTlsV1({
			origin,
			path,
			ca,
			signal,
			maxResponseBytes,
			request,
			lookup,
			prepare: (exporter) => {
				const channelBinding = exporter(
					connectionInstallExporterLabelsV1.channel,
					32,
				).toString("base64url");
				const bytes = Buffer.from(
					JSON.stringify(body(channelBinding, exporter)),
					"utf8",
				);
				if (bytes.byteLength > maxRequestBytes) unavailable();
				return { body: bytes };
			},
		});
		if (response.status !== 200 || response.body.byteLength > maxResponseBytes)
			unavailable();
		return JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(response.body),
		);
	}

	/** Never surfaces the cause: zod, TLS or Host errors could quote request data. */
	async function guarded<T>(run: () => Promise<T>): Promise<T> {
		try {
			return await run();
		} catch {
			return unavailable();
		}
	}

	/** The original EP-1060 key must be the one the template was generated for. */
	function registrationKeyHashFor(
		template: ConnectionRegistrationTemplateV1,
		registrationKey: string,
	): string {
		const registrationKeyHash = connectionRegistrationKeyHashV1(
			ConnectionRegistrationKeyV1Schema.parse(registrationKey),
		);
		if (registrationKeyHash !== template.registration.registrationKeyHash)
			unavailable();
		return registrationKeyHash;
	}

	return {
		supply(input, signal) {
			return guarded(async () => {
				const template = ConnectionRegistrationTemplateV1Schema.parse(
					input.template,
				);
				const { runtimeOrigin, ...target } = template.target;
				const attemptId =
					ConnectionHostSupplyRequestV1Schema.shape.attemptId.parse(
						input.attemptId,
					);
				const credential = input.credential;
				// Same plaintext bound as the AEAD envelope; checked before connecting.
				if (
					!isDeepStrictEqual({ ...input.target }, target) ||
					!(credential instanceof Uint8Array) ||
					credential.byteLength < 1 ||
					credential.byteLength > maxCredentialBytes
				)
					unavailable();
				const templateDigest = connectionRegistrationTemplateDigestV1(template);
				const binding: ConnectionHostSupplyBindingV1 = {
					...target,
					supplyRef: template.supply.ref,
					supplyRevision: template.supply.revision,
					attemptId,
					templateDigest,
				};
				// Validates the AAD tuple before any connection is opened.
				const aad = encodeConnectionHostSupplyAadV1(binding);
				const result = ConnectionHostSupplyResponseV1Schema.parse(
					await send(
						runtimeOrigin,
						connectionInstallPathsV1.supply,
						signal,
						(channelBinding, exporter) => {
							const key = exporter(
								connectionInstallExporterLabelsV1.supplyKey,
								32,
								aad,
							);
							let envelope: ReturnType<typeof sealConnectionHostSupplyV1>;
							try {
								envelope = sealConnectionHostSupplyV1(credential, key, binding);
							} finally {
								key.fill(0);
							}
							const unsigned = {
								schemaVersion: 1 as const,
								template,
								attemptId,
								envelope,
							};
							const claims = ConnectionHostSupplyClaimsV1Schema.parse({
								...installClaims(
									channelBinding,
									connectionInstallRequestDigestV1(unsigned),
								),
								purpose: "connection_host_supply",
								binding,
							});
							return ConnectionHostSupplyRequestV1Schema.parse({
								...unsigned,
								grant: jws(connectionInstallJwsTypesV1.supply, claims),
							});
						},
					),
				);
				if (
					result.attemptId !== attemptId ||
					result.templateDigest !== templateDigest
				)
					unavailable();
			});
		},

		command(input, signal) {
			return guarded(async () => {
				const template = ConnectionRegistrationTemplateV1Schema.parse(
					input.template,
				);
				const registrationKeyHash = registrationKeyHashFor(
					template,
					input.registrationKey,
				);
				if ((input.command === "revoke") !== (input.expected !== undefined))
					unavailable();
				const { grant: _grant, ...unsigned } =
					ConnectionInstallCommandRequestV1Schema.parse({
						schemaVersion: 1,
						command: input.command,
						commandId: input.commandId,
						attemptId: input.attemptId,
						attemptOwner: input.attemptOwner,
						template,
						supplyAttemptId: input.supplyAttemptId,
						registrationKey: input.registrationKey,
						...(input.expected !== undefined
							? { expected: input.expected }
							: {}),
						grant: unsignedGrant,
					});
				const templateDigest = connectionRegistrationTemplateDigestV1(template);
				const requestDigest = connectionInstallRequestDigestV1(unsigned);
				const result = ConnectionInstallCommandResponseV1Schema.parse(
					await send(
						template.target.runtimeOrigin,
						connectionInstallPathsV1[unsigned.command],
						signal,
						(channelBinding) => ({
							...unsigned,
							grant: jws(
								connectionInstallJwsTypesV1.registration,
								ConnectionInstallCommandClaimsV1Schema.parse({
									...installClaims(channelBinding, requestDigest),
									purpose: "connection_registration",
									command: unsigned.command,
									commandId: unsigned.commandId,
									attemptId: unsigned.attemptId,
									attemptOwner: unsigned.attemptOwner,
									authorizationId: template.authorizationId,
									templateDigest,
									supplyAttemptId: unsigned.supplyAttemptId,
									registrationKeyHash,
								}),
							),
						}),
					),
				);
				if (
					result.commandId !== unsigned.commandId ||
					(result.outcome === "registered" &&
						(unsigned.command === "revoke" ||
							!matchConnectionRegistrationReceiptV1(
								result.receipt,
								template,
								unsigned.registrationKey,
							))) ||
					(result.outcome === "revoked" && unsigned.command !== "revoke")
				)
					unavailable();
				return result;
			});
		},

		firstBegin(input, signal) {
			return guarded(async () => {
				const template = ConnectionRegistrationTemplateV1Schema.parse(
					input.template,
				);
				const configuration = RuntimeOAuthConfigurationV1Schema.parse(
					input.configuration,
				);
				const receipt = ConnectionRegistrationReceiptV1Schema.parse(
					input.receipt,
				);
				if (input.request.command !== "begin") unavailable();
				const { grant: _grant, ...request } =
					RuntimeOAuthAuthorizedRequestV1Schema.parse({
						...input.request,
						command: "begin",
						grant: {
							schemaVersion: 1,
							format: "runtime-connection-installation-jws",
							token: unsignedGrant,
						},
					});
				// Everything the Host verifies against its local facts is checked
				// before this Worker signs or connects.
				if (
					!isStandardConfiguration(configuration, template) ||
					configuration.clientId !== receipt.clientId ||
					!matchConnectionRegistrationReceiptV1(
						receipt,
						template,
						receipt.registrationKey,
					) ||
					!isDeepStrictEqual({ ...input.principal }, template.principal) ||
					request.oauthConfiguration.ref !== configuration.ref ||
					request.oauthConfiguration.revision !== configuration.revision ||
					request.authorizationId !== template.authorizationId ||
					request.confirmationRevision !== template.confirmationRevision ||
					!isDeepStrictEqual(request.reference, template.reference) ||
					request.agentId !== template.reference.agentId ||
					request.sandboxId !== template.target.sandboxId ||
					request.podUid !== template.target.podUid ||
					request.sessionGeneration !== template.target.sessionGeneration ||
					request.configFingerprint !==
						template.registration.configFingerprint ||
					!isDeepStrictEqual(request.source, template.registration.source)
				)
					unavailable();
				const body = ConnectionInstallFirstBeginRequestV1Schema.parse({
					schemaVersion: 1,
					commandId: input.commandId,
					attemptId: input.attemptId,
					attemptOwner: input.attemptOwner,
					template,
					supplyAttemptId: input.supplyAttemptId,
					receipt,
					configuration,
					request: {
						...request,
						grant: {
							schemaVersion: 1,
							format: "runtime-connection-installation-jws",
							token: unsignedGrant,
						},
					},
				});
				// The installation JWS signs the unsigned request; the outer body
				// digest excludes the grant that carries it.
				const requestDigest = createHash("sha256")
					.update(canonicalRuntimeRequestSigningPayload(body.request))
					.digest("hex");
				const bodyDigest = connectionInstallRequestDigestV1({
					...body,
					request: { ...body.request, grant: undefined },
				});
				const templateDigest = connectionRegistrationTemplateDigestV1(template);
				const receiptDigest = connectionRegistrationReceiptDigestV1(receipt);
				const configurationDigest =
					connectionInstallConfigurationDigestV1(configuration);
				const result = RuntimeOAuthResponseV1Schema.parse(
					await send(
						template.target.runtimeOrigin,
						connectionInstallPathsV1.begin,
						signal,
						(channelBinding) => {
							const issuedAt = now();
							const claims =
								ConnectionInstallFirstBeginGrantClaimsV1Schema.parse({
									...request,
									schemaVersion: 1,
									purpose: "connection_installation",
									audience: "runtime_connection_client",
									issuer: signing.issuer,
									workerId: signing.workerId,
									principal: template.principal,
									command: "begin",
									confirmationRevision: request.confirmationRevision,
									grantId: randomUUID(),
									issuedAt,
									expiresAt: issuedAt + grantLifetimeMs,
									requestDigest,
									firstBegin: {
										commandId: body.commandId,
										attemptId: body.attemptId,
										attemptOwner: body.attemptOwner,
										templateDigest,
										supplyAttemptId: body.supplyAttemptId,
										registrationKeyHash:
											template.registration.registrationKeyHash,
										receiptDigest,
										configurationDigest,
										bodyDigest,
										channelBinding,
									},
								});
							return {
								...body,
								request: RuntimeOAuthAuthorizedRequestV1Schema.parse({
									...body.request,
									grant: {
										schemaVersion: 1,
										format: "runtime-connection-installation-jws",
										token: jws(connectionInstallJwsTypesV1.firstBegin, claims),
									},
								}),
							};
						},
					),
				);
				assertAuthorizationLink(
					result,
					template.authorizationId,
					configuration,
				);
				return result;
			});
		},

		beginStatus(input, signal) {
			return guarded(async () => {
				const template = ConnectionRegistrationTemplateV1Schema.parse(
					input.template,
				);
				const configuration = RuntimeOAuthConfigurationV1Schema.parse(
					input.configuration,
				);
				const registrationKeyHash = registrationKeyHashFor(
					template,
					input.registrationKey,
				);
				if (!isStandardConfiguration(configuration, template)) unavailable();
				const { grant: _grant, ...unsigned } =
					ConnectionInstallBeginStatusRequestV1Schema.parse({
						schemaVersion: 1,
						commandId: input.commandId,
						attemptId: input.attemptId,
						attemptOwner: input.attemptOwner,
						beginCommandId: input.beginCommandId,
						template,
						supplyAttemptId: input.supplyAttemptId,
						registrationKey: input.registrationKey,
						grant: unsignedGrant,
					});
				const templateDigest = connectionRegistrationTemplateDigestV1(template);
				const requestDigest = connectionInstallRequestDigestV1(unsigned);
				const result = RuntimeOAuthResponseV1Schema.parse(
					await send(
						template.target.runtimeOrigin,
						connectionInstallPathsV1.beginStatus,
						signal,
						(channelBinding) => ({
							...unsigned,
							grant: jws(
								connectionInstallJwsTypesV1.registration,
								ConnectionInstallCommandClaimsV1Schema.parse({
									...installClaims(channelBinding, requestDigest),
									purpose: "connection_registration",
									command: "begin_status",
									commandId: unsigned.commandId,
									attemptId: unsigned.attemptId,
									attemptOwner: unsigned.attemptOwner,
									authorizationId: template.authorizationId,
									templateDigest,
									supplyAttemptId: unsigned.supplyAttemptId,
									registrationKeyHash,
								}),
							),
						}),
					),
				);
				assertAuthorizationLink(
					result,
					template.authorizationId,
					configuration,
				);
				return result;
			});
		},
	};
}
