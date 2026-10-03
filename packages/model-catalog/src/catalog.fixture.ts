export function catalogFixture() {
	return {
		schemaVersion: 1,
		revision: "catalog-a",
		validUntil: Date.now() + 60_000,
		endpoints: [
			{
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
			},
		],
	};
}
