import { describe, expect, it } from "vitest";
import { parseRuntimeOAuthDynamicPublicationContractV1 } from "./runtime-oauth-dynamic-publication.js";

// #4333 §13.5.6: the deployment-approved dynamic publication contract, with the
// tool declarations a new Thread uses before any installation exists.
const contract = {
	serviceRef: "connection-mcp",
	contract: {
		ref: "connection-mcp-publication",
		revision: "1",
		serverInfo: { name: "connection", version: "1" },
		tools: [{ name: "search", succeededResultSchema: { type: "object" } }],
	},
	toolDeclarations: [
		{
			name: "search",
			description: "Search the connected account",
			inputSchema: { type: "object" },
		},
	],
};

describe("dynamic publication contract deployment input", () => {
	it("is absent without the input and parses an approved contract", () => {
		expect(parseRuntimeOAuthDynamicPublicationContractV1(undefined)).toBe(
			undefined,
		);
		expect(parseRuntimeOAuthDynamicPublicationContractV1("")).toBe(undefined);
		expect(
			parseRuntimeOAuthDynamicPublicationContractV1(JSON.stringify(contract)),
		).toEqual(contract);
	});

	it.each([
		["unreadable JSON", "{"],
		["an unknown field", JSON.stringify({ ...contract, extra: true })],
		[
			"no tool declarations",
			JSON.stringify({ ...contract, toolDeclarations: undefined }),
		],
		[
			"a declaration for another tool",
			JSON.stringify({
				...contract,
				toolDeclarations: [{ ...contract.toolDeclarations[0], name: "other" }],
			}),
		],
		[
			"a declaration without an input schema",
			JSON.stringify({
				...contract,
				toolDeclarations: [{ name: "search", description: "x" }],
			}),
		],
		[
			"duplicate tools",
			JSON.stringify({
				...contract,
				contract: {
					...contract.contract,
					tools: [contract.contract.tools[0], contract.contract.tools[0]],
				},
				toolDeclarations: [
					contract.toolDeclarations[0],
					contract.toolDeclarations[0],
				],
			}),
		],
		[
			"an invalid service reference",
			JSON.stringify({ ...contract, serviceRef: " connection" }),
		],
		[
			"an oversized input",
			JSON.stringify({ ...contract, pad: "x".repeat(70_000) }),
		],
	])("refuses %s", (_name, raw) => {
		expect(() => parseRuntimeOAuthDynamicPublicationContractV1(raw)).toThrow();
	});
});
