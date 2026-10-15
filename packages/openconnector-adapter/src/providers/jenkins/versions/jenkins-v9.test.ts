import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { type Schema, Validator } from "@cfworker/json-schema";
import { createJenkinsConnectionCatalog as legacyCatalog } from "./jenkins.ts";
import {
	createJenkinsConnectionCatalog,
	JenkinsAdapter,
	jenkinsCiProfile,
	jenkinsReleaseProfile,
} from "./jenkins-v9.ts";

const credential = {
	accessToken: JSON.stringify({ username: "alice", apiToken: "test-token" }),
};
const inline = {
	kind: "inline",
	script:
		"pipeline { agent any; stages { stage('a') { steps { echo '<&>' } } } }",
};
const original = `<flow-definition plugin="workflow-job"><description>old</description><properties><custom secret="preserve">value</custom></properties><definition class="org.jenkinsci.plugins.workflow.cps.CpsFlowDefinition"><script>echo 'old'</script><sandbox>true</sandbox></definition><triggers><timer>nightly</timer></triggers><disabled>false</disabled></flow-definition>`;
const digest = (raw: string) => createHash("sha256").update(raw).digest("hex");
function setup(handler: (request: Request) => Response | Promise<Response>) {
	const requests: Request[] = [];
	const adapter = new JenkinsAdapter(jenkinsCiProfile, async (input, init) => {
		const request = new Request(input, init);
		requests.push(request);
		return handler(request);
	});
	return {
		requests,
		run: (action: string, input: Record<string, unknown>) =>
			adapter.execute({ action: `jenkins-ci.${action}`, credential, input }),
	};
}

test("v9 isolated deployment catalogs keep legacy immutable and validate definitions", () => {
	for (const profile of [jenkinsCiProfile, jenkinsReleaseProfile]) {
		const catalog = createJenkinsConnectionCatalog(profile);
		assert.equal(
			catalog.providerReleaseId,
			`${profile.providerId}-connection-v9`,
		);
		assert.equal(
			catalog.actions.length,
			legacyCatalog(profile).actions.length + 8,
		);
		assert.ok(catalog.actions.every((action) => action.id.endsWith("@v9")));
		assert.equal(
			legacyCatalog(profile).providerReleaseId,
			`${profile.providerId}-connection-v8`,
		);
		const action = catalog.actions.find((item) =>
			item.name.endsWith(".create_pipeline"),
		);
		assert.ok(action);
		const validator = new Validator(action.inputSchema as Schema);
		assert.equal(
			validator.validate({ jobFullName: "SDK/new", definition: inline }).valid,
			true,
		);
		assert.equal(
			validator.validate({
				jobFullName: "SDK/new",
				definition: { ...inline, sandbox: false },
			}).valid,
			false,
		);
	}
});

test("create/read/update round trip escapes XML and preserves non-target settings", async () => {
	let config = original;
	const state = setup(async (request) => {
		if (request.method === "GET" && request.url.endsWith("config.xml"))
			return new Response(config);
		if (request.method === "GET")
			return Response.json({
				_class: "com.cloudbees.hudson.plugins.folder.Folder",
			});
		config = await request.text();
		return new Response(null, { status: 200 });
	});
	await state.run("create_pipeline", {
		jobFullName: "SDK/new",
		definition: inline,
		description: "<&>",
	});
	assert.match(
		state.requests.at(-1)?.url ?? "",
		/\/job\/SDK\/createItem\?name=new$/,
	);
	assert.match(config, /&lt;&amp;&gt;/);
	const created = await state.run("get_pipeline_config", {
		jobFullName: "SDK/new",
	});
	assert.deepEqual(created.definition, { ...inline, sandbox: true });
	config = original;
	await state.run("update_pipeline", {
		jobFullName: "SDK/new",
		expectedConfigSha256: digest(original),
		definition: inline,
	});
	assert.match(config, /<custom secret="preserve">value<\/custom>/);
	assert.match(config, /<timer>nightly<\/timer>/);
	assert.match(config, /<description>old<\/description>/);
	assert.ok(state.requests.every((request) => !request.url.endsWith("/build")));
});

test("Git SCM round trip references credentials without secrets", async () => {
	let config = "";
	const state = setup(async (request) => {
		if (request.method === "POST") {
			config = await request.text();
			return new Response();
		}
		return new Response(config);
	});
	const git = {
		kind: "git",
		url: "ssh://git@example.test/team/repo.git",
		branch: "*/main",
		scriptPath: "ci/Jenkinsfile",
		credentialsId: "scm-read",
		lightweight: true,
	};
	await state.run("create_pipeline", { jobFullName: "new", definition: git });
	assert.deepEqual(
		(await state.run("get_pipeline_config", { jobFullName: "new" })).definition,
		git,
	);
});

test("invalid inputs never write; stale hashes and unsafe XML fail closed", async () => {
	const state = setup(() => new Response(original));
	for (const name of [
		"../bad",
		"SDK//bad",
		"SDK/%2e%2e",
		"SDK/a\\b",
		"SDK/a?b",
	])
		await assert.rejects(
			state.run("create_pipeline", { jobFullName: name, definition: inline }),
		);
	for (const definition of [
		{ ...inline, sandbox: false },
		{
			kind: "git",
			url: "https://user:secret@example.test/repo",
			branch: "main",
			scriptPath: "Jenkinsfile",
		},
		{
			kind: "git",
			url: "https://example.test/repo",
			branch: "main",
			scriptPath: "../Jenkinsfile",
		},
	])
		await assert.rejects(
			state.run("create_pipeline", { jobFullName: "new", definition }),
		);
	await assert.rejects(
		state.run("update_pipeline", {
			jobFullName: "new",
			expectedConfigSha256: "0".repeat(64),
			definition: inline,
		}),
		/changed/,
	);
	assert.ok(state.requests.every((request) => request.method === "GET"));
	for (const raw of [
		`<!DOCTYPE foo [<!ENTITY x SYSTEM "file:///etc/passwd">]>${original}`,
		original.replace("<sandbox>true", "<sandbox>false"),
		"<flow-definition><unclosed>",
		original.replace("flow-definition", "project"),
	]) {
		const bad = setup(() => new Response(raw));
		await assert.rejects(
			bad.run("get_pipeline_config", { jobFullName: "new" }),
		);
	}
});

test("enable/disable require preview hash, cancel checks exact queue ownership", async () => {
	const state = setup((request) =>
		request.url.endsWith("config.xml")
			? new Response(original)
			: request.method === "GET"
				? Response.json({
						task: {
							name: "new",
							url: `${jenkinsCiProfile.apiOrigin}/job/SDK/job/new/`,
						},
					})
				: new Response(),
	);
	for (const action of ["enable_pipeline", "disable_pipeline"])
		await state.run(action, {
			jobFullName: "SDK/new",
			expectedConfigSha256: digest(original),
		});
	await state.run("cancel_queue_item", {
		jobFullName: "SDK/new",
		queueItemId: 42,
	});
	assert.equal(
		state.requests.at(-1)?.url,
		`${jenkinsCiProfile.apiOrigin}/queue/cancelItem?id=42`,
	);
	const bad = setup(() =>
		Response.json({
			task: { url: `${jenkinsCiProfile.apiOrigin}/job/other/` },
		}),
	);
	await assert.rejects(
		bad.run("cancel_queue_item", { jobFullName: "SDK/new", queueItemId: 42 }),
		/belong/,
	);
	assert.equal(bad.requests.length, 1);
});

test("folder pages and parameter discovery hide password defaults", async () => {
	const state = setup((request) =>
		request.url.includes("parameterDefinitions")
			? Response.json({
					property: [
						{
							parameterDefinitions: [
								{
									name: "branch",
									type: "StringParameterDefinition",
									defaultParameterValue: { value: "main" },
								},
								{
									name: "password",
									type: "PasswordParameterDefinition",
									defaultParameterValue: { value: "never-return" },
								},
								{
									name: "plugin",
									type: "Unknown",
									defaultParameterValue: { value: "never-return" },
								},
							],
						},
					],
				})
			: Response.json({
					_class: "com.cloudbees.hudson.plugins.folder.Folder",
					jobs: Array.from({ length: 101 }, (_, i) => ({ name: String(i) })),
				}),
	);
	const params = await state.run("get_build_parameters", {
		jobFullName: "new",
	});
	assert.doesNotMatch(JSON.stringify(params), /never-return/);
	const page = await state.run("list_folder_jobs", {
		folderFullName: "SDK",
		offset: 100,
	});
	assert.equal((page.jobs as unknown[]).length, 100);
	assert.equal(page.moreData, true);
	assert.equal(page.nextOffset, 200);
});

test("write conflict/permission rejection deterministic, 5xx/lost response unknown without retry", async () => {
	for (const status of [400, 403, 409, 500]) {
		const state = setup(() => new Response(null, { status }));
		await assert.rejects(
			state.run("create_pipeline", { jobFullName: "new", definition: inline }),
			(
				error: Error & {
					providerStatus?: number;
					submissionUncertain?: boolean;
				},
			) =>
				error.providerStatus === status &&
				(status < 500
					? !error.submissionUncertain
					: error.submissionUncertain === true),
		);
		assert.equal(state.requests.length, 1);
	}
	const lost = setup(() => {
		throw new TypeError("socket closed");
	});
	await assert.rejects(
		lost.run("create_pipeline", { jobFullName: "new", definition: inline }),
		(error: Error & { submissionUncertain?: boolean }) =>
			error.submissionUncertain === true,
	);
	assert.equal(lost.requests.length, 1);
	const redirect = setup(
		() =>
			new Response(null, {
				status: 302,
				headers: { location: "https://evil.test/login" },
			}),
	);
	await assert.rejects(
		redirect.run("create_pipeline", { jobFullName: "new", definition: inline }),
	);
	assert.equal(redirect.requests.length, 1);
});

test("bounded streamed reads, DTD and XML complexity cannot reach write", async () => {
	for (const raw of [
		"x".repeat(262145),
		`<flow-definition>${"<x>".repeat(65)}${"</x>".repeat(65)}</flow-definition>`,
	]) {
		const state = setup(() => new Response(raw));
		await assert.rejects(
			state.run("get_pipeline_config", { jobFullName: "new" }),
		);
		assert.equal(state.requests.length, 1);
	}
});

test("CI identity and gateway remain isolated; legacy builds delegate without version drift", async () => {
	let gatewayCalls = 0;
	const requests: Request[] = [];
	const adapter = new JenkinsAdapter(
		jenkinsCiProfile,
		async (input, init) => {
			const request = new Request(input, init);
			requests.push(request);
			return request.url.includes("whoAmI")
				? Response.json({ name: "alice", authenticated: true })
				: new Response(null, { status: 201 });
		},
		{
			async getAccessToken() {
				gatewayCalls++;
				return "test-gateway";
			},
		},
	);
	const identity = await adapter.validateCredential(credential.accessToken);
	assert.equal(identity.providerReleaseId, "jenkins-ci-connection-v9");
	await adapter.execute({
		action: "jenkins-ci.create_pipeline",
		credential,
		input: { jobFullName: "new", definition: inline },
	});
	await adapter.execute({
		action: "jenkins-ci.build_job",
		credential,
		input: { jobFullName: "new" },
	});
	assert.equal(gatewayCalls, 3);
	assert.ok(
		requests.every(
			(request) =>
				request.headers.get("accessToken") === "test-gateway" &&
				request.url.startsWith(jenkinsCiProfile.apiOrigin),
		),
	);
});

test("read retries only before an HTTP response and queue aliases stay fixed", async () => {
	const pre = setup(() => {
		throw new TypeError("connect failed");
	});
	await assert.rejects(pre.run("get_pipeline_config", { jobFullName: "new" }));
	assert.equal(pre.requests.length, 2);
	const body = setup(
		() =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.error(new TypeError("body lost"));
					},
				}),
			),
	);
	await assert.rejects(body.run("get_pipeline_config", { jobFullName: "new" }));
	assert.equal(body.requests.length, 1);
	const alias = setup((request) =>
		request.method === "POST"
			? new Response()
			: Response.json({
					task: { url: "https://jenkins-ci.agoralab.co/job/SDK/job/new/" },
				}),
	);
	await alias.run("cancel_queue_item", {
		jobFullName: "SDK/new",
		queueItemId: 1,
	});
	assert.equal(alias.requests.length, 2);
});

test("legacy Pipeline without description can be read and given a description", async () => {
	let config = original.replace("<description>old</description>", "");
	const state = setup(async (request) => {
		if (request.method === "POST") {
			config = await request.text();
			return new Response();
		}
		return new Response(config);
	});
	const current = await state.run("get_pipeline_config", {
		jobFullName: "new",
	});
	assert.equal(current.description, "");
	await state.run("update_pipeline", {
		jobFullName: "new",
		expectedConfigSha256: current.configSha256,
		definition: inline,
		description: "new description",
	});
	assert.match(config, /<description>new description<\/description>/);
});
