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

test("production startup uses the formal runtime without fixture invocation", async () => {
	const entrypoint = await read("apps/connection-api/src/index.ts");
	const productionApp = await read("apps/connection-api/src/production-app.ts");
	const runtimeApp = await read("apps/connection-api/src/runtime-app.ts");
	const productionBootstrap = await read(
		"apps/connection-api/src/bootstrap-production.ts",
	);
	const productionCompose = parse(await read("docker-compose.production.yml"));
	const productionDockerfile = await read("apps/connection-api/Dockerfile");

	assert.match(entrypoint, /from "\.\/production-app"/);
	assert.match(
		productionApp,
		/createConnectionRuntimeApp as createProductionConnectionApp/,
	);
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
	assert.match(productionDockerfile, /src\/runtime-app\.ts/);
	assert.doesNotMatch(productionDockerfile, /src\/migrate\.ts/);
	assert.doesNotMatch(entrypoint, /@agent-infra\/connection-store/);
	assert.deepEqual(Object.keys(productionCompose.services), [
		"connection-bootstrap",
		"connection-api",
		"connection-web",
	]);
	assert.deepEqual(
		new Set(productionCompose.services["connection-api"].environment),
		new Set([
			"DATABASE_URL",
			"CONNECTION_PUBLIC_BASE_URL",
			"CONNECTION_IDENTITY_KEY",
			"CONNECTION_CREDENTIAL_KEY",
			"CONNECTION_DIRECT_CONSUMER_ID",
			"CONNECTION_DIRECT_CONSUMER_NAME",
			"GITHUB_OAUTH_CLIENT_ID",
			"GITHUB_OAUTH_CLIENT_SECRET",
			"GITHUB_OAUTH_AUTHORIZATION_URL",
			"GITHUB_OAUTH_TOKEN_URL",
			"JIRA_TOKEN_SERVER_URL",
			"JIRA_TOKEN_CLIENT_ID",
			"JIRA_TOKEN_CLIENT_SECRET",
			"JIRA_TOKEN_USERNAME",
			"JIRA_TOKEN_PASSWORD",
			"LDAP_URL",
			"LDAP_ISSUER",
			"LDAP_USERS_BASE_DN",
			"LDAP_SERVICE_BIND_DN",
			"LDAP_SERVICE_BIND_PASSWORD",
			"LDAP_USERNAME_ATTRIBUTE",
			"LDAP_UID_ATTRIBUTE",
			"LDAP_EMAIL_ATTRIBUTE",
			"LDAP_DISPLAY_NAME_ATTRIBUTE",
			"LDAP_ACTIVE_ATTRIBUTE",
			"LDAP_ACTIVE_VALUE",
			"LDAP_CONNECT_TIMEOUT_MS",
			"LDAP_OPERATION_TIMEOUT_MS",
		]),
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
	assert.deepEqual(adapterManifest.exports, {
		".": "./src/index.ts",
		"./confluence-server": "./src/confluence-server.ts",
		"./jira-server": "./src/jira-server.ts",
	});
	assert.doesNotMatch(buildConfig, /local-runtime/);
	assert.doesNotMatch(dockerfile, /local-runtime/);
	assert.doesNotMatch(readme, /LOCAL_SINGLE_USER|REMOTE_SHARED/);
	assert.match(readme, /codex mcp login connection/);
});

test("Connection management presentation belongs only to connection-web", async () => {
	const apiRoutes = await read("apps/connection-api/src/oauth-routes.ts");
	const webManifest = JSON.parse(
		await read("apps/connection-web/package.json"),
	);

	assert.equal(webManifest.name, "@agent-infra/connection-web");
	for (const legacyPage of [
		"consoleLoginPage",
		"tokenConsolePage",
		"connectionConsolePage",
		"administratorConsolePage",
		"sharedGithubAdministrationPage",
		"authorizationPreviewPage",
	]) {
		assert.doesNotMatch(apiRoutes, new RegExp(`function ${legacyPage}\\b`));
	}
	for (const legacyRoute of [
		'app.get("/connection/login"',
		'app.get("/connection/tokens"',
		'app.get("/connection/connections"',
		'app.get("/connection/admin/administrators"',
		'app.get("/connection/admin/shared-connections"',
	]) {
		assert.doesNotMatch(
			apiRoutes,
			new RegExp(legacyRoute.replace(/[()/]/g, "\\$&")),
		);
	}
	assert.match(apiRoutes, /app\.get\("\/api\/v1\/connection\/connections"/);
	assert.match(apiRoutes, /function loginPage\b/);
});
