import assert from "node:assert/strict";
import test from "node:test";

import {
	createJenkinsConnectionCatalog,
	JenkinsAdapter,
	jenkinsCiProfile,
	jenkinsReleaseProfile,
} from "./jenkins.ts";

const credential = JSON.stringify({ apiToken: "api-token", username: "alice" });

test("Jenkins deployment profiles have isolated catalog identities", () => {
	const first = createJenkinsConnectionCatalog(jenkinsCiProfile);
	const second = createJenkinsConnectionCatalog(jenkinsReleaseProfile);
	assert.notEqual(first.provider, second.provider);
	assert.notEqual(first.providerReleaseId, second.providerReleaseId);
	assert.equal(first.actions[0]?.name, "jenkins-ci.get_current_user");
	assert.equal(second.actions[0]?.name, "jenkins-release.get_current_user");
});

test("Jenkins validates identity without returning the API Token", async () => {
	const requests: Request[] = [];
	const adapter = new JenkinsAdapter(jenkinsCiProfile, async (input, init) => {
		requests.push(new Request(input, init));
		return Response.json({
			authenticated: true,
			anonymous: false,
			name: "alice",
		});
	});
	const identity = await adapter.validateCredential(credential);
	assert.equal(identity.externalAccount, "alice");
	assert.equal(identity.displayName, "alice");
	assert.equal(identity.accessToken, credential);
	assert.equal(
		requests[0]?.url,
		"https://jenkins-ci.agoralab.co/whoAmI/api/json",
	);
	assert.match(requests[0]?.headers.get("authorization") ?? "", /^Basic /);

	const visible = await adapter.execute({
		action: "jenkins-ci.get_current_user",
		credential: { accessToken: credential },
		input: {},
	});
	assert.equal("accessToken" in visible, false);
});

test("Jenkins encodes folder jobs and only uses the fixed deployment origin", async () => {
	const urls: string[] = [];
	const adapter = new JenkinsAdapter(jenkinsCiProfile, async (input) => {
		urls.push(String(input));
		return Response.json({ ok: true });
	});
	await adapter.execute({
		action: "jenkins-ci.get_build",
		credential: { accessToken: credential },
		input: { buildNumber: 42, jobFullName: "SDK/Mac Release" },
	});
	assert.deepEqual(urls, [
		"https://jenkins-ci.agoralab.co/job/SDK/job/Mac%20Release/42/api/json",
	]);
});

test("Jenkins rejects path injection before provider access", async () => {
	let called = false;
	const adapter = new JenkinsAdapter(jenkinsCiProfile, async () => {
		called = true;
		return Response.json({});
	});
	await assert.rejects(
		adapter.execute({
			action: "jenkins-ci.get_job",
			credential: { accessToken: credential },
			input: { jobFullName: "SDK/../admin" },
		}),
		/jobFullName is invalid/,
	);
	assert.equal(called, false);
});

test("Jenkins credential validation fails closed on auth errors and redirects", async () => {
	for (const response of [
		new Response("denied", { status: 401 }),
		new Response(null, {
			headers: { location: "https://oauth.example" },
			status: 302,
		}),
	]) {
		const adapter = new JenkinsAdapter(jenkinsCiProfile, async () => response);
		await assert.rejects(
			adapter.validateCredential(credential),
			(error: Error & { providerCredentialInvalid?: boolean }) =>
				error.providerCredentialInvalid === true,
		);
	}
});
