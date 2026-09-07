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
	const reactNamespaces = new Set();
	const reactCreateElement = new Set();
	for (const statement of file.statements) {
		if (
			!ts.isImportDeclaration(statement) ||
			!ts.isStringLiteral(statement.moduleSpecifier) ||
			statement.moduleSpecifier.text !== "react" ||
			!statement.importClause
		)
			continue;
		const { importClause } = statement;
		if (importClause.name) reactNamespaces.add(importClause.name.text);
		if (importClause.namedBindings) {
			if (ts.isNamespaceImport(importClause.namedBindings)) {
				reactNamespaces.add(importClause.namedBindings.name.text);
			} else {
				for (const item of importClause.namedBindings.elements) {
					if ((item.propertyName?.text ?? item.name.text) === "createElement")
						reactCreateElement.add(item.name.text);
				}
			}
		}
	}
	const report = (node, message) => {
		const { line, character } = file.getLineAndCharacterOfPosition(
			node.getStart(file),
		);
		violations.push(`${normalized}:${line + 1}:${character + 1} ${message}`);
	};
	const objectLiteralValue = (object, name) => {
		const matches = object.properties.filter(
			(item) =>
				ts.isPropertyAssignment(item) &&
				(ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) &&
				item.name.text === name,
		);
		const value = matches.length === 1 ? matches[0].initializer : undefined;
		return value && ts.isStringLiteral(value) ? value.text : undefined;
	};
	const isReactCreateElement = (expression) => {
		if (ts.isIdentifier(expression))
			return reactCreateElement.has(expression.text);
		if (
			ts.isPropertyAccessExpression(expression) &&
			expression.name.text === "createElement" &&
			ts.isIdentifier(expression.expression)
		)
			return reactNamespaces.has(expression.expression.text);
		return (
			ts.isElementAccessExpression(expression) &&
			ts.isIdentifier(expression.expression) &&
			ts.isStringLiteral(expression.argumentExpression) &&
			expression.argumentExpression.text === "createElement" &&
			reactNamespaces.has(expression.expression.text)
		);
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
		if (ts.isCallExpression(node) && isReactCreateElement(node.expression)) {
			const tag = node.arguments[0];
			const props = node.arguments[1];
			if (tag && ts.isStringLiteral(tag)) {
				const attributes =
					props && ts.isObjectLiteralExpression(props) ? props : undefined;
				const exception = attributes
					? objectLiteralValue(attributes, "data-native-control")
					: undefined;
				const hiddenFormValue =
					exception === "hidden-form-value" &&
					tag.text === "input" &&
					attributes &&
					objectLiteralValue(attributes, "type") === "hidden" &&
					!attributes.properties.some(ts.isSpreadAssignment);
				if (exception !== undefined && !hiddenFormValue)
					report(node, "invalid native control exception");
				if (controls.has(tag.text) && !hiddenFormValue)
					report(
						node,
						`use components/ui instead of React.createElement("${tag.text}")`,
					);
				if (
					/^[a-z]/.test(tag.text) &&
					attributes &&
					controlRoles.has(objectLiteralValue(attributes, "role"))
				)
					report(
						node,
						"use components/ui instead of a native element with a control role",
					);
			}
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
