import {
	createHash,
	createPrivateKey,
	createPublicKey,
	type KeyObject,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import { createS3ObjectStorageV1 } from "@agent-infra/object-storage";
import type { PlatformFileDeploymentV1 } from "./file-assembly.js";

/**
 * Deployment-owned assembler for the file data plane.
 *
 * The JSON configuration, signing keys, runtime verification keys, object
 * storage credentials and file service tokens are deployment inputs supplied
 * through the deployment secret chain. Nothing in this module contains a
 * built-in key, token, bucket or endpoint. Every field is required unless it is
 * explicitly optional below; any missing, unknown or malformed field, relative
 * path or unusable key fails closed before the Platform API registers the file
 * routes.
 */
export const PLATFORM_FILE_DEPLOYMENT_CONFIGURATION_FILE =
	"PLATFORM_API_FILE_DEPLOYMENT_CONFIGURATION_FILE";

const CONFIGURATION_INVALID = "PLATFORM_FILE_DEPLOYMENT_CONFIGURATION_INVALID";
const MAX_CONFIGURATION_BYTES = 1024 * 1024;
const MAX_SECRET_BYTES = 64 * 1024;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PRINTABLE = /^[\x21-\x7e]{1,256}$/;
const PREFIX = /^[a-zA-Z0-9_-]+\/$/;
const SERVICE_TOKEN = /^[\x21-\x7e]{32,4096}$/;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;

type ReadTextFile = (path: string) => Promise<string>;

export interface ProductionPlatformFileDeploymentOptionsV1 {
	/** Absolute path to the deployment-owned JSON configuration file. */
	readonly configurationFile: string;
	/**
	 * Deployment-owned current identity authority. File exchange re-resolves the
	 * signed actor on every request; a missing or unavailable actor denies.
	 */
	resolveActor(actorId: string): Promise<unknown | null>;
	/** Test/deployment seam; defaults to `node:fs/promises` readFile. */
	readonly readFile?: ReadTextFile;
}

function invalid(field?: string): never {
	throw new Error(
		field ? `${CONFIGURATION_INVALID}:${field}` : CONFIGURATION_INVALID,
	);
}

function strictRecord(
	value: unknown,
	required: readonly string[],
	optional: readonly string[] = [],
): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		invalid();
	const keys = Object.keys(value);
	if (
		keys.some((key) => !required.includes(key) && !optional.includes(key)) ||
		required.some((key) => !keys.includes(key))
	)
		invalid();
	return value as Record<string, unknown>;
}

function text(value: unknown, maximum: number, field: string): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > maximum ||
		value.includes("\0") ||
		!String.prototype.isWellFormed.call(value)
	)
		invalid(field);
	return value;
}

function printable(value: unknown, field: string): string {
	if (typeof value !== "string" || !PRINTABLE.test(value)) invalid(field);
	return value;
}

function identifier(value: unknown, field: string): string {
	if (typeof value !== "string" || !IDENTIFIER.test(value)) invalid(field);
	return value;
}

function absolutePath(value: unknown, field: string): string {
	const path = text(value, 4096, field);
	if (!path.startsWith("/") || path.includes("\0")) invalid(field);
	return path;
}

function integer(
	value: unknown,
	minimum: number,
	maximum: number,
	field: string,
): number {
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < minimum ||
		value > maximum
	)
		invalid(field);
	return value;
}

function array(
	value: unknown,
	minimum: number,
	maximum: number,
	field: string,
): unknown[] {
	if (!Array.isArray(value) || value.length < minimum || value.length > maximum)
		invalid(field);
	return value;
}

async function secretText(
	read: ReadTextFile,
	path: string,
	field: string,
): Promise<string> {
	let value: string;
	try {
		value = await read(path);
	} catch {
		invalid(field);
	}
	if (
		typeof value !== "string" ||
		Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES
	)
		invalid(field);
	return value.trim();
}

function ed25519PrivateKey(pem: string, field: string): KeyObject {
	let key: KeyObject;
	try {
		key = createPrivateKey(pem);
	} catch {
		invalid(field);
	}
	if (key.asymmetricKeyType !== "ed25519") invalid(field);
	return key;
}

function ed25519PublicKey(pem: string, field: string): KeyObject {
	if (
		!pem.trim().startsWith("-----BEGIN PUBLIC KEY-----") ||
		pem.includes("PRIVATE KEY")
	)
		invalid(field);
	let key: KeyObject;
	try {
		key = createPublicKey(pem);
	} catch {
		invalid(field);
	}
	if (key.asymmetricKeyType !== "ed25519") invalid(field);
	return key;
}

function publicPem(key: KeyObject, field: string): string {
	try {
		return key.export({ format: "pem", type: "spki" }).toString().trim();
	} catch {
		invalid(field);
	}
}

function endpoint(value: unknown, field: string): string {
	const endpoint = text(value, 2048, field);
	let parsed: URL;
	try {
		parsed = new URL(endpoint);
	} catch {
		invalid(field);
	}
	if (
		(parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
		parsed.username ||
		parsed.password ||
		(parsed.pathname !== "" && parsed.pathname !== "/") ||
		parsed.search ||
		parsed.hash
	)
		invalid(field);
	return endpoint;
}

async function credentials(
	read: ReadTextFile,
	path: string,
): Promise<{
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
}> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(
			await secretText(read, path, "storage.credentialsFile"),
		);
	} catch (error) {
		if (
			error instanceof Error &&
			error.message.startsWith(CONFIGURATION_INVALID)
		)
			throw error;
		invalid("storage.credentialsFile");
	}
	const value = strictRecord(
		parsed,
		["accessKeyId", "secretAccessKey"],
		["sessionToken"],
	);
	const accessKeyId = text(
		value.accessKeyId,
		512,
		"storage.credentialsFile.accessKeyId",
	);
	const secretAccessKey = text(
		value.secretAccessKey,
		1024,
		"storage.credentialsFile.secretAccessKey",
	);
	const sessionToken =
		value.sessionToken === undefined
			? undefined
			: text(value.sessionToken, 4096, "storage.credentialsFile.sessionToken");
	return {
		accessKeyId,
		secretAccessKey,
		...(sessionToken ? { sessionToken } : {}),
	};
}

/**
 * Assemble the file data plane from deployment-owned configuration and secret
 * files. Token values are read only to build the authority mapping; they are
 * never returned in error messages or written to logs.
 */
export async function createProductionPlatformFileDeploymentV1(
	options: ProductionPlatformFileDeploymentOptionsV1,
): Promise<PlatformFileDeploymentV1> {
	const read = options.readFile ?? ((path: string) => readFile(path, "utf8"));
	const configurationFile = absolutePath(
		options.configurationFile,
		"configurationFile",
	);
	if (typeof options.resolveActor !== "function") invalid("resolveActor");

	let configuration: string;
	try {
		configuration = await read(configurationFile);
	} catch {
		invalid("configurationFile");
	}
	if (
		typeof configuration !== "string" ||
		Buffer.byteLength(configuration, "utf8") > MAX_CONFIGURATION_BYTES
	)
		invalid("configurationFile");
	let parsed: unknown;
	try {
		parsed = JSON.parse(configuration);
	} catch {
		invalid("configurationFile");
	}
	const root = strictRecord(parsed, [
		"schemaVersion",
		"storage",
		"signing",
		"runtime",
		"limits",
		"services",
	]);
	if (root.schemaVersion !== 1) invalid("schemaVersion");

	const storage = strictRecord(
		root.storage,
		["region", "bucket", "prefix", "maxObjectBytes", "timeoutMs"],
		["endpoint", "credentialsFile"],
	);
	const storageRegion = printable(storage.region, "storage.region");
	const storageBucket = text(storage.bucket, 255, "storage.bucket");
	if (/[\s/]/.test(storageBucket)) invalid("storage.bucket");
	const storagePrefix = text(storage.prefix, 256, "storage.prefix");
	if (!PREFIX.test(storagePrefix)) invalid("storage.prefix");
	const storageEndpoint =
		storage.endpoint === undefined
			? undefined
			: endpoint(storage.endpoint, "storage.endpoint");
	const storageMaxObjectBytes = integer(
		storage.maxObjectBytes,
		1,
		5 * 1024 ** 4,
		"storage.maxObjectBytes",
	);
	const storageTimeoutMs = integer(
		storage.timeoutMs,
		1,
		600_000,
		"storage.timeoutMs",
	);
	const storageCredentialsPath =
		storage.credentialsFile === undefined
			? undefined
			: absolutePath(storage.credentialsFile, "storage.credentialsFile");

	const signing = strictRecord(root.signing, [
		"issuer",
		"keyVersion",
		"privateKeyFile",
		"publicKeys",
	]);
	const signingIssuer = printable(signing.issuer, "signing.issuer");
	const signingKeyVersion = identifier(
		signing.keyVersion,
		"signing.keyVersion",
	);
	const privateKey = ed25519PrivateKey(
		await secretText(
			read,
			absolutePath(signing.privateKeyFile, "signing.privateKeyFile"),
			"signing.privateKeyFile",
		),
		"signing.privateKeyFile",
	);
	const signingPublicKeys = new Map<string, KeyObject>();
	for (const [index, entry] of array(
		signing.publicKeys,
		1,
		16,
		"signing.publicKeys",
	).entries()) {
		const value = strictRecord(entry, ["keyVersion", "publicKeyFile"], []);
		const keyVersion = identifier(
			value.keyVersion,
			`signing.publicKeys.${index}.keyVersion`,
		);
		if (signingPublicKeys.has(keyVersion))
			invalid("signing.publicKeys.keyVersion");
		signingPublicKeys.set(
			keyVersion,
			ed25519PublicKey(
				await secretText(
					read,
					absolutePath(
						value.publicKeyFile,
						`signing.publicKeys.${index}.publicKeyFile`,
					),
					`signing.publicKeys.${index}.publicKeyFile`,
				),
				`signing.publicKeys.${index}.publicKeyFile`,
			),
		);
	}
	const currentSigningKey = signingPublicKeys.get(signingKeyVersion);
	if (
		!currentSigningKey ||
		publicPem(currentSigningKey, "signing.publicKeys") !==
			publicPem(createPublicKey(privateKey), "signing.privateKeyFile")
	)
		invalid("signing.publicKeys.keyVersion");

	const runtime = strictRecord(root.runtime, [
		"issuer",
		"workerId",
		"publicKeys",
	]);
	const runtimeIssuer = printable(runtime.issuer, "runtime.issuer");
	const runtimeWorkerId = printable(runtime.workerId, "runtime.workerId");
	const runtimePublicKeys = new Map<string, KeyObject>();
	for (const [index, entry] of array(
		runtime.publicKeys,
		1,
		16,
		"runtime.publicKeys",
	).entries()) {
		const value = strictRecord(entry, ["keyId", "publicKeyFile"], []);
		const keyId = identifier(value.keyId, `runtime.publicKeys.${index}.keyId`);
		if (runtimePublicKeys.has(keyId)) invalid("runtime.publicKeys.keyId");
		runtimePublicKeys.set(
			keyId,
			ed25519PublicKey(
				await secretText(
					read,
					absolutePath(
						value.publicKeyFile,
						`runtime.publicKeys.${index}.publicKeyFile`,
					),
					`runtime.publicKeys.${index}.publicKeyFile`,
				),
				`runtime.publicKeys.${index}.publicKeyFile`,
			),
		);
	}

	const limits = strictRecord(root.limits, [
		"intentTtlMs",
		"accessTtlMs",
		"maxConcurrentTransfers",
	]);
	const intentTtlMs = integer(
		limits.intentTtlMs,
		1,
		MAX_TTL_MS,
		"limits.intentTtlMs",
	);
	const accessTtlMs = integer(
		limits.accessTtlMs,
		1,
		MAX_TTL_MS,
		"limits.accessTtlMs",
	);
	const maxConcurrentTransfers = integer(
		limits.maxConcurrentTransfers,
		1,
		256,
		"limits.maxConcurrentTransfers",
	);

	const serviceTokens = new Set<string>();
	const services: {
		token: string;
		agentIds: string[];
	}[] = [];
	for (const [index, entry] of array(
		root.services,
		1,
		64,
		"services",
	).entries()) {
		const value = strictRecord(entry, ["tokenFile", "agentIds"], []);
		const token = await secretText(
			read,
			absolutePath(value.tokenFile, `services.${index}.tokenFile`),
			`services.${index}.tokenFile`,
		);
		if (!SERVICE_TOKEN.test(token)) invalid(`services.${index}.tokenFile`);
		const digest = createHash("sha256").update(token).digest("hex");
		if (serviceTokens.has(digest)) invalid(`services.${index}.tokenFile`);
		serviceTokens.add(digest);
		const agentIds = array(
			value.agentIds,
			1,
			1024,
			`services.${index}.agentIds`,
		).map((agentId) => text(agentId, 256, `services.${index}.agentIds`));
		if (new Set(agentIds).size !== agentIds.length)
			invalid(`services.${index}.agentIds`);
		services.push({ token, agentIds });
	}

	const storageCredentials =
		storageCredentialsPath === undefined
			? undefined
			: await credentials(read, storageCredentialsPath);
	let objectStorage: ReturnType<typeof createS3ObjectStorageV1>;
	try {
		objectStorage = createS3ObjectStorageV1({
			region: storageRegion,
			...(storageEndpoint ? { endpoint: storageEndpoint } : {}),
			...(storageCredentials ? { credentials: storageCredentials } : {}),
			bucket: storageBucket,
			prefix: storagePrefix,
			maxObjectBytes: storageMaxObjectBytes,
			timeoutMs: storageTimeoutMs,
		});
	} catch {
		invalid("storage");
	}

	return {
		storage: objectStorage,
		issuer: signingIssuer,
		keyVersion: signingKeyVersion,
		privateKey,
		publicKeys: signingPublicKeys,
		runtimeIssuer,
		runtimeWorkerId,
		runtimePublicKeys,
		intentTtlMs,
		accessTtlMs,
		maxConcurrentTransfers,
		services,
		resolveActor: options.resolveActor,
	};
}

/**
 * Load the file data plane only when the deployment names its configuration
 * file. An unset/empty variable leaves files unregistered (attachments are
 * rejected); a set but incomplete file fails startup instead of degrading.
 */
export async function createProductionPlatformFileDeploymentFromEnvironmentV1(input: {
	readonly environment?: NodeJS.ProcessEnv;
	resolveActor(actorId: string): Promise<unknown | null>;
	readonly readFile?: ReadTextFile;
}): Promise<PlatformFileDeploymentV1 | undefined> {
	const environment = input.environment ?? process.env;
	const configurationFile =
		environment[PLATFORM_FILE_DEPLOYMENT_CONFIGURATION_FILE];
	if (configurationFile === undefined || configurationFile === "")
		return undefined;
	return createProductionPlatformFileDeploymentV1({
		configurationFile,
		resolveActor: input.resolveActor,
		...(input.readFile ? { readFile: input.readFile } : {}),
	});
}
