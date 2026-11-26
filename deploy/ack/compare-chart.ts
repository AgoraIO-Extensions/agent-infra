import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseAllDocuments } from "yaml";

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, item]) => [key, canonical(item)]),
		);
	return value;
}

function resources(manifest: string): Map<string, string> {
	const result = new Map<string, string>();
	for (const document of parseAllDocuments(manifest)) {
		if (document.errors.length) throw new Error("CHART_MANIFEST_INVALID");
		const resource = document.toJSON();
		if (resource === null) continue;
		if (!resource?.apiVersion || !resource.kind || !resource.metadata?.name)
			throw new Error("CHART_RESOURCE_INVALID");
		const key = [
			resource.apiVersion,
			resource.kind,
			resource.metadata.namespace ?? "",
			resource.metadata.name,
		].join("/");
		if (result.has(key)) throw new Error("CHART_RESOURCE_DUPLICATE");
		result.set(
			key,
			createHash("sha256")
				.update(JSON.stringify(canonical(resource)))
				.digest("hex"),
		);
	}
	return result;
}

/** Compare every field, including Secret data and Hooks; return identities only. */
export function compareChartManifestsV1(baseline: string, candidate: string) {
	const before = resources(baseline);
	const after = resources(candidate);
	const changed = [...new Set([...before.keys(), ...after.keys()])]
		.filter((key) => before.get(key) !== after.get(key))
		.sort();
	return {
		baselineResources: before.size,
		candidateResources: after.size,
		changed,
	};
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		const [baseline, candidate] = process.argv.slice(2);
		if (!baseline || !candidate) throw new Error();
		const result = compareChartManifestsV1(
			await readFile(baseline, "utf8"),
			await readFile(candidate, "utf8"),
		);
		console.log(JSON.stringify(result));
		if (result.changed.length) process.exitCode = 1;
	} catch {
		console.error("CHART_COMPARISON_INPUT_INVALID");
		process.exitCode = 1;
	}
}
