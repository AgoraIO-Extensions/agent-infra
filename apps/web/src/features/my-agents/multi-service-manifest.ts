import {
	type MultiServiceManifestDocumentV1,
	MultiServiceManifestDocumentV1Schema,
	type MultiServiceTopologyIssueCodeV1,
	validateMultiServiceTopologyV1,
} from "@agent-infra/contracts/pilot";
import { parse } from "yaml";

/** The source contract and the browser use the same byte bound. */
export const MULTI_SERVICE_MANIFEST_MAX_BYTES = 262_144;

export const MULTI_SERVICE_TOPOLOGY_MESSAGES: Readonly<
	Record<MultiServiceTopologyIssueCodeV1, string>
> = {
	MULTI_SERVICE_WORKLOAD_COUNT: "工作负载数量必须在 2 到 16 个之间。",
	MULTI_SERVICE_SERVICE_COUNT: "Service 数量必须与工作负载数量相同。",
	MULTI_SERVICE_SERVICE_NAME_DUPLICATE: "Service 名称不能重复。",
	MULTI_SERVICE_STATEFULSET_RESTART_POLICY:
		"StatefulSet 的 restartPolicy 只能省略或设置为 Always。",
	MULTI_SERVICE_STATEFULSET_SERVICE:
		"每个 StatefulSet 都必须有同名 Service，且 Service selector 必须匹配。",
	MULTI_SERVICE_STATEFULSET_PVC:
		"每个 StatefulSet 都必须有对应的 <name>-data PersistentVolumeClaim。",
	MULTI_SERVICE_PVC_COUNT:
		"PersistentVolumeClaim 数量必须与 StatefulSet 数量相同。",
	MULTI_SERVICE_PVC_NAME:
		"PersistentVolumeClaim 名称必须与 StatefulSet 的 <name>-data 对应。",
	MULTI_SERVICE_JOB_COUNT: "最多只能包含一个迁移 Job。",
	MULTI_SERVICE_RESOURCE_KIND:
		"只支持 Deployment、StatefulSet、Service、PersistentVolumeClaim、Job 和 ConfigMap。",
	MULTI_SERVICE_SERVICE_SELECTOR:
		"每个 Service selector 必须唯一匹配一个工作负载。",
	MULTI_SERVICE_SERVICE_TARGET_PORT:
		"Service 的 targetPort 必须存在于目标工作负载的容器端口中。",
	MULTI_SERVICE_SERVICE_TARGET_DUPLICATE:
		"每个工作负载只能由一个 Service 唯一匹配。",
};

export function multiServiceTopologyMessageV1(
	code: MultiServiceTopologyIssueCodeV1,
) {
	return MULTI_SERVICE_TOPOLOGY_MESSAGES[code];
}

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
	const topology = validateMultiServiceTopologyV1(result.data);
	if (!topology.ok)
		return {
			ok: false,
			message: multiServiceTopologyMessageV1(topology.code),
		};
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
