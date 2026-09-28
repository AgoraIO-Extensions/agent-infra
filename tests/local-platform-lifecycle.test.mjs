import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = "deploy/local/platform.sh";

async function executable(directory, name, body) {
	const path = join(directory, name);
	await writeFile(path, `#!/usr/bin/env bash\n${body}\n`);
	await chmod(path, 0o755);
}

async function fixture() {
	const directory = await mkdtemp(
		join(tmpdir(), "agent-infra-local-lifecycle-"),
	);
	const bin = join(directory, "bin");
	const api = join(directory, "api");
	await mkdir(bin);
	await mkdir(api);
	const log = join(directory, "commands.log");
	const kubeconfig = join(directory, "kubeconfig");
	const values = join(directory, "worker.values.yaml");
	const cert = join(directory, "tls.crt");
	const key = join(directory, "tls.key");
	await Promise.all([
		writeFile(log, ""),
		writeFile(kubeconfig, "fixture"),
		writeFile(
			values,
			"platformWorker:\n  deploymentModule: file:///app/dist/deployment.mjs\n",
		),
		writeFile(join(api, "platform-api.mjs"), ""),
		writeFile(cert, ""),
		writeFile(key, ""),
	]);
	await executable(
		bin,
		"docker",
		`
if [[ "$*" == *"context inspect"* ]]; then
  printf 'unix:///private/isolated/docker.sock\\n'
else
  printf 'docker %s\\n' "$*" >> "$COMMAND_LOG"
fi`,
	);
	await executable(
		bin,
		"helm",
		`
printf 'helm %s\\n' "$*" >> "$COMMAND_LOG"
if [[ "$*" == *"uninstall"* && -n "$FAKE_HELM_UNINSTALL_EXIT" ]]; then
  exit "$FAKE_HELM_UNINSTALL_EXIT"
fi`,
	);
	await executable(
		bin,
		"kubectl",
		`
if [[ "$*" == *"config view"* ]]; then
  printf '%s' "$FAKE_KUBE_SERVER"
else
  printf 'kubectl %s\\n' "$*" >> "$COMMAND_LOG"
fi`,
	);
	const env = {
		...process.env,
		PATH: `${bin}:${process.env.PATH}`,
		COMMAND_LOG: log,
		FAKE_KUBE_SERVER: "https://127.0.0.1:6443",
		FAKE_HELM_UNINSTALL_EXIT: "",
		PLATFORM_LOCAL_DOCKER_CONTEXT: "isolated",
		PLATFORM_LOCAL_PROJECT: "agent-infra-verify",
		PLATFORM_LOCAL_API_DIRECTORY: api,
		PLATFORM_WEB_TLS_CERT_FILE: cert,
		PLATFORM_WEB_TLS_KEY_FILE: key,
		PLATFORM_LOCAL_KUBECONFIG: kubeconfig,
		PLATFORM_LOCAL_KUBE_CONTEXT: "kind-isolated",
		PLATFORM_LOCAL_NAMESPACE: "agent-infra-verify",
		PLATFORM_LOCAL_WORKER_VALUES: values,
	};
	return {
		env,
		log,
		async close() {
			await rm(directory, { recursive: true, force: true });
		},
	};
}

function run(command, env) {
	return spawnSync("bash", [script, command], {
		cwd: process.cwd(),
		env,
		encoding: "utf8",
	});
}

test("local up, status and stop bind one Worker release to the private kind context", async () => {
	const f = await fixture();
	try {
		assert.equal(run("up", f.env).status, 0);
		const up = (await readFile(f.log, "utf8")).trim().split("\n");
		assert.match(
			up[0],
			/^helm .*--kubeconfig .* --kube-context kind-isolated --namespace agent-infra-verify template agent-infra-verify /,
		);
		assert.match(up[0], /--set enterpriseDirectorySync\.enabled=false/);
		assert.match(
			up[1],
			/^docker .* compose .* up --detach --wait postgres object-storage platform-api web$/,
		);
		assert.match(up[2], /^helm .* upgrade --install agent-infra-verify /);
		assert.match(
			up[3],
			/^kubectl .* --context kind-isolated --namespace agent-infra-verify rollout status deployment\/agent-infra-verify-agent-infra-platform-worker/,
		);

		await writeFile(f.log, "");
		assert.equal(run("status", f.env).status, 0);
		const status = await readFile(f.log, "utf8");
		assert.match(
			status,
			/compose .* ps postgres object-storage platform-api web/,
		);
		assert.match(status, /helm .* status agent-infra-verify/);
		assert.match(
			status,
			/kubectl .* get deployment agent-infra-verify-agent-infra-platform-worker/,
		);

		await writeFile(f.log, "");
		assert.equal(run("stop", f.env).status, 0);
		const stop = await readFile(f.log, "utf8");
		assert.match(
			stop,
			/helm .* uninstall agent-infra-verify --ignore-not-found/,
		);
		assert.match(
			stop,
			/compose .* stop web platform-api object-storage postgres/,
		);
		assert.doesNotMatch(stop, /--volumes|delete|down/);
	} finally {
		await f.close();
	}
});

test("local up rejects remote Kubernetes and missing Worker values before starting services", async () => {
	const f = await fixture();
	try {
		const remote = run("up", {
			...f.env,
			FAKE_KUBE_SERVER: "https://api.example.invalid:6443",
		});
		assert.notEqual(remote.status, 0);
		assert.match(remote.stderr, /loopback endpoint/);
		assert.equal(await readFile(f.log, "utf8"), "");

		const missingValues = run("up", {
			...f.env,
			PLATFORM_LOCAL_WORKER_VALUES: join(
				tmpdir(),
				"missing-worker-values.yaml",
			),
		});
		assert.notEqual(missingValues.status, 0);
		assert.match(missingValues.stderr, /absolute readable file/);
		assert.equal(await readFile(f.log, "utf8"), "");
	} finally {
		await f.close();
	}
});

test("local stop still stops Compose if Worker uninstall fails and reports the failure", async () => {
	const f = await fixture();
	try {
		const result = run("stop", { ...f.env, FAKE_HELM_UNINSTALL_EXIT: "7" });
		assert.equal(result.status, 7);
		const log = await readFile(f.log, "utf8");
		assert.match(
			log,
			/helm .* uninstall agent-infra-verify --ignore-not-found/,
		);
		assert.match(
			log,
			/compose .* stop web platform-api object-storage postgres/,
		);
	} finally {
		await f.close();
	}
});
