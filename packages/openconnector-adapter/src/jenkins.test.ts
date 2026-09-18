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
	assert.equal(first.actions[0]?.id, "jenkins-ci.get_current_user@v3");
	assert.equal(second.actions[0]?.name, "jenkins-release.get_current_user");
	assert.equal(second.providerReleaseId, "jenkins-release-connection-v3");
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

test("Jenkins returns bounded unredacted progressive console output", async () => {
	const requests: Request[] = [];
	const secretLikeText = "token=not-redacted\n";
	const adapter = new JenkinsAdapter(
		jenkinsReleaseProfile,
		async (input, init) => {
			requests.push(new Request(input, init));
			return new Response(secretLikeText, {
				headers: { "x-more-data": "false", "x-text-size": "19" },
			});
		},
	);
	const result = await adapter.execute({
		action: "jenkins-release.get_build_console",
		credential: { accessToken: credential },
		input: { buildNumber: 901, jobFullName: "EP/build_all", start: 0 },
	});
	assert.deepEqual(result, {
		moreData: false,
		nextStart: 19,
		text: secretLikeText,
		truncated: false,
	});
	assert.equal(
		requests[0]?.url,
		"http://114.94.148.35:8010/job/EP/job/build_all/901/logText/progressiveText?start=0",
	);
});

test("Jenkins truncates a console page at 256 KiB", async () => {
	const adapter = new JenkinsAdapter(
		jenkinsReleaseProfile,
		async () =>
			new Response("x".repeat(256 * 1024 + 1), {
				headers: { "x-more-data": "false", "x-text-size": "262145" },
			}),
	);
	const result = (await adapter.execute({
		action: "jenkins-release.get_build_console",
		credential: { accessToken: credential },
		input: { buildNumber: 901, jobFullName: "EP/build_all", start: 10 },
	})) as {
		moreData: boolean;
		nextStart: number;
		text: string;
		truncated: boolean;
	};
	assert.equal(Buffer.byteLength(result.text), 256 * 1024);
	assert.equal(result.nextStart, 10 + 256 * 1024);
	assert.equal(result.moreData, true);
	assert.equal(result.truncated, true);
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

test("Jenkins exposes bounded Provider failure metadata", async () => {
	const missing = new JenkinsAdapter(
		jenkinsReleaseProfile,
		async () => new Response("missing", { status: 404 }),
	);
	await assert.rejects(
		missing.execute({
			action: "jenkins-release.get_queue_item",
			credential: { accessToken: credential },
			input: { queueItemId: 3831811 },
		}),
		(error: Error & { providerStatus?: number }) => error.providerStatus === 404,
	);

	const timedOut = new JenkinsAdapter(jenkinsReleaseProfile, async () => {
		throw Object.assign(new Error("aborted"), { name: "AbortError" });
	});
	await assert.rejects(
		timedOut.execute({
			action: "jenkins-release.get_job",
			credential: { accessToken: credential },
			input: { jobFullName: "EP/build_all" },
		}),
		(error: Error & { providerUnavailable?: boolean }) =>
			error.providerUnavailable === true,
	);
});
