import { describe, expect, it } from "vitest";

import { validateActionArguments } from "./action-schema.js";

describe("Connection Action Schema validation", () => {
	it("checks required properties and rejects unknown input", () => {
		const schema = {
			type: "object",
			properties: { owner: { type: "string", minLength: 1 } },
			required: ["owner"],
			additionalProperties: false,
		};
		expect(validateActionArguments(schema, { owner: "agora" })).toBe(true);
		expect(validateActionArguments(schema, {})).toBe(false);
		expect(validateActionArguments(schema, { owner: "agora", repo: "x" })).toBe(
			false,
		);
	});

	it("validates nested arrays and scalar constraints", () => {
		const schema = {
			type: "object",
			properties: {
				issues: {
					type: "array",
					items: { type: "integer", minimum: 1 },
					minItems: 1,
					uniqueItems: true,
				},
			},
			additionalProperties: false,
		};
		expect(validateActionArguments(schema, { issues: [1, 2] })).toBe(true);
		expect(validateActionArguments(schema, { issues: [0] })).toBe(false);
		expect(validateActionArguments(schema, { issues: [1, 1] })).toBe(false);
	});

	it("fails closed for unresolved references and invalid regexes", () => {
		expect(validateActionArguments({ $ref: "#/defs/input" }, {})).toBe(false);
		expect(validateActionArguments({ type: "string", pattern: "[" }, "x")).toBe(
			false,
		);
	});
});
