import {
	createConfiguration,
	KubeConfig,
	type KubernetesObject,
	KubernetesObjectApi,
	ServerConfiguration,
	type V1DeleteOptions,
} from "@kubernetes/client-node";

export const workloadApiVersions = {
	StatefulSet: "apps/v1",
	Service: "v1",
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
}

export class WorkloadKubernetesError extends Error {
	constructor(readonly code: "conflict" | "unavailable" | "policy") {
		super("Kubernetes Workload operation failed");
	}
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
			object.kind === "Pod" ||
			!Object.hasOwn(workloadApiVersions, object.kind ?? "") ||
			object.apiVersion !==
				workloadApiVersions[object.kind as WorkloadResourceKind]
		)
			throw new WorkloadKubernetesError("policy");
	};
	async function operation<T>(callback: () => Promise<T>): Promise<T> {
		try {
			return await callback();
		} catch (error) {
			if (error instanceof WorkloadKubernetesError) throw error;
			throw new WorkloadKubernetesError(
				status(error) === 409 ? "conflict" : "unavailable",
			);
		}
	}
	return {
		namespace,
		async read<T extends KubernetesObject>(
			kind: WorkloadResourceKind,
			name: string,
		) {
			return operation(async () => {
				try {
					return await api.read<T>(header(kind, name));
				} catch (error) {
					if (status(error) === 404) return null;
					throw error;
				}
			});
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
			);
		},
		async create<T extends KubernetesObject>(object: T) {
			check(object);
			return operation(() => api.create(object));
		},
		async replace<T extends KubernetesObject>(object: T) {
			check(object);
			if (!object.metadata?.resourceVersion || !object.metadata.uid)
				throw new WorkloadKubernetesError("policy");
			return operation(() => api.replace(object));
		},
		async delete(object) {
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
			await operation(async () => {
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
				} catch (error) {
					if (status(error) !== 404) throw error;
				}
			});
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
