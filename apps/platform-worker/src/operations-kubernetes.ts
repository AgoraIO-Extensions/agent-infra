import { request as httpRequest } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { KubeConfig } from "@kubernetes/client-node";
import type { OperationsReadKindV2 } from "./operations-collector.js";

const resources: Record<
	OperationsReadKindV2,
	{ api: string; plural: string; cluster?: true }
> = {
	pods: { api: "/api/v1", plural: "pods" },
	volumes: { api: "/api/v1", plural: "persistentvolumeclaims" },
	deployments: { api: "/apis/apps/v1", plural: "deployments" },
	statefulsets: { api: "/apis/apps/v1", plural: "statefulsets" },
	replicasets: { api: "/apis/apps/v1", plural: "replicasets" },
	events: { api: "/api/v1", plural: "events" },
	quotas: { api: "/api/v1", plural: "resourcequotas" },
	podMetrics: { api: "/apis/metrics.k8s.io/v1beta1", plural: "pods" },
	nodes: { api: "/api/v1", plural: "nodes", cluster: true },
	nodeMetrics: {
		api: "/apis/metrics.k8s.io/v1beta1",
		plural: "nodes",
		cluster: true,
	},
	imageCaches: {
		api: "/apis/eci.alibabacloud.com/v1",
		plural: "imagecaches",
		cluster: true,
	},
};

export function createOperationsKubernetesReaderV2(options: {
	namespace: string;
	readCluster: boolean;
	cacheOwner: string;
	kubeConfig?: KubeConfig;
}) {
	if (
		!/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/.test(options.namespace) ||
		!/^[a-zA-Z0-9]([-a-zA-Z0-9_.]{0,61}[a-zA-Z0-9])?$/.test(options.cacheOwner)
	)
		throw new Error("Invalid operations scope");
	const config = options.kubeConfig ?? new KubeConfig();
	if (!options.kubeConfig) config.loadFromCluster();
	const cluster = config.getCurrentCluster();
	if (!cluster)
		throw new Error("Operations Kubernetes configuration unavailable");
	const base = new URL(cluster.server);
	if (
		!["https:", "http:"].includes(base.protocol) ||
		base.username ||
		base.password ||
		base.search ||
		base.hash ||
		(!options.kubeConfig && base.protocol !== "https:")
	)
		throw new Error("Operations Kubernetes configuration unavailable");
	return async (
		kind: OperationsReadKindV2,
		signal: AbortSignal,
	): Promise<{ items: unknown[]; truncated: boolean }> => {
		const resource = resources[kind];
		if (!resource || (resource.cluster && !options.readCluster))
			throw new Error("Operations scope unavailable");
		try {
			const boundedSignal = AbortSignal.any([
				signal,
				AbortSignal.timeout(10000),
			]);
			boundedSignal.throwIfAborted();
			const url = new URL(base);
			url.pathname = `${base.pathname.replace(/\/$/, "")}${resource.api}${resource.cluster ? "" : `/namespaces/${options.namespace}`}/${resource.plural}`;
			url.searchParams.set("limit", "2000");
			if (kind === "imageCaches")
				url.searchParams.set(
					"labelSelector",
					`agent-infra.agora.io/cache-owner=${options.cacheOwner}`,
				);
			const requestOptions: RequestOptions = {
				method: "GET",
				headers: { Accept: "application/json" },
				signal: boundedSignal,
			};
			await config.applyToHTTPSOptions(requestOptions);
			boundedSignal.throwIfAborted();
			const bytes = await new Promise<Buffer>((resolve, reject) => {
				const request = (
					url.protocol === "https:" ? httpsRequest : httpRequest
				)(url, requestOptions, (response) => {
					if (response.statusCode !== 200) {
						response.destroy();
						reject(new Error("Kubernetes observation unavailable"));
						return;
					}
					const chunks: Buffer[] = [];
					let size = 0;
					response.on("data", (chunk: Buffer) => {
						size += chunk.byteLength;
						if (size > 8 * 1024 * 1024) {
							response.destroy(new Error("Kubernetes observation unavailable"));
							return;
						}
						chunks.push(chunk);
					});
					response.on("error", reject);
					response.on("end", () => resolve(Buffer.concat(chunks)));
				});
				request.on("error", reject);
				request.end();
			});
			const value: unknown = JSON.parse(bytes.toString("utf8"));
			if (
				!value ||
				typeof value !== "object" ||
				!("items" in value) ||
				!Array.isArray(value.items) ||
				value.items.length > 2000
			)
				throw new Error();
			const metadata =
				"metadata" in value &&
				value.metadata &&
				typeof value.metadata === "object"
					? (value.metadata as Record<string, unknown>)
					: {};
			return { items: value.items, truncated: Boolean(metadata.continue) };
		} catch {
			throw new Error("Operations Kubernetes query unavailable");
		}
	};
}
