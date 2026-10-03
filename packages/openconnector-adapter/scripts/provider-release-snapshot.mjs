import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { connectionProviderCatalogs } from "../src/provider-catalogs.ts";

function canonical(value) {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, canonical(value[key])]),
		);
	if (
		value === null ||
		["string", "boolean"].includes(typeof value) ||
		(typeof value === "number" && Number.isFinite(value))
	)
		return value;
	throw new Error("Provider snapshot must contain JSON data only");
}
export const digest = (value) =>
	`sha256:${createHash("sha256")
		.update(JSON.stringify(canonical(value)))
		.digest("hex")}`;
export function releaseSnapshot(catalogs = connectionProviderCatalogs) {
	return {
		version: 1,
		providers: catalogs
			.map((catalog) => ({
				provider: catalog.provider,
				providerReleaseId: catalog.providerReleaseId,
				executorDigest: catalog.executorDigest,
				sourceCommit: catalog.sourceCommit,
				credentialUpgradeBehavior: catalog.credentialUpgradeBehavior,
				authDigest: digest(catalog.authProfile),
				deploymentDigest: digest(catalog.deploymentProfile),
				actions: catalog.actions
					.map((action) => ({
						id: action.id,
						name: action.name,
						authorizationDigest: digest({
							name: action.name,
							effect: action.effect,
							inputSchema: action.inputSchema,
							requiredScopes: [...action.requiredScopes].sort(),
							description: action.description,
						}),
					}))
					.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
				compatibility:
					"authorizationCompatibility" in catalog
						? catalog.authorizationCompatibility
						: [],
			}))
			.sort((a, b) =>
				a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0,
			),
	};
}
export function verifyReleaseSnapshot() {
	const checked = JSON.parse(
		readFileSync(
			new URL("../provider-release-snapshot.json", import.meta.url),
			"utf8",
		),
	);
	if (
		JSON.stringify(canonical(checked)) !==
		JSON.stringify(canonical(releaseSnapshot()))
	)
		throw new Error(
			"Provider release snapshot is stale; regenerate it from the actual runtime catalogs",
		);
}
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	if (process.argv.includes("--write"))
		writeFileSync(
			fileURLToPath(
				new URL("../provider-release-snapshot.json", import.meta.url),
			),
			JSON.stringify(releaseSnapshot(), null, "\t") + "\n",
		);
	else {
		verifyReleaseSnapshot();
		console.log("Runtime Provider release snapshot verified");
	}
}
