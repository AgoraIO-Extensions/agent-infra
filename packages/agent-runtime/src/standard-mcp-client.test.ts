import { afterEach, expect, it } from "vitest";
import {
	closeStandardMcpFixtures,
	reference,
	standardMcpFixture,
	terminalSchema,
	token,
} from "./standard-mcp.fixture.js";
import {
	StandardMcpClient,
	validateStandardMcpInput,
	validateStandardMcpInstallationMetadata,
} from "./standard-mcp-client.js";

const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of closes.splice(0)) await close();
	await closeStandardMcpFixtures();
});

it("validates installation without a scope and freezes the later authenticated scope", async () => {
	const fixture = await standardMcpFixture();
	const { token: _token, scope: immutableScope, ...fields } = fixture.input;
	const scope = { ...immutableScope };
	const metadata = { ...fields, agentId: reference.agentId };
	expect(
		validateStandardMcpInstallationMetadata(metadata, fixture.target),
	).toEqual(metadata);
	for (const forbidden of [{ token }, { scope }, { unexpected: true }])
		expect(() =>
			validateStandardMcpInstallationMetadata(
				{ ...metadata, ...forbidden },
				fixture.target,
			),
		).toThrow();
	const original = validateStandardMcpInput(
		{ ...fixture.input, scope },
		reference,
		fixture.target,
	);
	scope.executionId = "mutated-after-validation";
	expect(original.scope.executionId).toBe(reference.executionId);
	const opaque = { ...reference, agentId: "agent/原值" };
	expect(
		validateStandardMcpInput(
			{ ...fixture.input, scope: opaque },
			opaque,
			fixture.target,
		).scope.agentId,
	).toBe(opaque.agentId);
});

it("uses actual standard initialize/discovery/call once without exporting credentials", async () => {
	const fixture = await standardMcpFixture();
	const client = await StandardMcpClient.open(
		{
			target: fixture.target,
			resolveInput: async () => fixture.input,
			fetch: fixture.fetch,
		},
		reference,
		new AbortController().signal,
	);
	closes.push(() => client.close());
	const alias = client.toolDefinitions[0]?.tools[0]?.name;
	if (!alias) throw new Error("No fixture tool");
	const ordering: string[] = [];
	const result = await client.call(
		alias,
		{ text: "bounded fixture text" },
		{
			block: () => {},
			confirm: async () => {},
			assertCurrent: async () => {
				ordering.push("authorize");
				return () => {};
			},
			prepare: async () => {},
			started: async (actual) => {
				ordering.push("started");
				expect(actual.requestDigest).toMatch(/^[a-f0-9]{64}$/);
			},
		},
		new AbortController().signal,
	);
	expect(result).toMatchObject({ phase: "completed", success: true });
	expect(fixture.trace.map((item) => item.method)).toContain("initialize");
	expect(
		fixture.trace.filter((item) => item.method === "tools/call"),
	).toHaveLength(1);
	expect(ordering.indexOf("authorize")).toBeLessThan(
		ordering.indexOf("started"),
	);
	expect(JSON.stringify([client.toolDefinitions, result])).not.toContain(token);
});

it.each(["persisted", "failed", "revoked"] as const)(
	"waits for RPC identity persistence and rechecks authority when it is %s",
	async (outcome) => {
		const fixture = await standardMcpFixture();
		let persisted = false;
		let authorized = true;
		let starts = 0;
		const sends: boolean[] = [];
		const client = await StandardMcpClient.open(
			{
				target: fixture.target,
				resolveInput: async () => fixture.input,
				fetch: (url, init) => {
					if (
						typeof init?.body === "string" &&
						JSON.parse(init.body).method === "tools/call"
					)
						sends.push(persisted);
					return fixture.fetch(url, init);
				},
			},
			reference,
			new AbortController().signal,
		);
		closes.push(() => client.close());
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const pending = client.call(
			client.toolDefinitions[0]?.tools[0]?.name ?? "",
			{ text: "fixture" },
			{
				block: () => {},
				confirm: async () => {},
				assertCurrent: async () => () => {
					if (!authorized) throw new Error("Controlled revocation");
				},
				prepare: async () => {
					entered.resolve();
					await release.promise;
					if (outcome === "failed")
						throw new Error("Controlled journal failure");
					persisted = true;
				},
				started: async () => {
					starts++;
					expect(sends).toEqual([true]);
				},
			},
			new AbortController().signal,
		);
		await entered.promise;
		const sendsBeforePersistence = sends.length;
		if (outcome === "revoked") authorized = false;
		release.resolve();
		const result = await pending;
		expect(sendsBeforePersistence).toBe(0);
		expect(sends).toEqual(outcome === "persisted" ? [true] : []);
		expect(starts).toBe(outcome === "persisted" ? 1 : 0);
		expect(result.phase).toBe(
			outcome === "persisted" ? "completed" : "unknown",
		);
	},
);

it.each(["unknown", "lost", "leak", "key-leak"] as const)(
	"keeps %s results unknown and does not resend",
	async (behavior) => {
		const fixture = await standardMcpFixture();
		const client = await StandardMcpClient.open(
			{
				target: fixture.target,
				resolveInput: async () => fixture.input,
				fetch: fixture.fetch,
			},
			reference,
			new AbortController().signal,
		);
		closes.push(() => client.close());
		fixture.setBehavior(behavior);
		const result = await client.call(
			client.toolDefinitions[0]?.tools[0]?.name ?? "",
			{ text: "fixture" },
			{
				block: () => {},
				confirm: async () => {},
				assertCurrent: async () => () => {},
				prepare: async () => {},
				started: async () => {},
			},
			new AbortController().signal,
		);
		expect(result).toEqual({
			phase: "unknown",
			contentItems: [],
			success: false,
		});
		expect(
			fixture.trace.filter((item) => item.method === "tools/call"),
		).toHaveLength(1);
	},
);

it("rejects discovery with credential-bearing JSON keys", async () => {
	const fixture = await standardMcpFixture();
	fixture.setBehavior("tool-key");
	await expect(
		StandardMcpClient.open(
			{
				target: fixture.target,
				resolveInput: async () => fixture.input,
				fetch: fixture.fetch,
			},
			reference,
			new AbortController().signal,
		),
	).rejects.toMatchObject({ code: "CONNECTION_STANDARD_CLIENT_UNAVAILABLE" });
});

it("rechecks original authorization after the final awaited installation read", async () => {
	const fixture = await standardMcpFixture();
	let checks = 0;
	let revoked = false;
	const client = await StandardMcpClient.open(
		{
			target: fixture.target,
			resolveInput: async () => {
				if (checks >= 2) revoked = true;
				return fixture.input;
			},
			fetch: fixture.fetch,
		},
		reference,
		new AbortController().signal,
	);
	closes.push(() => client.close());
	const result = await client.call(
		client.toolDefinitions[0]?.tools[0]?.name ?? "",
		{ text: "fixture" },
		{
			block: () => {},
			confirm: async () => {},
			prepare: async () => {},
			started: async () => {},
			assertCurrent: async () => {
				checks++;
				return () => {
					if (revoked) throw new Error("Revoked fixture");
				};
			},
		},
		new AbortController().signal,
	);
	expect(result.phase).toBe("failed");
	expect(
		fixture.trace.filter((entry) => entry.method === "tools/call"),
	).toHaveLength(0);
});

it.each(["completed", "unknown"] as const)(
	"holds queued tools through %s persistence/ACK",
	async (outcome) => {
		const fixture = await standardMcpFixture();
		const client = await StandardMcpClient.open(
			{
				target: fixture.target,
				resolveInput: async () => fixture.input,
				fetch: fixture.fetch,
			},
			reference,
			new AbortController().signal,
		);
		closes.push(() => client.close());
		fixture.setBehavior(outcome);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let blocked = false;
		const alias = client.toolDefinitions[0]?.tools[0]?.name ?? "";
		const first = client.call(
			alias,
			{ text: "first" },
			{
				assertCurrent: async () => () => {},
				prepare: async () => {},
				started: async () => {},
				block: () => {
					blocked = true;
				},
				confirm: async () => {
					entered.resolve();
					await release.promise;
				},
			},
			new AbortController().signal,
		);
		await entered.promise;
		expect(blocked).toBe(outcome === "unknown");
		const second = client.call(
			alias,
			{ text: "second" },
			{
				assertCurrent: async () => () => {},
				prepare: async () => {},
				started: async () => {},
				block: () => {},
				confirm: async () => {},
			},
			new AbortController().signal,
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(
			fixture.trace.filter((entry) => entry.method === "tools/call"),
		).toHaveLength(1);
		release.resolve();
		await first;
		await second;
		expect(
			fixture.trace.filter((entry) => entry.method === "tools/call"),
		).toHaveLength(outcome === "unknown" ? 1 : 2);
	},
);

it("denies installation drift and native argument overrides before sending tools", async () => {
	const fixture = await standardMcpFixture();
	let current = fixture.input;
	const client = await StandardMcpClient.open(
		{
			target: fixture.target,
			resolveInput: async () => current,
			fetch: fixture.fetch,
		},
		reference,
		new AbortController().signal,
	);
	closes.push(() => client.close());
	const alias = client.toolDefinitions[0]?.tools[0]?.name ?? "";
	expect(
		client.validateArguments(alias, { text: "fixture", principal: "user-b" }),
	).toBe(false);
	current = { ...current, credentialRevision: "r2" };
	const result = await client.call(
		alias,
		{ text: "fixture" },
		{
			block: () => {},
			confirm: async () => {},
			assertCurrent: async () => () => {},
			prepare: async () => {},
			started: async () => {},
		},
		new AbortController().signal,
	);
	expect(result.phase).toBe("failed");
	expect(
		fixture.trace.filter((item) => item.method === "tools/call"),
	).toHaveLength(0);
});

it("rejects redirects without copying the token to another target", async () => {
	const fixture = await standardMcpFixture();
	fixture.setBehavior("redirect");
	await expect(
		StandardMcpClient.open(
			{
				target: fixture.target,
				resolveInput: async () => fixture.input,
				fetch: fixture.fetch,
			},
			reference,
			new AbortController().signal,
		),
	).rejects.toMatchObject({ code: "CONNECTION_STANDARD_CLIENT_UNAVAILABLE" });
});

it.each([
	"agentId",
	"conversationId",
	"executionId",
	"sessionGeneration",
] as const)("rejects mismatched original %s", async (field) => {
	const fixture = await standardMcpFixture();
	const scope = {
		...fixture.input.scope,
		[field]: field === "sessionGeneration" ? 2 : "different",
	};
	expect(() =>
		validateStandardMcpInput(
			{ ...fixture.input, scope },
			reference,
			fixture.target,
		),
	).toThrow("unavailable");
	expect(fixture.trace).toHaveLength(0);
});

const schema2020 = "https://json-schema.org/draft/2020-12/schema";
const schemaDraft7 = "http://json-schema.org/draft-07/schema#";
const operation = () => ({
	assertCurrent: async () => () => {},
	prepare: async () => {},
	started: async () => {},
	confirm: async () => {},
	block: () => {},
});

it.each([undefined, schema2020, schemaDraft7])(
	"uses the actual SDK with supported schema dialect %s",
	async (dialect) => {
		const schema = {
			...(dialect ? { $schema: dialect } : {}),
			type: "object",
			properties: { text: { type: "string" } },
			required: ["text"],
			additionalProperties: false,
		};
		const fixture = await standardMcpFixture(schema);
		const input = {
			...fixture.input,
			contract: {
				...fixture.input.contract,
				tools: [
					{
						name: "write_note",
						succeededResultSchema: {
							...terminalSchema,
							...(dialect ? { $schema: dialect } : {}),
						},
					},
				],
			},
		};
		const client = await StandardMcpClient.open(
			{
				target: fixture.target,
				resolveInput: async () => input,
				fetch: fixture.fetch,
			},
			reference,
			new AbortController().signal,
		);
		closes.push(() => client.close());
		const result = await client.call(
			client.toolDefinitions[0]?.tools[0]?.name ?? "",
			{ text: "fixture" },
			operation(),
			new AbortController().signal,
		);
		expect(result).toMatchObject({ phase: "completed", success: true });
		expect(
			fixture.trace.filter((event) => event.method === "tools/call"),
		).toHaveLength(1);
	},
);

it.each([undefined, schema2020])(
	"enforces unevaluatedProperties in discovered %s input before dispatch",
	async (dialect) => {
		const fixture = await standardMcpFixture({
			...(dialect ? { $schema: dialect } : {}),
			type: "object",
			allOf: [{ properties: { text: { type: "string" } }, required: ["text"] }],
			unevaluatedProperties: false,
		});
		const client = await StandardMcpClient.open(
			{
				target: fixture.target,
				resolveInput: async () => fixture.input,
				fetch: fixture.fetch,
			},
			reference,
			new AbortController().signal,
		);
		closes.push(() => client.close());
		const alias = client.toolDefinitions[0]?.tools[0]?.name ?? "";
		expect(client.validateArguments(alias, { text: "fixture" })).toBe(true);
		expect(
			client.validateArguments(alias, {
				text: "fixture",
				unexpected: "rejected",
			}),
		).toBe(false);
		const result = await client.call(
			alias,
			{ text: "fixture", unexpected: "rejected" },
			operation(),
			new AbortController().signal,
		);
		expect(result.phase).toBe("failed");
		expect(
			fixture.trace.filter((event) => event.method === "tools/call"),
		).toHaveLength(0);
	},
);

it.each([undefined, schema2020])(
	"keeps invalid prefixItems result under %s unknown and does not resend",
	async (dialect) => {
		const fixture = await standardMcpFixture();
		const resultSchema = {
			...terminalSchema,
			...(dialect ? { $schema: dialect } : {}),
			properties: {
				...terminalSchema.properties,
				content: {
					type: "array",
					prefixItems: [
						{
							type: "object",
							properties: { text: { const: "different-approved-result" } },
							required: ["text"],
						},
					],
				},
			},
			required: ["content", "structuredContent"],
		};
		const input = {
			...fixture.input,
			contract: {
				...fixture.input.contract,
				tools: [{ name: "write_note", succeededResultSchema: resultSchema }],
			},
		};
		const client = await StandardMcpClient.open(
			{
				target: fixture.target,
				resolveInput: async () => input,
				fetch: fixture.fetch,
			},
			reference,
			new AbortController().signal,
		);
		closes.push(() => client.close());
		let blocked = false;
		const result = await client.call(
			client.toolDefinitions[0]?.tools[0]?.name ?? "",
			{ text: "fixture" },
			{
				...operation(),
				block: () => {
					blocked = true;
				},
			},
			new AbortController().signal,
		);
		expect(result.phase).toBe("unknown");
		expect(blocked).toBe(true);
		expect(
			fixture.trace.filter((event) => event.method === "tools/call"),
		).toHaveLength(1);
	},
);

it("preserves explicitly declared draft-07 tuple validation", async () => {
	const fixture = await standardMcpFixture({
		$schema: schemaDraft7,
		type: "object",
		properties: {
			tuple: {
				type: "array",
				items: [{ type: "string" }, { type: "integer" }],
				additionalItems: false,
			},
		},
		required: ["tuple"],
		additionalProperties: false,
	});
	const client = await StandardMcpClient.open(
		{
			target: fixture.target,
			resolveInput: async () => fixture.input,
			fetch: fixture.fetch,
		},
		reference,
		new AbortController().signal,
	);
	closes.push(() => client.close());
	const alias = client.toolDefinitions[0]?.tools[0]?.name ?? "";
	expect(client.validateArguments(alias, { tuple: ["fixture", 1] })).toBe(true);
	expect(client.validateArguments(alias, { tuple: [1, "fixture"] })).toBe(
		false,
	);
	const result = await client.call(
		alias,
		{ tuple: ["fixture", 1] },
		operation(),
		new AbortController().signal,
	);
	expect(result.phase).toBe("completed");
});

it.each([
	[
		"unknown dialect",
		{ ...terminalSchema, $schema: "https://unsupported.example.test/schema" },
	],
	["async schema", { ...terminalSchema, $async: true }],
	["remote ref", { $ref: "https://unsupported.example.test/schema" }],
	["dynamic ref", { $dynamicRef: "#" }],
	["recursive ref", { $recursiveRef: "#" }],
	["oversized", { ...terminalSchema, description: "x".repeat(32_769) }],
	[
		"too deep",
		Array.from({ length: 13 }).reduce<Record<string, unknown>>(
			(schema) => ({ type: "object", properties: { nested: schema } }),
			{ type: "string" },
		),
	],
	[
		"too many nodes",
		{
			type: "object",
			properties: Object.fromEntries(
				Array.from({ length: 512 }, (_, index) => [
					`field${index}`,
					{ type: "string" },
				]),
			),
		},
	],
])(
	"rejects %s before initializing the MCP connection",
	async (_name, schema) => {
		const fixture = await standardMcpFixture();
		const input = {
			...fixture.input,
			contract: {
				...fixture.input.contract,
				tools: [{ name: "write_note", succeededResultSchema: schema }],
			},
		};
		await expect(
			StandardMcpClient.open(
				{
					target: fixture.target,
					resolveInput: async () => input,
					fetch: fixture.fetch,
				},
				reference,
				new AbortController().signal,
			),
		).rejects.toMatchObject({ code: "CONNECTION_STANDARD_CLIENT_UNAVAILABLE" });
		expect(fixture.trace).toHaveLength(0);
	},
);

it.each(["input", "result"] as const)(
	"rejects unsupported embedded dialect in %s schema without tool dispatch",
	async (where) => {
		const embedded = {
			$id: "urn:embedded-resource",
			$schema: "https://unsupported.example.test/schema",
			type: "string",
		};
		const inputSchema = { type: "object", properties: { payload: embedded } };
		const fixture = await standardMcpFixture(
			where === "input" ? inputSchema : undefined,
		);
		const input =
			where === "result"
				? {
						...fixture.input,
						contract: {
							...fixture.input.contract,
							tools: [
								{
									name: "write_note",
									succeededResultSchema: {
										...terminalSchema,
										properties: {
											...terminalSchema.properties,
											unknown: embedded,
										},
									},
								},
							],
						},
					}
				: fixture.input;
		const denied = await StandardMcpClient.open(
			{
				target: fixture.target,
				resolveInput: async () => input,
				fetch: fixture.fetch,
			},
			reference,
			new AbortController().signal,
		).then(
			(client) => {
				closes.push(() => client.close());
				return false;
			},
			(error) => {
				expect(error).toMatchObject({
					code: "CONNECTION_STANDARD_CLIENT_UNAVAILABLE",
				});
				return true;
			},
		);
		expect(denied).toBe(true);
		expect(
			fixture.trace.filter((event) => event.method === "tools/call"),
		).toHaveLength(0);
	},
);

it("rejects a different embedded resource dialect instead of reinterpreting its keywords", async () => {
	const fixture = await standardMcpFixture({
		type: "object",
		properties: {
			payload: {
				$id: "urn:legacy-resource",
				$schema: schemaDraft7,
				type: "object",
				properties: { text: { type: "string" } },
				unevaluatedProperties: false,
			},
		},
	});
	const denied = await StandardMcpClient.open(
		{
			target: fixture.target,
			resolveInput: async () => fixture.input,
			fetch: fixture.fetch,
		},
		reference,
		new AbortController().signal,
	).then(
		(client) => {
			closes.push(() => client.close());
			return false;
		},
		(error) => {
			expect(error).toMatchObject({
				code: "CONNECTION_STANDARD_CLIENT_UNAVAILABLE",
			});
			return true;
		},
	);
	expect(denied).toBe(true);
});

it("accepts same-dialect resources and literal directive-shaped data without changing its meaning", async () => {
	const literal = {
		$id: "urn:literal-data",
		$schema: "https://unsupported.example.test/schema",
	};
	const fixture = await standardMcpFixture({
		type: "object",
		properties: {
			text: { $id: "urn:text-resource", $schema: schema2020, type: "string" },
			literal: { const: literal, default: literal, examples: [literal] },
		},
		required: ["text", "literal"],
		additionalProperties: false,
	});
	const client = await StandardMcpClient.open(
		{
			target: fixture.target,
			resolveInput: async () => fixture.input,
			fetch: fixture.fetch,
		},
		reference,
		new AbortController().signal,
	);
	closes.push(() => client.close());
	const alias = client.toolDefinitions[0]?.tools[0]?.name ?? "";
	expect(client.validateArguments(alias, { text: "fixture", literal })).toBe(
		true,
	);
	const result = await client.call(
		alias,
		{ text: "fixture", literal },
		operation(),
		new AbortController().signal,
	);
	expect(result.phase).toBe("completed");
});

it.each(["custom", "default"])(
	"rejects local references into non-schema %s data",
	async (location) => {
		const fixture = await standardMcpFixture({
			type: "object",
			properties: { payload: { $ref: `#/${location}` } },
			[location]: {
				$id: "urn:hidden-resource",
				$schema: "https://unsupported.example.test/schema",
				type: "string",
			},
		});
		await expect(
			StandardMcpClient.open(
				{
					target: fixture.target,
					resolveInput: async () => fixture.input,
					fetch: fixture.fetch,
				},
				reference,
				new AbortController().signal,
			).then((client) => {
				closes.push(() => client.close());
				return client;
			}),
		).rejects.toMatchObject({ code: "CONNECTION_STANDARD_CLIENT_UNAVAILABLE" });
		expect(
			fixture.trace.filter((event) => event.method === "tools/call"),
		).toHaveLength(0);
	},
);

it.each([
	["pointer", { $defs: { "a/b": { type: "string" } } }, "#/$defs/a~1b"],
	["boolean", { $defs: { allowed: true } }, "#/$defs/allowed"],
	["anchor", { $defs: { text: { $anchor: "text", type: "string" } } }, "#text"],
	["embedded resource", {}, undefined],
] as const)(
	"preserves recognized local %s schema references",
	async (_name, definitions, ref) => {
		const fixture = await standardMcpFixture({
			type: "object",
			...definitions,
			properties: {
				payload: ref
					? { $ref: ref }
					: {
							$id: "urn:fixture:embedded-resource",
							$schema: schema2020,
							type: "object",
							$defs: { text: { type: "string" } },
							properties: { text: { $ref: "#/$defs/text" } },
							required: ["text"],
						},
			},
			required: ["payload"],
		});
		const client = await StandardMcpClient.open(
			{
				target: fixture.target,
				resolveInput: async () => fixture.input,
				fetch: fixture.fetch,
			},
			reference,
			new AbortController().signal,
		);
		closes.push(() => client.close());
		const alias = client.toolDefinitions[0]?.tools[0]?.name ?? "";
		const arguments_ = { payload: ref ? "fixture" : { text: "fixture" } };
		expect(client.validateArguments(alias, arguments_)).toBe(true);
		expect(
			(
				await client.call(
					alias,
					arguments_,
					operation(),
					new AbortController().signal,
				)
			).phase,
		).toBe("completed");
		expect(
			fixture.trace.filter((event) => event.method === "tools/call"),
		).toHaveLength(1);
	},
);
