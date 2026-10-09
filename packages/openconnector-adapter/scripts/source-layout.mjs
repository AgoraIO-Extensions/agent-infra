import { readFileSync } from "node:fs";

export const sourceLayout = JSON.parse(
	readFileSync(
		new URL("../provider-source-layout.json", import.meta.url),
		"utf8",
	),
);

export function implementationUrl(logicalPath) {
	const entry = sourceLayout.files.find(
		(file) => file.logicalPath === logicalPath,
	);
	if (
		!entry &&
		/^src\/[a-z0-9-]+\.ts$/.test(logicalPath) &&
		sourceLayout.sharedDependencies?.some(
			(file) => file.logicalPath === logicalPath,
		)
	)
		return new URL("../" + logicalPath, import.meta.url);
	if (
		!entry ||
		!/^src\/providers\/[a-z0-9-]+\/versions\/[a-z0-9-]+\.ts$/.test(
			entry.implementationPath,
		)
	)
		throw new Error("Unknown or invalid pinned provider source location");
	return new URL("../" + entry.implementationPath, import.meta.url);
}
