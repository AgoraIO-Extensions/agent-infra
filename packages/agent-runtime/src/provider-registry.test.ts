import { describe, expect, it } from "vitest";
import {
	PROVIDER_REGISTRY,
	resolveProviderRegistration,
	projectProviderCapabilities,
} from "./provider-registry.js";

describe("fixed Provider Registry", () => {
	it("binds each standard template to its immutable implementation path", () => {
		expect(Object.fromEntries(Object.entries(PROVIDER_REGISTRY).map(([k, v]) => [k, v.path]))).toEqual({
			claude: "paseo-derived",
			pi: "paseo-derived",
			opencode: "paseo-derived",
			codex: "agent-infra-native",
		});
		expect(resolveProviderRegistration("claude", "codex").template).toBe("claude");
	});

	it("keeps capabilities disabled until every conservative gate passes", () => {
		const result = projectProviderCapabilities("claude", {
			conformance: "passed",
			probe: "passed",
			recovery: "supported",
			result: "confirmed",
			declared: { modelSelection: true, connection: true },
		});
		expect(result).toEqual({ modelSelection: true, connection: true });
		expect(projectProviderCapabilities("claude", {
			conformance: "passed", probe: "unknown", recovery: "supported", result: "confirmed",
			declared: { modelSelection: true },
		})).toEqual({ modelSelection: false });
	});
});
