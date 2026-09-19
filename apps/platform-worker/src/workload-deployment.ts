import {
	createPrivateKey,
	type KeyObject,
	randomUUID,
	sign,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
	WorkloadReadinessGrantClaimsV1Schema,
	type WorkloadReadinessGrantV1,
	WorkloadReadinessRequestBindingV1Schema,
	type WorkloadReadinessRequestV1,
	WorkloadReadinessRequestV1Schema,
	WorkloadReadinessResponseV1Schema,
} from "@agent-infra/contracts/runtime";
import { createOciImageRegistryAdapterV1 } from "@agent-infra/image-registry";
import {
	createDeploymentModelCatalogAdapterV1,
	createModelAccessValidatorV1,
} from "@agent-infra/model-catalog";
import { createWorkloadSecretKeyringDecryptorV1 } from "@agent-infra/secret-store/worker";
import { KubeConfig } from "@kubernetes/client-node";
import { createWorkerKubernetesClientV1 } from "./kubernetes-client.js";
import {
	createKubernetesRuntimeAdapterV1,
	workloadResourceNameV1,
} from "./kubernetes-runtime-adapter.js";
import type { PlatformWorkloadWorkerOptionsV1 } from "./workload-worker.js";

type ProbeRequest = Omit<WorkloadReadinessRequestV1, "grant">;

export interface WorkloadRuntimeProbeAuthorizationV1 {
	/** The deployment signs only this probe, never a task or tool authorization. */
	authorize(
		input: {
			readonly request: ProbeRequest;
		},
		signal: AbortSignal,
	): Promise<{
		readonly serviceToken: string;
		readonly grant: WorkloadReadinessGrantV1;
	}>;
}

export interface ProductionWorkloadWorkerInputV1 {
	readonly databaseUrl: string;
	readonly workerId: string;
	readonly kubernetes:
		| { readonly mode: "in-cluster" }
		| {
				readonly mode: "kubeconfig";
				readonly path: string;
				readonly context: string;
				readonly expectedServer: string;
		  };
	readonly policy: PlatformWorkloadWorkerOptionsV1["policy"];
	readonly registry: Parameters<typeof createOciImageRegistryAdapterV1>[0];
	readonly admissionPolicyRef: string;
	readonly registrySubjectRef: string;
	readonly keyring: Parameters<
		typeof createWorkloadSecretKeyringDecryptorV1
	>[0];
	readonly modelCatalog: Parameters<
		typeof createDeploymentModelCatalogAdapterV1
	>[0];
	readonly templateModelBindings: PlatformWorkloadWorkerOptionsV1["templateModelBindings"];
	readonly executionCapacityProfiles?: PlatformWorkloadWorkerOptionsV1["executionCapacityProfiles"];
	readonly runtimeProbe: WorkloadRuntimeProbeAuthorizationV1;
	/** Separate transports keep registry authentication out of model and Runtime requests. */
	readonly modelFetch?: typeof fetch;
	readonly runtimeFetch?: typeof fetch;
	readonly pollIntervalMs?: number;
	readonly maximumAttempts?: number;
	readonly log?: (message: string) => void;
}

export class WorkloadDeploymentErrorV1 extends Error {
	constructor(
		readonly code:
			| "WORKER_CONFIGURATION_INVALID"
			| "WORKER_KUBERNETES_CONFIGURATION_INVALID"
			| "WORKER_REGISTRY_CONFIGURATION_INVALID"
			| "WORKER_SECRET_KEYRING_INVALID"
			| "WORKER_RUNTIME_PROBE_FAILED",
	) {
		super(code);
	}
}

export async function createProductionWorkloadWorkerOptionsV1(
	input: ProductionWorkloadWorkerInputV1,
	signal: AbortSignal = new AbortController().signal,
): Promise<PlatformWorkloadWorkerOptionsV1> {
	let stage: WorkloadDeploymentErrorV1["code"] = "WORKER_CONFIGURATION_INVALID";
	try {
		signal.throwIfAborted();
		if (
			![
				input.workerId,
				input.admissionPolicyRef,
				input.registrySubjectRef,
			].every(
				(value) =>
					typeof value === "string" &&
					value.length > 0 &&
					value.length <= 256 &&
					[...value].every((character) => character.charCodeAt(0) >= 32),
			) ||
			!["postgres:", "postgresql:"].includes(
				new URL(input.databaseUrl).protocol,
			) ||
			!Array.isArray(input.templateModelBindings) ||
			typeof input.modelCatalog?.load !== "function" ||
			typeof input.runtimeProbe?.authorize !== "function" ||
			!input.policy.runtimeAuth ||
			input.policy.runtimeAuth.workerId !== input.workerId
		)
			throw new Error();
		stage = "WORKER_KUBERNETES_CONFIGURATION_INVALID";
		const config = new KubeConfig();
		if (input.kubernetes.mode === "in-cluster") config.loadFromCluster();
		else if (input.kubernetes.mode === "kubeconfig") {
			const source = input.kubernetes;
			if (!isAbsolute(source.path) || !source.context || !source.expectedServer)
				throw new Error();
			config.loadFromString(
				await readFile(source.path, { encoding: "utf8", signal }),
			);
			const context = config
				.getContexts()
				.find((entry) => entry.name === source.context);
			if (
				!context ||
				(context.namespace && context.namespace !== input.policy.namespace)
			)
				throw new Error();
			config.setCurrentContext(context.name);
			if (config.getCurrentCluster()?.server !== source.expectedServer)
				throw new Error();
		} else throw new Error();
		signal.throwIfAborted();
		const client = createWorkerKubernetesClientV1(
			input.policy.namespace,
			config,
		);
		// Validate deployment policy before opening a database or making Kubernetes changes.
		createKubernetesRuntimeAdapterV1({
			client,
			policy: input.policy,
			probe: async () => false,
		});
		stage = "WORKER_REGISTRY_CONFIGURATION_INVALID";
		const registry = createOciImageRegistryAdapterV1(input.registry);
		stage = "WORKER_SECRET_KEYRING_INVALID";
		const decryptor = createWorkloadSecretKeyringDecryptorV1(input.keyring);
		stage = "WORKER_CONFIGURATION_INVALID";
		const modelCatalog = createDeploymentModelCatalogAdapterV1(
			input.modelCatalog,
		);
		const modelAccess = createModelAccessValidatorV1({
			fetch: input.modelFetch,
		});
		const probeRuntime = createWorkloadRuntimeProbeV1({
			namespace: input.policy.namespace,
			workerId: input.workerId,
			authorization: input.runtimeProbe,
			fetch: input.runtimeFetch,
		});
		signal.throwIfAborted();
		return {
			databaseUrl: input.databaseUrl,
			workerId: input.workerId,
			policy: structuredClone(input.policy),
			client,
			registry,
			decryptor,
			modelCatalog,
			modelAccess,
			probeRuntime,
			admissionPolicyRef: input.admissionPolicyRef,
			registrySubjectRef: input.registrySubjectRef,
			templateModelBindings: structuredClone(input.templateModelBindings),
			executionCapacityProfiles: structuredClone(
				input.executionCapacityProfiles,
			),
			fetch: input.runtimeFetch,
			pollIntervalMs: input.pollIntervalMs,
			maximumAttempts: input.maximumAttempts,
			log: input.log,
		};
	} catch {
		throw new WorkloadDeploymentErrorV1(stage);
	}
}

/** Readiness is an authenticated, bounded RuntimeHost protocol exchange. */
export function createWorkloadRuntimeProbeV1(options: {
	readonly namespace: string;
	readonly workerId: string;
	readonly authorization: WorkloadRuntimeProbeAuthorizationV1;
	readonly fetch?: typeof fetch;
}): PlatformWorkloadWorkerOptionsV1["probeRuntime"] {
	return async (input) => {
		const signal = AbortSignal.any([input.signal, AbortSignal.timeout(10_000)]);
		let abort = () => {};
		try {
			signal.throwIfAborted();
			return await Promise.race([
				new Promise<never>((_resolve, reject) => {
					abort = () => reject(new Error());
					signal.addEventListener("abort", abort, { once: true });
				}),
				(async () => {
					const origin = `http://${workloadResourceNameV1(input.agentId)}-probe.${options.namespace}.svc:${input.manifest.service.port}`;
					if (
						input.baseUrl !== origin ||
						!Number.isSafeInteger(input.workloadRevision) ||
						input.workloadRevision < 1
					)
						throw new Error();
					const request = WorkloadReadinessRequestBindingV1Schema.parse({
						schemaVersion: 1,
						requestId: randomUUID(),
						traceId: randomUUID(),
						workerId: options.workerId,
						agentId: input.agentId,
						workloadRevision: input.workloadRevision,
						fence: input.fence,
						imageDigest: input.imageDigest,
					});
					const authorization = await options.authorization.authorize(
						{ request },
						signal,
					);
					signal.throwIfAborted();
					if (
						typeof authorization.serviceToken !== "string" ||
						!/^[\x21-\x7e]{1,8192}$/.test(authorization.serviceToken)
					)
						throw new Error();
					const body = WorkloadReadinessRequestV1Schema.parse({
						...request,
						grant: authorization.grant,
					});
					// Inspect scope before transport. Signature verification remains at RuntimeHost.
					if (body.grant.token.length > 16_384) throw new Error();
					const segments = body.grant.token.split(".");
					if (
						segments.length !== 3 ||
						segments.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))
					)
						throw new Error();
					const claims = WorkloadReadinessGrantClaimsV1Schema.parse(
						JSON.parse(
							Buffer.from(segments[1] ?? "", "base64url").toString("utf8"),
						),
					);
					if (
						Object.entries(request).some(
							([field, value]) =>
								claims[field as keyof typeof claims] !== value,
						)
					)
						throw new Error();
					const response = await (options.fetch ?? fetch)(
						`${origin}/internal/runtime/v1/readiness`,
						{
							method: "POST",
							redirect: "error",
							signal,
							headers: {
								authorization: `Bearer ${authorization.serviceToken}`,
								"content-type": "application/json",
								"x-trace-id": request.traceId,
							},
							body: JSON.stringify(body),
						},
					);
					const reader = response.body?.getReader();
					const cancelRead = () => {
						void reader?.cancel().catch(() => undefined);
					};
					signal.addEventListener("abort", cancelRead, { once: true });
					try {
						signal.throwIfAborted();
						if (
							!response.ok ||
							!reader ||
							Number(response.headers.get("content-length")) > 65_536
						)
							throw new Error();
						const chunks: Uint8Array[] = [];
						let bytes = 0;
						while (true) {
							const next = await reader.read();
							signal.throwIfAborted();
							if (next.value) {
								bytes += next.value.byteLength;
								if (bytes > 65_536) throw new Error();
								chunks.push(next.value);
							}
							if (next.done) break;
						}
						const result = WorkloadReadinessResponseV1Schema.parse(
							JSON.parse(
								new TextDecoder("utf8", { fatal: true }).decode(
									Buffer.concat(chunks, bytes),
								),
							),
						);
						if (
							Object.entries(request).some(
								([field, value]) =>
									result[field as keyof typeof result] !== value,
							)
						)
							throw new Error();
						return {
							core: "passed" as const,
							capabilities: result.capabilities,
						};
					} finally {
						signal.removeEventListener("abort", cancelRead);
						cancelRead();
					}
				})(),
			]);
		} catch {
			throw new WorkloadDeploymentErrorV1("WORKER_RUNTIME_PROBE_FAILED");
		} finally {
			signal.removeEventListener("abort", abort);
		}
	};
}

/** The actual Ed25519 signer lives only in the Worker deployment process. */
export function createWorkloadReadinessAuthorizationV1(options: {
	readonly workerId: string;
	readonly issuer: string;
	readonly keyId: string;
	readonly privateKey: string | KeyObject;
	readonly serviceToken: string;
	readonly now?: () => number;
}): WorkloadRuntimeProbeAuthorizationV1 {
	let key: KeyObject;
	try {
		key =
			typeof options.privateKey === "string"
				? createPrivateKey(options.privateKey)
				: options.privateKey;
		if (
			key.type !== "private" ||
			key.asymmetricKeyType !== "ed25519" ||
			!options.keyId ||
			!options.issuer ||
			!/^[\x21-\x7e]{1,8192}$/.test(options.serviceToken)
		)
			throw new Error();
	} catch {
		throw new WorkloadDeploymentErrorV1("WORKER_CONFIGURATION_INVALID");
	}
	const { workerId, issuer, keyId, serviceToken } = options;
	return {
		async authorize({ request: value }, signal) {
			try {
				signal.throwIfAborted();
				const request = WorkloadReadinessRequestBindingV1Schema.parse(value);
				if (request.workerId !== workerId) throw new Error();
				const now = (options.now ?? Date.now)();
				const claims = WorkloadReadinessGrantClaimsV1Schema.parse({
					...request,
					issuer,
					audience: "runtime_host_readiness",
					purpose: "readiness.read",
					grantId: randomUUID(),
					issuedAt: now,
					expiresAt: now + 30_000,
				});
				const header = Buffer.from(
					JSON.stringify({
						alg: "EdDSA",
						kid: keyId,
						typ: "workload-readiness+jws",
					}),
				).toString("base64url");
				const payload = Buffer.from(JSON.stringify(claims)).toString(
					"base64url",
				);
				const unsigned = `${header}.${payload}`;
				const signature = sign(
					null,
					Buffer.from(unsigned, "ascii"),
					key,
				).toString("base64url");
				return {
					serviceToken,
					grant: {
						schemaVersion: 1,
						format: "workload-readiness-jws",
						token: `${unsigned}.${signature}`,
					},
				};
			} catch {
				throw new WorkloadDeploymentErrorV1("WORKER_RUNTIME_PROBE_FAILED");
			}
		},
	};
}
