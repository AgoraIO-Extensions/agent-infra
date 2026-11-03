import { describe, expect, it } from "vitest";
import { customModelCredentialEnvironmentV1 } from "./kubernetes-runtime-policy.js";

describe("custom model credential environment", () => {
	it("aliases the API secret to the runtime contract variable", () => {
		const result = customModelCredentialEnvironmentV1({
			runtimeManifest: {
				schemaVersion: 1,
				interactionMode: "platform-adapter",
				protocol: "acp",
				service: { port: 3003 },
				health: { path: "/healthz" },
				capabilities: { modelSelection: true },
			},
			secretRefs: [{ name: "agent-secret" }],
		} as never);

		expect(result).toEqual([
			{
				name: "AGENT_INFRA_RUNTIME_MODEL_CREDENTIAL_OWNER",
				valueFrom: {
					secretKeyRef: {
						name: "agent-secret",
						key: "CUSTOM_MODEL_API_KEY",
						optional: false,
					},
				},
			},
		]);
	});

	it("does not add the alias without model-selection capability", () => {
		const result = customModelCredentialEnvironmentV1({
			runtimeManifest: {
				schemaVersion: 1,
				interactionMode: "platform-adapter",
				protocol: "acp",
				service: { port: 3003 },
				health: { path: "/healthz" },
				capabilities: { modelSelection: false },
			},
			secretRefs: [{ name: "agent-secret" }],
		} as never);

		expect(result).toEqual([]);
	});
});
