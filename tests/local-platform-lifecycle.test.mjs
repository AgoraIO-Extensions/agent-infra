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
elif [[ "$*" == *"container inspect isolated-control-plane"* ]]; then
  printf '%s\\n' "$FAKE_KIND_LABEL"
elif [[ "$*" == *"port isolated-control-plane 6443/tcp"* ]]; then
  printf '%s\\n' "$FAKE_KIND_PORT"
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
elif [[ "$*" == *"get deployment agent-infra-verify-agent-infra-platform-worker -o jsonpath="* ]]; then
  printf '%s' "$FAKE_WORKER_REPLICAS"
elif [[ "$*" == *"get pods -l app.kubernetes.io/instance=agent-infra-verify,app.kubernetes.io/component=platform-worker"* ]]; then
  printf '%s' "$FAKE_WORKER_PODS"
elif [[ "$*" == *"get statefulsets -l agent-infra.agora.io/agent"* ]]; then
  printf '%s' "$FAKE_AGENT_WORKLOADS"
elif [[ "$*" == *"get pods -l agent-infra.agora.io/agent"* ]]; then
  printf '%s' "$FAKE_AGENT_PODS"
else
  printf 'kubectl %s\\n' "$*" >> "$COMMAND_LOG"
  if [[ "$*" == *"scale deployment/agent-infra-verify-agent-infra-platform-worker --replicas=1"* && -n "$FAKE_RESTORE_SCALE_EXIT" ]]; then
    exit "$FAKE_RESTORE_SCALE_EXIT"
  fi
fi`,
	);
	const env = {
		...process.env,
		PATH: `${bin}:${process.env.PATH}`,
		COMMAND_LOG: log,
		FAKE_KUBE_SERVER: "https://127.0.0.1:6443",
		FAKE_KIND_LABEL: "isolated",
		FAKE_KIND_PORT: "127.0.0.1:6443",
		FAKE_AGENT_WORKLOADS: "",
		FAKE_AGENT_PODS: "",
		FAKE_WORKER_REPLICAS: "1",
		FAKE_WORKER_PODS: "",
		FAKE_RESTORE_SCALE_EXIT: "",
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
			/helm .* uninstall agent-infra-verify --ignore-not-found --wait --timeout 5m/,
		);
		assert.match(stop, /compose .* stop web platform-api/);
		assert.match(stop, /compose .* stop object-storage postgres/);
		assert.match(
			stop,
			/kubectl .* scale deployment\/agent-infra-verify-agent-infra-platform-worker --replicas=0/,
		);
		const stopSteps = stop.trim().split("\n");
		assert.match(stopSteps[0], /compose .* stop web platform-api/);
		assert.match(stopSteps[1], /kubectl .* scale .* --replicas=0/);
		assert.match(stopSteps[2], /kubectl .* rollout status/);
		assert.match(stopSteps[3], /helm .* uninstall/);
		assert.match(stopSteps[4], /compose .* stop object-storage postgres/);
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

test("local stop keeps Compose running if Worker uninstall fails", async () => {
	const f = await fixture();
	try {
		const result = run("stop", { ...f.env, FAKE_HELM_UNINSTALL_EXIT: "7" });
		assert.equal(result.status, 1);
		const log = await readFile(f.log, "utf8");
		assert.match(
			log,
			/helm .* uninstall agent-infra-verify --ignore-not-found --wait --timeout 5m/,
		);
		assert.match(log, /compose .* up --detach --wait platform-api web/);
		assert.doesNotMatch(log, /compose .* stop object-storage postgres/);
	} finally {
		await f.close();
	}
});

test("local stop leaves API closed when Worker restoration fails", async () => {
	const f = await fixture();
	try {
		const result = run("stop", {
			...f.env,
			FAKE_HELM_UNINSTALL_EXIT: "7",
			FAKE_RESTORE_SCALE_EXIT: "8",
		});
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /API and Web remain stopped/);
		const log = await readFile(f.log, "utf8");
		assert.match(log, /compose .* stop web platform-api/);
		assert.doesNotMatch(log, /compose .* up --detach --wait platform-api web/);
		assert.doesNotMatch(log, /compose .* stop object-storage postgres/);
	} finally {
		await f.close();
	}
});

test("local commands reject a mismatched Docker kind endpoint and namespace", async () => {
	const f = await fixture();
	try {
		const wrongPort = run("up", {
			...f.env,
			FAKE_KIND_PORT: "127.0.0.1:7443",
		});
		assert.notEqual(wrongPort.status, 0);
		assert.match(wrongPort.stderr, /does not match the local kind/);
		const wrongLabel = run("status", {
			...f.env,
			FAKE_KIND_LABEL: "other-cluster",
		});
		assert.notEqual(wrongLabel.status, 0);
		assert.match(wrongLabel.stderr, /label does not match/);
		const wrongNamespace = run("stop", {
			...f.env,
			PLATFORM_LOCAL_NAMESPACE: "another-project",
		});
		assert.notEqual(wrongNamespace.status, 0);
		assert.match(
			wrongNamespace.stderr,
			/must match the isolated Compose project/,
		);
		assert.equal(await readFile(f.log, "utf8"), "");
	} finally {
		await f.close();
	}
});

test("local stop refuses active Agent Workloads and Pods before uninstall", async () => {
	const f = await fixture();
	try {
		const activeWorkload = run("stop", {
			...f.env,
			FAKE_AGENT_WORKLOADS: "agent-1 1\n",
		});
		assert.notEqual(activeWorkload.status, 0);
		assert.match(activeWorkload.stderr, /Stop each Agent/);
		assert.match(
			await readFile(f.log, "utf8"),
			/compose .* up --detach --wait platform-api web/,
		);
		await writeFile(f.log, "");

		const activePod = run("stop", {
			...f.env,
			FAKE_AGENT_WORKLOADS: "agent-1 0\n",
			FAKE_AGENT_PODS: "pod/agent-1-0\n",
		});
		assert.notEqual(activePod.status, 0);
		assert.match(activePod.stderr, /Agent Pods to terminate/);
		assert.match(
			await readFile(f.log, "utf8"),
			/compose .* up --detach --wait platform-api web/,
		);
	} finally {
		await f.close();
	}
});
