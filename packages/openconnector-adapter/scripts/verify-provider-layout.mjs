import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { implementationUrl, sourceLayout } from "./source-layout.mjs";

assert.equal(sourceLayout.version, 1);
for (const file of sourceLayout.sharedDependencies ?? []) {
	assert.match(file.logicalPath, /^src\/[a-z0-9-]+\.ts$/);
	assert.equal(
		createHash("sha256")
			.update(readFileSync(implementationUrl(file.logicalPath)))
			.digest("hex"),
		file.sha256,
	);
}
assert.equal(
	new Set(sourceLayout.files.map((file) => file.logicalPath)).size,
	sourceLayout.files.length,
);
assert.equal(
	new Set(sourceLayout.files.map((file) => file.implementationPath)).size,
	sourceLayout.files.length,
);
for (const file of sourceLayout.files) {
	assert.match(file.logicalPath, /^src\/[a-z0-9-]+\.ts$/);
	assert.match(file.sha256, /^[a-f0-9]{64}$/);
	assert.equal(
		createHash("sha256")
			.update(readFileSync(implementationUrl(file.logicalPath)))
			.digest("hex"),
		file.sha256,
		"Published implementation bytes changed: " + file.logicalPath,
	);
	const facade = readFileSync(
		new URL("../" + file.logicalPath, import.meta.url),
		"utf8",
	)
		.replace(/^\/\/.*$/gm, "")
		.replace(/\s+/g, " ")
		.trim();
	assert.equal(
		facade,
		'export * from "./' + file.implementationPath.slice(4) + '";',
		"Legacy entry point must remain a transparent export: " + file.logicalPath,
	);
	const source = readFileSync(implementationUrl(file.logicalPath), "utf8");
	const implementations = new Set(
		sourceLayout.files.map((item) => implementationUrl(item.logicalPath).href),
	);
	for (const match of source.matchAll(/from "(\.\/[^"]+)"/g)) {
		const dependency = new URL(match[1], implementationUrl(file.logicalPath));
		if (implementations.has(dependency.href)) continue;
		const bridge = readFileSync(dependency, "utf8")
			.replace(/^\/\/.*$/gm, "")
			.replace(/\s+/g, " ")
			.trim();
		const target = bridge.match(
			/^export (?:\*|type \{ [A-Za-z0-9_, ]+ \}) from "([^"]+)";$/,
		);
		assert.ok(
			target,
			"Relative import bridge must remain a transparent export",
		);
		assert.equal(
			new URL(target[1], dependency).href,
			implementationUrl("src/" + match[1].slice(2)).href,
		);
	}
}
console.log("Provider layout and immutable source relocation verified");
