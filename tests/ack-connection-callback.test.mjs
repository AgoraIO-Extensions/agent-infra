import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseAllDocuments } from "yaml";

const chart = "deploy/ack/chart";
const authPath = "/var/run/agent-infra/connection-callback-auth/callback.auth";
const reference = [
	"--set",
	"platformApi.connectionCallbackAuthSecretRef.name=approved-callback-auth",
	"--set",
	"platformApi.connectionCallbackAuthSecretRef.key=callback.auth",
];
const render = (...args) =>
	parseAllDocuments(
		execFileSync("helm", ["template", "callback-test", chart, ...args], {
			encoding: "utf8",
		}),
	)
		.map((document) => document.toJSON())
		.filter(Boolean);
const api = (resources) =>
	resources.find(
		(item) =>
			item.kind === "Deployment" && item.metadata.name === "agent-infra-api",
	)?.spec.template.spec;

test("ACK without a callback SecretRef keeps the callback receiver unconfigured", () => {
	const pod = api(render());
	assert(
		!pod.initContainers?.some(
			(item) => item.name === "connection-callback-auth",
		),
	);
	assert(
		!pod.volumes.some((item) =>
			item.name.startsWith("connection-callback-auth"),
		),
	);
	assert(
		!pod.containers[0].env.some(
			(item) => item.name === "PLATFORM_API_CONNECTION_CALLBACK_AUTH_FILE",
		),
	);
});

test("ACK prepares the owner-only callback file required by the forwarder", async (t) => {
	const pod = api(render(...reference));
	const container = pod.containers[0];
	assert.equal(
		container.env.find(
			(item) => item.name === "PLATFORM_API_CONNECTION_CALLBACK_AUTH_FILE",
		)?.value,
		authPath,
	);
	const init = pod.initContainers.find(
		(item) => item.name === "connection-callback-auth",
	);
	assert.equal(init.image, container.image);
	assert.equal(pod.securityContext.runAsUser, 1000);
	assert.equal(pod.securityContext.fsGroup, 1000);
	assert.equal(init.securityContext.runAsUser, undefined);
	assert.equal(init.securityContext.allowPrivilegeEscalation, false);
	assert.deepEqual(init.securityContext.capabilities, { drop: ["ALL"] });
	assert.equal(init.securityContext.readOnlyRootFilesystem, true);
	const source = pod.volumes.find(
		(item) => item.name === "connection-callback-auth-source",
	);
	assert.deepEqual(source.secret, {
		secretName: "approved-callback-auth",
		defaultMode: 0o440,
		items: [{ key: "callback.auth", path: "callback.auth" }],
	});
	assert.deepEqual(
		pod.volumes.find((item) => item.name === "connection-callback-auth")
			.emptyDir,
		{ medium: "Memory", sizeLimit: "16Ki" },
	);
	assert.deepEqual(
		container.volumeMounts.find(
			(item) => item.name === "connection-callback-auth",
		),
		{
			name: "connection-callback-auth",
			mountPath: "/var/run/agent-infra/connection-callback-auth",
			readOnly: true,
		},
	);
	assert(!container.volumeMounts.some((item) => item.name === source.name));

	// Run the rendered initializer: a projected Secret's group-readable mode
	// must become an owner-only regular file before the forwarder reads it.
	const directory = await mkdtemp(join(tmpdir(), "ack-callback-auth-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const input = join(directory, "projected");
	const output = join(directory, "callback.auth");
	const material = "synthetic-callback-auth-material";
	await writeFile(input, material, { mode: 0o440 });
	const args = [...init.args];
	assert.equal(args.at(-2), "/callback-source/callback.auth");
	assert.equal(args.at(-1), authPath);
	args.splice(-2, 2, input, output);
	execFileSync(init.command[0], [...init.command.slice(1), ...args]);
	const metadata = await stat(output);
	assert.equal(metadata.mode & 0o777, 0o600);
	assert.equal(metadata.uid, process.getuid());
	assert.equal(metadata.nlink, 1);
	assert.equal(await readFile(output, "utf8"), material);
});

test("ACK callback initialization coexists with the Skill scanner initializer", () => {
	const pod = api(
		render(
			...reference,
			"--set",
			"skillHub.enabled=true,agentVersion=callback-test-v1",
		),
	);
	assert.deepEqual(pod.initContainers.map((item) => item.name).sort(), [
		"connection-callback-auth",
		"skill-scanner-runtime",
	]);
});

for (const invalid of [
	"platformApi.connectionCallbackAuthSecretRef.name=approved-callback-auth",
	"platformApi.connectionCallbackAuthSecretRef.name=approved-callback-auth,platformApi.connectionCallbackAuthSecretRef.key=../callback.auth",
])
	test(`ACK rejects malformed callback SecretRef: ${invalid}`, () => {
		const result = spawnSync(
			"helm",
			["template", "callback-test", chart, "--set", invalid],
			{
				encoding: "utf8",
			},
		);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /connectionCallbackAuthSecretRef/);
	});
