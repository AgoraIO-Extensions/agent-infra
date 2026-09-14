import { describe, expect, it } from "vitest";
import {
	createDeploymentModelCatalogAdapterV1,
	createFakeModelCatalogAdapterV1,
} from "./index.js";

const endpoint = {
	endpointId: "endpoint-a",
	baseUrl: "https://models.example.test/team-a/v1",
	origin: "https://models.example.test",
	protocol: "openai-responses-v1",
	security: { tls: "verify-peer", redirects: "reject" },
	capabilities: {
		streaming: true,
		tools: true,
		reasoningLevels: ["medium", "high"],
	},
	allowedModels: null,
	available: true,
};
export function catalogFixture() {
	return {
		schemaVersion: 1,
		revision: "catalog-a",
		validUntil: Date.now() + 60_000,
		endpoints: [structuredClone(endpoint)],
	};
}

describe.each([
	[
		"deployment",
		(snapshot: unknown) =>
			createDeploymentModelCatalogAdapterV1({ load: async () => snapshot }),
	],
	["fake", (snapshot: unknown) => createFakeModelCatalogAdapterV1(snapshot)],
] as const)("%s ModelCatalog conformance", (_name, create) => {
	it("requires deployment-owned authentication for Messages without rewriting Responses snapshots", async () => {
		const messages = {
			...endpoint,
			protocol: "anthropic-messages-v1",
			authentication: "api-key",
		};
		const input = { endpointId: "endpoint-a", catalogRevision: "catalog-a" };
		const options = { signal: AbortSignal.timeout(1000) };
		expect(
			await create({ ...catalogFixture(), endpoints: [messages] }).resolve(
				input,
				options,
			),
		).toEqual(messages);
		const { authentication: _authentication, ...missingAuthentication } =
			messages;
		await expect(
			create({
				...catalogFixture(),
				endpoints: [missingAuthentication],
			}).resolve(input, options),
		).rejects.toThrow(/^MODEL_CONFIGURATION_UNAVAILABLE$/);
	});
	it("resolves the exact approved endpoint and policy without credentials", async () => {
		const catalog = create(catalogFixture());
		expect(
			await catalog.resolve(
				{ endpointId: "endpoint-a", catalogRevision: "catalog-a" },
				{ signal: AbortSignal.timeout(1000) },
			),
		).toEqual(endpoint);
	});
	it.each([
		{ endpoints: [] },
		{ revision: "catalog-b" },
		{ validUntil: 1 },
		...[
			{ available: false },
			{ protocol: "chat-completions" },
			{ baseUrl: "https://user:synthetic-credential@models.example.test/v1" },
			{ baseUrl: "https://models.example.test/v1?key=synthetic-credential" },
			{ origin: "https://other.example.test" },
			{ security: { tls: "insecure", redirects: "reject" } },
			{
				capabilities: {
					streaming: false,
					tools: true,
					reasoningLevels: ["medium"],
				},
			},
			{ credential: "synthetic-credential" },
		].map((overrides) => ({ endpoints: [{ ...endpoint, ...overrides }] })),
	])(
		"rejects missing, stale, unavailable and incompatible catalog material",
		async (overrides) => {
			await expect(
				create({ ...catalogFixture(), ...overrides }).resolve(
					{ endpointId: "endpoint-a", catalogRevision: "catalog-a" },
					{ signal: AbortSignal.timeout(1000) },
				),
			).rejects.toThrow(/^MODEL_CONFIGURATION_UNAVAILABLE$/);
		},
	);
});

it("bounds a stalled deployment loader and redacts its errors", async () => {
	const catalog = createDeploymentModelCatalogAdapterV1({
		load: () => new Promise(() => {}),
	});
	await expect(
		catalog.resolve(
			{ endpointId: "endpoint-a", catalogRevision: "catalog-a" },
			{ signal: AbortSignal.timeout(10) },
		),
	).rejects.toThrow(/^MODEL_CONFIGURATION_UNAVAILABLE$/);
}, 200);

it("marks loader failures retryable without exposing the original error", async () => {
	const catalog = createDeploymentModelCatalogAdapterV1({
		load: async () => {
			throw new Error("https://private.example.test synthetic-credential");
		},
	});
	await expect(
		catalog.resolve(
			{ endpointId: "endpoint-a", catalogRevision: "catalog-a" },
			{ signal: AbortSignal.timeout(1000) },
		),
	).rejects.toMatchObject({
		message: "MODEL_CONFIGURATION_UNAVAILABLE",
		retryable: true,
	});
});
