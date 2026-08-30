import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import ts from "typescript";

const sourceExtension = /\.[cm]?[jt]sx?$/;
const testFile = /(?:^|\/)test(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/;
const forbiddenContractImports = [
	/^react(?:-|\/|$)/,
	/^(?:@hono\/|hono(?:-|\/|$))/,
	/^drizzle(?:-|\/|$)/,
	/^postgres$/,
	/^@kubernetes(?:\/|$)/,
	/^@agent-infra\//,
];
const rawDatabaseImports = [/^drizzle(?:-|\/|$)/, /^postgres$/];
const dedicatedStorePaths = new Set([
	"packages/platform-store",
	"packages/connection-store",
]);
const runtimeDependencySections = [
	"dependencies",
	"optionalDependencies",
	"peerDependencies",
];

function importSpecifiers(source) {
	const sourceFile = ts.createSourceFile(
		"policy-input.ts",
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	const specifiers = [];
	function visit(node) {
		if (
			(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
			node.moduleSpecifier &&
			ts.isStringLiteral(node.moduleSpecifier)
		) {
			specifiers.push(node.moduleSpecifier.text);
		}
		if (
			ts.isCallExpression(node) &&
			node.arguments.length === 1 &&
			ts.isStringLiteral(node.arguments[0]) &&
			(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
				(ts.isIdentifier(node.expression) &&
					node.expression.text === "require"))
		) {
			specifiers.push(node.arguments[0].text);
		}
		ts.forEachChild(node, visit);
	}
	visit(sourceFile);
	return specifiers;
}

export function checkSourceImports(source, { path }) {
	const normalizedPath = path.replaceAll("\\", "/");
	const violations = [];
	for (const specifier of importSpecifiers(source)) {
		if (normalizedPath.startsWith("packages/contracts/src/")) {
			if (
				forbiddenContractImports.some((pattern) => pattern.test(specifier)) ||
				specifier.startsWith("../..")
			) {
				violations.push(
					`contracts source must not import ${specifier}: ${path}`,
				);
			}
		}
		const packagePath = normalizedPath.split("/src/")[0];
		if (
			!testFile.test(normalizedPath) &&
			!dedicatedStorePaths.has(packagePath) &&
			rawDatabaseImports.some((pattern) => pattern.test(specifier))
		) {
			violations.push(
				`only dedicated Store packages may import ${specifier}: ${path}`,
			);
		}
		if (
			!testFile.test(normalizedPath) &&
			!normalizedPath.startsWith("packages/test-support/") &&
			(specifier === "@agent-infra/test-support" ||
				specifier.startsWith("@agent-infra/test-support/"))
		) {
			violations.push(
				`production source must not import ${specifier}: ${path}`,
			);
		}
	}
	return violations;
}

export function checkManifestDependencies(manifest) {
	const violations = [];
	for (const section of runtimeDependencySections) {
		for (const dependency of Object.keys(manifest[section] ?? {})) {
			if (
				forbiddenContractImports.some((pattern) => pattern.test(dependency))
			) {
				violations.push(
					`contracts package must not depend on ${dependency} via ${section}`,
				);
			}
		}
	}
	return violations;
}

export function checkProductionManifestDependencies(manifest, { path }) {
	const violations = [];
	for (const section of runtimeDependencySections) {
		if (Object.hasOwn(manifest[section] ?? {}, "@agent-infra/test-support")) {
			violations.push(
				`production package must not depend on @agent-infra/test-support via ${section}: ${path}`,
			);
		}
		if (!dedicatedStorePaths.has(path)) {
			for (const dependency of Object.keys(manifest[section] ?? {})) {
				if (rawDatabaseImports.some((pattern) => pattern.test(dependency))) {
					violations.push(
						`only dedicated Store packages may depend on ${dependency} via ${section}: ${path}`,
					);
				}
			}
		}
	}
	return violations;
}

export function isProductionPackagePath(path) {
	const normalizedPath = path.replaceAll("\\", "/");
	return (
		normalizedPath !== "packages/contracts" &&
		normalizedPath !== "packages/test-support"
	);
}

async function sourceFiles(directory) {
	const entries = await readdir(directory, { withFileTypes: true }).catch(
		() => [],
	);
	const files = [];
	for (const entry of entries) {
		const path = resolve(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
		else if (entry.isFile() && sourceExtension.test(entry.name))
			files.push(path);
	}
	return files;
}

async function packageDirectories(directory) {
	const entries = await readdir(directory, { withFileTypes: true }).catch(
		() => [],
	);
	return entries
		.filter((entry) => entry.isDirectory())
		.map((entry) => resolve(directory, entry.name));
}

export async function checkRepositoryArchitecture(repositoryRoot) {
	const violations = [];
	const contractsManifest = JSON.parse(
		await readFile(
			resolve(repositoryRoot, "packages/contracts/package.json"),
			"utf8",
		),
	);
	violations.push(...checkManifestDependencies(contractsManifest));

	const roots = [
		...(await packageDirectories(resolve(repositoryRoot, "apps"))),
		...(await packageDirectories(resolve(repositoryRoot, "packages"))),
	];
	for (const root of roots) {
		for (const file of await sourceFiles(resolve(root, "src"))) {
			const path = relative(repositoryRoot, file);
			violations.push(
				...checkSourceImports(await readFile(file, "utf8"), { path }),
			);
		}
		const packagePath = relative(repositoryRoot, root).replaceAll("\\", "/");
		if (isProductionPackagePath(packagePath)) {
			const manifest = JSON.parse(
				await readFile(resolve(root, "package.json"), "utf8"),
			);
			violations.push(
				...checkProductionManifestDependencies(manifest, {
					path: packagePath,
				}),
			);
		}
	}
	return violations.sort();
}
