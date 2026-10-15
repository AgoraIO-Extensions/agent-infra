import {
	type MultiServiceManifestDocumentV1,
	MultiServiceManifestDocumentV1Schema,
	MultiServiceMaxWorkloadsV1,
	type MultiServiceTopologyIssueCodeV1,
	multiServiceTopologyIssuesV1,
} from "@agent-infra/contracts/pilot";
import { parse } from "yaml";

/** The source contract and the browser use the same byte bound. */
export const MULTI_SERVICE_MANIFEST_MAX_BYTES = 262_144;

export type MultiServiceManifestSummary = {
	readonly entryServiceName: string;
	readonly resourceCount: number;
	readonly serviceNames: readonly string[];
	readonly resourceProfileRefs: readonly string[];
};

export type MultiServiceManifestParseResult =
	| {
			readonly ok: true;
			readonly document: MultiServiceManifestDocumentV1;
			readonly summary: MultiServiceManifestSummary;
	  }
	| { readonly ok: false; readonly message: string };

/**
 * 服务端准入的拓扑规则（与部署策略无关的那一部分）的中文提示。判定函数与服务端共用，所以
 * 这里「通过」的清单不会再被服务端以拓扑原因拒绝（#2531）；提示只描述清单自身，不涉及镜像准入。
 */
const topologyMessages = {
	workload_count: `工作负载（Deployment、StatefulSet）需要 2 到 ${MultiServiceMaxWorkloadsV1} 个。`,
	service_count: "Service 的数量必须与工作负载的数量相同，每个工作负载一个。",
	job_count: "最多只能有 1 个 Job。",
	stateful_service:
		"每个 StatefulSet 需要一个与其 serviceName 同名、selector 匹配其 Pod 标签的 Service。",
	stateful_restart_policy:
		"StatefulSet 的 restartPolicy 只能省略或设为 Always。",
	stateful_storage:
		"每个 StatefulSet 需要一个名为「<名称>-data」的 PersistentVolumeClaim，且不能有多余的 PVC。",
	service_selector:
		"每个 Service 的 selector 必须恰好匹配一个工作负载的 Pod 标签。",
	service_port: "Service 的 targetPort 必须出现在其目标工作负载的容器端口里。",
	service_target_shared: "每个工作负载只能对应一个 Service。",
} as const satisfies Record<MultiServiceTopologyIssueCodeV1, string>;

export function multiServiceTopologyMessage(
	issues: readonly MultiServiceTopologyIssueCodeV1[],
) {
	return `多服务 YAML 的服务拓扑不符合要求：${issues.map((code) => topologyMessages[code]).join("")}`;
}

function byteLength(value: string) {
	return new TextEncoder().encode(value).byteLength;
}

function profileReferenceForAnnotation(key: string) {
	const normalized = key.toLocaleLowerCase();
	return (
		normalized.includes("resource-profile") ||
		normalized.includes("resource_profile") ||
		normalized.includes("resourceprofile")
	);
}

function summarize(document: MultiServiceManifestDocumentV1) {
	const serviceNames = document.resources
		.filter((resource) => resource.kind === "Service")
		.map((resource) => resource.metadata.name);
	const profileRefs = new Set<string>();
	for (const resource of document.resources) {
		for (const metadataValues of [
			resource.metadata.annotations ?? {},
			resource.metadata.labels ?? {},
		]) {
			for (const [key, value] of Object.entries(metadataValues)) {
				if (profileReferenceForAnnotation(key)) profileRefs.add(value);
			}
		}
	}
	return {
		entryServiceName: document.entryServiceName,
		resourceCount: document.resources.length,
		serviceNames,
		resourceProfileRefs: [...profileRefs],
	} satisfies MultiServiceManifestSummary;
}

export function parseMultiServiceManifest(
	manifest: string,
): MultiServiceManifestParseResult {
	if (!manifest.trim())
		return { ok: false, message: "请上传或粘贴多服务 YAML。" };
	if (byteLength(manifest) > MULTI_SERVICE_MANIFEST_MAX_BYTES)
		return {
			ok: false,
			message: `多服务 YAML 不能超过 ${MULTI_SERVICE_MANIFEST_MAX_BYTES} bytes。`,
		};
	let parsed: unknown;
	try {
		parsed = parse(manifest);
	} catch {
		return { ok: false, message: "多服务 YAML 语法不正确，请检查缩进和字段。" };
	}
	const result = MultiServiceManifestDocumentV1Schema.safeParse(parsed);
	if (!result.success)
		return {
			ok: false,
			message:
				"多服务 YAML 不符合受限资源清单格式，请检查资源、入口服务和镜像 Digest。",
		};
	const topology = multiServiceTopologyIssuesV1(result.data);
	if (topology.length > 0)
		return { ok: false, message: multiServiceTopologyMessage(topology) };
	return { ok: true, document: result.data, summary: summarize(result.data) };
}

export function formatMultiServiceManifestSummary(
	summary: MultiServiceManifestSummary,
) {
	return [
		`${summary.serviceNames.length} 个 Service：${summary.serviceNames.join("、")}`,
		`入口服务：${summary.entryServiceName}`,
		`资源：${summary.resourceCount} 项`,
		...(summary.resourceProfileRefs.length
			? [`规格引用：${summary.resourceProfileRefs.join("、")}`]
			: []),
	].join("；");
}
