import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

const read = (path) => readFile(path, "utf8");

test("production code reaches PostgreSQL only through connection-store", async () => {
	const apiManifest = JSON.parse(
		await read("apps/connection-api/package.json"),
	);
	const entrypoint = await read("apps/connection-api/src/index.ts");
	const productionBootstrap = await read(
		"apps/connection-api/src/bootstrap-production.ts",
	);
	const productionApp = await read("apps/connection-api/src/production-app.ts");
	const runtimeApp = await read("apps/connection-api/src/runtime-app.ts");

	assert.equal(apiManifest.dependencies.postgres, undefined);
	assert.match(
		apiManifest.devDependencies["@agent-infra/connection-store"],
		/^workspace:/,
	);
	assert.match(
		apiManifest.devDependencies["@agent-infra/connection-core"],
		/^workspace:/,
	);
	assert.equal(
		apiManifest.dependencies["@agent-infra/connection-store"],
		undefined,
	);
	assert.equal(
		apiManifest.dependencies["@agent-infra/connection-core"],
		undefined,
	);
	assert.doesNotMatch(entrypoint, /@agent-infra\/connection-store/);
	assert.doesNotMatch(entrypoint, /from "postgres"/);
	assert.doesNotMatch(productionApp, /@agent-infra\/connection-store/);
	assert.doesNotMatch(productionApp, /from "postgres"/);
	assert.match(runtimeApp, /from "@agent-infra\/connection-store"/);
	assert.doesNotMatch(runtimeApp, /from "postgres"/);
	assert.match(
		productionBootstrap,
		/from "@agent-infra\/connection-store\/migrations"/,
	);
	assert.doesNotMatch(
		productionBootstrap,
		/from "@agent-infra\/connection-store";/,
	);
});

test("production startup cannot opt into fixture invocation or provider routes", async () => {
	const entrypoint = await read("apps/connection-api/src/index.ts");
	const productionApp = await read("apps/connection-api/src/production-app.ts");
	const runtimeApp = await read("apps/connection-api/src/runtime-app.ts");
	const productionBootstrap = await read(
		"apps/connection-api/src/bootstrap-production.ts",
	);
	const productionCompose = parse(await read("docker-compose.production.yml"));
	const productionDockerfile = await read("apps/connection-api/Dockerfile");

	assert.match(entrypoint, /from "\.\/production-app"/);
	assert.match(productionApp, /createConnectionApp/);
	assert.doesNotMatch(entrypoint, /ConnectionApplicationService/);
	assert.doesNotMatch(entrypoint, /RemoteOidcIdentityVerifier/);
	assert.doesNotMatch(entrypoint, /OpenConnectorGitHubAdapter/);
	assert.doesNotMatch(productionApp, /ConnectionOAuthService/);
	assert.doesNotMatch(productionApp, /LdapDirectoryAuthenticator/);
	assert.match(runtimeApp, /ConnectionOAuthService/);
	assert.match(runtimeApp, /LdapDirectoryAuthenticator/);
	assert.match(runtimeApp, /PostgresConnectionRepository/);
	assert.match(runtimeApp, /OpenConnectorGitHubAdapter/);
	assert.match(runtimeApp, /dynamicClientRegistration:/);
	assert.match(runtimeApp, /clientName: config\.directConsumer\.name/);
	assert.match(runtimeApp, /githubProviderEnabled: false/);
	assert.doesNotMatch(productionApp, /OpenConnectorGitHubAdapter/);
	assert.doesNotMatch(productionBootstrap, /bootstrapProductionCodex\(/);
	assert.doesNotMatch(productionBootstrap, /INSERT INTO connection_/);
	assert.doesNotMatch(productionDockerfile, /src\/development\.ts/);
	assert.doesNotMatch(productionDockerfile, /src\/conformance(?:-app)?\.ts/);
	assert.doesNotMatch(productionDockerfile, /src\/runtime-app\.ts/);
	assert.doesNotMatch(productionDockerfile, /src\/migrate\.ts/);
	assert.doesNotMatch(entrypoint, /@agent-infra\/connection-store/);
	assert.deepEqual(Object.keys(productionCompose.services), [
		"connection-bootstrap",
		"connection-api",
	]);
	assert.equal(
		productionCompose.services["connection-api"].environment,
		undefined,
	);
	assert.equal(productionCompose.services["connection-api"].secrets, undefined);
	assert.equal(productionCompose.services["connection-api"].ports, undefined);
	assert.equal(
		productionCompose.services["connection-api"].env_file,
		undefined,
	);
});

test("all Consumers use the account-backed Connection without a Runtime profile", async () => {
	const manifest = JSON.parse(await read("package.json"));
	const apiManifest = JSON.parse(
		await read("apps/connection-api/package.json"),
	);
	const adapterManifest = JSON.parse(
		await read("packages/openconnector-adapter/package.json"),
	);
	const buildConfig = await read("apps/connection-api/tsdown.config.ts");
	const dockerfile = await read("apps/connection-api/Dockerfile");
	const readme = await read("README.md");

	assert.equal(manifest.scripts["connection:local"], undefined);
	assert.equal(manifest.scripts["openconnector:runtime:build"], undefined);
	assert.equal(apiManifest.scripts.local, undefined);
	assert.equal(adapterManifest.exports, "./src/index.ts");
	assert.doesNotMatch(buildConfig, /local-runtime/);
	assert.doesNotMatch(dockerfile, /local-runtime/);
	assert.doesNotMatch(readme, /LOCAL_SINGLE_USER|REMOTE_SHARED/);
	assert.match(readme, /codex mcp login connection/);
});
