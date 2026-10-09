import assert from "node:assert/strict";
import test from "node:test";

test("provider entry points preserve executor identity and published action arrays", async () => {
	for (const [provider, file, executor] of [
		["github", "index.ts", "OpenConnectorGitHubAdapter"],
		["bitbucket", "bitbucket-server.ts", "BitbucketServerAdapter"],
		["confluence", "confluence-server.ts", "ConfluenceServerAdapter"],
		["jira", "jira-server.ts", "JiraServerAdapter"],
		["datalego", "datalego-v6.ts", "DataLegoV6Adapter"],
		["manhattan", "manhattan.ts", "ManhattanAdapter"],
		["rehoboam", "rehoboam-v11.ts", "RehoboamV11Adapter"],
		["static-spaces", "static-spaces.ts", "StaticSpacesAdapter"],
	] as const) {
		const current = await import(`./providers/${provider}/index.ts`);
		const legacy = await import(`./${file}`);
		assert.equal(
			current[executor],
			legacy[executor],
			provider + " executor identity changed",
		);
		assert.equal(
			current.actions,
			current.providerDefinition.actions,
			provider + " duplicated its action schema",
		);
	}
	const jenkins = await import("./providers/jenkins/index.ts");
	const legacyJenkins = await import("./jenkins.ts");
	assert.equal(jenkins.JenkinsAdapter, legacyJenkins.JenkinsAdapter);
	assert.equal(
		jenkins.actions.ci,
		legacyJenkins.jenkinsCiConnectionCatalog.actions,
	);
	assert.equal(
		jenkins.actions.release,
		legacyJenkins.jenkinsReleaseConnectionCatalog.actions,
	);
});
