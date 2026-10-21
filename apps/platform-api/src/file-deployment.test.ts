import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
	createProductionPlatformFileDeploymentFromEnvironmentV1,
	createProductionPlatformFileDeploymentV1,
} from "./file-deployment.js";

const DIRECT_CONNECTIONS = "http://object-storage:9000";

interface Workspace {
	readonly root: string;
	readonly configurationFile: string;
	readonly configuration: Record<string, unknown>;
}

const workspaces: string[] = [];

afterEach(async () => {
	await Promise.all(
		workspaces
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

function ed25519Pair() {
	const keys = generateKeyPairSync("ed25519");
	return {
		privateKey: keys.privateKey
			.export({ format: "pem", type: "pkcs8" })
			.toString(),
		publicKey: keys.publicKey
			.export({ format: "pem", type: "spki" })
			.toString(),
	};
}

async function workspace(): Promise<
	Workspace & {
		readonly files: {
			readonly signingPrivate: string;
			readonly signingPublic: string;
			readonly runtimePublic: string;
			readonly serviceToken: string;
			readonly credentials: string;
		};
		write(value: Record<string, unknown>): Promise<void>;
	}
> {
	const root = await mkdtemp(join(tmpdir(), "platform-file-deployment-"));
	workspaces.push(root);
	const signing = ed25519Pair();
	const runtime = ed25519Pair();
	const files = {
		signingPrivate: join(root, "file-signing.pem"),
		signingPublic: join(root, "file-signing.pub.pem"),
		runtimePublic: join(root, "runtime-grant.pub.pem"),
		serviceToken: join(root, "file-service-token"),
		credentials: join(root, "s3-credentials.json"),
	};
	await writeFile(files.signingPrivate, signing.privateKey);
	await writeFile(files.signingPublic, signing.publicKey);
	await writeFile(files.runtimePublic, runtime.publicKey);
	await writeFile(files.serviceToken, `${"s".repeat(48)}\n`);
	await writeFile(
		files.credentials,
		JSON.stringify({
			accessKeyId: "synthetic-access-key",
			secretAccessKey: "synthetic-secret-key",
		}),
	);
	const configuration = {
		schemaVersion: 1,
		storage: {
			region: "us-east-1",
			endpoint: DIRECT_CONNECTIONS,
			bucket: "file-contract",
			prefix: "files/",
			maxObjectBytes: 1024 * 1024,
			timeoutMs: 10000,
			credentialsFile: files.credentials,
		},
		signing: {
			issuer: "platform-files",
			keyVersion: "file-key-1",
			privateKeyFile: files.signingPrivate,
			publicKeys: [
				{ keyVersion: "file-key-1", publicKeyFile: files.signingPublic },
			],
		},
		runtime: {
			issuer: "platform-runtime",
			workerId: "platform-worker",
			publicKeys: [
				{ keyId: "runtime-key-1", publicKeyFile: files.runtimePublic },
			],
		},
		limits: {
			intentTtlMs: 600_000,
			accessTtlMs: 60_000,
			maxConcurrentTransfers: 8,
		},
		services: [{ tokenFile: files.serviceToken, agentIds: ["agent-a"] }],
	};
	const configurationFile = join(root, "file-deployment.json");
	await writeFile(configurationFile, JSON.stringify(configuration));
	return {
		root,
		files,
		configuration,
		configurationFile,
		async write(value) {
			await writeFile(configurationFile, JSON.stringify(value));
		},
	};
}

function builder(configurationFile: string) {
	return createProductionPlatformFileDeploymentV1({
		configurationFile,
		resolveActor: async (actorId) =>
			actorId === "actor-a" ? { userId: "actor-a" } : null,
	});
}

it("assembles the file data plane from deployment-owned configuration files", async () => {
	const fixture = await workspace();
	const deployment = await builder(fixture.configurationFile);
	expect(deployment).toMatchObject({
		issuer: "platform-files",
		keyVersion: "file-key-1",
		runtimeIssuer: "platform-runtime",
		runtimeWorkerId: "platform-worker",
		intentTtlMs: 600_000,
		accessTtlMs: 60_000,
		maxConcurrentTransfers: 8,
		services: [{ token: "s".repeat(48), agentIds: ["agent-a"] }],
	});
	expect(deployment.privateKey.asymmetricKeyType).toBe("ed25519");
	expect(deployment.publicKeys.get("file-key-1")?.asymmetricKeyType).toBe(
		"ed25519",
	);
	expect(
		deployment.runtimePublicKeys.get("runtime-key-1")?.asymmetricKeyType,
	).toBe("ed25519");
	expect(typeof deployment.storage.upload).toBe("function");
	expect(typeof deployment.resolveActor).toBe("function");
	await expect(deployment.resolveActor("actor-a")).resolves.toEqual({
		userId: "actor-a",
	});
	await expect(deployment.resolveActor("actor-b")).resolves.toBeNull();
});

it("fails closed when the configuration is missing, partial or unknown", async () => {
	const fixture = await workspace();
	const { configuration } = fixture;
	const mutations: ((value: Record<string, unknown>) => void)[] = [
		(value) => delete value.runtime,
		(value) => delete (value.runtime as Record<string, unknown>).workerId,
		(value) => {
			(value.services as unknown[]).length = 0;
		},
		(value) => {
			value.extra = true;
		},
		(value) => {
			(value.storage as Record<string, unknown>).credentialsFile =
				"relative/credentials.json";
		},
		(value) => {
			value.schemaVersion = 2;
		},
	];
	for (const mutate of mutations) {
		const value = structuredClone(configuration);
		mutate(value);
		await fixture.write(value);
		await expect(builder(fixture.configurationFile)).rejects.toThrow(
			"PLATFORM_FILE_DEPLOYMENT_CONFIGURATION_INVALID",
		);
	}
});

it("rejects unusable signing and runtime keys", async () => {
	const fixture = await workspace();
	const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
	await writeFile(
		fixture.files.runtimePublic,
		rsa.publicKey.export({ format: "pem", type: "spki" }).toString(),
	);
	await expect(builder(fixture.configurationFile)).rejects.toThrow(
		"PLATFORM_FILE_DEPLOYMENT_CONFIGURATION_INVALID",
	);

	const other = ed25519Pair();
	await writeFile(fixture.files.runtimePublic, other.publicKey);
	await writeFile(fixture.files.signingPublic, other.publicKey);
	await expect(builder(fixture.configurationFile)).rejects.toThrow(
		"PLATFORM_FILE_DEPLOYMENT_CONFIGURATION_INVALID",
	);

	const duplicateKey = structuredClone(fixture.configuration);
	(duplicateKey.signing as { publicKeys: unknown[] }).publicKeys = [
		{ keyVersion: "file-key-1", publicKeyFile: fixture.files.signingPublic },
		{ keyVersion: "file-key-1", publicKeyFile: fixture.files.signingPublic },
	];
	await fixture.write(duplicateKey);
	await expect(builder(fixture.configurationFile)).rejects.toThrow(
		"PLATFORM_FILE_DEPLOYMENT_CONFIGURATION_INVALID",
	);
});

it("never echoes token or private-key material in configuration errors", async () => {
	const fixture = await workspace();
	const token = "s".repeat(48);
	await writeFile(fixture.files.serviceToken, token);
	const invalid = structuredClone(fixture.configuration);
	(invalid.runtime as Record<string, unknown>).workerId = "";
	await fixture.write(invalid);
	const error = await builder(fixture.configurationFile).catch(
		(caught: unknown) => caught,
	);
	expect(error).toBeInstanceOf(Error);
	expect((error as Error).message).toBe(
		"PLATFORM_FILE_DEPLOYMENT_CONFIGURATION_INVALID:runtime.workerId",
	);
	expect((error as Error).message).not.toContain(token);

	await writeFile(fixture.files.serviceToken, "short-token");
	await fixture.write(fixture.configuration);
	const shortToken = await builder(fixture.configurationFile).catch(
		(caught: unknown) => caught,
	);
	expect((shortToken as Error).message).toBe(
		"PLATFORM_FILE_DEPLOYMENT_CONFIGURATION_INVALID:services.0.tokenFile",
	);
	expect((shortToken as Error).message).not.toContain("short-token");

	const privateKey = await import("node:fs/promises").then(({ readFile }) =>
		readFile(fixture.files.signingPrivate, "utf8"),
	);
	await writeFile(fixture.files.runtimePublic, privateKey);
	await writeFile(fixture.files.serviceToken, token);
	const privateKeyError = await builder(fixture.configurationFile).catch(
		(caught: unknown) => caught,
	);
	expect((privateKeyError as Error).message).toBe(
		"PLATFORM_FILE_DEPLOYMENT_CONFIGURATION_INVALID:runtime.publicKeys.0.publicKeyFile",
	);
	expect((privateKeyError as Error).message).not.toContain("PRIVATE KEY");
});

it("requires a complete strict S3 credentials file when one is named", async () => {
	const fixture = await workspace();
	const invalid = structuredClone(fixture.configuration);
	(invalid.storage as Record<string, unknown>).credentialsFile = null;
	await fixture.write(invalid);
	await expect(builder(fixture.configurationFile)).rejects.toThrow(
		"PLATFORM_FILE_DEPLOYMENT_CONFIGURATION_INVALID",
	);
	await writeFile(fixture.files.credentials, "{}");
	await fixture.write(fixture.configuration);
	await expect(builder(fixture.configurationFile)).rejects.toThrow(
		"PLATFORM_FILE_DEPLOYMENT_CONFIGURATION_INVALID",
	);
});

it("enables the deployment only from an explicit absolute configuration file", async () => {
	const fixture = await workspace();
	expect(
		await createProductionPlatformFileDeploymentFromEnvironmentV1({
			environment: {},
			resolveActor: async () => null,
		}),
	).toBeUndefined();
	await expect(
		createProductionPlatformFileDeploymentFromEnvironmentV1({
			environment: {
				PLATFORM_API_FILE_DEPLOYMENT_CONFIGURATION_FILE: "relative.json",
			},
			resolveActor: async () => null,
		}),
	).rejects.toThrow("PLATFORM_FILE_DEPLOYMENT_CONFIGURATION_INVALID");

	const deployment =
		await createProductionPlatformFileDeploymentFromEnvironmentV1({
			environment: {
				PLATFORM_API_FILE_DEPLOYMENT_CONFIGURATION_FILE:
					fixture.configurationFile,
			},
			resolveActor: async () => null,
		});
	expect(deployment?.runtimeWorkerId).toBe("platform-worker");
});
