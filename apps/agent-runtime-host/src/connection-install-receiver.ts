import {
	createHash,
	createPrivateKey,
	type KeyObject,
	randomBytes,
	randomUUID,
	timingSafeEqual,
	verify,
	X509Certificate,
} from "node:crypto";
import { readdir } from "node:fs/promises";
import { createServer as createHttpsServer } from "node:https";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	type ConnectionHostSupplyBindingV1,
	type ConnectionInstallTlsExporterV1,
	connectionInstallServerExporterV1,
	type DynamicConnectionClientV1,
	DynamicConnectionRefusalV1,
	encodeConnectionHostSupplyAadV1,
	type FileRuntimeStore,
	openConnectionHostSupplyV1,
	RuntimeHostError,
	type RuntimeOriginalExecutionRef,
	readConnectionMachineOAuthClientOutcomeV1,
	readConnectionMachineOAuthClientV1,
	registerConnectionMachineOAuthClientV1,
	revokeConnectionMachineOAuthClientV1,
	validateStandardMcpInput,
	validateStandardMcpInstallationMetadata,
	validateStandardMcpToken,
} from "@agent-infra/agent-runtime";
import {
	type ApprovedConnectionConsumerTargetV1,
	resolveApprovedConnectionSystemAccessV1,
} from "@agent-infra/contracts/connection-consumer-profile";
import {
	ConnectionHostInstallTargetV1Schema,
	ConnectionHostSupplyClaimsV1Schema,
	type ConnectionHostSupplyRequestV1,
	ConnectionHostSupplyRequestV1Schema,
	ConnectionHostSupplyResponseV1Schema,
	type ConnectionInstallBeginStatusRequestV1,
	ConnectionInstallBeginStatusRequestV1Schema,
	ConnectionInstallCommandClaimsV1Schema,
	type ConnectionInstallCommandRequestV1,
	ConnectionInstallCommandRequestV1Schema,
	type ConnectionInstallCommandResponseV1,
	ConnectionInstallCommandResponseV1Schema,
	type ConnectionInstallConfirmBindingReadbackRequestV1,
	ConnectionInstallConfirmBindingReadbackRequestV1Schema,
	type ConnectionInstallConfirmBindingReadbackResponseV1,
	ConnectionInstallConfirmBindingReadbackResponseV1Schema,
	type ConnectionInstallConfirmExchangeRequestV1,
	ConnectionInstallConfirmExchangeRequestV1Schema,
	type ConnectionInstallConfirmExchangeResponseV1,
	ConnectionInstallConfirmExchangeResponseV1Schema,
	type ConnectionInstallFirstBeginGrantClaimsV1,
	ConnectionInstallFirstBeginGrantClaimsV1Schema,
	type ConnectionInstallFirstBeginRequestV1,
	ConnectionInstallFirstBeginRequestV1Schema,
	ConnectionManualConfirmCandidateV1Schema,
	type ConnectionManualInstallDescriptorV1,
	ConnectionManualInstallDescriptorV1Schema,
	type ConnectionRegistrationReceiptV1,
	type ConnectionRegistrationTemplateV1,
	canonicalRuntimeRequestSigningPayload,
	connectionHostDeploymentIdentityV1,
	connectionInstallExporterLabelsV1,
	connectionInstallJwsTypesV1,
	connectionInstallPathsV1,
	connectionManualConfirmContractV1,
	connectionServiceCredentialPatternV1,
	type RuntimeOAuthAuthorizedRequestV1,
	RuntimeOAuthAuthorizedRequestV1Schema,
	RuntimeOAuthCallbackRequestV1Schema,
	type RuntimeOAuthConfigurationV1,
	RuntimeOAuthConfigurationV1Schema,
	type RuntimeOAuthGrantClaimsV1,
	RuntimeOAuthGrantClaimsV1Schema,
	type RuntimeOAuthResponseV1,
	RuntimeOAuthResponseV1Schema,
	type RuntimeOAuthScopeV1,
	RuntimeOAuthScopeV1Schema,
	runtimeOAuthScopeV1,
} from "@agent-infra/contracts/runtime";
import {
	connectionInstallConfigurationDigestV1,
	connectionInstallRequestDigestV1,
	connectionManualConfirmCandidateDigestV1,
	connectionManualInstallConfigurationV1,
	connectionManualInstallDescriptorDigestV1,
	connectionManualInstallDescriptorMatchesV1,
	connectionRegistrationKeyHashV1,
	connectionRegistrationReceiptDigestV1,
	connectionRegistrationTemplateDigestV1,
	matchConnectionRegistrationReceiptV1,
	verifyConnectionRegistrationTemplateV1,
} from "@agent-infra/contracts/runtime/connection-install-node";
import { getRequestListener, type HttpBindings } from "@hono/node-server";
import { Hono } from "hono";
import {
	type ConnectionInstallReadbackClientV1,
	type ConnectionInstallReadbackInputV1,
	createConnectionInstallReadbackClientV1,
} from "./connection-install-readback-client.js";
import {
	createProtectedRuntimeOAuthClient,
	eraseRuntimeOAuthInstallationMaterials,
	type ProtectedRuntimeOAuthClient,
	sealRuntimeOAuthInstallationPublication,
} from "./runtime-oauth-client.js";
import {
	createRuntimeOAuthDynamicPublication,
	parseRuntimeOAuthDynamicPublicationContractV1,
	type RuntimeOAuthDynamicPublicationContractV1,
} from "./runtime-oauth-dynamic-publication.js";
import { runtimeOAuthPublicationCommitDigestV1 } from "./runtime-oauth-publication.js";
import {
	openProtectedStandardMcpDirectory,
	readProtectedStandardMcpBytes,
} from "./standard-mcp-files.js";
import {
	standardMcpInstallationKey,
	standardMcpMaterialKey,
} from "./standard-mcp-input.js";
import {
	assertProtectedStandardMcpExportCommitted,
	ensurePrivateDirectory,
	publishMetadata,
	standardMcpExportKey,
} from "./standard-mcp-installation.js";
import { assertStandardMcpProcessProtection } from "./standard-mcp-protection.js";

type InstallStore = Pick<
	FileRuntimeStore,
	| "resolveInstallationSessionBinding"
	| "assertInstallationSessionBindingCurrent"
	| "resolveInstallationSessionHostRef"
	| "resolveOriginalExecutionBinding"
	| "assertOriginalExecutionBindingCurrent"
	| "resolveOriginalExecutionHostSessionRef"
>;
type MachineFetch = Parameters<
	typeof registerConnectionMachineOAuthClientV1
>[0]["fetch"];
type SystemAccess = Parameters<
	typeof connectionManualInstallConfigurationV1
>[0]["access"];
type Template = ConnectionRegistrationTemplateV1;
type Receipt = ConnectionRegistrationReceiptV1;

export type ConnectionInstallReceiverEnvV1 = {
	Bindings: HttpBindings;
	Variables: { exporter: ConnectionInstallTlsExporterV1; channel: string };
};

export type ConnectionInstallReceiverAssemblyV1 =
	| { readonly status: "unavailable" }
	| {
			readonly status: "available";
			readonly fetch: Hono<ConnectionInstallReceiverEnvV1>["fetch"];
			readonly key: string;
			readonly cert: string;
			readonly port: number;
			readonly runtimeOrigin: string;
			/**
			 * §13.5.6 动态安装的 reader (ADR-0048): the Driver's per-Execution
			 * `resolveInput` for this Host's dynamic manual installations; present
			 * only with the approved dynamic publication contract.
			 */
			readonly dynamicReader?: {
				readonly contract: RuntimeOAuthDynamicPublicationContractV1;
				resolveTarget(
					reference: RuntimeOriginalExecutionRef,
					signal: AbortSignal,
				): Promise<ApprovedConnectionConsumerTargetV1>;
				resolveInput(
					reference: RuntimeOriginalExecutionRef,
					signal: AbortSignal,
				): Promise<unknown>;
			};
			close(): Promise<void>;
	  };

/**
 * §13.5.6 (ADR-0048): the Driver input for a receiver's dynamic reader. The
 * Codex Thread, or the Claude, ACP and Pi Execution, declares the contract's
 * tools; each call reads its installation through the reader.
 */
export function dynamicConnectionClientForReaderV1(
	reader: NonNullable<
		Extract<
			ConnectionInstallReceiverAssemblyV1,
			{ status: "available" }
		>["dynamicReader"]
	>,
): DynamicConnectionClientV1 | undefined {
	const declarations = reader.contract.toolDeclarations;
	if (!declarations) return undefined;
	// Live discovery lists tools in the contract's order; declare them the same way.
	const tools = reader.contract.contract.tools.map((tool) =>
		declarations.find(
			(declaration) => declaration.name === (tool as { name?: unknown }).name,
		),
	);
	if (tools.some((tool) => tool === undefined)) return undefined;
	return {
		declared: {
			contract: {
				ref: reader.contract.contract.ref,
				revision: reader.contract.contract.revision,
			},
			tools: structuredClone(tools as NonNullable<(typeof tools)[number]>[]),
		},
		resolveTarget: (reference, signal) =>
			reader.resolveTarget(reference, signal),
		resolveInput: (reference, signal) => reader.resolveInput(reference, signal),
	};
}

/** Same input under its Codex-era name. */
export const codexDynamicConnectionClientForReaderV1 =
	dynamicConnectionClientForReaderV1;

export interface ConnectionInstallReceiverOptionsV1 {
	readonly environment: NodeJS.ProcessEnv;
	readonly dataDirectory: string;
	readonly agentId: string | undefined;
	readonly workerId: string | undefined;
	/** Worker runtime grant public key (Ed25519). */
	readonly key: KeyObject;
	readonly keyId: string;
	readonly issuer: string;
	/** Worker business credential; it only authorizes post-begin standard routes. */
	readonly serviceToken: string;
	readonly store: InstallStore;
	/** EP-1060 and token endpoint seam; production uses global fetch. */
	readonly fetch?: MachineFetch;
	readonly readback?: ConnectionInstallReadbackClientV1;
	readonly now?: () => number;
	/**
	 * §13.5.6 deployment-approved dynamic publication contract (`serviceRef`,
	 * `contract`), from the protected deployment input at assembly only. Absent,
	 * an exception exchange publishes nothing and its install is closed.
	 */
	readonly dynamicPublication?: RuntimeOAuthDynamicPublicationContractV1;
}

interface SupplySlot {
	readonly binding: ConnectionHostSupplyBindingV1;
	readonly template: Template;
	readonly templateDigest: string;
	readonly credential: Buffer;
	state: "confirmed" | "closed";
}

interface RegistrationLedger {
	phase: "sending" | "registered" | "unknown" | "revoked" | "revoke_unknown";
	readonly commands: Map<string, ConnectionInstallCommandRequestV1["command"]>;
	receipt?: Receipt;
}

interface FixedInstallationBinding {
	readonly template: Template;
	readonly supplyAttemptId: string;
	readonly expiresAt: number;
}

interface FixedInstallation extends FixedInstallationBinding {
	readonly client: ProtectedRuntimeOAuthClient;
	/**
	 * §13.5.6 exception installs exchange only through their `exchange` phase:
	 * one in-process confirm under claims this receiver built after every
	 * phase-2 gate held. The standard confirm route refuses them.
	 */
	readonly exchangeOnce: (
		request: RuntimeOAuthAuthorizedRequestV1,
		claims: RuntimeOAuthGrantClaimsV1,
		publication?: DynamicPublication,
	) => Promise<RuntimeOAuthResponseV1>;
}

type DynamicPublication = ReturnType<
	typeof createRuntimeOAuthDynamicPublication
>;

interface FirstBeginConsumption {
	readonly schemaVersion: 1;
	readonly authorizationId: string;
	readonly commandId: string;
	readonly bodyDigest: string;
	readonly supplyAttemptId: string;
	readonly configurationDigest: string;
	readonly receiptDigest: string;
	readonly descriptorDigest: string;
	readonly configuration: unknown;
	readonly template: unknown;
	readonly receipt: unknown;
	/** §13.5.6 descriptor fixed by this first begin; confirm and recovery follow it. */
	readonly descriptor: unknown;
}

const oauthRoot = [
	"codex-driver.json.native",
	"conversations",
	"standard-mcp-oauth",
] as const;
const firstBeginRecord = /^install-first-begin-([a-f0-9]{64})\.json$/;
/** §13.5.6 permit reference and commit digest of a published dynamic install. */
function dynamicPublicationRecordName(authorizationId: string) {
	return `install-dynamic-publication-${createHash("sha256").update(authorizationId).digest("hex")}.json`;
}
/** Durable fact that Connection confirmed the revoke of an installation's original key. */
const revokedRecord = /^install-revoked-([a-f0-9]{64})\.json$/;
const maxSlots = 8;
const maxFixedInstallations = 8;
const maxGrants = 4096;
const maxClosedSlots = 4096;
const maxLedgerCommands = 64;
const failureMessage = "Connection installation is unavailable";

function denied(): never {
	throw new RuntimeHostError(
		"RUNTIME_GRANT_INVALID",
		failureMessage,
		403,
		false,
	);
}

function conflict(): never {
	throw new RuntimeHostError(
		"CONNECTION_INSTALL_CONFLICT",
		failureMessage,
		409,
		false,
	);
}

function unavailable(): never {
	throw new RuntimeHostError(
		"CONNECTION_INSTALL_UNAVAILABLE",
		failureMessage,
		503,
		false,
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDigest(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function sha256Hex(value: string) {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function sameText(actual: string, expected: string) {
	const left = Buffer.from(actual);
	const right = Buffer.from(expected);
	return left.length === right.length && timingSafeEqual(left, right);
}

function bearer(header: string | undefined, expected: string) {
	return header?.startsWith("Bearer ") === true
		? sameText(header.slice(7), expected)
		: false;
}

function isAuthorizationDenial(error: unknown) {
	return (
		error instanceof RuntimeHostError && error.code === "RUNTIME_GRANT_INVALID"
	);
}

function positiveDecimal(value: string | undefined) {
	if (!value || !/^[1-9][0-9]{0,15}$/.test(value)) unavailable();
	const number = Number(value);
	if (!Number.isSafeInteger(number)) unavailable();
	return number;
}

function httpsOrigin(value: string | undefined) {
	if (!value) unavailable();
	const url = new URL(value);
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== "/" ||
		!url.port ||
		url.href !== value
	)
		unavailable();
	return url;
}

function decodeSegment(value: string) {
	const bytes = Buffer.from(value, "base64url");
	if (bytes.toString("base64url") !== value) denied();
	return bytes;
}

async function boundedJson(request: Request, guard: () => void) {
	const reader = request.body?.getReader();
	if (!reader) denied();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		for (;;) {
			const part = await reader.read();
			guard();
			if (part.done) break;
			length += part.value.byteLength;
			if (length > 32_768) denied();
			chunks.push(part.value);
		}
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
	try {
		return JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
		) as unknown;
	} catch {
		denied();
	}
}

function standardFirstBeginClaims(
	claims: ConnectionInstallFirstBeginGrantClaimsV1,
): RuntimeOAuthGrantClaimsV1 {
	const {
		firstBegin: _firstBegin,
		installation: _installation,
		audience: _audience,
		...standard
	} = claims;
	return { ...standard, audience: "runtime_connection_client" };
}

/**
 * Spec §13.5.5–§13.5.7 empty Session Host install receiver. Absent rollout input
 * keeps today's Host; any configured but invalid input closes only this receiver.
 */
export async function prepareConnectionInstallReceiverV1(
	options: ConnectionInstallReceiverOptionsV1,
): Promise<ConnectionInstallReceiverAssemblyV1 | undefined> {
	const environment = { ...options.environment };
	if (environment.AGENT_INFRA_RUNTIME_CONNECTION_INSTALL_RECEIVER === undefined)
		return undefined;
	try {
		return await assembleConnectionInstallReceiver(options, environment);
	} catch {
		return { status: "unavailable" };
	}
}

/** Dedicated TLS 1.3 listener; forwarded headers and plain HTTP never attest a channel. */
export function startConnectionInstallReceiverServerV1(
	assembly: Extract<
		ConnectionInstallReceiverAssemblyV1,
		{ status: "available" }
	>,
) {
	assertStandardMcpProcessProtection();
	const server = createHttpsServer(
		{
			key: assembly.key,
			cert: assembly.cert,
			minVersion: "TLSv1.3",
			maxVersion: "TLSv1.3",
		},
		getRequestListener(assembly.fetch),
	);
	server.headersTimeout = 15_000;
	server.requestTimeout = 15_000;
	server.on("error", () => {
		void assembly.close().catch(() => undefined);
		server.close();
	});
	server.listen(assembly.port);
	return server;
}

async function assembleConnectionInstallReceiver(
	options: ConnectionInstallReceiverOptionsV1,
	environment: NodeJS.ProcessEnv,
): Promise<
	Extract<ConnectionInstallReceiverAssemblyV1, { status: "available" }>
> {
	if (environment.AGENT_INFRA_RUNTIME_CONNECTION_INSTALL_RECEIVER !== "v1")
		unavailable();
	// The pre-registered OAuth provisioning owns the same OAuth role; never both.
	if (
		environment.AGENT_INFRA_RUNTIME_CONNECTION_OAUTH_FILE !== undefined ||
		environment.AGENT_INFRA_RUNTIME_CONNECTION_OAUTH_PROVISIONED !== undefined
	)
		unavailable();
	const { agentId: agentInput, workerId: workerInput } = options;
	const { store, serviceToken, key, keyId, issuer } = options;
	const dataDirectory = options.dataDirectory;
	const now = options.now ?? Date.now;
	const machineFetch = options.fetch;
	// §13.5.6: the approved contract comes only from the deployment input at
	// assembly; present but invalid keeps the whole receiver unavailable.
	const dynamicPublication = options.dynamicPublication
		? structuredClone(options.dynamicPublication)
		: parseRuntimeOAuthDynamicPublicationContractV1(
				environment.AGENT_INFRA_RUNTIME_CONNECTION_INSTALL_PUBLICATION_CONTRACT,
			);
	if (
		!agentInput ||
		!workerInput ||
		!serviceToken ||
		!keyId ||
		!issuer ||
		key.type !== "public" ||
		key.asymmetricKeyType !== "ed25519"
	)
		unavailable();
	const agentId: string = agentInput;
	const workerId: string = workerInput;
	// Host-local trusted identity comes only from the downward API and deployment.
	const namespace = environment.AGENT_INFRA_RUNTIME_NAMESPACE ?? "";
	const sandboxId = environment.AGENT_INFRA_RUNTIME_SANDBOX_ID;
	const podName = environment.AGENT_INFRA_RUNTIME_POD_NAME;
	const deploymentIdentity = connectionHostDeploymentIdentityV1({
		namespace,
		workerId,
	});
	if (!sandboxId || podName !== `sandbox-${sandboxId}`) unavailable();
	const runtime = httpsOrigin(
		environment.AGENT_INFRA_RUNTIME_CONNECTION_INSTALL_ORIGIN,
	);
	const port = Number(runtime.port);
	if (
		port < 1024 ||
		port === Number(environment.PORT ?? 3003) ||
		runtime.href !== `https://${podName}.${namespace}.svc:${port}/`
	)
		unavailable();
	const localTarget = ConnectionHostInstallTargetV1Schema.omit({
		hostRef: true,
	}).parse({
		deploymentIdentity,
		sandboxId,
		podUid: environment.AGENT_INFRA_RUNTIME_POD_UID,
		sessionGeneration: positiveDecimal(
			environment.AGENT_INFRA_RUNTIME_SESSION_GENERATION,
		),
		resourceFence: positiveDecimal(
			environment.AGENT_INFRA_RUNTIME_RESOURCE_FENCE,
		),
		runtimeOrigin: runtime.href,
	});
	const workerOrigin = httpsOrigin(
		environment.AGENT_INFRA_RUNTIME_CONNECTION_INSTALL_WORKER_ORIGIN,
	).href;
	const approved = resolveApprovedConnectionSystemAccessV1(
		JSON.parse(
			environment.AGENT_INFRA_RUNTIME_CONNECTION_INSTALL_SYSTEM_ACCESS ??
				"null",
		),
		JSON.parse(
			environment.AGENT_INFRA_RUNTIME_CONNECTION_INSTALL_SYSTEM_ACCESS_APPROVAL ??
				"null",
		),
	);
	if (approved.status !== "available") unavailable();
	const access: SystemAccess = structuredClone(approved);
	const clientNameInput =
		environment.AGENT_INFRA_RUNTIME_CONNECTION_INSTALL_CLIENT_NAME;
	if (!clientNameInput || !/^[\x20-\x7e]{1,100}$/.test(clientNameInput))
		unavailable();
	const clientName: string = clientNameInput;
	// Never read TLS keys or install tokens before real process protection.
	assertStandardMcpProcessProtection();
	const tlsDirectory = join(dataDirectory, ...oauthRoot, "tls");
	const cert = await readProtectedStandardMcpBytes(
		tlsDirectory,
		"server.crt",
		16_384,
	);
	const tlsKey = await readProtectedStandardMcpBytes(
		tlsDirectory,
		"server.key",
		16_384,
	);
	const callbackToken = validateStandardMcpToken(
		await readProtectedStandardMcpBytes(tlsDirectory, "callback.auth", 4096),
	);
	const installToken = await readProtectedStandardMcpBytes(
		tlsDirectory,
		"install.auth",
		4096,
	);
	const workerCa = await readProtectedStandardMcpBytes(
		tlsDirectory,
		"worker-ca.crt",
		16_384,
	);
	assertStandardMcpProcessProtection();
	if (
		!/^[\x21-\x7e]{32,4096}$/.test(installToken) ||
		new Set([serviceToken, callbackToken, installToken]).size !== 3 ||
		!workerCa.includes("-----BEGIN CERTIFICATE-----")
	)
		unavailable();
	const certificate = new X509Certificate(cert);
	const assembledAt = now();
	if (
		!certificate.checkHost(runtime.hostname) ||
		!certificate.checkPrivateKey(createPrivateKey(tlsKey)) ||
		Date.parse(certificate.validFrom) > assembledAt ||
		Date.parse(certificate.validTo) <= assembledAt
	)
		unavailable();
	const readback =
		options.readback ??
		createConnectionInstallReadbackClientV1({
			origin: workerOrigin,
			ca: workerCa,
			installToken,
		});
	let records = dataDirectory;
	for (const part of [...oauthRoot, "records"]) {
		records = join(records, part);
		await ensurePrivateDirectory(records);
	}

	const abort = new AbortController();
	let closed = false;
	let closing: Promise<void> | undefined;
	let queued = 0;
	let tail: Promise<unknown> = Promise.resolve();
	const grants = new Map<string, number>();
	const slots = new Map<string, SupplySlot>();
	const closedSlots = new Set<string>();
	const ledgers = new Map<string, RegistrationLedger>();
	const fixed = new Map<string, FixedInstallation>();
	/** Revoked installations whose local erase is still to be retried. */
	const unerased = new Map<string, RevokedFacts>();

	function closeSlot(authorizationId: string) {
		const slot = slots.get(authorizationId);
		if (slot) {
			slot.credential.fill(0);
			slot.state = "closed";
		}
		// A closed supply never reopens, even after its slot is evicted.
		closedSlots.delete(authorizationId);
		closedSlots.add(authorizationId);
		if (closedSlots.size > maxClosedSlots) {
			const oldest = closedSlots.values().next().value;
			if (oldest !== undefined) closedSlots.delete(oldest);
		}
	}
	function closeAllSlots() {
		for (const authorizationId of slots.keys()) closeSlot(authorizationId);
	}
	const current = () => {
		try {
			assertStandardMcpProcessProtection();
		} catch (error) {
			// Without real protection no received credential stays open (§13.5.5).
			closeAllSlots();
			throw error;
		}
		if (closed) unavailable();
	};
	// ponytail: one bounded install queue per Host; split by installation if throughput requires it.
	function serial<T>(operation: () => Promise<T>) {
		current();
		if (queued >= 32) unavailable();
		queued++;
		const result = tail
			.then(async () => {
				current();
				return operation();
			})
			.finally(() => {
				queued--;
			});
		tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	function verifyCompact(token: string, typ: string): unknown {
		try {
			const [headerPart, payloadPart, signaturePart, ...rest] =
				token.split(".");
			if (!headerPart || !payloadPart || !signaturePart || rest.length > 0)
				denied();
			const decoder = new TextDecoder("utf-8", { fatal: true });
			const header: unknown = JSON.parse(
				decoder.decode(decodeSegment(headerPart)),
			);
			if (
				!isRecord(header) ||
				Object.keys(header).sort().join(",") !== "alg,kid,typ" ||
				header.alg !== "EdDSA" ||
				header.kid !== keyId ||
				header.typ !== typ ||
				!verify(
					null,
					Buffer.from(`${headerPart}.${payloadPart}`, "ascii"),
					key,
					decodeSegment(signaturePart),
				)
			)
				denied();
			return JSON.parse(decoder.decode(decodeSegment(payloadPart)));
		} catch {
			denied();
		}
	}
	function admitFresh(claims: {
		readonly issuer: string;
		readonly workerId: string;
		readonly issuedAt: number;
		readonly expiresAt: number;
	}) {
		const at = now();
		if (
			claims.issuer !== issuer ||
			claims.workerId !== workerId ||
			!Number.isSafeInteger(at) ||
			claims.issuedAt > at ||
			claims.expiresAt <= at ||
			claims.expiresAt <= claims.issuedAt ||
			claims.expiresAt - claims.issuedAt > 30_000
		)
			denied();
		return at;
	}
	function assertInstallationClaims(
		claims: {
			readonly expiresAt: number;
			readonly installation: ConnectionInstallFirstBeginGrantClaimsV1["installation"];
		},
		template: Template,
	) {
		if (
			!isDeepStrictEqual(claims.installation, {
				principal: template.principal,
				reference: template.reference,
				authorizationId: template.authorizationId,
				confirmationRevision: template.confirmationRevision,
				target: template.target,
				expiresAt: template.expiresAt,
			}) ||
			claims.expiresAt > template.expiresAt ||
			template.expiresAt <= now()
		)
			denied();
	}

	function consumeGrant(grantId: string, expiresAt: number, at: number) {
		for (const [id, expiry] of grants) if (expiry <= at) grants.delete(id);
		if (grants.has(grantId)) denied();
		if (grants.size >= maxGrants) unavailable();
		grants.set(grantId, expiresAt);
	}
	/** Fresh, single-use and bound to this TLS connection's exporter value. */
	function admitWorkerClaims<
		T extends {
			readonly issuer: string;
			readonly workerId: string;
			readonly grantId: string;
			readonly issuedAt: number;
			readonly expiresAt: number;
			readonly channelBinding: string;
		},
	>(
		claims: T & {
			readonly installation: ConnectionInstallFirstBeginGrantClaimsV1["installation"];
		},
		channel: string,
		template: Template,
	) {
		const at = admitFresh(claims);
		assertInstallationClaims(claims, template);
		if (!sameText(claims.channelBinding, channel)) denied();
		consumeGrant(claims.grantId, claims.expiresAt, at);
		return claims;
	}

	function assertOriginal(
		template: Template,
		grantExpiresAt = template.expiresAt,
	) {
		current();
		if (now() >= Math.min(template.expiresAt, grantExpiresAt)) denied();
		store.assertInstallationSessionBindingCurrent(
			template.reference,
			template.principal,
			now,
		);
	}
	/** Template, Host-local target and original Execution checks (never request input). */
	async function admitTemplate(value: Template) {
		current();
		let verified: ReturnType<typeof verifyConnectionRegistrationTemplateV1>;
		try {
			verified = verifyConnectionRegistrationTemplateV1(
				value,
				access,
				clientName,
			);
		} catch {
			denied();
		}
		const template = verified.template;
		if (template.reference.agentId !== agentId) denied();
		const templateDigest = connectionRegistrationTemplateDigestV1(template);
		try {
			const hostRef = await store.resolveInstallationSessionHostRef(
				template.reference,
				now,
			);
			current();
			const target = ConnectionHostInstallTargetV1Schema.parse({
				...localTarget,
				hostRef,
			});
			if (!isDeepStrictEqual(template.target, target)) denied();
			const binding = await store.resolveInstallationSessionBinding(
				template.reference,
				now,
			);
			current();
			if (
				!isDeepStrictEqual(binding.principal, template.principal) ||
				!isDeepStrictEqual(binding.scope, template.reference)
			)
				denied();
			assertOriginal(template);
			return {
				template,
				consumer: verified.target,
				target,
				templateDigest,
			};
		} catch (error) {
			// Revocation, Host, Pod, generation or fence change closes the same supply.
			if (
				isAuthorizationDenial(error) &&
				slots.get(template.authorizationId)?.templateDigest === templateDigest
			)
				closeSlot(template.authorizationId);
			throw error;
		}
	}
	type Admitted = Awaited<ReturnType<typeof admitTemplate>>;

	function supplyReadback(
		admitted: Admitted,
		attemptId: string,
	): ConnectionInstallReadbackInputV1 {
		const { template, target, templateDigest } = admitted;
		return {
			purpose: "supply",
			target,
			principal: template.principal,
			reference: template.reference,
			authorizationId: template.authorizationId,
			confirmationRevision: template.confirmationRevision,
			templateDigest,
			supply: {
				ref: template.supply.ref,
				revision: template.supply.revision,
				attemptId,
			},
		};
	}
	function commandReadback(
		admitted: Admitted,
		supplyAttemptId: string,
		command: NonNullable<ConnectionInstallReadbackInputV1["command"]>,
	): ConnectionInstallReadbackInputV1 {
		return {
			...supplyReadback(admitted, supplyAttemptId),
			purpose: "command",
			command,
		};
	}
	async function readbackOutcome(input: ConnectionInstallReadbackInputV1) {
		try {
			current();
			return await readback.readback(input, abort.signal);
		} catch {
			return "unavailable" as const;
		}
	}

	function confirmedSlot(
		template: Template,
		templateDigest: string,
		supplyAttemptId: string,
	) {
		const slot = slots.get(template.authorizationId);
		return slot?.state === "confirmed" &&
			slot.templateDigest === templateDigest &&
			slot.binding.attemptId === supplyAttemptId
			? slot
			: undefined;
	}
	async function reserveSlot() {
		if (slots.size < maxSlots) return true;
		await reclaimFixedInstallations();
		await Promise.all(
			[...slots].map(async ([authorizationId, slot]) => {
				if (slot.state !== "confirmed" || fixed.has(authorizationId)) return;
				try {
					const admitted = await admitTemplate(slot.template);
					const outcome = await readbackOutcome(
						supplyReadback(admitted, slot.binding.attemptId),
					);
					if (outcome === "denied" && slots.get(authorizationId) === slot)
						closeSlot(authorizationId);
				} catch (error) {
					if (
						isAuthorizationDenial(error) &&
						slots.get(authorizationId) === slot
					)
						closeSlot(authorizationId);
				}
			}),
		);
		for (const [authorizationId, slot] of slots) {
			if (slot.state !== "closed") continue;
			slots.delete(authorizationId);
			ledgers.delete(authorizationId);
			return true;
		}
		return false;
	}

	async function supply(
		body: ConnectionHostSupplyRequestV1,
		exporter: ConnectionInstallTlsExporterV1,
		channel: string,
	) {
		const parsedClaims = ConnectionHostSupplyClaimsV1Schema.safeParse(
			verifyCompact(body.grant, connectionInstallJwsTypesV1.supply),
		);
		if (!parsedClaims.success) denied();
		const claims = admitWorkerClaims(parsedClaims.data, channel, body.template);
		if (claims.requestDigest !== connectionInstallRequestDigestV1(body))
			denied();
		const admitted = await admitTemplate(body.template);
		const { template, target, templateDigest } = admitted;
		// The AAD tuple is rebuilt from local facts only; the claims must name it.
		const binding: ConnectionHostSupplyBindingV1 = {
			deploymentIdentity: target.deploymentIdentity,
			hostRef: target.hostRef,
			sandboxId: target.sandboxId,
			podUid: target.podUid,
			sessionGeneration: target.sessionGeneration,
			resourceFence: target.resourceFence,
			supplyRef: template.supply.ref,
			supplyRevision: template.supply.revision,
			attemptId: body.attemptId,
			templateDigest,
		};
		if (!isDeepStrictEqual(claims.binding, binding)) denied();
		const authorizationId = template.authorizationId;
		const conflicting = () => {
			const slot = slots.get(authorizationId);
			return (
				closedSlots.has(authorizationId) ||
				(slot !== undefined &&
					(slot.state !== "confirmed" ||
						slot.templateDigest !== templateDigest ||
						slot.binding.attemptId !== body.attemptId))
			);
		};
		if (conflicting()) conflict();
		if (!slots.has(authorizationId) && !(await reserveSlot())) unavailable();
		const outcome = await readbackOutcome({
			...supplyReadback(admitted, body.attemptId),
			purpose: slots.has(authorizationId) ? "supply" : "supply_delivery",
		});
		assertOriginal(template, claims.expiresAt);
		if (outcome === "denied") denied();
		if (outcome !== "allowed") unavailable();
		if (conflicting()) conflict();
		assertOriginal(template, claims.expiresAt);
		const supplyKey = exporter(
			connectionInstallExporterLabelsV1.supplyKey,
			32,
			encodeConnectionHostSupplyAadV1(binding),
		);
		let credential: Buffer;
		try {
			credential = openConnectionHostSupplyV1(
				body.envelope,
				supplyKey,
				binding,
			);
		} catch {
			denied();
		} finally {
			supplyKey.fill(0);
		}
		let valid = false;
		try {
			valid = connectionServiceCredentialPatternV1.test(
				new TextDecoder("utf-8", { fatal: true }).decode(credential),
			);
		} catch {
			valid = false;
		}
		if (!valid) {
			credential.fill(0);
			denied();
		}
		const existing = slots.get(authorizationId);
		if (existing) {
			const same =
				existing.credential.byteLength === credential.byteLength &&
				timingSafeEqual(existing.credential, credential);
			credential.fill(0);
			if (!same || existing.state !== "confirmed") conflict();
		} else {
			slots.set(authorizationId, {
				binding,
				template,
				templateDigest,
				credential,
				state: "confirmed",
			});
		}
		return ConnectionHostSupplyResponseV1Schema.parse({
			schemaVersion: 1,
			outcome: "confirmed",
			attemptId: body.attemptId,
			templateDigest,
		});
	}

	async function registrationCommand(
		body: ConnectionInstallCommandRequestV1,
		channel: string,
	): Promise<ConnectionInstallCommandResponseV1> {
		const parsedClaims = ConnectionInstallCommandClaimsV1Schema.safeParse(
			verifyCompact(body.grant, connectionInstallJwsTypesV1.registration),
		);
		if (!parsedClaims.success) denied();
		const claims = admitWorkerClaims(parsedClaims.data, channel, body.template);
		const registrationKeyHash = connectionRegistrationKeyHashV1(
			body.registrationKey,
		);
		if (
			claims.command !== body.command ||
			claims.commandId !== body.commandId ||
			claims.attemptId !== body.attemptId ||
			claims.attemptOwner !== body.attemptOwner ||
			claims.supplyAttemptId !== body.supplyAttemptId ||
			claims.authorizationId !== body.template.authorizationId ||
			claims.templateDigest !==
				connectionRegistrationTemplateDigestV1(body.template) ||
			claims.registrationKeyHash !== registrationKeyHash ||
			registrationKeyHash !== body.template.registration.registrationKeyHash ||
			claims.requestDigest !== connectionInstallRequestDigestV1(body)
		)
			denied();
		const reply = (
			outcome: "revoked" | "unknown" | "rejected" | "supply_confirmed",
		) =>
			ConnectionInstallCommandResponseV1Schema.parse({
				schemaVersion: 1,
				outcome,
				commandId: body.commandId,
			});
		const registered = (receipt: Receipt) =>
			ConnectionInstallCommandResponseV1Schema.parse({
				schemaVersion: 1,
				outcome: "registered",
				commandId: body.commandId,
				receipt,
			});
		// Until the ledger enters sending, every refusal is definite: nothing was sent.
		let admitted: Admitted;
		try {
			admitted = await admitTemplate(body.template);
		} catch {
			return reply("rejected");
		}
		const { template, templateDigest } = admitted;
		const authorizationId = template.authorizationId;
		if (body.command === "supply_status") {
			const outcome = await readbackOutcome(
				commandReadback(admitted, body.supplyAttemptId, {
					commandId: body.commandId,
					attemptId: body.attemptId,
					attemptOwner: body.attemptOwner,
					command: "supply_status",
					requestDigest: claims.requestDigest,
					registrationKeyHash,
				}),
			);
			assertOriginal(template, claims.expiresAt);
			return reply(
				outcome === "allowed" &&
					confirmedSlot(template, templateDigest, body.supplyAttemptId)
					? "supply_confirmed"
					: "unknown",
			);
		}
		const ledger = ledgers.get(authorizationId);
		const seen = ledger?.commands.get(body.commandId);
		if (ledger && seen !== undefined) {
			// A command that already reached Connection is answered locally, never resent.
			if (seen !== body.command) return reply("rejected");
			if (
				body.command !== "revoke" &&
				ledger.phase === "registered" &&
				ledger.receipt
			)
				return registered(ledger.receipt);
			if (body.command === "revoke" && ledger.phase === "revoked")
				return reply("revoked");
			return reply("unknown");
		}
		const slot = confirmedSlot(template, templateDigest, body.supplyAttemptId);
		if (!slot || (body.command === "revoke") !== (body.expected !== undefined))
			return reply("rejected");
		if (ledger) {
			if (body.command === "prepare") return reply("rejected");
			if (
				body.command === "status" &&
				ledger.phase === "registered" &&
				ledger.receipt
			)
				return registered(ledger.receipt);
			if (
				(body.command === "status" &&
					ledger.phase !== "sending" &&
					ledger.phase !== "unknown") ||
				(body.command === "revoke" &&
					ledger.phase !== "registered" &&
					ledger.phase !== "unknown") ||
				ledger.commands.size >= maxLedgerCommands
			)
				return reply("rejected");
			if (
				body.command === "revoke" &&
				ledger.receipt &&
				!isDeepStrictEqual(body.expected, {
					consumerId: ledger.receipt.consumerId,
					clientId: ledger.receipt.clientId,
					instanceId: ledger.receipt.instanceId,
				})
			)
				return reply("rejected");
		}
		const readbackInput = commandReadback(admitted, body.supplyAttemptId, {
			commandId: body.commandId,
			attemptId: body.attemptId,
			attemptOwner: body.attemptOwner,
			command: body.command,
			requestDigest: claims.requestDigest,
			registrationKeyHash,
		});
		if ((await readbackOutcome(readbackInput)) !== "allowed")
			return reply("rejected");
		const assertCurrent = () => {
			current();
			if (slots.get(authorizationId) !== slot || slot.state !== "confirmed")
				unavailable();
			assertOriginal(template, claims.expiresAt);
		};
		try {
			assertCurrent();
		} catch {
			return reply("rejected");
		}
		// §13.5.6: before the revoke of the original key is sent, this installation
		// stops serving and its publication is durably closed; a revoke that cannot
		// close it first sends nothing.
		if (body.command === "revoke")
			try {
				await sealRevokingInstallation(template);
				assertCurrent();
			} catch {
				return reply("rejected");
			}
		const entry: RegistrationLedger = ledger ?? {
			phase: body.command === "prepare" ? "sending" : "unknown",
			commands: new Map(),
		};
		entry.commands.set(body.commandId, body.command);
		ledgers.set(authorizationId, entry);
		// Exactly one Connection request; any failure from here on stays unknown.
		const registration = template.registration;
		let receipt: Receipt | undefined;
		try {
			if (body.command === "revoke") {
				const expected = body.expected;
				if (!expected) unavailable();
				await revokeConnectionMachineOAuthClientV1({
					endpoint: registration.endpoint,
					// The adapter takes a string; it lives only for this one request.
					serviceCredential: slot.credential.toString("utf8"),
					registrationKey: body.registrationKey,
					expected,
					signal: abort.signal,
					assertCurrent,
					...(machineFetch ? { fetch: machineFetch } : {}),
				});
				entry.phase = "revoked";
			} else {
				const result =
					body.command === "prepare"
						? await registerConnectionMachineOAuthClientV1({
								endpoint: registration.endpoint,
								serviceCredential: slot.credential.toString("utf8"),
								registrationKey: body.registrationKey,
								clientName,
								redirectUri: registration.redirectUri,
								resource: registration.resource,
								scope: "mcp",
								source: registration.source,
								configFingerprint: registration.configFingerprint,
								signal: abort.signal,
								assertCurrent,
								...(machineFetch ? { fetch: machineFetch } : {}),
							})
						: await readConnectionMachineOAuthClientV1({
								endpoint: registration.endpoint,
								serviceCredential: slot.credential.toString("utf8"),
								registrationKey: body.registrationKey,
								signal: abort.signal,
								assertCurrent,
								...(machineFetch ? { fetch: machineFetch } : {}),
							});
				receipt = matchConnectionRegistrationReceiptV1(
					result.registration,
					template,
					body.registrationKey,
				);
				if (!receipt) unavailable();
				entry.phase = "registered";
				entry.receipt = receipt;
			}
		} catch {
			entry.phase = body.command === "revoke" ? "revoke_unknown" : "unknown";
			return reply("unknown");
		} finally {
			// After a revoke attempt the credential has no further use here.
			if (body.command === "revoke") closeSlot(authorizationId);
		}
		// Connection confirmed the revoke of the original key; only now are this
		// installation's Host copies erased. An unconfirmed revoke never gets here.
		if (body.command === "revoke") await eraseRevokedInstallation(template);
		const confirmed = await readbackOutcome(readbackInput);
		try {
			assertOriginal(template, claims.expiresAt);
		} catch {
			return reply("unknown");
		}
		if (confirmed !== "allowed") return reply("unknown");
		return receipt ? registered(receipt) : reply("revoked");
	}

	function installScope(
		template: Template,
		configuration: RuntimeOAuthConfigurationV1,
	): RuntimeOAuthScopeV1 {
		return RuntimeOAuthScopeV1Schema.parse({
			agentId,
			sandboxId: localTarget.sandboxId,
			podUid: localTarget.podUid,
			sessionGeneration: localTarget.sessionGeneration,
			configFingerprint: template.registration.configFingerprint,
			source: template.registration.source,
			oauthConfiguration: {
				ref: configuration.ref,
				revision: configuration.revision,
			},
		});
	}
	/** Existing installation JWS checks (runtime-oauth-grant.ts) plus the template binding. */
	function verifyFirstBeginToken(
		request: RuntimeOAuthAuthorizedRequestV1,
		template: Template,
		scope?: RuntimeOAuthScopeV1,
	) {
		const parsed = ConnectionInstallFirstBeginGrantClaimsV1Schema.safeParse(
			verifyCompact(
				request.grant.token,
				connectionInstallJwsTypesV1.firstBegin,
			),
		);
		if (!parsed.success) denied();
		const claims = parsed.data;
		admitFresh(claims);
		assertInstallationClaims(claims, template);
		if (
			request.command !== "begin" ||
			claims.command !== request.command ||
			claims.principal.kind !== "user" ||
			!isDeepStrictEqual(claims.principal, template.principal) ||
			claims.authorizationId !== request.authorizationId ||
			claims.authorizationId !== template.authorizationId ||
			claims.confirmationRevision !== request.confirmationRevision ||
			claims.confirmationRevision !== template.confirmationRevision ||
			!isDeepStrictEqual(claims.reference, request.reference) ||
			!isDeepStrictEqual(claims.reference, template.reference) ||
			!isDeepStrictEqual(
				runtimeOAuthScopeV1(claims),
				runtimeOAuthScopeV1(request),
			) ||
			claims.requestDigest !==
				sha256Hex(canonicalRuntimeRequestSigningPayload(request)) ||
			(scope !== undefined &&
				(claims.reference.agentId !== scope.agentId ||
					claims.reference.sessionGeneration !== scope.sessionGeneration ||
					!isDeepStrictEqual(runtimeOAuthScopeV1(request), scope)))
		)
			denied();
		return claims;
	}
	async function openFixedClient(
		template: Template,
		consumer: ApprovedConnectionConsumerTargetV1,
		configuration: RuntimeOAuthConfigurationV1,
		descriptor: ConnectionManualInstallDescriptorV1,
		firstBeginToken?: string,
	) {
		const scope = installScope(template, configuration);
		let activeToken = firstBeginToken;
		const exception =
			descriptor.principalMapping.kind === "consistency-exception-v1";
		let exchangeGrant:
			| { readonly token: string; readonly claims: RuntimeOAuthGrantClaimsV1 }
			| undefined;
		let exchangePublication: DynamicPublication | undefined;
		const client = await createProtectedRuntimeOAuthClient({
			dataDirectory,
			configuration,
			target: consumer,
			principal: template.principal,
			scope,
			store: {
				resolveOriginalExecutionBinding: async (reference, readNow) => {
					const binding = await store.resolveInstallationSessionBinding(
						reference,
						readNow,
					);
					assertOriginal(template);
					return binding;
				},
				assertOriginalExecutionBindingCurrent: (
					reference,
					principal,
					readNow,
				) => {
					assertOriginal(template);
					store.assertInstallationSessionBindingCurrent(
						reference,
						principal,
						readNow,
					);
				},
			},
			authorizationExpiresAt: template.expiresAt,
			...(machineFetch ? { fetch: machineFetch } : {}),
			// §13.5.6: only the exception `exchange` phase publishes, with the
			// dynamic publication its own confirm built from the pinned candidate.
			...(exception
				? {
						publicationVerifier: async (input) =>
							exchangePublication ? exchangePublication(input) : undefined,
					}
				: {}),
			verifyGrant: (request) => {
				// §13.5.6: the M1 dynamic path never refreshes; the install expires
				// with its access token and the user reinstalls.
				if (exception && request.command === "refresh") denied();
				if (exception && request.command === "confirm") {
					// §13.5.6: no standard confirm can stand in for the exchange phase.
					if (
						exchangeGrant === undefined ||
						exchangeGrant.claims.expiresAt <= now() ||
						template.expiresAt <= now() ||
						request.grant.token !== exchangeGrant.token
					)
						denied();
					return exchangeGrant.claims;
				}
				if (request.command !== "begin") denied();
				// Only the first begin consumed by this receiver may open the transaction.
				if (activeToken === undefined || request.grant.token !== activeToken)
					denied();
				return standardFirstBeginClaims(
					verifyFirstBeginToken(request, template, scope),
				);
			},
		});
		return {
			client,
			endFirstBegin: () => {
				activeToken = undefined;
			},
			exchangeOnce: async (
				request: RuntimeOAuthAuthorizedRequestV1,
				claims: RuntimeOAuthGrantClaimsV1,
				publication?: DynamicPublication,
			) => {
				if (!exception || request.command !== "confirm") denied();
				exchangeGrant = { token: request.grant.token, claims };
				exchangePublication = publication;
				try {
					return await client.authorized(request);
				} finally {
					exchangeGrant = undefined;
					exchangePublication = undefined;
				}
			},
		};
	}

	async function readRecord(name: string) {
		let text: string;
		try {
			text = await readProtectedStandardMcpBytes(
				records,
				name,
				65_536,
				current,
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		const value: unknown = JSON.parse(text);
		if (!isRecord(value)) unavailable();
		return value;
	}
	function parseConsumption(value: Record<string, unknown>) {
		if (
			Object.keys(value).sort().join(",") !==
				"authorizationId,bodyDigest,commandId,configuration,configurationDigest,descriptor,descriptorDigest,receipt,receiptDigest,schemaVersion,supplyAttemptId,template" ||
			value.schemaVersion !== 1 ||
			typeof value.authorizationId !== "string" ||
			typeof value.commandId !== "string" ||
			typeof value.supplyAttemptId !== "string" ||
			!value.supplyAttemptId ||
			!isDigest(value.bodyDigest) ||
			!isDigest(value.configurationDigest) ||
			!isDigest(value.receiptDigest) ||
			!isDigest(value.descriptorDigest) ||
			!ConnectionManualInstallDescriptorV1Schema.safeParse(value.descriptor)
				.success ||
			connectionManualInstallDescriptorDigestV1(
				value.descriptor as ConnectionManualInstallDescriptorV1,
			) !== value.descriptorDigest
		)
			unavailable();
		return value as unknown as FirstBeginConsumption;
	}
	function parseFirstBeginResult(
		value: Record<string, unknown>,
		consumption: FirstBeginConsumption,
	): RuntimeOAuthResponseV1 {
		const keys = [
			"authorizationId",
			"bodyDigest",
			"commandId",
			"expiresAt",
			"phase",
			"schemaVersion",
			...(value.authorizationUrl === undefined ? [] : ["authorizationUrl"]),
		]
			.sort()
			.join(",");
		if (
			Object.keys(value).sort().join(",") !== keys ||
			value.schemaVersion !== 1 ||
			value.authorizationId !== consumption.authorizationId ||
			value.commandId !== consumption.commandId ||
			value.bodyDigest !== consumption.bodyDigest
		)
			unavailable();
		const parsed = RuntimeOAuthResponseV1Schema.safeParse({
			schemaVersion: 1,
			authorizationId: value.authorizationId,
			phase: value.phase,
			expiresAt: value.expiresAt,
			...(value.authorizationUrl === undefined
				? {}
				: { authorizationUrl: value.authorizationUrl }),
		});
		if (!parsed.success) unavailable();
		return parsed.data;
	}

	async function firstBegin(
		body: ConnectionInstallFirstBeginRequestV1,
		channel: string,
	): Promise<RuntimeOAuthResponseV1> {
		const request = body.request;
		if (request.command !== "begin") denied();
		let template: Template;
		try {
			template = verifyConnectionRegistrationTemplateV1(
				body.template,
				access,
				clientName,
			).template;
		} catch {
			denied();
		}
		const templateDigest = connectionRegistrationTemplateDigestV1(template);
		const bodyDigest = connectionInstallRequestDigestV1({
			...body,
			request: { ...request, grant: undefined },
		});
		// 1. The installation JWS binds this exact command, body and TLS connection.
		const claims = verifyFirstBeginToken(request, template);
		const marker = claims.firstBegin;
		if (
			marker.commandId !== body.commandId ||
			marker.attemptId !== body.attemptId ||
			marker.attemptOwner !== body.attemptOwner ||
			marker.supplyAttemptId !== body.supplyAttemptId ||
			marker.templateDigest !== templateDigest ||
			marker.registrationKeyHash !==
				template.registration.registrationKeyHash ||
			marker.bodyDigest !== bodyDigest ||
			marker.receiptDigest !==
				connectionRegistrationReceiptDigestV1(body.receipt) ||
			marker.configurationDigest !==
				connectionInstallConfigurationDigestV1(body.configuration) ||
			marker.descriptorDigest !==
				connectionManualInstallDescriptorDigestV1(body.descriptor) ||
			!sameText(marker.channelBinding, channel)
		)
			denied();
		consumeGrant(claims.grantId, claims.expiresAt, now());
		// 2. Host-local target, original Execution and the confirmed supply.
		const admitted = await admitTemplate(template);
		if (!confirmedSlot(template, templateDigest, body.supplyAttemptId))
			conflict();
		// 3. The CAS-verified receipt of this installation.
		const receipt = matchConnectionRegistrationReceiptV1(
			body.receipt,
			template,
			body.receipt.registrationKey,
		);
		if (!receipt) conflict();
		const ledgerReceipt = ledgers.get(template.authorizationId)?.receipt;
		if (ledgerReceipt && !isDeepStrictEqual(ledgerReceipt, receipt)) conflict();
		// 4. The complete configuration is derived locally, never chosen by the request.
		let configuration: RuntimeOAuthConfigurationV1;
		try {
			configuration = connectionManualInstallConfigurationV1({
				access,
				template,
				receipt,
			});
		} catch {
			conflict();
		}
		if (!isDeepStrictEqual(configuration, body.configuration)) conflict();
		// The descriptor names exactly this receipt, configuration and supply.
		if (
			!connectionManualInstallDescriptorMatchesV1(body.descriptor, {
				template,
				receipt,
				configuration,
			})
		)
			conflict();
		const scope = installScope(template, configuration);
		if (!isDeepStrictEqual(runtimeOAuthScopeV1(request), scope)) conflict();
		// 5. A consumed first begin is never repeated, replayed or late-accepted.
		const recordKey = sha256Hex(template.authorizationId);
		const consumedName = `install-first-begin-${recordKey}.json`;
		if ((await readRecord(consumedName)) !== undefined) conflict();
		assertOriginal(template, claims.expiresAt);
		if (fixed.size >= maxFixedInstallations) {
			await reclaimFixedInstallations();
			if (fixed.size >= maxFixedInstallations) unavailable();
			assertOriginal(template, claims.expiresAt);
			if (!confirmedSlot(template, templateDigest, body.supplyAttemptId))
				conflict();
		}
		// 6. Worker authority for this exact begin command.
		const outcome = await readbackOutcome(
			commandReadback(admitted, body.supplyAttemptId, {
				commandId: body.commandId,
				attemptId: body.attemptId,
				attemptOwner: body.attemptOwner,
				command: "begin",
				requestDigest: marker.bodyDigest,
				registrationKeyHash: template.registration.registrationKeyHash,
				configurationDigest: marker.configurationDigest,
				receiptDigest: marker.receiptDigest,
				descriptorDigest: marker.descriptorDigest,
			}),
		);
		assertOriginal(template, claims.expiresAt);
		if (outcome === "denied") denied();
		if (outcome !== "allowed") unavailable();
		if (!confirmedSlot(template, templateDigest, body.supplyAttemptId))
			conflict();
		// Opened before consumption so a local I/O failure cannot strand the begin.
		const opened = await openFixedClient(
			template,
			admitted.consumer,
			configuration,
			body.descriptor,
			request.grant.token,
		);
		try {
			// 7. Atomic consumption: the immutable record exists at most once.
			assertOriginal(template, claims.expiresAt);
			if ((await readRecord(consumedName)) !== undefined) conflict();
			await publishMetadata(
				records,
				consumedName,
				{
					schemaVersion: 1,
					authorizationId: template.authorizationId,
					commandId: body.commandId,
					bodyDigest: marker.bodyDigest,
					supplyAttemptId: body.supplyAttemptId,
					configurationDigest: marker.configurationDigest,
					receiptDigest: marker.receiptDigest,
					descriptorDigest: marker.descriptorDigest,
					configuration,
					template,
					receipt,
					descriptor: body.descriptor,
				},
				{
					immutable: true,
					guard: () => assertOriginal(template, claims.expiresAt),
				},
			);
			// 8. Only the consumed first begin generates state, PKCE and the link.
			let result: RuntimeOAuthResponseV1;
			try {
				result = await opened.client.authorized(request);
			} finally {
				opened.endFirstBegin();
			}
			// 9. The original result is durable before the link is released.
			await publishMetadata(
				records,
				`install-first-begin-result-${recordKey}.json`,
				{
					schemaVersion: 1,
					commandId: body.commandId,
					bodyDigest: marker.bodyDigest,
					authorizationId: template.authorizationId,
					phase: result.phase,
					expiresAt: result.expiresAt,
					...(result.authorizationUrl
						? { authorizationUrl: result.authorizationUrl }
						: {}),
				},
				{ immutable: true },
			);
			fixed.set(template.authorizationId, {
				template,
				supplyAttemptId: body.supplyAttemptId,
				expiresAt: result.expiresAt,
				client: opened.client,
				exchangeOnce: opened.exchangeOnce,
			});
			assertOriginal(template, claims.expiresAt);
			return result;
		} catch (error) {
			if (fixed.get(template.authorizationId)?.client !== opened.client)
				await opened.client.close().catch(() => undefined);
			throw error;
		}
	}

	/**
	 * §13.5.6 exception confirm, phase 1 (`connection-manual-confirm/v1`). On a
	 * fixed installation and a sending phase command, the Host reads EP-1060
	 * back for the original key, checks the §13.5.1 item 2 gates and returns the
	 * non-secret candidate, recorded once under the phase key. It never reads a
	 * code or verifier, exchanges or publishes, and it writes nothing to the Store.
	 */
	async function confirmBindingReadback(
		body: ConnectionInstallConfirmBindingReadbackRequestV1,
		channel: string,
	): Promise<ConnectionInstallConfirmBindingReadbackResponseV1> {
		const parsedClaims = ConnectionInstallCommandClaimsV1Schema.safeParse(
			verifyCompact(body.grant, connectionInstallJwsTypesV1.registration),
		);
		if (!parsedClaims.success) denied();
		const claims = admitWorkerClaims(parsedClaims.data, channel, body.template);
		const registrationKeyHash = connectionRegistrationKeyHashV1(
			body.registrationKey,
		);
		const descriptorDigest = connectionManualInstallDescriptorDigestV1(
			body.descriptor,
		);
		if (
			claims.command !== "confirm_binding_readback" ||
			claims.commandId !== body.commandId ||
			claims.attemptId !== body.attemptId ||
			claims.attemptOwner !== body.attemptOwner ||
			claims.supplyAttemptId !== body.supplyAttemptId ||
			claims.authorizationId !== body.template.authorizationId ||
			claims.templateDigest !==
				connectionRegistrationTemplateDigestV1(body.template) ||
			claims.registrationKeyHash !== registrationKeyHash ||
			registrationKeyHash !== body.template.registration.registrationKeyHash ||
			claims.requestDigest !== connectionInstallRequestDigestV1(body) ||
			body.descriptor.registrationKey !== body.registrationKey ||
			body.descriptor.principalMapping.kind !== "consistency-exception-v1"
		)
			denied();
		const reply = (outcome: "rejected" | "unknown") =>
			ConnectionInstallConfirmBindingReadbackResponseV1Schema.parse({
				schemaVersion: 1,
				contract: connectionManualConfirmContractV1,
				outcome,
				commandId: body.commandId,
			});
		const admitted = await admitTemplate(body.template);
		const { template, templateDigest } = admitted;
		// Only the installation this Host fixed, with the same descriptor and supply.
		const consumed = await readRecord(
			`install-first-begin-${sha256Hex(template.authorizationId)}.json`,
		);
		if (!consumed) conflict();
		const consumption = parseConsumption(consumed);
		if (
			!isDeepStrictEqual(consumption.template, template) ||
			consumption.descriptorDigest !== descriptorDigest ||
			consumption.supplyAttemptId !== body.supplyAttemptId
		)
			conflict();
		const slot = confirmedSlot(template, templateDigest, body.supplyAttemptId);
		if (!slot) conflict();
		const candidateName = `install-confirm-candidate-${sha256Hex(body.commandId)}.json`;
		if ((await readRecord(candidateName)) !== undefined) conflict();
		const readbackInput = commandReadback(admitted, body.supplyAttemptId, {
			commandId: body.commandId,
			attemptId: body.attemptId,
			attemptOwner: body.attemptOwner,
			command: "confirm_binding_readback",
			requestDigest: claims.requestDigest,
			registrationKeyHash,
			descriptorDigest,
		});
		const outcome = await readbackOutcome(readbackInput);
		assertOriginal(template, claims.expiresAt);
		if (outcome === "denied") denied();
		if (outcome !== "allowed") unavailable();
		const assertCurrent = () => {
			current();
			if (
				slots.get(template.authorizationId) !== slot ||
				slot.state !== "confirmed"
			)
				unavailable();
			assertOriginal(template, claims.expiresAt);
		};
		let read: Awaited<
			ReturnType<typeof readConnectionMachineOAuthClientOutcomeV1>
		>;
		try {
			read = await readConnectionMachineOAuthClientOutcomeV1({
				endpoint: template.registration.endpoint,
				serviceCredential: slot.credential.toString("utf8"),
				registrationKey: body.registrationKey,
				signal: abort.signal,
				assertCurrent,
				...(machineFetch ? { fetch: machineFetch } : {}),
			});
		} catch {
			// A failed read is not an answer: the phase stays unknown, verify only.
			return reply("unknown");
		}
		// The EP-1060 wait may have outlasted the phase, the claim or the Host
		// binding; neither a reject nor a candidate outlives them.
		if ((await readbackOutcome(readbackInput)) !== "allowed")
			return reply("unknown");
		try {
			assertOriginal(template, claims.expiresAt);
		} catch {
			return reply("unknown");
		}
		// §13.5.1 item 2: anything but KNOWN is refused. Connection's explicit
		// UNKNOWN for the original key closes and revokes it like a mismatch.
		if (read.outcome !== "KNOWN") return reply("rejected");
		const registration = read.registration as Record<string, unknown>;
		const principalId = registration.principalId;
		// §13.5.1 item 2: KNOWN, a principal, the same client, instance, Consumer,
		// redirect URI, resource and scope, and an ACTIVE instance.
		if (
			typeof principalId !== "string" ||
			!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(principalId) ||
			registration.registrationKey !== body.registrationKey ||
			registration.clientId !== body.descriptor.clientId ||
			registration.instanceId !== body.descriptor.instanceId ||
			registration.consumerId !== body.descriptor.consumerId ||
			registration.redirectUri !== template.registration.redirectUri ||
			registration.resource !== template.registration.resource ||
			registration.scope !== "mcp" ||
			registration.instanceStatus !== "ACTIVE"
		)
			return reply("rejected");
		const candidate = ConnectionManualConfirmCandidateV1Schema.parse({
			schemaVersion: 1,
			principal: template.principal,
			reference: template.reference,
			authorizationId: template.authorizationId,
			confirmationRevision: template.confirmationRevision,
			association: template.association,
			confirm: {
				commandId: body.confirmCommandId,
				phase: "binding_readback",
				phaseCommandId: body.commandId,
				requestDigest: claims.requestDigest,
			},
			target: template.target,
			descriptorDigest,
			supply: template.supply,
			exceptionPolicy: body.descriptor.principalMapping.policy,
			verified: {
				issuer: access.system.issuer,
				registrationKey: body.registrationKey,
				principalId,
				clientId: body.descriptor.clientId,
				consumerId: body.descriptor.consumerId,
				instanceId: body.descriptor.instanceId,
				redirectUri: template.registration.redirectUri,
				resource: template.registration.resource,
				scope: "mcp",
				instanceStatus: "ACTIVE",
			},
		});
		// Bound once to this phase key, request digest and the original claim/fence.
		await publishMetadata(
			records,
			candidateName,
			{
				schemaVersion: 1,
				phaseCommandId: body.commandId,
				requestDigest: claims.requestDigest,
				claim: template.claim,
				candidate,
			},
			{
				immutable: true,
				guard: () => assertOriginal(template, claims.expiresAt),
			},
		);
		return ConnectionInstallConfirmBindingReadbackResponseV1Schema.parse({
			schemaVersion: 1,
			contract: connectionManualConfirmContractV1,
			outcome: "candidate",
			commandId: body.commandId,
			candidate,
		});
	}

	/**
	 * §13.5.6 exception confirm, phase 2 (`exchange`). Only after this
	 * confirm's first-pin receipt committed: the Host verifies the receipt, the
	 * active pin and the original claim through the read-only command readback,
	 * reads EP-1060 back again for the original key (it must still be the
	 * pinned KNOWN/ACTIVE candidate), records the phase once, rechecks, and
	 * only then lets its fixed transaction read the original code/verifier and
	 * exchange it once. It publishes nothing and writes nothing to the Store.
	 */
	async function confirmExchange(
		body: ConnectionInstallConfirmExchangeRequestV1,
		channel: string,
	): Promise<ConnectionInstallConfirmExchangeResponseV1> {
		const parsedClaims = ConnectionInstallCommandClaimsV1Schema.safeParse(
			verifyCompact(body.grant, connectionInstallJwsTypesV1.registration),
		);
		if (!parsedClaims.success) denied();
		const claims = admitWorkerClaims(parsedClaims.data, channel, body.template);
		const registrationKeyHash = connectionRegistrationKeyHashV1(
			body.registrationKey,
		);
		const descriptorDigest = connectionManualInstallDescriptorDigestV1(
			body.descriptor,
		);
		const pinned = body.candidate;
		if (
			claims.command !== "confirm_exchange" ||
			claims.commandId !== body.commandId ||
			claims.attemptId !== body.attemptId ||
			claims.attemptOwner !== body.attemptOwner ||
			claims.supplyAttemptId !== body.supplyAttemptId ||
			claims.authorizationId !== body.template.authorizationId ||
			claims.templateDigest !==
				connectionRegistrationTemplateDigestV1(body.template) ||
			claims.registrationKeyHash !== registrationKeyHash ||
			registrationKeyHash !== body.template.registration.registrationKeyHash ||
			claims.requestDigest !== connectionInstallRequestDigestV1(body) ||
			body.descriptor.registrationKey !== body.registrationKey ||
			body.descriptor.principalMapping.kind !== "consistency-exception-v1" ||
			connectionManualConfirmCandidateDigestV1(pinned) !==
				body.pinReceipt.candidateDigest ||
			pinned.confirm.commandId !== body.confirmCommandId ||
			pinned.authorizationId !== body.template.authorizationId ||
			pinned.descriptorDigest !== descriptorDigest ||
			pinned.verified.registrationKey !== body.registrationKey ||
			!isDeepStrictEqual(pinned.principal, body.template.principal) ||
			!isDeepStrictEqual(pinned.reference, body.template.reference) ||
			!isDeepStrictEqual(pinned.target, body.template.target)
		)
			denied();
		const reply = (outcome: "exchanged" | "rejected" | "unknown") =>
			ConnectionInstallConfirmExchangeResponseV1Schema.parse({
				schemaVersion: 1,
				contract: connectionManualConfirmContractV1,
				outcome,
				commandId: body.commandId,
			});
		const admitted = await admitTemplate(body.template);
		const { template, templateDigest } = admitted;
		const consumed = await readRecord(
			`install-first-begin-${sha256Hex(template.authorizationId)}.json`,
		);
		if (!consumed) conflict();
		const consumption = parseConsumption(consumed);
		if (
			!isDeepStrictEqual(consumption.template, template) ||
			consumption.descriptorDigest !== descriptorDigest ||
			consumption.supplyAttemptId !== body.supplyAttemptId
		)
			conflict();
		const slot = confirmedSlot(template, templateDigest, body.supplyAttemptId);
		if (!slot) conflict();
		// Phase 1 of this same Host recorded exactly this candidate for this claim.
		const recorded = await readRecord(
			`install-confirm-candidate-${sha256Hex(pinned.confirm.phaseCommandId)}.json`,
		);
		if (
			!recorded ||
			!isDeepStrictEqual(recorded.candidate, pinned) ||
			!isDeepStrictEqual(recorded.claim, template.claim)
		)
			conflict();
		const exchangeName = `install-confirm-exchange-${sha256Hex(body.commandId)}.json`;
		if ((await readRecord(exchangeName)) !== undefined) conflict();
		const readbackInput = commandReadback(admitted, body.supplyAttemptId, {
			commandId: body.commandId,
			attemptId: body.attemptId,
			attemptOwner: body.attemptOwner,
			command: "confirm_exchange",
			requestDigest: claims.requestDigest,
			registrationKeyHash,
			descriptorDigest,
			pinReceipt: {
				id: body.pinReceipt.id,
				candidateDigest: body.pinReceipt.candidateDigest,
			},
		});
		const outcome = await readbackOutcome(readbackInput);
		assertOriginal(template, claims.expiresAt);
		if (outcome === "denied") denied();
		if (outcome !== "allowed") unavailable();
		const entry = fixed.get(template.authorizationId);
		if (!entry) unavailable();
		await assertFixedCurrent(entry);
		const assertCurrent = () => {
			current();
			if (
				slots.get(template.authorizationId) !== slot ||
				slot.state !== "confirmed"
			)
				unavailable();
			assertOriginal(template, claims.expiresAt);
		};
		let read: Awaited<
			ReturnType<typeof readConnectionMachineOAuthClientOutcomeV1>
		>;
		try {
			read = await readConnectionMachineOAuthClientOutcomeV1({
				endpoint: template.registration.endpoint,
				serviceCredential: slot.credential.toString("utf8"),
				registrationKey: body.registrationKey,
				signal: abort.signal,
				assertCurrent,
				...(machineFetch ? { fetch: machineFetch } : {}),
			});
		} catch {
			return reply("unknown");
		}
		if ((await readbackOutcome(readbackInput)) !== "allowed")
			return reply("unknown");
		try {
			assertOriginal(template, claims.expiresAt);
		} catch {
			return reply("unknown");
		}
		// The binding must still be the pinned KNOWN/ACTIVE candidate; a drift is
		// refused, never re-pinned to the new value.
		const registration =
			read.outcome === "KNOWN"
				? (read.registration as Record<string, unknown>)
				: undefined;
		if (
			!registration ||
			registration.principalId !== pinned.verified.principalId ||
			registration.registrationKey !== pinned.verified.registrationKey ||
			registration.clientId !== pinned.verified.clientId ||
			registration.instanceId !== pinned.verified.instanceId ||
			registration.consumerId !== pinned.verified.consumerId ||
			registration.redirectUri !== pinned.verified.redirectUri ||
			registration.resource !== pinned.verified.resource ||
			registration.scope !== "mcp" ||
			registration.instanceStatus !== "ACTIVE"
		)
			return reply("rejected");
		// Host-private CAS: this phase exchanges at most once, bound to its key,
		// request digest, receipt and the original claim/fence.
		await publishMetadata(
			records,
			exchangeName,
			{
				schemaVersion: 1,
				phaseCommandId: body.commandId,
				requestDigest: claims.requestDigest,
				claim: template.claim,
				pinReceipt: body.pinReceipt,
			},
			{
				immutable: true,
				guard: () => assertOriginal(template, claims.expiresAt),
			},
		);
		if ((await readbackOutcome(readbackInput)) !== "allowed")
			return reply("unknown");
		assertOriginal(template, claims.expiresAt);
		const scope = installScope(
			template,
			RuntimeOAuthConfigurationV1Schema.parse(consumption.configuration),
		);
		// §13.5.6 动态安装的同一 Host 发布: with the deployment-approved contract,
		// this one exchange publishes from the pinned candidate, the fixed
		// configuration and the Owner-association Consumer target.
		const fixedConfiguration = RuntimeOAuthConfigurationV1Schema.parse(
			consumption.configuration,
		);
		let built:
			| NonNullable<
					Awaited<ReturnType<Awaited<ReturnType<DynamicPublication>>>>
			  >
			| undefined;
		const dynamic = dynamicPublication
			? createRuntimeOAuthDynamicPublication({
					dataDirectory,
					target: admitted.consumer,
					principal: template.principal,
					clientId: fixedConfiguration.clientId,
					issuer: fixedConfiguration.issuer,
					resource: fixedConfiguration.resource,
					descriptorContract: body.descriptor.publicationContract,
					contract: dynamicPublication,
					candidate: {
						principalId: pinned.verified.principalId,
						instanceId: pinned.verified.instanceId,
					},
				})
			: undefined;
		const publication: DynamicPublication | undefined = dynamic
			? async (input) => {
					const commit = await dynamic(input);
					return async (expiresAt) => {
						const read = await commit(expiresAt);
						built = read;
						return read;
					};
				}
			: undefined;
		const issuedAt = now();
		const request = RuntimeOAuthAuthorizedRequestV1Schema.parse({
			...scope,
			schemaVersion: 1,
			authorizationId: template.authorizationId,
			confirmationRevision: template.confirmationRevision,
			reference: template.reference,
			command: "confirm",
			grant: {
				schemaVersion: 1,
				format: "runtime-connection-installation-jws",
				token: [0, 1, 2]
					.map(() => randomBytes(32).toString("base64url"))
					.join("."),
			},
		});
		const result = await entry.exchangeOnce(
			request,
			RuntimeOAuthGrantClaimsV1Schema.parse({
				...scope,
				schemaVersion: 1,
				reference: template.reference,
				purpose: "connection_installation",
				audience: "runtime_connection_client",
				issuer,
				workerId,
				principal: template.principal,
				command: "confirm",
				authorizationId: template.authorizationId,
				confirmationRevision: template.confirmationRevision,
				grantId: randomUUID(),
				issuedAt,
				expiresAt: Math.min(
					issuedAt + 60_000,
					claims.expiresAt,
					entry.expiresAt,
					template.expiresAt,
				),
				requestDigest: sha256Hex(
					canonicalRuntimeRequestSigningPayload(request),
				),
			}),
			publication,
		);
		if (result.phase !== "awaiting_verification") return reply("unknown");
		if (!built) return reply("exchanged");
		// §13.5.6 提交证据: only a committed private publication (lock released,
		// sidecar and original record committed) yields the evidence, never a
		// pending one; the Platform permit then binds its commit digest.
		const committed = built;
		const commitDigest = runtimeOAuthPublicationCommitDigestV1(
			committed.commit,
		);
		try {
			await assertProtectedStandardMcpExportCommitted(
				join(
					dataDirectory,
					"codex-driver.json.native",
					"conversations",
					"standard-mcp-export",
					standardMcpExportKey(
						committed.delivery.ref,
						committed.delivery.revision,
					),
				),
				true,
			);
			assertOriginal(template, claims.expiresAt);
			// §13.5.6 许可引用 (ADR-0048): the dynamic reader reads the permit by this
			// exchange's command reference and the commit digest, which only this
			// Host holds; without the record no evidence is returned.
			await publishMetadata(
				records,
				dynamicPublicationRecordName(template.authorizationId),
				{
					schemaVersion: 1,
					authorizationId: template.authorizationId,
					permitId: body.commandId,
					delivery: committed.delivery,
					commitDigest,
				},
				{
					immutable: true,
					guard: () => assertOriginal(template, claims.expiresAt),
				},
			);
		} catch {
			return reply("exchanged");
		}
		return ConnectionInstallConfirmExchangeResponseV1Schema.parse({
			schemaVersion: 1,
			contract: connectionManualConfirmContractV1,
			outcome: "exchanged",
			commandId: body.commandId,
			publication: {
				commitDigest,
				expiresAt: committed.metadata.expiresAt,
			},
		});
	}

	async function beginStatus(
		body: ConnectionInstallBeginStatusRequestV1,
		channel: string,
	): Promise<RuntimeOAuthResponseV1> {
		const parsedClaims = ConnectionInstallCommandClaimsV1Schema.safeParse(
			verifyCompact(body.grant, connectionInstallJwsTypesV1.registration),
		);
		if (!parsedClaims.success) denied();
		const claims = admitWorkerClaims(parsedClaims.data, channel, body.template);
		const registrationKeyHash = connectionRegistrationKeyHashV1(
			body.registrationKey,
		);
		if (
			claims.command !== "begin_status" ||
			claims.commandId !== body.commandId ||
			claims.attemptId !== body.attemptId ||
			claims.attemptOwner !== body.attemptOwner ||
			claims.supplyAttemptId !== body.supplyAttemptId ||
			claims.authorizationId !== body.template.authorizationId ||
			claims.templateDigest !==
				connectionRegistrationTemplateDigestV1(body.template) ||
			claims.registrationKeyHash !== registrationKeyHash ||
			registrationKeyHash !== body.template.registration.registrationKeyHash ||
			claims.requestDigest !== connectionInstallRequestDigestV1(body)
		)
			denied();
		if (closedSlots.has(body.template.authorizationId)) denied();
		const admitted = await admitTemplate(body.template);
		const { template, templateDigest } = admitted;
		// A Host restart loses the in-memory supply slot. Only a lost slot is replaced,
		// read-only, by the persisted first begin and the Worker's live supply authority;
		// a slot of this process that is not confirmed, or was closed, still refuses.
		const slotLost =
			!slots.has(template.authorizationId) &&
			!closedSlots.has(template.authorizationId);
		if (
			!slotLost &&
			!confirmedSlot(template, templateDigest, body.supplyAttemptId)
		)
			conflict();
		const recordKey = sha256Hex(template.authorizationId);
		const consumed = await readRecord(`install-first-begin-${recordKey}.json`);
		const stored = await readRecord(
			`install-first-begin-result-${recordKey}.json`,
		);
		assertOriginal(template, claims.expiresAt);
		if (!consumed || !stored) conflict();
		const consumption = parseConsumption(consumed);
		const result = parseFirstBeginResult(stored, consumption);
		if (
			consumption.authorizationId !== template.authorizationId ||
			consumption.commandId !== body.beginCommandId ||
			!isDeepStrictEqual(consumption.template, template)
		)
			conflict();
		if (slotLost) {
			// Only the supply attempt the first begin consumed stands in for the slot.
			if (consumption.supplyAttemptId !== body.supplyAttemptId) conflict();
			await assertFixedBindingCurrent({
				template,
				supplyAttemptId: body.supplyAttemptId,
				expiresAt: result.expiresAt,
			});
		}
		const outcome = await readbackOutcome(
			commandReadback(admitted, body.supplyAttemptId, {
				commandId: body.commandId,
				attemptId: body.attemptId,
				attemptOwner: body.attemptOwner,
				command: "begin_status",
				requestDigest: claims.requestDigest,
				registrationKeyHash,
			}),
		);
		assertOriginal(template, claims.expiresAt);
		if (outcome === "denied") {
			closeSlot(template.authorizationId);
			fixed.delete(template.authorizationId);
			denied();
		}
		if (outcome !== "allowed") unavailable();
		if (result.expiresAt <= now()) denied();
		// Read-only: the stored result is returned; no state, PKCE or link is generated.
		return result;
	}

	/**
	 * §13.5.6 动态安装的 reader 与可见起点 (ADR-0048). For the current Execution's
	 * original binding it finds this session's fixed installation, reads the
	 * Platform permit by the exchange command reference, checks the local
	 * publication is committed with the same commit digest, reads the material
	 * and reads the permit again. A missing installation or a denied permit is
	 * `authorization_required`; an unavailable or unknown readback is
	 * `unavailable`. Both happen before any Connection request and are never
	 * retried.
	 */
	/**
	 * Finds this session's fixed installation for the current Execution's
	 * original binding. Missing is `authorization_required`; a binding or
	 * template that cannot be read is `unavailable`.
	 */
	async function locateDynamic(
		reference: RuntimeOriginalExecutionRef,
		signal: AbortSignal,
	) {
		let binding: Awaited<
			ReturnType<InstallStore["resolveOriginalExecutionBinding"]>
		>;
		let hostRef: string;
		try {
			current();
			signal.throwIfAborted();
			binding = await store.resolveOriginalExecutionBinding(reference, now);
			hostRef = await store.resolveOriginalExecutionHostSessionRef(
				reference,
				now,
			);
			current();
		} catch {
			throw new DynamicConnectionRefusalV1("unavailable");
		}
		const entry = [...fixed.values()].find(
			(candidate) =>
				isDeepStrictEqual(candidate.template.principal, binding.principal) &&
				candidate.template.reference.agentId === reference.agentId &&
				candidate.template.reference.conversationId ===
					reference.conversationId &&
				candidate.template.reference.sessionGeneration ===
					reference.sessionGeneration,
		);
		if (!entry) throw new DynamicConnectionRefusalV1("authorization_required");
		let consumer: ApprovedConnectionConsumerTargetV1;
		try {
			consumer = verifyConnectionRegistrationTemplateV1(
				entry.template,
				access,
				clientName,
			).target;
		} catch {
			throw new DynamicConnectionRefusalV1("unavailable");
		}
		return { binding, hostRef, entry, consumer };
	}

	/** The verified consumer target of the installation `resolveDynamicInput` reads. */
	async function resolveDynamicTarget(
		reference: RuntimeOriginalExecutionRef,
		signal: AbortSignal,
	): Promise<ApprovedConnectionConsumerTargetV1> {
		return structuredClone((await locateDynamic(reference, signal)).consumer);
	}

	async function resolveDynamicInput(
		reference: RuntimeOriginalExecutionRef,
		signal: AbortSignal,
	): Promise<unknown> {
		const required = () => {
			throw new DynamicConnectionRefusalV1("authorization_required");
		};
		const refuse = () => {
			throw new DynamicConnectionRefusalV1("unavailable");
		};
		const { binding, hostRef, entry, consumer } = await locateDynamic(
			reference,
			signal,
		);
		const template = entry.template;
		let recorded: Record<string, unknown> | undefined;
		let target: ReturnType<typeof ConnectionHostInstallTargetV1Schema.parse>;
		try {
			recorded = await readRecord(
				dynamicPublicationRecordName(template.authorizationId),
			);
			target = ConnectionHostInstallTargetV1Schema.parse({
				...localTarget,
				hostRef,
			});
		} catch {
			return refuse();
		}
		const delivery = recorded?.delivery as
			| { ref?: unknown; revision?: unknown }
			| undefined;
		if (
			!recorded ||
			Object.keys(recorded).sort().join(",") !==
				"authorizationId,commitDigest,delivery,permitId,schemaVersion" ||
			recorded.schemaVersion !== 1 ||
			recorded.authorizationId !== template.authorizationId ||
			typeof recorded.permitId !== "string" ||
			!isDigest(recorded.commitDigest) ||
			!isRecord(delivery) ||
			typeof delivery.ref !== "string" ||
			typeof delivery.revision !== "string"
		)
			return required();
		if (!isDeepStrictEqual(template.target, target)) return required();
		const permitReadback: ConnectionInstallReadbackInputV1 = {
			purpose: "permit",
			target,
			principal: template.principal,
			reference,
			authorizationId: template.authorizationId,
			confirmationRevision: template.confirmationRevision,
			templateDigest: connectionRegistrationTemplateDigestV1(template),
			supply: {
				ref: template.supply.ref,
				revision: template.supply.revision,
				attemptId: entry.supplyAttemptId,
			},
			permit: {
				id: recorded.permitId,
				commitDigest: recorded.commitDigest as string,
			},
		};
		const permitted = async () => {
			const outcome = await readbackOutcome(permitReadback);
			if (outcome === "denied") required();
			if (outcome !== "allowed") refuse();
		};
		await permitted();
		const source = join(
			dataDirectory,
			"codex-driver.json.native",
			"conversations",
			"standard-mcp-export",
			standardMcpExportKey(delivery.ref, delivery.revision),
		);
		let input: unknown;
		try {
			signal.throwIfAborted();
			await assertProtectedStandardMcpExportCommitted(source, true);
			const sidecar: unknown = JSON.parse(
				await readProtectedStandardMcpBytes(
					source,
					".oauth-publication.json",
					8192,
					current,
				),
			);
			const expected = isRecord(sidecar) ? sidecar.expected : undefined;
			if (
				!isRecord(expected) ||
				runtimeOAuthPublicationCommitDigestV1(
					expected as Parameters<
						typeof runtimeOAuthPublicationCommitDigestV1
					>[0],
				) !== recorded.commitDigest
			)
				unavailable();
			const installationKey = standardMcpInstallationKey(
				binding.principal,
				reference.agentId,
				consumer,
			);
			if (expected.installationKey !== installationKey) unavailable();
			const metadataText = await readProtectedStandardMcpBytes(
				join(source, "bindings"),
				`${installationKey}.json`,
				65_536,
				current,
			);
			const metadata = validateStandardMcpInstallationMetadata(
				JSON.parse(metadataText),
				consumer,
			);
			if (
				!isDeepStrictEqual(metadata.principal, binding.principal) ||
				metadata.agentId !== reference.agentId ||
				!isDeepStrictEqual(metadata.contract, dynamicPublication?.contract)
			)
				unavailable();
			const token = await readProtectedStandardMcpBytes(
				join(source, "materials"),
				`${standardMcpMaterialKey(installationKey, metadata.credentialRef, metadata.credentialRevision)}.token`,
				4096,
				current,
			);
			await assertProtectedStandardMcpExportCommitted(source, true);
			const { agentId: _agentId, ...publicInput } = metadata;
			input = validateStandardMcpInput(
				{ ...publicInput, scope: binding.scope, token },
				reference,
				consumer,
			);
		} catch {
			// A sealed, erased, tampered or expired local publication backs nothing.
			return required();
		}
		await permitted();
		return input;
	}

	type RevokedFacts = {
		readonly schemaVersion: 1;
		readonly authorizationId: string;
		readonly confirmationRevision: string;
		readonly principal: Template["principal"];
	};
	function revokedFacts(template: Template): RevokedFacts {
		return {
			schemaVersion: 1,
			authorizationId: template.authorizationId,
			confirmationRevision: template.confirmationRevision,
			principal: template.principal,
		};
	}
	function parseRevokedFacts(
		value: Record<string, unknown> | undefined,
		hash: string,
	): RevokedFacts {
		const principal = value?.principal;
		if (
			!value ||
			Object.keys(value).sort().join(",") !==
				"authorizationId,confirmationRevision,principal,schemaVersion" ||
			value.schemaVersion !== 1 ||
			typeof value.authorizationId !== "string" ||
			sha256Hex(value.authorizationId) !== hash ||
			typeof value.confirmationRevision !== "string" ||
			!isRecord(principal) ||
			Object.keys(principal).sort().join(",") !== "id,kind" ||
			principal.kind !== "user" ||
			typeof principal.id !== "string"
		)
			unavailable();
		return value as unknown as RevokedFacts;
	}
	/** Local erase only; `false` keeps the installation for a later retry. */
	async function eraseRevokedCopies(facts: RevokedFacts) {
		try {
			await eraseRuntimeOAuthInstallationMaterials({
				dataDirectory,
				principal: facts.principal,
				agentId,
				authorizationId: facts.authorizationId,
				confirmationRevision: facts.confirmationRevision,
			});
			return true;
		} catch {
			return false;
		}
	}
	/**
	 * §13.5.6 “refresh/revoke 开始前先持久封闭旧 publication”: the installation's
	 * fixed client stops and its committed publication is durably marked
	 * pending before the revoke is sent. Nothing is erased yet.
	 */
	async function sealRevokingInstallation(template: Template) {
		const id = template.authorizationId;
		const entry = fixed.get(id);
		if (entry) {
			fixed.delete(id);
			await entry.client.close();
		}
		await sealRuntimeOAuthInstallationPublication({
			dataDirectory,
			principal: template.principal,
			agentId,
			authorizationId: id,
			confirmationRevision: template.confirmationRevision,
		});
	}
	/**
	 * §13.5.6 撤销 / §13.5.7 逐安装撤销: once Connection confirmed the revoke of
	 * the original key, this Host closes the installation and erases its
	 * revision's code, verifier and Token copies without any remote request.
	 * The durable marker comes first, so a Host that stops before the erase
	 * finishes it at the next start; a failed erase is retried and never
	 * changes the remote result.
	 */
	async function eraseRevokedInstallation(template: Template) {
		const id = template.authorizationId;
		const entry = fixed.get(id);
		if (entry) {
			fixed.delete(id);
			await entry.client.close();
		}
		const facts = revokedFacts(template);
		await publishMetadata(
			records,
			`install-revoked-${sha256Hex(id)}.json`,
			facts,
			{ immutable: true },
		).catch(() => undefined);
		if (!(await eraseRevokedCopies(facts))) unerased.set(id, facts);
	}

	async function reloadFixedInstallation(name: string) {
		const recordKey = firstBeginRecord.exec(name)?.[1];
		const consumed = await readRecord(name);
		if (
			!recordKey ||
			!consumed ||
			typeof consumed.authorizationId !== "string" ||
			sha256Hex(consumed.authorizationId) !== recordKey
		)
			return;
		const consumption = parseConsumption(consumed);
		const { template, target: consumer } =
			verifyConnectionRegistrationTemplateV1(
				consumption.template,
				access,
				clientName,
			);
		const { hostRef: _hostRef, ...targetFacts } = template.target;
		// hostRef is re-resolved from the Store before every delegated request.
		if (
			template.authorizationId !== consumption.authorizationId ||
			template.reference.agentId !== agentId ||
			!isDeepStrictEqual(targetFacts, localTarget)
		)
			return;
		const receiptValue = consumption.receipt;
		const receipt = matchConnectionRegistrationReceiptV1(
			receiptValue,
			template,
			isRecord(receiptValue) && typeof receiptValue.registrationKey === "string"
				? receiptValue.registrationKey
				: "",
		);
		if (!receipt) return;
		const configuration = connectionManualInstallConfigurationV1({
			access,
			template,
			receipt,
		});
		if (
			!isDeepStrictEqual(configuration, consumption.configuration) ||
			connectionInstallConfigurationDigestV1(configuration) !==
				consumption.configurationDigest ||
			connectionRegistrationReceiptDigestV1(receipt) !==
				consumption.receiptDigest ||
			!connectionManualInstallDescriptorMatchesV1(
				consumption.descriptor as ConnectionManualInstallDescriptorV1,
				{ template, receipt, configuration },
			)
		)
			return;
		const stored = await readRecord(
			`install-first-begin-result-${recordKey}.json`,
		);
		if (!stored) return;
		const result = parseFirstBeginResult(stored, consumption);
		const binding = {
			template,
			supplyAttemptId: consumption.supplyAttemptId,
			expiresAt: result.expiresAt,
		};
		try {
			await assertFixedBindingCurrent(binding);
		} catch (error) {
			if (isAuthorizationDenial(error)) return;
			// Restore the candidate during an outage. Its use still requires live authority.
		}
		const opened = await openFixedClient(
			template,
			consumer,
			configuration,
			ConnectionManualInstallDescriptorV1Schema.parse(consumption.descriptor),
		);
		fixed.set(template.authorizationId, {
			...binding,
			client: opened.client,
			exchangeOnce: opened.exchangeOnce,
		});
	}
	async function reloadFixedInstallations() {
		const directory = await openProtectedStandardMcpDirectory(records);
		let all: string[];
		try {
			all = (
				await readdir(
					process.platform === "linux"
						? `/proc/self/fd/${directory.fd}`
						: records,
				)
			).sort();
		} finally {
			await directory.close();
		}
		// A Host that stopped between Connection's confirmed revoke and the local
		// erase finishes the erase first and never reopens that installation.
		const revoked = new Set<string>();
		for (const name of all) {
			const hash = revokedRecord.exec(name)?.[1];
			if (!hash) continue;
			revoked.add(hash);
			try {
				const facts = parseRevokedFacts(await readRecord(name), hash);
				if (!(await eraseRevokedCopies(facts)))
					unerased.set(facts.authorizationId, facts);
			} catch {
				// A malformed marker still keeps its installation closed.
			}
		}
		const names = all.filter((name) => {
			const hash = firstBeginRecord.exec(name)?.[1];
			return hash !== undefined && !revoked.has(hash);
		});
		for (const name of names) {
			if (fixed.size >= maxFixedInstallations) break;
			try {
				await reloadFixedInstallation(name);
			} catch {
				// Another target or a partial first begin never reopens a link.
			}
		}
	}
	/** The fixed installation still belongs to this Host session and Execution. */
	async function assertFixedBindingCurrent(entry: FixedInstallationBinding) {
		if (entry.expiresAt <= now()) denied();
		const admitted = await admitTemplate(entry.template);
		const outcome = await readbackOutcome(
			supplyReadback(admitted, entry.supplyAttemptId),
		);
		if (outcome === "denied" || entry.expiresAt <= now()) {
			closeSlot(entry.template.authorizationId);
			fixed.delete(entry.template.authorizationId);
			denied();
		}
		if (outcome !== "allowed") unavailable();
		assertOriginal(admitted.template);
	}

	async function assertFixedCurrent(entry: FixedInstallation) {
		try {
			await assertFixedBindingCurrent(entry);
		} catch (error) {
			const id = entry.template.authorizationId;
			if (isAuthorizationDenial(error) && fixed.get(id) === entry) {
				fixed.delete(id);
				closeSlot(id);
				await entry.client.close();
			}
			throw error;
		}
	}

	async function reclaimFixedInstallations() {
		for (const [id, facts] of unerased)
			if (await eraseRevokedCopies(facts)) unerased.delete(id);
		for (const entry of fixed.values()) {
			try {
				await assertFixedCurrent(entry);
			} catch {
				// Only definite invalidation frees capacity. Unavailable authority preserves the entry.
			}
		}
	}

	const runtimeHost = runtime.host;
	const app = new Hono<ConnectionInstallReceiverEnvV1>();
	app.use("*", async (context, next) => {
		context.header("cache-control", "no-store");
		context.header("referrer-policy", "no-referrer");
		let exporter: ConnectionInstallTlsExporterV1;
		let channel: string;
		try {
			exporter = connectionInstallServerExporterV1(
				context.env.incoming?.socket,
			);
			channel = exporter(
				connectionInstallExporterLabelsV1.channel,
				32,
			).toString("base64url");
		} catch {
			unavailable();
		}
		if (context.req.header("host") !== runtimeHost) denied();
		current();
		context.set("exporter", exporter);
		context.set("channel", channel);
		await next();
	});
	app.post(connectionInstallPathsV1.supply, async (context) => {
		const parsed = ConnectionHostSupplyRequestV1Schema.safeParse(
			await boundedJson(context.req.raw, current),
		);
		if (!parsed.success) denied();
		const body = parsed.data;
		const exporter = context.get("exporter");
		const channel = context.get("channel");
		return serial(async () =>
			context.json(await supply(body, exporter, channel)),
		);
	});
	for (const command of [
		"prepare",
		"status",
		"supply_status",
		"revoke",
	] as const) {
		app.post(connectionInstallPathsV1[command], async (context) => {
			const parsed = ConnectionInstallCommandRequestV1Schema.safeParse(
				await boundedJson(context.req.raw, current),
			);
			if (!parsed.success || parsed.data.command !== command) denied();
			const body = parsed.data;
			const channel = context.get("channel");
			return serial(async () =>
				context.json(await registrationCommand(body, channel)),
			);
		});
	}
	app.post(connectionInstallPathsV1.begin, async (context) => {
		const parsed = ConnectionInstallFirstBeginRequestV1Schema.safeParse(
			await boundedJson(context.req.raw, current),
		);
		if (!parsed.success) denied();
		const body = parsed.data;
		const channel = context.get("channel");
		return serial(async () => context.json(await firstBegin(body, channel)));
	});
	app.post(connectionInstallPathsV1.confirmBindingReadback, async (context) => {
		const parsed =
			ConnectionInstallConfirmBindingReadbackRequestV1Schema.safeParse(
				await boundedJson(context.req.raw, current),
			);
		if (!parsed.success) denied();
		const body = parsed.data;
		const channel = context.get("channel");
		return serial(async () =>
			context.json(await confirmBindingReadback(body, channel)),
		);
	});
	app.post(connectionInstallPathsV1.confirmExchange, async (context) => {
		const parsed = ConnectionInstallConfirmExchangeRequestV1Schema.safeParse(
			await boundedJson(context.req.raw, current),
		);
		if (!parsed.success) denied();
		const body = parsed.data;
		const channel = context.get("channel");
		return serial(async () =>
			context.json(await confirmExchange(body, channel)),
		);
	});
	app.post(connectionInstallPathsV1.beginStatus, async (context) => {
		const parsed = ConnectionInstallBeginStatusRequestV1Schema.safeParse(
			await boundedJson(context.req.raw, current),
		);
		if (!parsed.success) denied();
		const body = parsed.data;
		const channel = context.get("channel");
		return serial(async () => context.json(await beginStatus(body, channel)));
	});
	// Post-begin standard routes stay closed until a first begin fixed a configuration.
	app.post("/internal/runtime/oauth/v1/callback", async (context) => {
		if (!bearer(context.req.header("authorization"), callbackToken)) denied();
		const parsed = RuntimeOAuthCallbackRequestV1Schema.safeParse(
			await boundedJson(context.req.raw, current),
		);
		if (!parsed.success) denied();
		for (const entry of fixed.values()) {
			try {
				await assertFixedCurrent(entry);
				return context.json(await entry.client.callback(parsed.data));
			} catch {
				// Only the fixed client that owns this state accepts the callback.
			}
		}
		unavailable();
	});
	for (const command of ["confirm", "status", "refresh"] as const) {
		app.post(`/internal/runtime/oauth/v1/${command}`, async (context) => {
			if (!bearer(context.req.header("authorization"), serviceToken)) denied();
			const parsed = RuntimeOAuthAuthorizedRequestV1Schema.safeParse(
				await boundedJson(context.req.raw, current),
			);
			if (!parsed.success || parsed.data.command !== command) denied();
			const entry = fixed.get(parsed.data.authorizationId);
			if (!entry) unavailable();
			await assertFixedCurrent(entry);
			return context.json(await entry.client.authorized(parsed.data));
		});
	}
	app.notFound((context) => {
		context.header("cache-control", "no-store");
		context.header("referrer-policy", "no-referrer");
		return context.json(
			{
				schemaVersion: 1,
				code: "CONNECTION_INSTALL_UNAVAILABLE",
				message: failureMessage,
				retryable: false,
			},
			404,
		);
	});
	app.onError((error, context) => {
		const status =
			error instanceof RuntimeHostError && error.httpStatus === 403
				? 403
				: error instanceof RuntimeHostError && error.httpStatus === 409
					? 409
					: 503;
		context.header("cache-control", "no-store");
		context.header("referrer-policy", "no-referrer");
		return context.json(
			{
				schemaVersion: 1,
				code:
					status === 403
						? "RUNTIME_GRANT_INVALID"
						: status === 409
							? "CONNECTION_INSTALL_CONFLICT"
							: "CONNECTION_INSTALL_UNAVAILABLE",
				message: failureMessage,
				retryable: false,
			},
			status,
		);
	});

	const close = () => {
		closing ??= (async () => {
			closed = true;
			abort.abort();
			closeAllSlots();
			await tail;
			const clients = [...fixed.values()].map((entry) => entry.client);
			fixed.clear();
			await Promise.allSettled(clients.map((client) => client.close()));
		})();
		return closing;
	};
	try {
		await reloadFixedInstallations();
	} catch (error) {
		await close();
		throw error;
	}
	return {
		status: "available",
		fetch: app.fetch,
		key: tlsKey,
		cert,
		port,
		runtimeOrigin: runtime.href,
		...(dynamicPublication
			? {
					dynamicReader: {
						contract: structuredClone(dynamicPublication),
						resolveTarget: (
							reference: RuntimeOriginalExecutionRef,
							signal: AbortSignal,
						) => resolveDynamicTarget(reference, signal),
						resolveInput: (
							reference: RuntimeOriginalExecutionRef,
							signal: AbortSignal,
						) => resolveDynamicInput(reference, signal),
					},
				}
			: {}),
		close,
	};
}
