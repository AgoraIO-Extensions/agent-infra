import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import ts from "typescript";

const roots = ["apps/web/src/routes/", "apps/web/src/features/"];
const controls = new Set([
	"button",
	"input",
	"textarea",
	"select",
	"option",
	"optgroup",
	"label",
	"summary",
]);
const controlRoles = new Set([
	"button",
	"checkbox",
	"combobox",
	"listbox",
	"radio",
	"slider",
	"spinbutton",
	"switch",
	"textbox",
]);
// These existing helpers render test routers only. Production imports are checked below.
const fixtures = new Set([
	"apps/web/src/features/agent-discovery/test-router.tsx",
	"apps/web/src/features/my-agents/test-router.tsx",
	"apps/web/src/features/my-agents/test-fixtures.ts",
]);
const isTest = (path) =>
	/\.(test|spec)\.[cm]?[jt]sx?$/.test(path) || fixtures.has(path);

export function checkWebUiSource(source, { path }) {
	const normalized = path.replaceAll("\\", "/");
	if (!roots.some((root) => normalized.startsWith(root)) || isTest(normalized))
		return [];
	const file = ts.createSourceFile(
		normalized,
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TSX,
	);
	const violations = [];
	const report = (node, message) => {
		const { line, character } = file.getLineAndCharacterOfPosition(
			node.getStart(file),
		);
		violations.push(`${normalized}:${line + 1}:${character + 1} ${message}`);
	};
	function visit(node) {
		if (
			ts.isImportDeclaration(node) &&
			ts.isStringLiteral(node.moduleSpecifier)
		) {
			const specifier = node.moduleSpecifier.text;
			if (
				/(?:^|\/)(?:test-router|test-fixtures)(?:\.|$)|\.(?:test|spec)(?:\.|$)/.test(
					specifier,
				)
			) {
				report(node, "production UI must not import test fixtures");
			}
		}
		if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
			const tag = node.tagName.getText(file);
			const attributes = node.attributes.properties;
			const literal = (name) => {
				const matches = attributes.filter(
					(item) => ts.isJsxAttribute(item) && item.name.getText(file) === name,
				);
				const value = matches.length === 1 ? matches[0].initializer : undefined;
				if (value && ts.isStringLiteral(value)) return value.text;
				if (
					value &&
					ts.isJsxExpression(value) &&
					value.expression &&
					ts.isStringLiteral(value.expression)
				)
					return value.expression.text;
				return undefined;
			};
			const exception = literal("data-native-control");
			// hidden-form-value: native form metadata has no visible control or focus target.
			// No spread may override type="hidden" and turn this into a visible input.
			const hiddenFormValue =
				exception === "hidden-form-value" &&
				tag === "input" &&
				literal("type") === "hidden" &&
				!attributes.some(ts.isJsxSpreadAttribute);
			if (exception !== undefined && !hiddenFormValue)
				report(node, "invalid native control exception");
			if (controls.has(tag) && !hiddenFormValue)
				report(node, `use components/ui instead of <${tag}>`);
			if (/^[a-z]/.test(tag) && controlRoles.has(literal("role")))
				report(
					node,
					"use components/ui instead of a native element with a control role",
				);
		}
		ts.forEachChild(node, visit);
	}
	visit(file);
	return violations;
}

export async function checkWebUiRepository(root) {
	const violations = [];
	async function walk(directory) {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = resolve(directory, entry.name);
			if (entry.isDirectory()) await walk(path);
			else if (/\.[cm]?[jt]sx?$/.test(entry.name))
				violations.push(
					...checkWebUiSource(await readFile(path, "utf8"), {
						path: relative(root, path),
					}),
				);
		}
	}
	for (const directory of roots) await walk(resolve(root, directory));
	return violations.sort();
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	const violations = await checkWebUiRepository(process.cwd());
	if (violations.length) {
		console.error(violations.join("\n"));
		process.exitCode = 1;
	} else console.info("Web UI component policy passed");
}
