import assert from "node:assert/strict";
import test from "node:test";

import {
	checkWebUiRepository,
	checkWebUiSource,
} from "./support/web-ui-policy.mjs";

const path = "apps/web/src/features/example/screen.tsx";
const check = (source, file = path) => checkWebUiSource(source, { path: file });

test("production Web routes and features use shared controls", async () => {
	assert.deepEqual(await checkWebUiRepository(process.cwd()), []);
});

test("rejects direct common native controls in routes and features", () => {
	for (const file of [
		path,
		"apps/web/src/routes/example.tsx",
		"apps\\web\\src\\routes\\example.tsx",
	]) {
		for (const tag of [
			"button",
			"input",
			"textarea",
			"select",
			"option",
			"optgroup",
			"label",
			"summary",
		]) {
			assert.match(
				check(`const screen = <${tag} />;`, file)[0],
				new RegExp(`use components/ui instead of <${tag}>`),
			);
		}
	}
	assert.match(
		check('const screen = <div role={"button"} />;')[0],
		/control role/,
	);
});

test("rejects React createElement controls and native control roles", () => {
	for (const source of [
		'import React from "react"; const screen = React.createElement("button");',
		'import ReactAlias from "react"; const screen = ReactAlias.createElement("input");',
		'import * as React from "react"; const screen = React["createElement"]("textarea");',
		'import { createElement } from "react"; const screen = createElement("select");',
		'import { createElement as h } from "react"; const screen = h("label");',
		'import React from "react"; const h = React.createElement; const screen = h("button");',
		'import React from "react"; const h = React["createElement"]; const screen = h("input");',
		'import * as React from "react"; const { createElement: h } = React; const screen = h("input");',
		'import * as React from "react"; const { ["createElement"]: h } = React; const screen = h("select");',
		'import { createElement } from "react"; const h = createElement; const screen = h("textarea");',
	])
		assert.match(
			check(source)[0],
			/use components\/ui instead of React\.createElement/,
		);
	assert.match(
		check(
			'import * as React from "react"; const screen = React.createElement("div", { role: "button" });',
		)[0],
		/control role/,
	);
	assert.deepEqual(
		check(
			'import React from "react"; const metadata = React.createElement("input", { "data-native-control": "hidden-form-value", type: "hidden" });',
		),
		[],
	);
	for (const source of [
		'import React from "react"; React.createElement("input", { type: "hidden" });',
		'import React from "react"; React.createElement("input", { "data-native-control": "hidden-form-value", type: "text" });',
		'import React from "react"; React.createElement("input", { "data-native-control": "hidden-form-value", type: "hidden", ...props });',
	])
		assert.ok(check(source).length > 0, source);
	assert.deepEqual(
		check('const createElement = () => null; createElement("button");'),
		[],
	);
});

test("attributes React createElement calls to lexical import bindings", () => {
	for (const source of [
		'import { createElement } from "react"; function render(createElement) { return createElement("button"); }',
		'import React from "react"; function render() { const React = { createElement: () => null }; return React.createElement("button"); }',
		'import * as React from "react"; function render(React) { return React["createElement"]("button"); }',
		'import React from "react"; function render(React) { const h = React.createElement; return h("button"); }',
		'import * as React from "react"; function render(React) { const { createElement: h } = React; return h("button"); }',
		'import React from "react"; const h1 = React.createElement; const h2 = h1; const screen = h2("button");',
	])
		assert.deepEqual(check(source), [], source);
});

test("accepts shared controls and ordinary semantic layout and navigation", () => {
	assert.deepEqual(
		check(
			'const screen = <main><form><fieldset><legend>Source</legend><Label htmlFor="source">Source</Label><NativeSelect id="source"><NativeSelectOption>Standard</NativeSelectOption></NativeSelect><Input /><Textarea /><Checkbox /><Button type="submit">Save</Button><p role="alert">Error</p><a href="/agents">Agents</a><dl><dt>Status</dt><dd>Ready</dd></dl></fieldset></form></main>;',
		),
		[],
	);
	assert.deepEqual(
		check('const prose = "<button>not JSX</button>"; /* <input /> */'),
		[],
	);
});

test("accepts UI internals and test fixtures without excluding nearby business files", () => {
	for (const file of [
		"apps/web/src/components/ui/input.tsx",
		"apps/web/src/features/example/screen.test.tsx",
		"apps/web/src/features/my-agents/test-router.tsx",
		"tests/fixtures/example.tsx",
	]) {
		assert.deepEqual(check("const fixture = <button />;", file), []);
	}
	assert.equal(
		check(
			"const screen = <button />;",
			"apps/web/src/features/my-agents/test-controls.tsx",
		).length,
		1,
	);
	assert.match(
		check('import { fixture } from "./test-router.js";')[0],
		/must not import test fixtures/,
	);
});

test("hidden-form-value is the only named native exception and cannot become visible", () => {
	assert.deepEqual(
		check(
			'const metadata = <input data-native-control="hidden-form-value" type="hidden" name="revision" value="1" />;',
		),
		[],
	);
	for (const source of [
		'<input type="hidden" />',
		'<input data-native-control="hidden-form-value" type="text" />',
		'<input data-native-control="hidden-form-value" type={kind} />',
		'<input data-native-control="hidden-form-value" type="hidden" {...props} />',
		'<input data-native-control="hidden-form-value" type="hidden" type="text" />',
		'<button data-native-control="hidden-form-value" />',
		'<button data-native-control="approved" />',
	])
		assert.ok(check(`const screen = ${source};`).length > 0, source);
});
