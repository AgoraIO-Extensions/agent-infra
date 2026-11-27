import { describe, expect, it } from "vitest";
import {
	assertProviderRegistration,
	assertRegisteredProvider,
	PROVIDER_REGISTRY,
	projectProviderCapabilities,
	resolveProviderRegistration,
	selectProviderDeploymentBinding,
} from "./provider-registry.js";

describe("fixed Provider Registry", () => {
	it("distinguishes SDK Codex provenance from the retained Native fallback", () => {
		expect(resolveProviderRegistration("codex", "paseo-sdk-pod")).toMatchObject(
			{
				runtimeDriverBinding: {
					template: "codex",
					path: "paseo-sdk",
					adapter: "codex-app-server-sdk",
				},
				provenance: {
					sdk: "@getpaseo/client",
					version: "0.17.4",
					sourceCommit: "2b3559b107243306986176b80beb0e779f9fe53e",
				},
			},
		);
		expect(resolveProviderRegistration("codex").path).toBe(
			"agent-infra-native",
		);
	});
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
		expect(resolveProviderRegistration("claude").template).toBe("claude");
	});

	it("admits every standard template only through its complete registration", () => {
		for (const template of ["claude", "pi", "opencode", "codex"] as const) {
			expect(assertRegisteredProvider(template).template).toBe(template);
		}
	});

	it("records source provenance required for every fixed adapter seam", () => {
		for (const registration of Object.values(PROVIDER_REGISTRY)) {
			expect(registration.provenance).toEqual(
				expect.objectContaining({
					repository: expect.any(String),
					sourceRevision: expect.any(String),
					file: expect.any(String),
					symbol: expect.any(String),
					license: expect.any(String),
					copyright: expect.any(String),
					adaptations: expect.arrayContaining([expect.any(String)]),
					regressionEvidence: expect.arrayContaining([expect.any(String)]),
				}),
			);
		}
	});

	it("records the Pi Paseo-derived JSONL RPC closure", () => {
		expect(PROVIDER_REGISTRY.pi).toMatchObject({
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

	it.each(["claude", "pi", "opencode", "codex"] as const)(
		"uses the same evidence projection for %s",
		(template) => {
			const registration = PROVIDER_REGISTRY[template];
			const declared = {
				modelSelection: true,
				attachments: true,
				resultFiles: true,
				connection: true,
				supplementaryInstruction: true,
			};
			const projected = projectProviderCapabilities(
				{
					runtimeDriverBinding: registration.runtimeDriverBinding,
					imageDigest: `sha256:${"d".repeat(64)}`,
					configurationRevision: 7,
					evidence: {
						runtimeDriverBinding: registration.runtimeDriverBinding,
						imageDigest: `sha256:${"d".repeat(64)}`,
						configurationRevision: 7,
						conformance: "passed",
						probe: "passed",
						recovery: "supported",
						result: "confirmed",
					},
				},
				declared,
			);
			expect(projected).toEqual(declared);
		},
	);

	it("fails closed when deployment evidence is missing or unknown", () => {
		const declared = {
			modelSelection: true,
			attachments: true,
			resultFiles: true,
			connection: true,
			supplementaryInstruction: true,
			skills: [
				{
					schemaVersion: 1 as const,
					name: "skill",
					version: "1",
					manifestSha256: "a".repeat(64),
					packageDigest: "b".repeat(64),
					readOnly: true as const,
				},
			],
		};
		expect(projectProviderCapabilities(undefined, declared)).toEqual({
			modelSelection: false,
			attachments: false,
			resultFiles: false,
			connection: false,
			supplementaryInstruction: false,
		});
		const binding = {
			runtimeDriverBinding: PROVIDER_REGISTRY.claude.runtimeDriverBinding,
			imageDigest: `sha256:${"c".repeat(64)}`,
			configurationRevision: 1,
			evidence: {
				runtimeDriverBinding: PROVIDER_REGISTRY.claude.runtimeDriverBinding,
				imageDigest: `sha256:${"c".repeat(64)}`,
				configurationRevision: 1,
				conformance: "unknown" as const,
				probe: "passed" as const,
				recovery: "supported" as const,
				result: "confirmed" as const,
			},
		};
		expect(projectProviderCapabilities(binding, declared)).toEqual({
			modelSelection: false,
			attachments: false,
			resultFiles: false,
			connection: false,
			supplementaryInstruction: false,
		});
	});
});

it("selects only reviewed evidence for the exact deployed driver, image and configuration", async () => {
	const driver = PROVIDER_REGISTRY.claude.runtimeDriverBinding;
	const image = "sha256:" + "a".repeat(64);
	const evidence = {
		runtimeDriverBinding: driver,
		imageDigest: image,
		configurationRevision: 3,
		configVersion: "configuration-3-" + "a".repeat(64),
		conformance: "passed",
		probe: "passed",
		recovery: "supported",
		result: "confirmed",
	} as const;
	const select = (
		records: readonly (typeof evidence)[],
		version = evidence.configVersion,
	) => selectProviderDeploymentBinding(records, "claude", image, version);
	expect(select([evidence])?.evidence).toEqual(evidence);
	expect(
		select([evidence], "configuration-3-" + "b".repeat(64)),
	).toBeUndefined();
	expect(select([evidence, evidence])).toBeUndefined();
	expect(select([])).toBeUndefined();
});

it("projects only the separately confirmed report capability on the admitted Pi SDK release", () => {
	const driver = resolveProviderRegistration(
		"pi",
		"paseo-sdk-pod",
	).runtimeDriverBinding;
	const digest = "sha256:" + "d".repeat(64);
	const version = "configuration-2-" + "f".repeat(64);
	const row = {
		runtimeDriverBinding: driver,
		imageDigest: digest,
		configVersion: version,
		configurationRevision: 2,
		conformance: "passed",
		probe: "passed",
		recovery: "supported",
		result: "confirmed",
		resultFiles: "passed",
	} as const;
	const declared = {
		resultFiles: true,
		attachments: true,
		modelSelection: true,
		connection: true,
		supplementaryInstruction: true,
	};
	const select = (
		rows: Parameters<typeof selectProviderDeploymentBinding>[0],
	) =>
		selectProviderDeploymentBinding(
			rows,
			"pi",
			digest,
			version,
			"paseo-sdk-pod",
		);
	expect(projectProviderCapabilities(select([row]), declared, driver)).toEqual({
		resultFiles: true,
		attachments: false,
		modelSelection: false,
		connection: false,
		supplementaryInstruction: false,
	});
	for (const rows of [
		[{ ...row, resultFiles: undefined }],
		[{ ...row, imageDigest: "sha256:" + "e".repeat(64) }],
		[
			{
				...row,
				runtimeDriverBinding: PROVIDER_REGISTRY.pi.runtimeDriverBinding,
			},
		],
		[row, row],
	]) {
		expect(
			projectProviderCapabilities(select(rows), declared, driver).resultFiles,
		).toBe(false);
	}
});
