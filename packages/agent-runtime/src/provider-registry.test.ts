import { describe, expect, it } from "vitest";
import {
	assertProviderRegistration,
	PROVIDER_REGISTRY,
	projectProviderCapabilities,
	resolveProviderRegistration,
} from "./provider-registry.js";

describe("fixed Provider Registry", () => {
	it("exposes the Claude Paseo-derived RuntimeHost registration", () => {
		expect(
			assertProviderRegistration("claude", "paseo-derived", "claude-query"),
		).toEqual(PROVIDER_REGISTRY.claude);
	});
	it("keeps Codex on the agent-infra Native Driver contract", () => {
		expect(
			assertProviderRegistration("codex", "agent-infra-native", "codex-native"),
		).toEqual(PROVIDER_REGISTRY.codex);
		expect(PROVIDER_REGISTRY.codex.provenance).toMatchObject({
			source: "agent-infra",
			sourceCommit: "41e22fee981a63b3698df7ed36bad393cda24715",
			sdk: "codex app-server",
			version: "0.153.0",
			license: "Apache-2.0",
		});
		expect(PROVIDER_REGISTRY.codex.provenance.adaptations).toEqual([
			"native-execution-fence",
			"connection-mcp-boundary",
			"sandbox-and-credential-boundary",
		]);
	});

	it("rejects a path or adapter that crosses the fixed Native boundary", () => {
		expect(() =>
			assertProviderRegistration("codex", "paseo-derived", "codex-native"),
		).toThrowError("RUNTIME_PROVIDER_REGISTRATION_MISMATCH");
		expect(() =>
			assertProviderRegistration("codex", "agent-infra-native", "generic-acp"),
		).toThrowError("RUNTIME_PROVIDER_REGISTRATION_MISMATCH");
	});
	it("binds each standard template to its immutable implementation path", () => {
		expect(
			Object.fromEntries(
				Object.entries(PROVIDER_REGISTRY).map(([k, v]) => [k, v.path]),
			),
		).toEqual({
			claude: "paseo-derived",
			pi: "paseo-derived",
			opencode: "paseo-derived",
			codex: "agent-infra-native",
		});
		expect(resolveProviderRegistration("claude", "codex").template).toBe(
			"claude",
		);
	});

	it("records the Pi Paseo-derived JSONL RPC closure", () => {
		expect(PROVIDER_REGISTRY.pi).toEqual({
			template: "pi",
			path: "paseo-derived",
			adapter: "pi-jsonl-rpc",
			provenance: {
				source: "paseo",
				sourceCommit: "d1b705a0cd91617a5707fae25d80cb0be305795",
				sdk: "@earendil-works/pi-coding-agent",
				version: "0.99.0",
				license: "MIT",
				adaptations: [
					"runtime-host-driver-contract",
					"verified-session-checkpoint",
					"sandbox-and-credential-boundary",
				],
			},
		});
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
		expect(
			projectProviderCapabilities("claude", {
				conformance: "passed",
				probe: "unknown",
				recovery: "supported",
				result: "confirmed",
				declared: { modelSelection: true },
			}),
		).toEqual({ modelSelection: false });
	});
});
