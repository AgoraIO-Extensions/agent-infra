import {
	type MultiServiceManifestDocumentV1,
	MultiServiceManifestDocumentV1Schema,
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
