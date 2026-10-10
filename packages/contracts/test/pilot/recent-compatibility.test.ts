import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });

const path = "/api/v2/me/conversations/recent";
const cli = fileURLToPath(
	new URL("../../src/compatibility.mjs", import.meta.url),
);
const document = JSON.parse(
	await readFile(
		new URL(
			"../../artifacts/openapi/pilot-browser.v2.openapi.json",
			import.meta.url,
		),
		"utf8",
	),
);

describe("recent personal conversation additive compatibility", () => {
	it.each(["absent", "empty", "existing", "existingBearer"])(
		"preserves the entire old document when cookie schemes were %s",
		async (cookieBaseline) => {
			const current = structuredClone(document);
			if (cookieBaseline !== "existingBearer") {
				// Historical recent-only fixtures precede the later personal Agent read.
				delete current.paths["/api/v2/agents"].get.security;
				delete current.paths["/api/v2/agents"].get.description;
				delete current.components.securitySchemes.platformApiCredential;
			}
			const previous = structuredClone(current);
			delete previous.paths[path];
			if (cookieBaseline !== "existing" && cookieBaseline !== "existingBearer")
				delete previous.components.securitySchemes.PlatformSession;
			if (cookieBaseline === "absent")
				delete previous.components.securitySchemes;
			const directory = await mkdtemp(join(tmpdir(), "agent-infra-recent-"));
			const previousPath = join(directory, "previous.json");
			const currentPath = join(directory, "current.json");
			const compare = () =>
				spawnSync(
					process.execPath,
					[cli, "--previous", previousPath, "--current", currentPath],
					{ encoding: "utf8" },
				);
			try {
				await writeFile(previousPath, JSON.stringify(previous));
				await writeFile(currentPath, JSON.stringify(current));
				expect(compare().status).toBe(0);
				for (const [name, mutate] of [
					[
						"operation",
						(d: typeof document) => {
							d.paths[path].get.operationId = "changed";
						},
					],
					[
						"path",
						(d: typeof document) => {
							d.paths[`${path}/changed`] = d.paths[path];
							delete d.paths[path];
						},
					],
					[
						"method",
						(d: typeof document) => {
							d.paths[path].post = d.paths[path].get;
						},
					],
					[
						"identity-query",
						(d: typeof document) => {
							d.paths[path].get.parameters.push({
								in: "query",
								name: "actorId",
								schema: { type: "string" },
							});
						},
					],
					[
						"limit-default",
						(d: typeof document) => {
							d.paths[path].get.parameters[1].schema.default = 51;
						},
					],
					[
						"limit-minimum",
						(d: typeof document) => {
							d.paths[path].get.parameters[1].schema.minimum = 0;
						},
					],
					[
						"limit-maximum",
						(d: typeof document) => {
							d.paths[path].get.parameters[1].schema.maximum = 101;
						},
					],
					[
						"required-limit",
						(d: typeof document) => {
							d.paths[path].get.parameters[1].required = true;
						},
					],
					[
						"cursor",
						(d: typeof document) => {
							d.paths[path].get.parameters[0].schema.minLength = 0;
						},
					],
					[
						"body",
						(d: typeof document) => {
							d.paths[path].get.requestBody = {};
						},
					],
					[
						"schema-version",
						(d: typeof document) => {
							d.paths[path].get.responses[200].content[
								"application/json"
							].schema.properties.items.items.properties.schemaVersion.const =
								2;
						},
					],
					[
						"response",
						(d: typeof document) => {
							d.paths[path].get.responses[200].content[
								"application/json"
							].schema.required = [];
						},
					],
					[
						"errors",
						(d: typeof document) => {
							delete d.paths[path].get.responses[503];
						},
					],
					[
						"security",
						(d: typeof document) => {
							d.paths[path].get.security = [];
						},
					],
					[
						"cookie-name",
						(d: typeof document) => {
							d.components.securitySchemes.PlatformSession.name = "other";
						},
					],
					[
						"cookie-location",
						(d: typeof document) => {
							d.components.securitySchemes.PlatformSession.in = "header";
						},
					],
					[
						"cookie-definition",
						(d: typeof document) => {
							delete d.components.securitySchemes.PlatformSession;
						},
					],
					[
						"old-path",
						(d: typeof document) => {
							d.paths["/api/v2/agents"].get.operationId = "changed";
						},
					],
					[
						"old-component",
						(d: typeof document) => {
							d.components.schemas.AgentProjectionV2.required = [];
						},
					],
					[
						"old-security",
						(d: typeof document) => {
							d.security = [];
						},
					],
					[
						"unrelated-bearer",
						(d: typeof document) => {
							d.components.securitySchemes.platformApiCredential = {
								type: "http",
								scheme: "basic",
							};
						},
					],
					[
						"extra-scheme",
						(d: typeof document) => {
							d.components.securitySchemes.Other = {
								type: "http",
								scheme: "bearer",
							};
						},
					],
				] as const) {
					const changed = structuredClone(current);
					mutate(changed);
					await writeFile(currentPath, JSON.stringify(changed));
					const result = compare();
					expect(result.status, name).toBe(1);
					expect(result.stderr, name).toContain("changed OpenAPI contract");
				}
				if (
					cookieBaseline === "existing" ||
					cookieBaseline === "existingBearer"
				) {
					previous.components.securitySchemes.PlatformSession.name = "old-name";
					await writeFile(previousPath, JSON.stringify(previous));
					await writeFile(currentPath, JSON.stringify(current));
					expect(compare().status).toBe(1);
				}
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		},
		120_000,
	);
});
