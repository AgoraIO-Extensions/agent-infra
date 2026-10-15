import {
	createConfiguration,
	KubeConfig,
	type KubernetesObject,
	KubernetesObjectApi,
	ServerConfiguration,
	type V1DeleteOptions,
} from "@kubernetes/client-node";

export const workloadApiVersions = {
	Deployment: "apps/v1",
	StatefulSet: "apps/v1",
	Service: "v1",
	ConfigMap: "v1",
	Job: "batch/v1",
	ServiceAccount: "v1",
	PersistentVolumeClaim: "v1",
	Secret: "v1",
	Pod: "v1",
	NetworkPolicy: "networking.k8s.io/v1",
	Ingress: "networking.k8s.io/v1",
} as const;
export type WorkloadResourceKind = keyof typeof workloadApiVersions;

export interface WorkerKubernetesClientV1 {
	readonly namespace: string;
	read<T extends KubernetesObject>(
		kind: WorkloadResourceKind,
		name: string,
	): Promise<T | null>;
	list<T extends KubernetesObject>(
		kind: WorkloadResourceKind,
		selector: string,
	): Promise<T[]>;
	create<T extends KubernetesObject>(object: T): Promise<T>;
	replace<T extends KubernetesObject>(object: T): Promise<T>;
	delete(object: KubernetesObject): Promise<void>;
	/**
	 * Conditional delete result used by durable Session Sandbox cleanup.
	 * `absent` means the API returned 404; it is not a DELETE acknowledgement.
	 */
	deleteResult?(object: KubernetesObject): Promise<"acknowledged" | "absent">;
}

export type WorkloadKubernetesVerb =
	| "get"
	| "list"
	| "create"
	| "update"
	| "delete";

/** Credential-free facts about a failed call, for diagnostics only. */
export interface WorkloadKubernetesFailureDetailsV1 {
	/** HTTP status of the API response; absent when the call never got one. */
	readonly status?: number;
	readonly kind?: WorkloadResourceKind;
	readonly verb?: WorkloadKubernetesVerb;
}

export class WorkloadKubernetesError extends Error {
	constructor(
		readonly code: "conflict" | "unavailable" | "policy",
		/** Never the response body, resource names or credentials. */
		readonly details: WorkloadKubernetesFailureDetailsV1 = {},
	) {
		super("Kubernetes Workload operation failed");
	}
}

/**
 * Map any failure of a Kubernetes call to the bounded error type, keeping only
 * the HTTP status, the resource kind and the verb for diagnostics.
 */
export function workloadKubernetesFailureV1(
	error: unknown,
	context: {
		readonly kind: WorkloadResourceKind;
		readonly verb: WorkloadKubernetesVerb;
	},
): WorkloadKubernetesError {
	if (error instanceof WorkloadKubernetesError) return error;
	const httpStatus = status(error);
	return new WorkloadKubernetesError(
		httpStatus === 409 ? "conflict" : "unavailable",
		{
			...(httpStatus === undefined ? {} : { status: httpStatus }),
			kind: context.kind,
			verb: context.verb,
		},
	);
}

export function createWorkerKubernetesClientV1(
	namespace: string,
	config?: KubeConfig,
): WorkerKubernetesClientV1 {
	if (!/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(namespace))
		throw new WorkloadKubernetesError("policy");
	const kubeConfig = config ?? new KubeConfig();
	// Production never falls back to the developer's current kubeconfig context.
	if (!config) kubeConfig.loadFromCluster();
	const cluster = kubeConfig.getCurrentCluster();
	if (!cluster) throw new WorkloadKubernetesError("policy");
	const api = new KubernetesObjectApi(
		createConfiguration({
			baseServer: new ServerConfiguration(cluster.server, {}),
			authMethods: { default: kubeConfig },
			promiseMiddleware: [
				{
					async pre(context) {
						context.setSignal(AbortSignal.timeout(10_000));
						return context;
					},
					async post(context) {
						return context;
					},
				},
			],
		}),
	);
	const header = (kind: WorkloadResourceKind, name: string) => ({
		apiVersion: workloadApiVersions[kind],
		kind,
		metadata: { namespace, name },
	});
	const check = (object: KubernetesObject) => {
		if (
			object.metadata?.namespace !== namespace ||
			!Object.hasOwn(workloadApiVersions, object.kind ?? "") ||
			object.apiVersion !==
				workloadApiVersions[object.kind as WorkloadResourceKind]
		)
			throw new WorkloadKubernetesError("policy");
	};
	async function operation<T>(
		callback: () => Promise<T>,
		context: {
			readonly kind: WorkloadResourceKind;
			readonly verb: WorkloadKubernetesVerb;
		},
	): Promise<T> {
		try {
			return await callback();
		} catch (error) {
			throw workloadKubernetesFailureV1(error, context);
		}
	}
	return {
		namespace,
		async read<T extends KubernetesObject>(
			kind: WorkloadResourceKind,
			name: string,
		) {
			return operation(
				async () => {
					try {
						return await api.read<T>(header(kind, name));
					} catch (error) {
						if (status(error) === 404) return null;
						throw error;
					}
				},
				{ kind, verb: "get" },
			);
		},
		async list<T extends KubernetesObject>(
			kind: WorkloadResourceKind,
			selector: string,
		) {
			return operation(
				async () =>
					(
						await api.list<T>(
							workloadApiVersions[kind],
							kind,
							namespace,
							undefined,
							undefined,
							undefined,
							undefined,
							selector,
						)
					).items,
				{ kind, verb: "list" },
			);
		},
		async create<T extends KubernetesObject>(object: T) {
			check(object);
			return operation(() => api.create(object), {
				kind: object.kind as WorkloadResourceKind,
				verb: "create",
			});
		},
		async replace<T extends KubernetesObject>(object: T) {
			check(object);
			if (!object.metadata?.resourceVersion || !object.metadata.uid)
				throw new WorkloadKubernetesError("policy");
			return operation(() => api.replace(object), {
				kind: object.kind as WorkloadResourceKind,
				verb: "update",
			});
		},
		async delete(object) {
			await this.deleteResult?.(object);
		},
		async deleteResult(object) {
			check(object);
			if (!object.metadata?.uid || !object.metadata.resourceVersion)
				throw new WorkloadKubernetesError("policy");
			const options: V1DeleteOptions = {
				propagationPolicy: "Foreground",
				preconditions: {
					uid: object.metadata.uid,
					resourceVersion: object.metadata.resourceVersion,
				},
			};
			return operation(
				async () => {
					try {
						await api.delete(
							object,
							undefined,
							undefined,
							undefined,
							undefined,
							undefined,
							options,
						);
						return "acknowledged" as const;
					} catch (error) {
						if (status(error) === 404) return "absent" as const;
						throw error;
					}
				},
				{ kind: object.kind as WorkloadResourceKind, verb: "delete" },
			);
		},
	};
}

function status(error: unknown): number | undefined {
	if (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		typeof error.code === "number"
	)
		return error.code;
	return undefined;
}
