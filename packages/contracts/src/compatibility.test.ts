import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const cliPath = fileURLToPath(new URL("./compatibility.mjs", import.meta.url));
const fixturePath = (name: string) =>
	fileURLToPath(new URL(`../test/compatibility/${name}.json`, import.meta.url));
const pilotBrowserArtifactPath = fileURLToPath(
	new URL(
		"../artifacts/openapi/pilot-browser.v1.openapi.json",
		import.meta.url,
	),
);
const runtimeHostV2ArtifactPath = fileURLToPath(
	new URL("../artifacts/openapi/runtime-host.v2.openapi.json", import.meta.url),
);

function comparePaths(current: string, previous: string) {
	return spawnSync(
		process.execPath,
		[cliPath, "--previous", previous, "--current", current],
		{ encoding: "utf8" },
	);
}

function compare(current: string, previous = "base") {
	return comparePaths(fixturePath(current), fixturePath(previous));
}

function restoreOldApiReadActions(input: unknown) {
	if (!input || typeof input !== "object") return;
	const value = input as Record<string, unknown>;
	if (Array.isArray(value.enum))
		value.enum = value.enum.filter(
			(action) => action !== "api.agent.metadata.read",
		);
	for (const child of Object.values(value)) restoreOldApiReadActions(child);
}

// Preserve every historical guard test while testing the exact list addition separately.
function restorePreCredentialManagementContract(value: {
	paths: Record<string, Record<string, unknown>>;
	components: { schemas: Record<string, { enum?: unknown[] }> };
}) {
	if (value.paths["/api/v2/me/api-credentials"])
		delete value.paths["/api/v2/me/api-credentials"].get;
	for (const name of [
		"PersonalApiCredentialListQueryV1",
		"PersonalApiCredentialPageV1",
	])
		delete value.components.schemas[name];
	const actions = value.components.schemas.ScopedPlatformAuditActionV1;
	if (actions?.enum)
		actions.enum = actions.enum.filter(
			(action) => action !== "api.credential.metadata.read",
		);
}

// Keep the historical #1059/#1060 tests bound to their original contracts.
// The separate #1089 tests below pin and mutate every removed addition.
function restorePreRelayKeyContract(value: {
	paths: Record<string, Record<string, unknown>>;
	components: { schemas: Record<string, { enum?: unknown[] }> };
}) {
	restorePreCredentialManagementContract(value);
	delete value.paths["/api/v2/me/relay-key"];
	for (const name of [
		"PersonalRelayKeyStateV1",
		"PersonalRelayKeyReplaceRequestV1",
		"PersonalRelayKeyRevokeRequestV1",
	])
		delete value.components.schemas[name];
	const actions = value.components.schemas.ScopedPlatformAuditActionV1;
	if (actions?.enum)
		actions.enum = actions.enum.filter(
			(action) =>
				![
					"relay_key.personal.read",
					"relay_key.personal.replace",
					"relay_key.personal.revoke",
				].includes(String(action)),
		);
}

describe("contract compatibility command", () => {
	it("admits only exact scoped audit cookie/Bearer documentation and rejects authority drift", async () => {
		const current = JSON.parse(
			await readFile(pilotBrowserArtifactPath, "utf8"),
		);
		const previous = structuredClone(current);
		for (const path of ["/api/v1/audit", "/api/v1/audit/{auditId}"])
			previous.paths[path].get.security = [{}];
		for (const path of ["/api/v3/admin/audit", "/api/v3/admin/audit/{auditId}"])
			previous.paths[path].get.security = [];
		delete previous.components.securitySchemes;
		const directory = await mkdtemp(
			resolve(tmpdir(), "agent-infra-audit-auth-compat-"),
		);
		const before = resolve(directory, "previous.json");
		const after = resolve(directory, "current.json");
		try {
			await writeFile(before, JSON.stringify(previous));
			await writeFile(after, JSON.stringify(current));
			expect(comparePaths(after, before).status).toBe(0);
			const withExistingSchemes = structuredClone(previous);
			withExistingSchemes.components.securitySchemes = structuredClone(
				current.components.securitySchemes,
			);
			await writeFile(before, JSON.stringify(withExistingSchemes));
			expect(comparePaths(after, before).status).toBe(0);
			await writeFile(before, JSON.stringify(previous));
			const mutations = [
				(value: typeof current) => {
					value.paths["/api/v1/audit"].get.security = [{}];
				},
				(value: typeof current) => {
					value.paths["/api/v1/audit/{auditId}"].get.security = [
						{ PlatformSession: [], platformApiCredential: [] },
					];
				},
				(value: typeof current) => {
					value.paths["/api/v3/admin/audit"].get.security = [
						{ platformApiCredential: [] },
					];
				},
				(value: typeof current) => {
					value.paths["/api/v3/admin/audit/{auditId}"].get.security = [];
				},
				(value: typeof current) => {
					value.components.securitySchemes.PlatformSession.name =
						"untrusted-cookie";
				},
				(value: typeof current) => {
					value.components.securitySchemes.platformApiCredential.scheme =
						"basic";
				},
				(value: typeof current) => {
					delete value.paths["/api/v1/audit"].get.responses["401"];
				},
				(value: typeof current) => {
					value.paths["/api/v1/admin/audit"].get.security = [];
				},
			];
			for (const mutate of mutations) {
				const changed = structuredClone(current);
				mutate(changed);
				await writeFile(after, JSON.stringify(changed));
				expect(comparePaths(after, before).status).not.toBe(0);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it.each([1, 2])(
		"admits only the exact personal list addition for browser V%s",
		async (version) => {
			const current = JSON.parse(
				await readFile(
					new URL(
						`../artifacts/openapi/pilot-browser.v${version}.openapi.json`,
						import.meta.url,
					),
					"utf8",
				),
			);
			const previous = structuredClone(current);
			restorePreCredentialManagementContract(previous);
			const directory = await mkdtemp(
				resolve(tmpdir(), "agent-infra-personal-list-compat-"),
			);
			const previousPath = resolve(directory, "previous.json");
			const currentPath = resolve(directory, "current.json");
			try {
				await writeFile(previousPath, JSON.stringify(previous));
				await writeFile(currentPath, JSON.stringify(current));
				expect(comparePaths(currentPath, previousPath).status).toBe(0);
				const mutations: ((document: typeof current) => void)[] =
					version === 1
						? [
								(document) => {
									document.components.schemas.ScopedPlatformAuditActionV1.enum.push(
										"unreviewed.action",
									);
								},
								(document) => {
									document.components.schemas.ScopedPlatformAuditActionV1.enum.splice(
										0,
										1,
									);
								},
							]
						: [
								(document) => {
									document.paths["/api/v2/me/api-credentials"].get.security = [
										{},
									];
								},
								(document) => {
									document.paths["/api/v2/me/api-credentials"].get.parameters =
										[];
								},
								(document) => {
									document.components.schemas.PersonalApiCredentialPageV1.properties.items.maxItems = 200;
								},
								(document) => {
									document.components.schemas.PersonalApiCredentialPageV1.properties.credential =
										{ type: "string" };
								},
								(document) => {
									document.paths["/api/v2/me/api-credentials"].post.security = [
										{},
									];
								},
								(document) => {
									document.components.securitySchemes.PlatformSession = {};
								},
							];
				mutations.push(
					(document) => {
						document.paths["/unreviewed"] = {};
					},
					(document) => {
						document.components.schemas.Unreviewed = { type: "object" };
					},
				);
				for (const mutate of mutations) {
					const changed = structuredClone(current);
					mutate(changed);
					await writeFile(currentPath, JSON.stringify(changed));
					expect(comparePaths(currentPath, previousPath).status).toBe(1);
				}
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		},
	);

	it("admits only the exact own-application GET without changing prior contracts", async () => {
		const current = JSON.parse(
			await readFile(
				new URL(
					"../artifacts/openapi/pilot-browser.v2.openapi.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		const path = "/api/v2/applications/{applicationId}";
		const previous = structuredClone(current);
		delete previous.paths[path];
		const directory = await mkdtemp(
			resolve(tmpdir(), "agent-infra-own-application-compat-"),
		);
		const previousPath = resolve(directory, "previous.json");
		const currentPath = resolve(directory, "current.json");
		try {
			await writeFile(previousPath, JSON.stringify(previous));
			await writeFile(currentPath, JSON.stringify(current));
			expect(comparePaths(currentPath, previousPath).status).toBe(0);
			for (const mutate of [
				(document: typeof current) => {
					document.paths[path].post = document.paths[path].get;
				},
				(document: typeof current) => {
					document.paths[path].get.security = [{}];
				},
				(document: typeof current) => {
					document.paths[path].get.parameters = [];
				},
				(document: typeof current) => {
					delete document.paths[path].get.responses["200"];
				},
				(document: typeof current) => {
					document.paths[path].get.requestBody = { required: false };
				},
				(document: typeof current) => {
					document.paths[path].get.responses["200"].content[
						"application/json"
					].schema = { type: "object", additionalProperties: true };
				},
				(document: typeof current) => {
					document.components.schemas.ApplicationMetadataV1.properties.credential =
						{ type: "string" };
				},
				(document: typeof current) => {
					document.paths["/api/v2/applications"].post.operationId = "changed";
				},
				(document: typeof current) => {
					document.components.securitySchemes.PlatformSession = {};
				},
				(document: typeof current) => {
					document.paths["/api/v2/unreviewed"] = {};
				},
				(document: typeof current) => {
					document.components.schemas.Unreviewed = { type: "object" };
				},
			]) {
				const changed = structuredClone(current);
				mutate(changed);
				await writeFile(currentPath, JSON.stringify(changed));
				expect(comparePaths(currentPath, previousPath).status).toBe(1);
			}
			const occupied = structuredClone(current);
			occupied.paths[path].get.description = "Existing contract";
			await writeFile(previousPath, JSON.stringify(occupied));
			await writeFile(currentPath, JSON.stringify(current));
			expect(comparePaths(currentPath, previousPath).status).toBe(1);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("admits only the exact application registration POST and preserves all prior contracts", async () => {
		const current = JSON.parse(
			await readFile(
				new URL(
					"../artifacts/openapi/pilot-browser.v2.openapi.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		delete current.paths["/api/v2/applications/{applicationId}"];
		const path = "/api/v2/applications";
		const previous = structuredClone(current);
		delete previous.paths[path];
		for (const name of [
			"ApplicationMetadataV1",
			"ApplicationRegistrationRequestV1",
			"ApplicationRegistrationResponseV1",
		])
			delete previous.components.schemas[name];
		const directory = await mkdtemp(
			resolve(tmpdir(), "agent-infra-registration-compat-"),
		);
		const previousPath = resolve(directory, "previous.json");
		const currentPath = resolve(directory, "current.json");
		try {
			await writeFile(previousPath, JSON.stringify(previous));
			await writeFile(currentPath, JSON.stringify(current));
			expect(comparePaths(currentPath, previousPath).status).toBe(0);
			for (const mutate of [
				(document: typeof current) => {
					delete document.paths[path];
				},
				(document: typeof current) => {
					document.paths[path].get = document.paths[path].post;
				},
				(document: typeof current) => {
					document.paths[path].post.security = [{}];
				},
				(document: typeof current) => {
					document.paths[path].post.parameters = [];
				},
				(document: typeof current) => {
					delete document.paths[path].post.responses["403"];
				},
				(document: typeof current) => {
					document.components.schemas.ApplicationRegistrationRequestV1.additionalProperties = true;
				},
				(document: typeof current) => {
					document.components.schemas.ApplicationMetadataV1.properties.credential =
						{ type: "string" };
				},
				(document: typeof current) => {
					document.paths["/api/v2/unreviewed"] = {};
				},
				(document: typeof current) => {
					document.paths["/api/v2/agents"].get.operationId = "changed";
				},
				(document: typeof current) => {
					document.components.schemas.AgentProjectionV2.required = [];
				},
				(document: typeof current) => {
					document.components.securitySchemes.PlatformSession = {};
				},
				(document: typeof current) => {
					document.components.schemas.Unreviewed = { type: "object" };
				},
			]) {
				const changed = structuredClone(current);
				mutate(changed);
				await writeFile(currentPath, JSON.stringify(changed));
				expect(comparePaths(currentPath, previousPath).status).toBe(1);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("admits only the three pinned personal Relay Key audit actions at the existing V1 location", async () => {
		const current = JSON.parse(
			await readFile(pilotBrowserArtifactPath, "utf8"),
		);
		restorePreCredentialManagementContract(current);
		const previous = structuredClone(current);
		previous.components.schemas.ScopedPlatformAuditActionV1.enum =
			previous.components.schemas.ScopedPlatformAuditActionV1.enum.filter(
				(action: string) =>
					![
						"relay_key.personal.read",
						"relay_key.personal.replace",
						"relay_key.personal.revoke",
					].includes(action),
			);
		const directory = await mkdtemp(
			resolve(tmpdir(), "agent-infra-relay-audit-compat-"),
		);
		const baseline = resolve(directory, "previous.json");
		try {
			await writeFile(baseline, JSON.stringify(previous));
			expect(comparePaths(pilotBrowserArtifactPath, baseline).status).toBe(0);
			const mutations: Record<string, (value: typeof current) => void> = {
				inventedAction: (value) => {
					value.components.schemas.ScopedPlatformAuditActionV1.enum.push(
						"relay_key.personal.anything",
					);
				},
				removedOldAction: (value) => {
					value.components.schemas.ScopedPlatformAuditActionV1.enum.shift();
				},
				missingNewAction: (value) => {
					value.components.schemas.ScopedPlatformAuditActionV1.enum =
						value.components.schemas.ScopedPlatformAuditActionV1.enum.filter(
							(action: string) => action !== "relay_key.personal.revoke",
						);
				},
				keyReadback: (value) => {
					value.components.schemas.ScopedPlatformAuditProjectionV1.properties.keyValue =
						{ type: "string" };
				},
				anonymousAudit: (value) => {
					value.paths["/api/v3/admin/audit"].get.security = [{}];
				},
				missingAuthenticationFailure: (value) => {
					delete value.paths["/api/v3/admin/audit"].get.responses["401"];
				},
				missingAuthorizationFailure: (value) => {
					delete value.paths["/api/v3/admin/audit/{auditId}"].get.responses[
						"403"
					];
				},
			};
			for (const baselineKind of ["apiRead", "beforeApiRead"]) {
				const existing = structuredClone(previous);
				if (baselineKind === "beforeApiRead")
					restoreOldApiReadActions(existing);
				await writeFile(baseline, JSON.stringify(existing));
				expect(
					comparePaths(pilotBrowserArtifactPath, baseline).status,
					baselineKind,
				).toBe(0);
				for (const [name, mutate] of Object.entries(mutations)) {
					const candidate = structuredClone(current);
					mutate(candidate);
					expect(candidate, name).not.toEqual(current);
					const path = resolve(directory, `${name}.json`);
					await writeFile(path, JSON.stringify(candidate));
					expect(
						comparePaths(path, baseline).status,
						`${baselineKind}-${name}`,
					).toBe(1);
				}
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("admits only the pinned browser personal Relay Key path and rejects identity/material/security drift", async () => {
		const artifact = fileURLToPath(
			new URL(
				"../artifacts/openapi/pilot-browser.v2.openapi.json",
				import.meta.url,
			),
		);
		const current = JSON.parse(await readFile(artifact, "utf8"));
		const previous = structuredClone(current);
		restorePreRelayKeyContract(previous);
		const directory = await mkdtemp(
			resolve(tmpdir(), "agent-infra-relay-key-compat-"),
		);
		const baseline = resolve(directory, "previous.json");
		try {
			await writeFile(baseline, JSON.stringify(previous));
			expect(comparePaths(artifact, baseline).status).toBe(0);
			const mutations: Record<string, (value: typeof current) => void> = {
				anonymous: (value) => {
					value.paths["/api/v2/me/relay-key"].put.security = [];
				},
				bearer: (value) => {
					value.paths["/api/v2/me/relay-key"].delete.security = [
						{ platformApiCredential: [] },
					];
				},
				callerIdentity: (value) => {
					value.components.schemas.PersonalRelayKeyReplaceRequestV1.properties.userId =
						{ type: "string" };
				},
				keyReadback: (value) => {
					value.components.schemas.PersonalRelayKeyStateV1.oneOf[1].properties.keyValue =
						{ type: "string" };
				},
				keyBounds: (value) => {
					value.components.schemas.PersonalRelayKeyReplaceRequestV1.properties.keyValue.minLength = 0;
				},
				keyPattern: (value) => {
					delete value.components.schemas.PersonalRelayKeyReplaceRequestV1
						.properties.keyValue.pattern;
				},
				zeroVersion: (value) => {
					value.components.schemas.PersonalRelayKeyRevokeRequestV1.properties.expectedVersion.minimum = 0;
				},
				unknownBodyFields: (value) => {
					value.components.schemas.PersonalRelayKeyReplaceRequestV1.additionalProperties = true;
				},
				inventedPatch: (value) => {
					value.paths["/api/v2/me/relay-key"].patch =
						value.paths["/api/v2/me/relay-key"].put;
				},
				missingFailureStatus: (value) => {
					delete value.paths["/api/v2/me/relay-key"].put.responses["503"];
				},
				changedCookie: (value) => {
					value.components.securitySchemes.PlatformSession.name =
						"caller_session";
				},
				unrelatedAnonymousAdmin: (value) => {
					value.paths["/api/v2/admin/agents"].get.security = [];
				},
			};
			for (const [name, mutate] of Object.entries(mutations)) {
				const candidate = structuredClone(current);
				mutate(candidate);
				const path = resolve(directory, `${name}.json`);
				await writeFile(path, JSON.stringify(candidate));
				expect(comparePaths(path, baseline).status, name).toBe(1);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("admits only the exact original binding addition and preserves every prior V3 operation", async () => {
		const artifact = fileURLToPath(
			new URL(
				"../artifacts/openapi/runtime-host.v3.openapi.json",
				import.meta.url,
			),
		);
		const current = JSON.parse(await readFile(artifact, "utf8"));
		const previous = structuredClone(current);
		delete previous.paths["/internal/runtime/v3/original-binding"];
		delete previous.components.schemas.RuntimeOriginalBindingResponseV3;
		const directory = await mkdtemp(
			resolve(tmpdir(), "agent-infra-original-binding-"),
		);
		const previousPath = resolve(directory, "previous.json");
		const currentPath = resolve(directory, "current.json");
		try {
			await writeFile(previousPath, JSON.stringify(previous));
			expect(comparePaths(artifact, previousPath).status).toBe(0);
			const mutations: Record<string, (value: typeof current) => void> = {
				widenedRef: (value) => {
					value.components.schemas.RuntimeOriginalBindingResponseV3.properties.hostSessionRef.minLength = 0;
				},
				statusProjection: (value) => {
					value.components.schemas.RuntimeOriginalBindingResponseV3.properties.status =
						{ type: "string" };
				},
				changedRequest: (value) => {
					value.paths[
						"/internal/runtime/v3/original-binding"
					].post.requestBody.content["application/json"].schema.$ref =
						"#/components/schemas/RuntimeStopRequestV3";
				},
				anonymous: (value) => {
					value.paths["/internal/runtime/v3/original-binding"].post.security =
						[];
				},
				changedOldStatus: (value) => {
					value.paths["/internal/runtime/v3/status"].post.operationId =
						"changed";
				},
				changedOldRequest: (value) => {
					value.components.schemas.RuntimeStatusRequestV3.additionalProperties = true;
				},
			};
			for (const mutate of Object.values(mutations)) {
				const changed = structuredClone(current);
				mutate(changed);
				await writeFile(currentPath, JSON.stringify(changed));
				expect(comparePaths(currentPath, previousPath).status).toBe(1);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("admits the exact durable API Agent read audit action while preserving every old action and field", async () => {
		const artifact = fileURLToPath(
			new URL(
				"../artifacts/openapi/pilot-browser.v1.openapi.json",
				import.meta.url,
			),
		);
		const current = JSON.parse(await readFile(artifact, "utf8"));
		restorePreRelayKeyContract(current);
		const previous = structuredClone(current);
		restoreOldApiReadActions(previous);
		const directory = await mkdtemp(
			resolve(tmpdir(), "agent-infra-api-read-audit-compat-"),
		);
		const baseline = resolve(directory, "previous.json");
		const historicalCurrent = resolve(directory, "historical-current.json");
		try {
			await writeFile(baseline, JSON.stringify(previous));
			await writeFile(historicalCurrent, JSON.stringify(current));
			expect(comparePaths(historicalCurrent, baseline).status).toBe(0);
			for (const [name, mutate] of Object.entries({
				inventedAction: (value: typeof current) => {
					value.components.schemas.ScopedPlatformAuditActionV1.enum.push(
						"api.anything",
					);
				},
				removedOldAction: (value: typeof current) => {
					value.components.schemas.ScopedPlatformAuditActionV1.enum.shift();
				},
				credentialReadback: (value: typeof current) => {
					value.components.schemas.ScopedPlatformAuditProjectionV1.properties.credential =
						{ type: "string" };
				},
				anonymousAudit: (value: typeof current) => {
					value.paths["/api/v1/admin/audit"].get.security = [];
				},
			})) {
				const candidate = structuredClone(current);
				mutate(candidate);
				const path = resolve(directory, `${name}.json`);
				await writeFile(path, JSON.stringify(candidate));
				expect(comparePaths(path, baseline).status, name).toBe(1);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("admits only the pinned personal credential contract and rejects security/material regressions", async () => {
		const artifact = fileURLToPath(
			new URL(
				"../artifacts/openapi/pilot-browser.v2.openapi.json",
				import.meta.url,
			),
		);
		const current = JSON.parse(await readFile(artifact, "utf8"));
		const latest = structuredClone(current);
		restorePreRelayKeyContract(current);
		const previous = structuredClone(current);
		for (const path of [
			"/api/v2/me/api-credentials",
			"/api/v2/me/api-credentials/{credentialId}",
		])
			delete previous.paths[path];
		for (const name of [
			"PersonalApiCredentialIssueRequestV1",
			"PersonalApiCredentialIssueResponseV1",
			"PersonalApiCredentialMetadataV1",
			"PersonalApiCredentialRevokeResponseV1",
		])
			delete previous.components.schemas[name];
		delete previous.components.securitySchemes;
		delete previous.paths["/api/v2/agents"].get.security;
		delete previous.paths["/api/v2/agents"].get.description;
		restoreOldApiReadActions(previous);
		const directory = await mkdtemp(
			resolve(tmpdir(), "agent-infra-personal-credential-compat-"),
		);
		const baseline = resolve(directory, "previous.json");
		const historicalCurrent = resolve(directory, "historical-current.json");
		try {
			await writeFile(baseline, JSON.stringify(previous));
			await writeFile(historicalCurrent, JSON.stringify(current));
			expect(comparePaths(historicalCurrent, baseline).status).toBe(0);
			const mutations: Record<string, (value: typeof current) => void> = {
				anonymous: (value) => {
					value.paths["/api/v2/me/api-credentials"].post.security = [];
				},
				bearerGovernance: (value) => {
					value.paths[
						"/api/v2/me/api-credentials/{credentialId}"
					].delete.security = [{ PersonalApiCredential: [] }];
				},
				hashReadback: (value) => {
					value.components.schemas.PersonalApiCredentialMetadataV1.properties.credentialHash =
						{ type: "string" };
				},
				emptyScopes: (value) => {
					value.components.schemas.PersonalApiCredentialIssueRequestV1.properties.scopes.minItems = 0;
				},
				materialReplay: (value) => {
					value.paths["/api/v2/me/api-credentials"].post.responses["200"] =
						value.paths["/api/v2/me/api-credentials"].post.responses["201"];
				},
				unexpectedPatch: (value) => {
					value.paths["/api/v2/me/api-credentials/{credentialId}"].patch =
						value.paths["/api/v2/me/api-credentials/{credentialId}"].delete;
				},
				differentCookie: (value) => {
					value.components.securitySchemes.PlatformSession.name =
						"caller_session";
				},
				unrelatedOperation: (value) => {
					value.paths["/unexpected"] =
						value.paths["/api/v2/me/api-credentials"];
				},
				oldAdministratorSecurity: (value) => {
					value.paths["/api/v2/admin/agents"].get.security = [];
				},
				oldMetadataResponse: (value) => {
					value.components.schemas.AgentProjectionV2.properties.rawCredential =
						{ type: "string" };
				},
				globalSecurity: (value) => {
					value.security = [{ PlatformSession: [] }];
				},
				anonymousAgentRead: (value) => {
					value.paths["/api/v2/agents"].get.security = [{}];
				},
				bearerOwnerOverride: (value) => {
					value.paths["/api/v2/agents"].get.parameters.find(
						({ name }: { name: string }) => name === "scope",
					).schema = { type: "string" };
				},
				bearerSchemeChanged: (value) => {
					value.components.securitySchemes.platformApiCredential = {
						type: "http",
						scheme: "basic",
					};
				},
				unrelatedBearerOperation: (value) => {
					value.paths["/api/v2/admin/agents"].get.security = [
						{ platformApiCredential: [] },
					];
				},
				andAuthentication: (value) => {
					value.paths["/api/v2/agents"].get.security = [
						{ PlatformSession: [], platformApiCredential: [] },
					];
				},
				removedBrowserAuthentication: (value) => {
					value.paths["/api/v2/agents"].get.security = [
						{ platformApiCredential: [] },
					];
				},
			};
			for (const [name, mutate] of Object.entries(mutations)) {
				const candidate = structuredClone(current);
				mutate(candidate);
				const path = resolve(directory, `${name}.json`);
				await writeFile(path, JSON.stringify(candidate));
				const result = comparePaths(path, baseline);
				expect(result.status, name).toBe(1);
				expect(result.stderr, name).toContain("changed OpenAPI contract");
			}
			for (const baselineKind of ["empty", "existingCookie", "governance"]) {
				const existing = structuredClone(
					baselineKind === "governance" ? current : previous,
				);
				if (baselineKind === "governance") {
					delete existing.paths["/api/v2/agents"].get.security;
					delete existing.paths["/api/v2/agents"].get.description;
					delete existing.components.securitySchemes.platformApiCredential;
					restoreOldApiReadActions(existing);
				} else {
					existing.components.securitySchemes = {};
				}
				if (baselineKind === "existingCookie")
					existing.components.securitySchemes.PlatformSession = structuredClone(
						current.components.securitySchemes.PlatformSession,
					);
				const path = resolve(directory, `${baselineKind}-previous.json`);
				await writeFile(path, JSON.stringify(existing));
				if (baselineKind === "governance")
					expect(comparePaths(path, baseline).status).toBe(0);
				expect(comparePaths(artifact, path).status, baselineKind).toBe(0);
				expect(
					comparePaths(historicalCurrent, path).status,
					`${baselineKind}-historical`,
				).toBe(0);
				for (const [version, contract] of Object.entries({
					historical: current,
					latest,
				})) {
					for (const [name, mutate] of Object.entries(mutations)) {
						const candidate = structuredClone(contract);
						mutate(candidate);
						const mutated = resolve(
							directory,
							`${baselineKind}-${version}-${name}.json`,
						);
						await writeFile(mutated, JSON.stringify(candidate));
						expect(
							comparePaths(mutated, path).status,
							`${baselineKind}-${version}-${name}`,
						).toBe(1);
					}
				}
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}, 15_000);
	it("tracks published browser, file, readiness and template-release contracts", async () => {
		const source = await readFile(cliPath, "utf8");
		for (const path of [
			"json-schema/files.v1.schema.json",
			"openapi/files.v1.openapi.json",
			"json-schema/runtime-readiness.v1.schema.json",
			"openapi/runtime-readiness.v1.openapi.json",
			"openapi/standard-template-release.v1.openapi.json",
		])
			expect(source).toContain(`"packages/contracts/artifacts/${path}"`);
		expect(source).toContain(
			'"packages/contracts/artifacts/openapi/pilot-browser.v1.openapi.json"',
		);
		expect(source).toContain(
			'"packages/contracts/artifacts/openapi/pilot-browser.v2.openapi.json"',
		);
	});

	it("accepts additive schemas and disjoint oneOf literals", () => {
		const result = compare("additive");
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
	});

	it("accepts only the model-selection fallback OpenAPI addition", () => {
		const result = compare(
			"openapi-component-ref-additive",
			"openapi-component-ref-base",
		);
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
	});

	it("rejects every deviation from the fallback OpenAPI addition", async () => {
		const previous = fixturePath("openapi-component-ref-base");
		const additive = JSON.parse(
			await readFile(fixturePath("openapi-component-ref-additive"), "utf8"),
		);
		const directory = await mkdtemp(
			resolve(tmpdir(), "agent-infra-openapi-ref-"),
		);
		const expectRejected = async (name: string, current: unknown) => {
			const path = resolve(directory, `${name}.json`);
			await writeFile(path, JSON.stringify(current), "utf8");
			const result = comparePaths(path, previous);
			expect(result.status, name).toBe(1);
			expect(result.stderr, name).toContain("changed OpenAPI contract");
		};

		try {
			for (const [name, ref] of [
				["alternate", "#/components/schemas/OtherEventV1"],
				["external", "https://example.invalid/FallbackEventV1"],
			] as const) {
				const current = structuredClone(additive);
				current.components.schemas.PersistedConversationEventV1.oneOf[1].$ref =
					ref;
				await expectRejected(name, current);
			}

			const missingRef = structuredClone(additive);
			delete missingRef.components.schemas.PersistedConversationEventV1.oneOf[1]
				.$ref;
			await expectRejected("missing-ref", missingRef);

			const sibling = structuredClone(additive);
			sibling.components.schemas.PersistedConversationEventV1.oneOf[1].description =
				"Ref sibling";
			await expectRejected("sibling", sibling);

			const wrongReason = structuredClone(additive);
			wrongReason.components.schemas.ModelSelectionFallbackEventV1.properties.payload.properties.reason.const =
				"provider_failed";
			await expectRejected("wrong-reason", wrongReason);

			const extraPayload = structuredClone(additive);
			const extra =
				extraPayload.components.schemas.ModelSelectionFallbackEventV1.properties
					.payload;
			extra.properties.credential = { type: "string" };
			extra.required.push("credential");
			await expectRejected("extra-payload", extraPayload);

			const operationChange = structuredClone(additive);
			operationChange.paths["/events"].get.operationId = "streamEventsV2";
			await expectRejected("operation", operationChange);

			const discriminatorOverlap = structuredClone(additive);
			const discriminator =
				discriminatorOverlap.components.schemas.PersistedConversationEventV1
					.oneOf[0].properties.type;
			delete discriminator.const;
			discriminator.enum = ["text.delta", "model.selection.fell_back"];
			await expectRejected("existing-discriminator", discriminatorOverlap);

			const removedRequired = structuredClone(additive);
			removedRequired.components.schemas.PersistedConversationEventV1.oneOf[0].required =
				["type"];
			await expectRejected("existing-required", removedRequired);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("accepts only the agent-summary OpenAPI addition", async () => {
		const current = JSON.parse(
			await readFile(pilotBrowserArtifactPath, "utf8"),
		);
		const options = current.components.schemas.ExecutionProcessSummaryV1.oneOf;
		const summaryIndex = options.findIndex(
			(option: { properties?: { kind?: { const?: string } } }) =>
				option.properties?.kind?.const === "agent_summary",
		);
		expect(summaryIndex).toBeGreaterThanOrEqual(0);
		const previous = structuredClone(current);
		previous.components.schemas.ExecutionProcessSummaryV1.oneOf.splice(
			summaryIndex,
			1,
		);
		const directory = await mkdtemp(
			resolve(tmpdir(), "agent-infra-agent-summary-"),
		);
		const previousPath = resolve(directory, "previous.json");
		const expectResult = async (
			name: string,
			candidate: unknown,
			status: number,
		) => {
			const currentPath = resolve(directory, `${name}.json`);
			await Promise.all([
				writeFile(previousPath, JSON.stringify(previous), "utf8"),
				writeFile(currentPath, JSON.stringify(candidate), "utf8"),
			]);
			const result = comparePaths(currentPath, previousPath);
			expect(result.status, name).toBe(status);
			if (status === 0) {
				expect(result.stderr, name).toBe("");
			} else {
				expect(result.stderr, name).toContain("changed OpenAPI contract");
			}
		};

		try {
			await expectResult("additive", current, 0);

			const wrongCategory = structuredClone(current);
			wrongCategory.components.schemas.ExecutionProcessSummaryV1.oneOf[
				summaryIndex
			].properties.category.enum.push("credential");
			await expectResult("wrong-category", wrongCategory, 1);

			const extraField = structuredClone(current);
			extraField.components.schemas.ExecutionProcessSummaryV1.oneOf[
				summaryIndex
			].properties.credential = { type: "string" };
			await expectResult("extra-field", extraField, 1);

			const operationChange = structuredClone(current);
			operationChange.info.title = "changed";
			await expectResult("other-change", operationChange, 1);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("admits only WeCom receipt and setup routes and preserves existing browser authority", async () => {
		const current = JSON.parse(
			await readFile(pilotBrowserArtifactPath, "utf8"),
		);
		const paths = [
			"/api/v1/wecom/receipts",
			"/api/v1/wecom/receipts/{receiptId}",
			"/api/v1/wecom/receipts/{receiptId}/abandon",
			"/api/v1/agents/{agentId}/wecom-bot",
			"/api/v1/agents/{agentId}/wecom-setup",
			"/api/v1/agents/{agentId}/wecom-setup/{sessionId}",
			"/api/v1/agents/{agentId}/wecom-setup/{sessionId}/credentials",
			"/api/v1/agents/{agentId}/wecom-setup/{sessionId}/cancel",
			"/api/v1/agents/{agentId}/wecom-app",
			"/api/v1/agents/{agentId}/wecom-app-setup",
			"/api/v1/agents/{agentId}/wecom-app-setup/{sessionId}",
			"/api/v1/agents/{agentId}/wecom-app-setup/{sessionId}/credentials",
			"/api/v1/agents/{agentId}/wecom-app-setup/{sessionId}/cancel",
		] as const;
		const previous = structuredClone(current);
		for (const path of paths) delete previous.paths[path];
		const directory = await mkdtemp(
			resolve(tmpdir(), "agent-infra-wecom-compatibility-"),
		);
		const previousPath = resolve(directory, "previous.json");
		const currentPath = resolve(directory, "current.json");
		try {
			await writeFile(previousPath, JSON.stringify(previous));
			await writeFile(currentPath, JSON.stringify(current));
			expect(comparePaths(currentPath, previousPath).status).toBe(0);
			const mutations = [
				(document: typeof current) => {
					delete document.paths[paths[0]];
				},
				(document: typeof current) => {
					document.paths[paths[2]].post.operationId = "retryDelivery";
				},
				(document: typeof current) => {
					document.paths[paths[6]].post.requestBody = {};
				},
				(document: typeof current) => {
					document.paths[paths[0]].get.responses = {};
				},
				(document: typeof current) => {
					delete document.paths["/api/v1/agents"];
				},
				(document: typeof current) => {
					document.components.schemas = {};
				},
			];
			for (const mutate of mutations) {
				const changed = structuredClone(current);
				mutate(changed);
				await writeFile(currentPath, JSON.stringify(changed));
				expect(comparePaths(currentPath, previousPath).status).toBe(1);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("accepts only the Runtime status-recovery V2 addition", async () => {
		const current = JSON.parse(
			await readFile(runtimeHostV2ArtifactPath, "utf8"),
		);
		const previous = structuredClone(current);
		delete previous.paths["/internal/runtime/v2/status"];
		delete previous.components.schemas.RuntimeStatusRequestV2;
		delete previous.components.schemas.RuntimeStatusResponseV2;
		const directory = await mkdtemp(
			resolve(tmpdir(), "agent-infra-runtime-status-recovery-"),
		);
		const previousPath = resolve(directory, "previous.json");
		const currentPath = resolve(directory, "current.json");
		try {
			await Promise.all([
				writeFile(previousPath, JSON.stringify(previous), "utf8"),
				writeFile(currentPath, JSON.stringify(current), "utf8"),
			]);
			expect(comparePaths(currentPath, previousPath).status).toBe(0);

			const changed = structuredClone(current);
			changed.components.schemas.RuntimeStatusRequestV2.properties.recovery.properties.schemaVersion.const = 2;
			await writeFile(currentPath, JSON.stringify(changed), "utf8");
			expect(comparePaths(currentPath, previousPath).status).toBe(1);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("admits only the pinned administrator Agent read and preserves every existing contract", async () => {
		const current = JSON.parse(
			await readFile(
				new URL(
					"../artifacts/openapi/pilot-browser.v2.openapi.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		const path = "/api/v2/admin/agents";
		const previous = structuredClone(current);
		delete previous.paths[path];
		const directory = await mkdtemp(
			resolve(tmpdir(), "agent-infra-admin-read-v2-"),
		);
		const previousPath = resolve(directory, "previous.json");
		const currentPath = resolve(directory, "current.json");
		try {
			await writeFile(previousPath, JSON.stringify(previous));
			await writeFile(currentPath, JSON.stringify(current));
			expect(comparePaths(currentPath, previousPath).status).toBe(0);
			for (const [name, mutate] of [
				[
					"operation",
					(document: typeof current) => {
						document.paths[path].get.operationId = "unreviewed";
					},
				],
				[
					"query",
					(document: typeof current) => {
						document.paths[path].get.parameters = [];
					},
				],
				[
					"response",
					(document: typeof current) => {
						document.paths[path].get.responses["200"].content[
							"application/json"
						].schema.required = [];
					},
				],
				[
					"operation-security",
					(document: typeof current) => {
						document.paths[path].get.security = [];
					},
				],
				[
					"document-security",
					(document: typeof current) => {
						document.security = [];
					},
				],
				[
					"old-operation",
					(document: typeof current) => {
						document.paths["/api/v2/agents"].get.operationId = "unreviewed";
					},
				],
				[
					"old-component",
					(document: typeof current) => {
						document.components.schemas.AgentProjectionV2.required = [];
					},
				],
				[
					"old-security",
					(document: typeof current) => {
						document.components.securitySchemes = {};
					},
				],
				[
					"extra-path",
					(document: typeof current) => {
						document.paths["/api/v2/admin/unreviewed"] = {};
					},
				],
				[
					"extra-method",
					(document: typeof current) => {
						document.paths[path].post = document.paths[path].get;
					},
				],
			] as const) {
				const changed = structuredClone(current);
				mutate(changed);
				await writeFile(currentPath, JSON.stringify(changed));
				const result = comparePaths(currentPath, previousPath);
				expect(result.status, name).toBe(1);
				expect(result.stderr, name).toContain("changed OpenAPI contract");
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("admits only the V2 lifecycle addition and preserves existing audit authority", async () => {
		const current = JSON.parse(
			await readFile(
				new URL(
					"../artifacts/openapi/pilot-browser.v2.openapi.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		// Isolate lifecycle from later personal API/Relay Key and registration additions.
		restorePreRelayKeyContract(current);
		delete current.paths["/api/v2/applications"];
		delete current.paths["/api/v2/applications/{applicationId}"];
		for (const name of [
			"ApplicationMetadataV1",
			"ApplicationRegistrationRequestV1",
			"ApplicationRegistrationResponseV1",
		])
			delete current.components.schemas[name];
		delete current.paths["/api/v2/agents"].get.security;
		delete current.paths["/api/v2/agents"].get.description;
		const previous = structuredClone(current);
		for (const path of Object.keys(previous.paths)) {
			if (
				path !== "/api/v2/admin/audit" &&
				path !== "/api/v2/me/conversations/recent" &&
				path !== "/api/v2/me/api-credentials" &&
				path !== "/api/v2/me/api-credentials/{credentialId}" &&
				!path.startsWith("/api/v2/conversations/")
			)
				delete previous.paths[path];
		}
		for (const name of [
			"AgentApplicationCreateRequestV2",
			"AgentApplicationProjectionV2",
			"AgentApplicationUpdateRequestV2",
			"AgentConfigurationProjectionV2",
			"AgentConfigurationUpdateRequestV2",
			"AgentLifecycleCommandRequestV1",
			"AgentProjectionV2",
			"ApprovalDecisionRequestV1",
			"DeploymentConfigurationProjectionV2",
			"DeploymentConfigurationStatusV2",
			"DeploymentModelCatalogProjectionV2",
			"DeploymentModelEndpointProjectionV2",
			"DeploymentModelProjectionV2",
			"DeploymentTemplateProjectionV2",
		])
			delete previous.components.schemas[name];
		const directory = await mkdtemp(
			resolve(tmpdir(), "agent-infra-lifecycle-v2-"),
		);
		const previousPath = resolve(directory, "previous.json");
		const currentPath = resolve(directory, "current.json");
		try {
			await writeFile(previousPath, JSON.stringify(previous), "utf8");
			await writeFile(currentPath, JSON.stringify(current), "utf8");
			expect(comparePaths(currentPath, previousPath).status).toBe(0);
			for (const mutate of [
				(document: typeof current) => {
					delete document.paths["/api/v2/agents"];
				},
				(document: typeof current) => {
					document.paths["/api/v2/unreviewed"] = {};
				},
				(document: typeof current) => {
					document.paths["/api/v2/admin/audit"].get.operationId = "changed";
				},
				(document: typeof current) => {
					document.components.schemas.AgentApplicationCreateRequestV2.required =
						[];
				},
				(document: typeof current) => {
					document.components.schemas.PlatformAuditProjectionV2.required = [];
				},
				(document: typeof current) => {
					document.info.title = "changed";
				},
			]) {
				const changed = structuredClone(current);
				mutate(changed);
				await writeFile(currentPath, JSON.stringify(changed), "utf8");
				expect(comparePaths(currentPath, previousPath).status).toBe(1);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("admits only the existing resource-unavailable response added to V2 SSE", async () => {
		const current = JSON.parse(
			await readFile(
				new URL(
					"../artifacts/openapi/pilot-browser.v2.openapi.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		const path = "/api/v2/conversations/{conversationId}/events";
		const previous = structuredClone(current);
		delete previous.paths[path].get.responses["404"];
		const directory = await mkdtemp(resolve(tmpdir(), "agent-infra-sse404-"));
		const previousPath = resolve(directory, "previous.json");
		const currentPath = resolve(directory, "current.json");
		try {
			await writeFile(previousPath, JSON.stringify(previous));
			await writeFile(currentPath, JSON.stringify(current));
			expect(comparePaths(currentPath, previousPath).status).toBe(0);
			for (const mutate of [
				(document: typeof current) => {
					document.paths[path].get.responses["404"].description = "changed";
				},
				(document: typeof current) => {
					document.paths[path].get.responses["200"].description = "changed";
				},
				(document: typeof current) => {
					document.paths["/api/v2/agents"].get.operationId = "changed";
				},
			]) {
				const changed = structuredClone(current);
				mutate(changed);
				await writeFile(currentPath, JSON.stringify(changed));
				expect(comparePaths(currentPath, previousPath).status).toBe(1);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("admits reviewed V2 operation reads while preserving lifecycle and audit", async () => {
		const current = JSON.parse(
			await readFile(
				new URL(
					"../artifacts/openapi/pilot-browser.v2.openapi.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		const previous = structuredClone(current);
		for (const path of Object.keys(previous.paths)) {
			if (path.startsWith("/api/v2/conversations/"))
				delete previous.paths[path];
		}
		for (const name of [
			"AuthorizationRevokedSignalV1",
			"ConversationDetailProjectionV2",
			"ConversationSseMessageV1",
			"ConversationSseMessageV2",
			"ExecutionDetailProjectionV2",
			"ExecutionOperationEventV2",
			"HeartbeatSignalV1",
			"ModelSelectionFallbackEventV1",
			"PersistedConversationEventV1",
			"PersistedConversationEventV2",
			"RuntimeConnectionAssociationV1",
			"RuntimeOperationFactV2",
			"RuntimeOperationFailureV2",
			"SseEventIdV1",
			"TimelineReloadSignalV1",
		])
			delete previous.components.schemas[name];
		const directory = await mkdtemp(
			resolve(tmpdir(), "agent-infra-operation-v2-"),
		);
		const previousPath = resolve(directory, "previous.json");
		const currentPath = resolve(directory, "current.json");
		try {
			await writeFile(previousPath, JSON.stringify(previous));
			await writeFile(currentPath, JSON.stringify(current));
			expect(comparePaths(currentPath, previousPath).status).toBe(0);
			for (const mutate of [
				(document: typeof current) => {
					delete document.paths["/api/v2/conversations/{conversationId}/events"]
						.get.responses["404"];
				},
				(document: typeof current) => {
					document.paths[
						"/api/v2/conversations/{conversationId}/events"
					].get.responses["404"].description = "changed";
				},
				(document: typeof current) => {
					delete document.paths[
						"/api/v2/conversations/{conversationId}/events"
					];
				},
				(document: typeof current) => {
					document.components.schemas.RuntimeOperationFactV2.required = [];
				},
				(document: typeof current) => {
					document.paths["/api/v2/agents"].get.operationId = "changed";
				},
				(document: typeof current) => {
					document.components.schemas.PlatformAuditProjectionV2.required = [];
				},
				(document: typeof current) => {
					document.paths["/api/v2/conversations/unreviewed"] = {};
				},
			]) {
				const changed = structuredClone(current);
				mutate(changed);
				await writeFile(currentPath, JSON.stringify(changed));
				expect(comparePaths(currentPath, previousPath).status).toBe(1);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it.each([
		["removed", "removed"],
		["narrowed", "narrowed"],
		["retyped", "retyped"],
	])("rejects %s schema changes", (fixture, reason) => {
		const result = compare(fixture);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(reason);
	});

	it("accepts only the exact file addition and rejects altered authorization, limits and old operations", async () => {
		const current = JSON.parse(
			await readFile(pilotBrowserArtifactPath, "utf8"),
		);
		const previous = structuredClone(current);
		for (const path of Object.keys(previous.paths))
			if (path.includes("/files")) delete previous.paths[path];
		for (const name of Object.keys(previous.components.schemas))
			if (name.startsWith("File")) delete previous.components.schemas[name];
		delete previous.components.schemas.MessageCommandRequestV1.properties
			.attachments;
		const directory = await mkdtemp(
			resolve(tmpdir(), "agent-infra-files-compatibility-"),
		);
		const previousPath = resolve(directory, "previous.json");
		const currentPath = resolve(directory, "current.json");
		try {
			await writeFile(previousPath, JSON.stringify(previous));
			await writeFile(currentPath, JSON.stringify(current));
			expect(comparePaths(currentPath, previousPath).status).toBe(0);
			const changedPath = structuredClone(current);
			delete changedPath.paths[
				"/api/v1/conversations/{conversationId}/files/{fileId}/content"
			].get.parameters;
			const changedScope = structuredClone(current);
			delete changedScope.components.schemas.FileAccessClaimsV1.properties
				.actorId;
			const changedLimit = structuredClone(current);
			changedLimit.components.schemas.MessageCommandRequestV1.properties.attachments.maxItems = 64;
			const required = structuredClone(current);
			required.components.schemas.MessageCommandRequestV1.required.push(
				"attachments",
			);
			const oldOperation = structuredClone(current);
			delete oldOperation.paths[
				"/api/v1/conversations/{conversationId}/messages"
			].post;
			for (const changed of [
				changedPath,
				changedScope,
				changedLimit,
				required,
				oldOperation,
			]) {
				await writeFile(currentPath, JSON.stringify(changed));
				expect(comparePaths(currentPath, previousPath).status).toBe(1);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it.each([
		["removed", "removed"],
		["narrowed", "narrowed"],
		["retyped", "retyped"],
	])("rejects %s schema changes", (fixture, reason) => {
		const result = compare(fixture);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(reason);
	});

	it("rejects adding an overlapping oneOf option", () => {
		const result = compare("advanced-narrowed", "advanced-base");
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("narrowed $defs.ExclusiveChoiceV1 oneOf");
		expect(result.stderr).toContain(
			"narrowed $defs.DiscriminatedChoiceV1 oneOf",
		);
		expect(result.stderr).toContain(
			"narrowed $defs.UntypedDiscriminatedChoiceV1 oneOf",
		);
	});

	it("rejects shortening a closed tuple prefix", () => {
		const result = compare("advanced-narrowed", "advanced-base");
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("narrowed $defs.TupleV1[0] prefixItems");
	});

	it("rejects replacing a true schema with false", () => {
		const result = compare("advanced-narrowed", "advanced-base");
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("narrowed $defs.BooleanSchemaV1 schema");
	});

	it("rejects constraining a property previously governed by an open object", () => {
		const result = compare("advanced-narrowed", "advanced-base");
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("narrowed $defs.OpenObjectV1.foo property");
	});

	it.each(["--previous", "--current"])(
		"rejects an unpaired %s fixture argument",
		(option) => {
			const result = spawnSync(
				process.execPath,
				[cliPath, option, fixturePath("base")],
				{ encoding: "utf8" },
			);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("Usage: compatibility.mjs");
		},
	);

	it("rejects adding a dependent required property", () => {
		const result = compare("advanced-narrowed", "advanced-base");
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"narrowed $defs.DependentObjectV1.creditCard dependentRequired billingAddress",
		);
	});

	it("rejects nested definition and pattern-property narrowings", () => {
		const result = compare("advanced-narrowed", "advanced-base");
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("retyped $defs.NestedDefsV1.$defs.Value");
		expect(result.stderr).toContain(
			"narrowed $defs.PatternObjectV1.^x patternProperties",
		);
		expect(result.stderr).toContain(
			"retyped $defs.PatternExplicitV1.x patternProperties ^x",
		);
		expect(result.stderr).toContain(
			"removed $defs.RemovedNestedDefV1.$defs.Value",
		);
		expect(result.stderr).toContain(
			"removed $defs.UnusedNestedDefV1.$defs.Value",
		);
		expect(result.stderr).toContain(
			"retyped $defs.PatternToPropertyV1.x property ^x",
		);
	});

	it("fails closed for unsupported evaluation constraints", () => {
		const result = compare("advanced-narrowed", "advanced-base");
		expect(result.status).toBe(1);
		for (const keyword of [
			"dependentSchemas",
			"if",
			"then",
			"else",
			"unevaluatedProperties",
			"unevaluatedItems",
		]) {
			expect(result.stderr).toContain(keyword);
		}
	});

	it("accepts removed constraints and proven one-to-many schema widening", () => {
		const result = compare("advanced-widened", "advanced-base");
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
	});
});
