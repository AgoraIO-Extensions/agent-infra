import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { connectionHostDeploymentIdentityV1 } from "@agent-infra/contracts/runtime";
import {
	type ConnectionManualInstallationDeploymentV1,
	PostgresConnectionManualInstallationStoreV1,
} from "@agent-infra/platform-store";
import { createWorkloadSecretKeyringDecryptorV1 } from "@agent-infra/secret-store/worker";
import type { ConnectionInstallBootstrapDeploymentV1 } from "./connection-install-bootstrap.js";
import {
	type ConnectionInstallWorkerSigningV1,
	createConnectionInstallHostClientV1,
} from "./connection-install-host-client.js";
import { createConnectionInstallReadbackServerV1 } from "./connection-install-readback-server.js";
import { createConnectionManualInstallationDrainV1 } from "./connection-manual-installation-drain.js";

type Enabled = Extract<
	ConnectionManualInstallationDeploymentV1,
	{ status: "enabled" }
>;

/** Raised when the gate opened the route but this Worker cannot carry it. */
export class ConnectionManualInstallationWorkerUnavailableErrorV1 extends Error {
	constructor() {
		super("CONNECTION_MANUAL_INSTALLATION_WORKER_UNAVAILABLE");
		this.name = "ConnectionManualInstallationWorkerUnavailableErrorV1";
	}
}

function unavailable(): never {
	throw new ConnectionManualInstallationWorkerUnavailableErrorV1();
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function secretRef(value: unknown) {
	return (
		record(value) &&
		typeof value.name === "string" &&
		value.name !== "" &&
		typeof value.key === "string" &&
		value.key !== ""
	);
}

/**
 * #4199 C2 D5/S3: the Session Sandbox install bootstrap of an enabled exception
 * route. The deployment supplies only the transport (receiver port, Worker
 * origin, API selector and Secret references); the system access, its approval
 * and the EP-1060 `clientName` come from the same gate decision as the API, so
 * the Host receives exactly the approved values. A deployment that also names
 * any of those three, or misses the transport, cannot carry the route.
 */
export function connectionManualInstallationBootstrapV1(
	decision: Enabled,
	bootstrap: unknown,
): ConnectionInstallBootstrapDeploymentV1 {
	if (
		!record(bootstrap) ||
		["clientName", "configuration", "approval", "installToken"].some((key) =>
			Object.hasOwn(bootstrap, key),
		) ||
		!Number.isInteger(bootstrap.port) ||
		(bootstrap.port as number) < 1024 ||
		(bootstrap.port as number) > 65_535 ||
		typeof bootstrap.workerOrigin !== "string" ||
		!record(bootstrap.apiSelector) ||
		typeof bootstrap.tlsSecretForSandbox !== "function" ||
		!secretRef(bootstrap.callbackAuthSecretRef) ||
		!secretRef(bootstrap.workerCaSecretRef)
	)
		unavailable();
	let worker: URL;
	try {
		worker = new URL(bootstrap.workerOrigin);
	} catch {
		unavailable();
	}
	if (worker.protocol !== "https:" || worker.port === "") unavailable();
	return {
		port: bootstrap.port as number,
		workerOrigin: bootstrap.workerOrigin,
		apiSelector: structuredClone(
			bootstrap.apiSelector as Record<string, string>,
		),
		clientName: decision.policy.clientName,
		configuration: structuredClone(decision.policy.systemAccess),
		approval: structuredClone(decision.policy.approval),
		tlsSecretForSandbox:
			bootstrap.tlsSecretForSandbox as ConnectionInstallBootstrapDeploymentV1["tlsSecretForSandbox"],
		callbackAuthSecretRef: structuredClone(
			bootstrap.callbackAuthSecretRef as ConnectionInstallBootstrapDeploymentV1["callbackAuthSecretRef"],
		),
		workerCaSecretRef: structuredClone(
			bootstrap.workerCaSecretRef as ConnectionInstallBootstrapDeploymentV1["workerCaSecretRef"],
		),
	};
}

export interface ConnectionManualInstallationWorkerV1 {
	/** Drained in the conversation Worker's installation tick. */
	readonly manual: {
		drain(
			executionIds: readonly string[],
			signal: AbortSignal,
		): Promise<number>;
	};
	/** Port the Host EP-1060 readback server listens on. */
	readonly readbackPort: number;
	close(): Promise<void>;
}

/**
 * #4199 C2 D5: the Worker production assembly of the exception route, from the
 * same enabled gate decision as the API. It builds the manual install Store,
 * the Worker-only keyring decryptor, the Host client and the Host readback
 * server, then the drain. Files are read once; any failure closes what was
 * started and reports only `CONNECTION_MANUAL_INSTALLATION_WORKER_UNAVAILABLE`,
 * never a path, certificate, key or token.
 */
export async function assembleConnectionManualInstallationWorkerV1(input: {
	readonly decision: Enabled;
	readonly bootstrap: ConnectionInstallBootstrapDeploymentV1;
	readonly worker: unknown;
	readonly databaseUrl: string;
	readonly directory: ConstructorParameters<
		typeof PostgresConnectionManualInstallationStoreV1
	>[0]["directory"];
	readonly namespace: string;
	readonly signing: ConnectionInstallWorkerSigningV1;
	readonly serviceToken: string;
	/** This process's outbox claim owner. */
	readonly attemptOwner: string;
	/** Listen address of the readback server; all interfaces when absent. */
	readonly readbackHost?: string;
}): Promise<ConnectionManualInstallationWorkerV1> {
	const worker = input.worker;
	if (
		!record(worker) ||
		![worker.hostCaFile, worker.readbackCertFile, worker.readbackKeyFile].every(
			(path) => typeof path === "string" && isAbsolute(path),
		) ||
		!record(worker.keyring)
	)
		unavailable();
	let store: PostgresConnectionManualInstallationStoreV1 | undefined;
	let readback:
		| ReturnType<typeof createConnectionInstallReadbackServerV1>
		| undefined;
	try {
		const [ca, cert, key] = await Promise.all(
			[worker.hostCaFile, worker.readbackCertFile, worker.readbackKeyFile].map(
				(path) => readFile(path as string, "utf8"),
			),
		);
		const decryptor = createWorkloadSecretKeyringDecryptorV1(
			worker.keyring as Parameters<
				typeof createWorkloadSecretKeyringDecryptorV1
			>[0],
		);
		const host = createConnectionInstallHostClientV1({
			ca: ca as string,
			signing: {
				issuer: input.signing.issuer,
				workerId: input.signing.workerId,
				keyId: input.signing.keyId,
				privateKey: input.signing.privateKey,
			},
		});
		store = new PostgresConnectionManualInstallationStoreV1({
			databaseUrl: input.databaseUrl,
			directory: input.directory,
			policy: input.decision.policy,
		});
		const manualStore = store;
		const drain = createConnectionManualInstallationDrainV1({
			store: manualStore,
			decryptor,
			host,
			systemAccess: input.decision.policy.systemAccess,
			approval: input.decision.policy.approval,
			clientName: input.decision.policy.clientName,
			namespace: input.namespace,
			receiverPort: input.bootstrap.port,
			deploymentWorkerId: input.signing.workerId,
			attemptOwner: input.attemptOwner,
		});
		readback = createConnectionInstallReadbackServerV1({
			key: key as string,
			cert: cert as string,
			port: Number(new URL(input.bootstrap.workerOrigin).port),
			...(input.readbackHost === undefined ? {} : { host: input.readbackHost }),
			deploymentServiceToken: input.serviceToken,
			namespace: input.namespace,
			deploymentIdentity: connectionHostDeploymentIdentityV1({
				namespace: input.namespace,
				workerId: input.signing.workerId,
			}),
			readback: (request) => manualStore.readback(request),
		});
		const readbackPort = await readback.listen();
		const server = readback;
		return {
			manual: drain,
			readbackPort,
			async close() {
				await server.close().catch(() => undefined);
				await manualStore.close();
			},
		};
	} catch {
		await readback?.close().catch(() => undefined);
		await store?.close().catch(() => undefined);
		unavailable();
	}
}
