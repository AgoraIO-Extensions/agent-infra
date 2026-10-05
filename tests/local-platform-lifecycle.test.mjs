import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
const proxyTokenValue = Buffer.from("a".repeat(32)).toString("base64url");

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
	const manifest = join(directory, "database-route.yaml");
	const networkState = join(directory, "kind-network-connected");
	const routeState = join(directory, "database-route.json");
	const kubeconfig = join(directory, "kubeconfig");
	const values = join(directory, "worker.values.yaml");
	const cert = join(directory, "tls.crt");
	const key = join(directory, "tls.key");
	const proxyToken = join(directory, "proxy-token");
	const localState = join(directory, "state");
	await Promise.all([
		writeFile(log, ""),
		writeFile(kubeconfig, "fixture"),
		writeFile(
			values,
			"platformWorker:\n  configurationModuleSecretRef:\n    name: fixture-worker-configuration\n    key: configuration.mjs\n  runtimeAuthSecretRef:\n    name: fixture-worker-auth\n    privateKeyKey: runtime-grant.pem\n    serviceTokenKey: service-token\n  deploymentModule: file:///app/dist/deployment.mjs\n",
		),
		writeFile(
			join(api, "configuration.mjs"),
			[
				'export const ldap = { url: "ldaps://directory.example.invalid", issuer: "fixture", baseDn: "dc=example,dc=invalid", serviceBindDn: "cn=service", serviceBindPassword: "fixture", loginAttribute: "uid", uidAttribute: "uid", emailAttribute: "mail", displayNameAttribute: "displayName", verifyCurrentStatus: async () => "active", identityIds: { findByUid: async () => null, findUidByUserId: async () => null, getOrCreate: async () => "00000000-0000-4000-8000-000000000000" } };',
				"export const isPlatformDisabled = async () => false;",
				"export const organizationIds = async () => [];",
				'export const publicOrigin = "https://localhost:3001";',
				"export const directorySearch = async () => [];",
				'export const apiInput = { imageRepository: "registry.example/agent", loadAuthorityContext: async () => ({}), modelCatalog: { revision: "catalog-v1", load: async () => ({}) }, encryptionKeys: {}, resourceProfile: {} };',
				"",
			].join("\n"),
		),
		writeFile(cert, ""),
		writeFile(key, ""),
		writeFile(proxyToken, proxyTokenValue, { mode: 0o600 }),
	]);
	await executable(
		bin,
		"node",
		`
if [[ "$1" == "deploy/local/check-api-auth.ts" ]]; then
  printf 'node %s\\n' "$*" >> "$COMMAND_LOG"
  exit "\${FAKE_AUTH_PROBE_EXIT:-0}"
fi
exec "$REAL_NODE" "$@"`,
	);
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
elif [[ "$*" == *"compose"*"ps --all -q postgres"* ]]; then
  printf 'fixture-postgres\\n'
elif [[ "$*" == *"compose"*"ps -q postgres"* ]]; then
  [[ "$FAKE_CONTAINER_RUNNING" == 1 ]] && printf 'fixture-postgres\\n'
elif [[ "$*" == *"compose"*"config --format json"* ]]; then
  printf '{"services":{"platform-api":{"environment":{"PLATFORM_DATABASE_URL":"%s"}}}}\\n' "$FAKE_DATABASE_URL"
elif [[ "$*" == *"compose"*"run --rm --no-deps platform-api"* ]]; then
  [[ -r "$PLATFORM_LOCAL_PROXY_RUNTIME_TOKEN_FILE" ]] || exit 9
  printf 'docker %s\\n' "$*" >> "$COMMAND_LOG"
elif [[ "$*" == *"container inspect fixture-postgres"*"IPAddress"* ]]; then
  printf '172.18.0.42\\n'
elif [[ "$*" == *"container inspect fixture-postgres"* ]]; then
  if [[ -f "$FAKE_NETWORK_STATE" ]]; then cat "$FAKE_NETWORK_STATE"; else printf '%s' "$FAKE_PRECONNECTED_ALIASES"; fi
elif [[ "$*" == *"network connect --alias "*" kind fixture-postgres"* ]]; then
  command="$*"
  alias="\${command#*--alias }"
  alias="\${alias%% kind fixture-postgres*}"
  printf '%s' "$alias" > "$FAKE_NETWORK_STATE"
  printf 'docker %s\\n' "$*" >> "$COMMAND_LOG"
elif [[ "$*" == *"network disconnect kind fixture-postgres"* ]]; then
  rm -f "$FAKE_NETWORK_STATE"
  printf 'docker %s\\n' "$*" >> "$COMMAND_LOG"
else
  printf 'docker %s\\n' "$*" >> "$COMMAND_LOG"
fi`,
	);
	await executable(
		bin,
		"helm",
		`
printf 'helm %s\\n' "$*" >> "$COMMAND_LOG"
if [[ "$*" == *" template "* ]]; then
  cat <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: fixture-worker
spec:
  template:
    spec:
      containers:
        - name: platform-worker
          env:
            - name: PLATFORM_DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: agent-infra-verify-postgres
                  key: url
          volumeMounts:
            - name: deployment-module
              mountPath: /app/dist/configuration.mjs
              subPath: configuration.mjs
      volumes:
        - name: deployment-module
          secret:
            secretName: fixture-worker-configuration
            items:
              - key: worker-config
                path: configuration.mjs
        - name: runtime-auth
          secret:
            secretName: fixture-worker-auth
            items:
              - key: runtime-grant.pem
              - key: service-token
        - name: decryption-keyring
          secret:
            secretName: agent-infra-worker-decryption-keyring
            items:
              - key: keyring.pem
YAML
elif [[ "$*" == *"uninstall"* && -n "$FAKE_HELM_UNINSTALL_EXIT" ]]; then
  exit "$FAKE_HELM_UNINSTALL_EXIT"
elif [[ "$*" == *"upgrade --install"* && -n "$FAKE_HELM_UPGRADE_EXIT" ]]; then
  exit "$FAKE_HELM_UPGRADE_EXIT"
elif [[ "$*" == *"get values agent-infra-verify --all --output json"* ]]; then
  printf '{"platformWorker":{"replicas":%s}}\\n' "$FAKE_CONFIGURED_WORKER_REPLICAS"
elif [[ "$*" == *"list --all --filter ^agent-infra-verify$ -q"* ]]; then
  printf '%s' "$FAKE_HELM_LIST_RESULT"
fi`,
	);
	await executable(
		bin,
		"kubectl",
		`
if [[ "$*" == *"config view"* ]]; then
  printf '%s' "$FAKE_KUBE_SERVER"
elif [[ "$*" == *"--ignore-not-found -o json" ]]; then
  if [[ "$*" == *"get pvc/"* ]]; then
    printf '%s\\n' "$FAKE_AGENT_PVC_JSON"
  elif [[ "$*" == *"get statefulset/"* ]]; then
    printf '%s\\n' "$FAKE_AGENT_STATEFULSET_JSON"
  elif [[ -n "$FAKE_FOREIGN_RESOURCE" && "$*" == *"get $FAKE_FOREIGN_RESOURCE "* ]]; then
    printf '%s\\n' '{"metadata":{"labels":{"app.kubernetes.io/managed-by":"another-owner"}}}'
  elif [[ "$*" == *"get secret/"* && "$FAKE_SECRET_MATERIAL" == 1 ]]; then
    command="$*"
    secret_name="\${command#*get secret/}"
    secret_name="\${secret_name%% *}"
    if [[ "$secret_name" == agent-infra-verify-postgres ]]; then
      printf '{"kind":"Secret","metadata":{"name":"%s","namespace":"agent-infra-verify","labels":{"app.kubernetes.io/managed-by":"agent-infra-local","agent-infra.agora.io/local-project":"agent-infra-verify"}},"data":{"url":"eA==","configuration.mjs":"eA==","runtime-grant.pem":"eA==","service-token":"eA==","keyring.pem":"eA=="}}\\n' "$secret_name"
    elif [[ "$secret_name" == fixture-worker-configuration && "$FAKE_SECRET_MISSING_KEY" == 1 ]]; then
      printf '{"kind":"Secret","metadata":{"name":"%s","namespace":"agent-infra-verify"},"data":{"other":"eA=="}}\\n' "$secret_name"
    elif [[ "$secret_name" == fixture-worker-configuration ]]; then
      printf '{"kind":"Secret","metadata":{"name":"%s","namespace":"agent-infra-verify"},"data":{"worker-config":"eA=="}}\\n' "$secret_name"
    else
      printf '{"kind":"Secret","metadata":{"name":"%s","namespace":"agent-infra-verify"},"data":{"url":"eA==","configuration.mjs":"eA==","runtime-grant.pem":"eA==","service-token":"eA==","keyring.pem":"eA=="}}\\n' "$secret_name"
    fi
  elif [[ "$*" == *"get endpointslice/agent-infra-verify-postgres-docker "* && -f "$FAKE_ROUTE_STATE" ]]; then
    cat "$FAKE_ROUTE_STATE"
  fi
elif [[ "$*" == *"get deployment agent-infra-verify-agent-infra-platform-worker"*"-o jsonpath="* ]]; then
  printf '%s' "$FAKE_WORKER_REPLICAS"
elif [[ "$*" == *"get pods -l app.kubernetes.io/instance=agent-infra-verify,app.kubernetes.io/component=platform-worker"* ]]; then
  printf '%s' "$FAKE_WORKER_PODS"
elif [[ "$*" == *"get statefulsets -l agent-infra.agora.io/agent"* ]]; then
  printf '%s' "$FAKE_AGENT_WORKLOADS"
  if [[ -n "$FAKE_AGENT_WORKLOADS_READ_EXIT" ]]; then
    printf 'private-inventory-error-fixture\\n' >&2
    exit "$FAKE_AGENT_WORKLOADS_READ_EXIT"
  fi
elif [[ "$*" == *"get pods -l agent-infra.agora.io/agent"* ]]; then
  printf '%s' "$FAKE_AGENT_PODS"
  if [[ -n "$FAKE_AGENT_PODS_READ_EXIT" ]]; then
    printf 'private-inventory-error-fixture\\n' >&2
    exit "$FAKE_AGENT_PODS_READ_EXIT"
  fi
else
  printf 'kubectl %s\\n' "$*" >> "$COMMAND_LOG"
  if [[ "$*" == *"apply -f -"* ]]; then
    payload=$(cat)
    printf '%s\\n' "$payload" >> "$MANIFEST_LOG"
    alias=$(printf '%s\\n' "$payload" | sed -n 's/^    agent-infra.agora.io\\/local-network-alias: //p')
    if [[ -n "$alias" ]]; then
      printf '{"metadata":{"labels":{"app.kubernetes.io/managed-by":"agent-infra-local","agent-infra.agora.io/local-project":"agent-infra-verify"},"annotations":{"agent-infra.agora.io/local-network-alias":"%s"}}}' "$alias" > "$FAKE_ROUTE_STATE"
    fi
  elif [[ "$*" == *"apply --server-side"* ]]; then
    cat >> "$MANIFEST_LOG"
  elif [[ "$*" == *"delete endpointslice/agent-infra-verify-postgres-docker"* ]]; then
    rm -f "$FAKE_ROUTE_STATE"
  fi
  if [[ "$*" == *"scale deployment/agent-infra-verify-agent-infra-platform-worker --replicas=1"* && -n "$FAKE_RESTORE_SCALE_EXIT" ]]; then
    exit "$FAKE_RESTORE_SCALE_EXIT"
  fi
fi`,
	);
	const env = {
		...process.env,
		PATH: `${bin}:${process.env.PATH}`,
		REAL_NODE: process.execPath,
		COMMAND_LOG: log,
		MANIFEST_LOG: manifest,
		FAKE_NETWORK_STATE: networkState,
		FAKE_ROUTE_STATE: routeState,
		FAKE_KUBE_SERVER: "https://127.0.0.1:6443",
		FAKE_KIND_LABEL: "isolated",
		FAKE_KIND_PORT: "127.0.0.1:6443",
		FAKE_AGENT_WORKLOADS: "",
		FAKE_AGENT_WORKLOADS_READ_EXIT: "",
		FAKE_AGENT_PODS: "",
		FAKE_AGENT_PODS_READ_EXIT: "",
		FAKE_WORKER_REPLICAS: "1",
		FAKE_WORKER_PODS: "",
		FAKE_FOREIGN_RESOURCE: "",
		FAKE_PRECONNECTED_ALIASES: "",
		FAKE_CONTAINER_RUNNING: "1",
		FAKE_RESTORE_SCALE_EXIT: "",
		FAKE_HELM_UNINSTALL_EXIT: "",
		FAKE_HELM_UPGRADE_EXIT: "",
		FAKE_CONFIGURED_WORKER_REPLICAS: "1",
		FAKE_HELM_LIST_RESULT: "",
		FAKE_AUTH_PROBE_EXIT: "",
		FAKE_AGENT_PVC_JSON: "",
		FAKE_AGENT_STATEFULSET_JSON: "",
		FAKE_SECRET_MATERIAL: "1",
		FAKE_SECRET_MISSING_KEY: "0",
		FAKE_DATABASE_URL: "postgresql://fixture:fixture@postgres:5432/fixture",
		PLATFORM_LOCAL_DOCKER_CONTEXT: "isolated",
		PLATFORM_LOCAL_PROJECT: "agent-infra-verify",
		PLATFORM_LOCAL_API_DIRECTORY: api,
		PLATFORM_WEB_TLS_CERT_FILE: cert,
		PLATFORM_WEB_TLS_KEY_FILE: key,
		PLATFORM_LOCAL_PROXY_TOKEN_FILE: proxyToken,
		PLATFORM_LOCAL_STATE_DIRECTORY: localState,
		PLATFORM_LOCAL_KUBECONFIG: kubeconfig,
		PLATFORM_LOCAL_KUBE_CONTEXT: "kind-isolated",
		PLATFORM_LOCAL_NAMESPACE: "agent-infra-verify",
		PLATFORM_LOCAL_WORKER_VALUES: values,
	};
	return {
		env,
		log,
		manifest,
		async close() {
			await rm(directory, { recursive: true, force: true });
		},
	};
}

function run(command, env, args = []) {
	return spawnSync("bash", [script, command, ...args], {
		cwd: process.cwd(),
		env,
		encoding: "utf8",
	});
}

test("local up, status and stop bind one Worker release to the private kind context", async () => {
	const f = await fixture();
	try {
		assert.equal(run("migrate", f.env).status, 0);
		assert.match(
			await readFile(f.log, "utf8"),
			/compose .* run --rm --no-deps platform-api node node_modules\/@agent-infra\/platform-store\/dist\/migrate-cli\.mjs/,
		);
		await writeFile(f.log, "");
		assert.equal(run("up", f.env).status, 0);
		const nginxConfig = join(
			f.env.PLATFORM_LOCAL_STATE_DIRECTORY,
			"agent-infra-verify/nginx.conf",
		);
		assert.match(
			await readFile(nginxConfig, "utf8"),
			new RegExp(`proxy_set_header X-Platform-Proxy-Token ${proxyTokenValue};`),
		);
		const runtimeToken = join(
			f.env.PLATFORM_LOCAL_STATE_DIRECTORY,
			"agent-infra-verify/proxy-token",
		);
		assert.equal(await readFile(runtimeToken, "utf8"), proxyTokenValue);
		const up = (await readFile(f.log, "utf8")).trim().split("\n");
		assert.match(
			up[0],
			/^helm .*--kubeconfig .* --kube-context kind-isolated --namespace agent-infra-verify template agent-infra-verify /,
		);
		assert.match(up[0], /--set enterpriseDirectorySync\.enabled=false/);
		assert.match(
			up[0],
			/--set-string database\.secretRef\.name=agent-infra-verify-postgres/,
		);
		assert.match(
			up[0],
			/--set-string platformWorker\.deploymentModule=file:\/\/\/app\/dist\/deployment\.mjs/,
		);
		assert.match(up[1], /^docker .* compose .* stop web platform-api$/);
		assert.match(
			up[2],
			/^docker .* compose .* up --detach --wait postgres object-storage$/,
		);
		assert.match(
			up[3],
			/network connect --alias agent-infra-verify-postgres-[0-9a-f]{16} kind fixture-postgres$/,
		);
		assert.match(up[4], /^kubectl .* apply -f -$/);
		const manifest = await readFile(f.manifest, "utf8");
		assert.match(manifest, /name: agent-infra-verify-postgres/);
		assert.match(manifest, /addresses: \["172\.18\.0\.42"\]/);
		assert.match(
			manifest,
			/agent-infra\.agora\.io\/local-network-alias: agent-infra-verify-postgres-[0-9a-f]{16}/,
		);
		assert.match(manifest, /"kind":"Secret"/);
		const encodedUrl = manifest.match(/"data":\{"url":"([^"]+)"\}/)?.[1];
		assert.ok(encodedUrl);
		assert.equal(
			Buffer.from(encodedUrl, "base64").toString(),
			"postgresql://fixture:fixture@agent-infra-verify-postgres.agent-infra-verify.svc.cluster.local:5432/fixture",
		);
		assert.match(
			up[9],
			/^kubectl .* --context kind-isolated --namespace agent-infra-verify rollout status deployment\/agent-infra-verify-agent-infra-platform-worker/,
		);
		assert.match(
			up[10],
			/^docker .* compose .* up --detach --wait --force-recreate --no-deps platform-api$/,
		);
		assert.match(up[11], /^node deploy\/local\/check-api-auth\.ts /);
		assert.match(
			up[12],
			/^docker .* compose .* up --detach --wait --force-recreate --no-deps web$/,
		);
		assert.match(
			up[5],
			/apply --server-side --field-manager=agent-infra-local -f -/,
		);
		assert.match(up[6], /^helm .* upgrade --install agent-infra-verify /);
		assert.match(
			up[7],
			/^helm .* get values agent-infra-verify --all --output json$/,
		);
		assert.match(up[8], /kubectl .* scale .* --replicas=1$/);
		assert.equal(up.length, 13);

		await writeFile(f.log, "");
		assert.equal(run("up", f.env).status, 0);
		assert.doesNotMatch(await readFile(f.log, "utf8"), /network connect/);

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
			/get service\/agent-infra-verify-postgres endpointslice\/agent-infra-verify-postgres-docker secret\/agent-infra-verify-postgres/,
		);
		assert.match(
			status,
			/kubectl .* get deployment agent-infra-verify-agent-infra-platform-worker/,
		);

		await writeFile(f.log, "");
		assert.equal(
			JSON.parse(await readFile(f.env.FAKE_ROUTE_STATE, "utf8")).metadata
				.annotations["agent-infra.agora.io/local-network-alias"],
			await readFile(f.env.FAKE_NETWORK_STATE, "utf8"),
		);
		const stopEnv = { ...f.env };
		delete stopEnv.PLATFORM_LOCAL_PROXY_TOKEN_FILE;
		const stopped = run("stop", stopEnv);
		assert.equal(stopped.status, 0, stopped.stderr);
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
		assert.match(stopSteps[4], /network disconnect kind fixture-postgres/);
		assert.match(
			stopSteps[5],
			/delete endpointslice\/agent-infra-verify-postgres-docker service\/agent-infra-verify-postgres secret\/agent-infra-verify-postgres/,
		);
		assert.match(stopSteps[6], /compose .* stop object-storage postgres/);
		assert.doesNotMatch(
			stop,
			/--volumes|compose .* down|delete (persistentvolumeclaim|pvc|namespace)/,
		);
		await assert.rejects(readFile(nginxConfig, "utf8"), { code: "ENOENT" });
		await assert.rejects(readFile(runtimeToken, "utf8"), { code: "ENOENT" });
	} finally {
		await f.close();
	}
});

test("local up rejects an invalid proxy token before stopping services", async () => {
	const f = await fixture();
	try {
		await writeFile(f.env.PLATFORM_LOCAL_PROXY_TOKEN_FILE, "a".repeat(45));
		const result = run("up", f.env);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /Local proxy token must be a Base64URL value/);
		assert.doesNotMatch(
			await readFile(f.log, "utf8"),
			/compose .* stop web platform-api/,
		);
		assert.doesNotMatch(result.stderr, new RegExp(proxyTokenValue));
	} finally {
		await f.close();
	}
});

test("local up keeps Web and API closed when proxy token wiring fails", async () => {
	const f = await fixture();
	try {
		const result = run("up", { ...f.env, FAKE_AUTH_PROBE_EXIT: "7" });
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /Local API login boundary is unavailable/);
		const log = await readFile(f.log, "utf8");
		assert.match(log, /node deploy\/local\/check-api-auth\.ts /);
		assert.match(log, /compose .* stop platform-api/);
		assert.doesNotMatch(log, /compose .* up .* web/);
		assert.doesNotMatch(result.stderr, new RegExp(proxyTokenValue));
	} finally {
		await f.close();
	}
});

test("local up rejects a world-readable proxy token before stopping services", async () => {
	const f = await fixture();
	try {
		await chmod(f.env.PLATFORM_LOCAL_PROXY_TOKEN_FILE, 0o644);
		const result = run("up", f.env);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /owned private regular file/);
		assert.doesNotMatch(
			await readFile(f.log, "utf8"),
			/compose .* stop web platform-api/,
		);
	} finally {
		await f.close();
	}
});

test("local up keeps API and Web closed when Worker upgrade fails", async () => {
	const f = await fixture();
	try {
		const result = run("up", { ...f.env, FAKE_HELM_UPGRADE_EXIT: "7" });
		assert.notEqual(result.status, 0);
		const steps = (await readFile(f.log, "utf8")).trim().split("\n");
		assert.match(steps[1], /compose .* stop web platform-api$/);
		assert.match(
			steps[2],
			/compose .* up --detach --wait postgres object-storage$/,
		);
		assert.match(
			steps[3],
			/network connect --alias agent-infra-verify-postgres-[0-9a-f]{16} kind fixture-postgres/,
		);
		assert.match(steps[4], /kubectl .* apply -f -/);
		assert.match(
			steps[5],
			/apply --server-side --field-manager=agent-infra-local -f -/,
		);
		assert.match(steps[6], /helm .* upgrade --install/);
		assert.equal(steps.length, 7);
	} finally {
		await f.close();
	}
});

test("local up refuses to reopen API when the installed Worker has no configured replicas", async () => {
	const f = await fixture();
	try {
		const result = run("up", {
			...f.env,
			FAKE_CONFIGURED_WORKER_REPLICAS: "0",
		});
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /Local Worker replica count is invalid/);
		const log = await readFile(f.log, "utf8");
		assert.match(
			log,
			/helm .* get values agent-infra-verify --all --output json/,
		);
		assert.doesNotMatch(log, /kubectl .* scale .* --replicas=0/);
		assert.doesNotMatch(log, /compose .* up --detach --wait --force-recreate/);
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

test("local commands refuse foreign database route resources and network links", async () => {
	const f = await fixture();
	try {
		const sameAliasWithoutMarker = run("up", {
			...f.env,
			FAKE_PRECONNECTED_ALIASES: "agent-infra-verify-postgres-1234567890abcdef",
		});
		assert.notEqual(sameAliasWithoutMarker.status, 0);
		assert.match(sameAliasWithoutMarker.stderr, /outside this project/);
		assert.equal(await readFile(f.log, "utf8"), "");
		const stopSameAliasWithoutMarker = run("stop", {
			...f.env,
			FAKE_PRECONNECTED_ALIASES: "agent-infra-verify-postgres-1234567890abcdef",
		});
		assert.notEqual(stopSameAliasWithoutMarker.status, 0);
		assert.match(stopSameAliasWithoutMarker.stderr, /outside this project/);
		assert.equal(await readFile(f.log, "utf8"), "");
		for (const resource of [
			"service/agent-infra-verify-postgres",
			"endpointslice/agent-infra-verify-postgres-docker",
			"secret/agent-infra-verify-postgres",
		]) {
			const result = run("up", { ...f.env, FAKE_FOREIGN_RESOURCE: resource });
			assert.notEqual(result.status, 0);
			assert.match(result.stderr, /not owned by this project/);
			assert.equal(await readFile(f.log, "utf8"), "");
		}
		const preconnected = run("stop", {
			...f.env,
			FAKE_PRECONNECTED_ALIASES: "another-owner-db",
		});
		assert.notEqual(preconnected.status, 0);
		assert.match(preconnected.stderr, /connected to kind outside this project/);
		assert.equal(await readFile(f.log, "utf8"), "");
		const stoppedPreconnected = run("up", {
			...f.env,
			FAKE_CONTAINER_RUNNING: "0",
			FAKE_PRECONNECTED_ALIASES: "another-owner-db",
		});
		assert.notEqual(stoppedPreconnected.status, 0);
		assert.match(
			stoppedPreconnected.stderr,
			/connected to kind outside this project/,
		);
		assert.equal(await readFile(f.log, "utf8"), "");
	} finally {
		await f.close();
	}
});

test("local up redacts malformed database connection input", async () => {
	const f = await fixture();
	try {
		const result = run("up", {
			...f.env,
			FAKE_DATABASE_URL: "not-a-url-fixture-password-sentinel",
		});
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /Local API database URL is invalid/);
		assert.doesNotMatch(result.stderr, /fixture-password-sentinel/);
		assert.doesNotMatch(await readFile(f.log, "utf8"), /upgrade --install/);
	} finally {
		await f.close();
	}
});

test("local stop can finish owned route cleanup after an earlier Helm uninstall", async () => {
	const f = await fixture();
	try {
		const result = run("stop", {
			...f.env,
			FAKE_WORKER_REPLICAS: "",
			FAKE_HELM_LIST_RESULT: "",
		});
		assert.equal(result.status, 0);
		const log = await readFile(f.log, "utf8");
		assert.match(
			log,
			/delete endpointslice\/agent-infra-verify-postgres-docker/,
		);
		assert.match(log, /compose .* stop object-storage postgres/);
		assert.doesNotMatch(log, /uninstall|scale deployment/);
	} finally {
		await f.close();
	}
});

test("local stop refuses a release missing its Worker Deployment", async () => {
	const f = await fixture();
	try {
		const result = run("stop", {
			...f.env,
			FAKE_WORKER_REPLICAS: "",
			FAKE_HELM_LIST_RESULT: "agent-infra-verify",
		});
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /release exists without its Deployment/);
		assert.doesNotMatch(
			await readFile(f.log, "utf8"),
			/compose .* stop|delete /,
		);
	} finally {
		await f.close();
	}
});

test("local stop keeps API and Web running when Agents remain but Worker Deployment is absent", async () => {
	const f = await fixture();
	try {
		const result = run("stop", {
			...f.env,
			FAKE_WORKER_REPLICAS: "",
			FAKE_HELM_LIST_RESULT: "",
			FAKE_AGENT_WORKLOADS: "agent-1 1\n",
		});
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /Stop each Agent/);
		assert.doesNotMatch(
			await readFile(f.log, "utf8"),
			/compose .* stop|delete |network disconnect/,
		);
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

test("local stop leaves API closed when an existing zero-replica Worker cannot be uninstalled", async () => {
	const f = await fixture();
	try {
		const result = run("stop", {
			...f.env,
			FAKE_WORKER_REPLICAS: "0",
			FAKE_HELM_UNINSTALL_EXIT: "7",
		});
		assert.notEqual(result.status, 0);
		assert.match(
			result.stderr,
			/Worker had zero replicas; API and Web remain stopped/,
		);
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

for (const inventory of [
	{
		resource: "Workload",
		exitField: "FAKE_AGENT_WORKLOADS_READ_EXIT",
		outputField: "FAKE_AGENT_WORKLOADS",
		partialOutput: "agent-1 0\n",
		diagnostic: /Agent Workloads could not be read/,
	},
	{
		resource: "Pod",
		exitField: "FAKE_AGENT_PODS_READ_EXIT",
		outputField: "FAKE_AGENT_PODS",
		partialOutput: "pod/agent-1-0\n",
		diagnostic: /Agent Pods could not be read/,
	},
]) {
	for (const [outputName, output] of [
		["empty", ""],
		["partial", inventory.partialOutput],
	]) {
		test(`local stop restores services after a failed Agent ${inventory.resource} read with ${outputName} output`, async () => {
			const f = await fixture();
			try {
				const result = run("stop", {
					...f.env,
					[inventory.exitField]: "1",
					[inventory.outputField]: output,
				});
				const log = await readFile(f.log, "utf8");
				assert.equal(result.status, 1, log);
				assert.match(result.stderr, inventory.diagnostic);
				assert.doesNotMatch(
					result.stdout + result.stderr,
					/private-inventory-error-fixture/,
				);
				assert.match(log, /scale deployment\/.* --replicas=1/);
				assert.match(log, /rollout status deployment\/.* --timeout=5m/);
				assert.match(log, /compose .* up --detach --wait platform-api web/);
				assert.doesNotMatch(
					log,
					/helm .* uninstall|network disconnect|delete service|delete endpointslice|stop object-storage postgres/,
				);
			} finally {
				await f.close();
			}
		});
	}

	test(`local stop refuses a failed Agent ${inventory.resource} read without a Worker Deployment`, async () => {
		const f = await fixture();
		try {
			const result = run("stop", {
				...f.env,
				FAKE_WORKER_REPLICAS: "",
				[inventory.exitField]: "1",
			});
			assert.equal(result.status, 1);
			assert.match(result.stderr, inventory.diagnostic);
			assert.doesNotMatch(
				result.stdout + result.stderr,
				/private-inventory-error-fixture/,
			);
			assert.doesNotMatch(
				await readFile(f.log, "utf8"),
				/compose .* (stop|up)|scale deployment|helm .* uninstall|network disconnect|delete service|delete endpointslice/,
			);
		} finally {
			await f.close();
		}
	});
}

test("local up validates private API and Worker material before stopping services", async () => {
	const f = await fixture();
	try {
		await writeFile(
			join(f.env.PLATFORM_LOCAL_API_DIRECTORY, "configuration.mjs"),
			"export const ldap = ;",
		);
		const result = run("up", f.env);
		assert.notEqual(result.status, 0);
		assert.match(
			result.stderr,
			/Local API configuration.mjs has invalid syntax/,
		);
		assert.equal(await readFile(f.log, "utf8"), "");
	} finally {
		await f.close();
	}
});

test("local up reports missing Worker Secret material before Helm rollout", async () => {
	const f = await fixture();
	try {
		const result = run("up", { ...f.env, FAKE_SECRET_MATERIAL: "0" });
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /Local Worker Secret/);
		const log = await readFile(f.log, "utf8");
		assert.doesNotMatch(log, /helm .* upgrade --install/);
		assert.doesNotMatch(log, /compose .* up .* platform-api/);
	} finally {
		await f.close();
	}
});

test("local up names a missing mapped Worker configuration key without exposing data", async () => {
	const f = await fixture();
	try {
		const result = run("up", { ...f.env, FAKE_SECRET_MISSING_KEY: "1" });
		assert.notEqual(result.status, 0);
		assert.match(
			result.stderr,
			/Local Worker Secret is missing key worker-config: fixture-worker-configuration/,
		);
		assert.doesNotMatch(result.stderr, /eA==|fixture:fixture/);
		assert.doesNotMatch(
			await readFile(f.log, "utf8"),
			/helm .* upgrade --install/,
		);
	} finally {
		await f.close();
	}
});

test("local reset requires the exact project and removes only the isolated Compose volumes", async () => {
	const f = await fixture();
	try {
		const unconfirmed = run("reset", f.env);
		assert.notEqual(unconfirmed.status, 0);
		assert.match(unconfirmed.stderr, /exact isolated project name/);
		assert.equal(await readFile(f.log, "utf8"), "");

		const confirmed = run("reset", f.env, ["agent-infra-verify"]);
		assert.equal(confirmed.status, 0, confirmed.stderr);
		const log = await readFile(f.log, "utf8");
		assert.match(log, /compose .* down --volumes --remove-orphans/);
		assert.doesNotMatch(log, /delete persistentvolumeclaim|delete pvc/);
	} finally {
		await f.close();
	}
});

test("local reset deletes an explicitly selected canonical Agent PVC", async () => {
	const f = await fixture();
	try {
		const agentId = "local-reset-agent";
		const agentName = `agent-${createHash("sha256").update(agentId).digest("hex").slice(0, 32)}`;
		const env = {
			...f.env,
			PLATFORM_LOCAL_AGENT_PVC_NAMES: `${agentName}-data`,
			FAKE_AGENT_PVC_JSON: JSON.stringify({
				kind: "PersistentVolumeClaim",
				metadata: {
					name: `${agentName}-data`,
					namespace: "agent-infra-verify",
					labels: { "agent-infra.agora.io/agent": agentName },
					annotations: { "agent-infra.agora.io/agent-id": agentId },
				},
			}),
			FAKE_AGENT_STATEFULSET_JSON: JSON.stringify({
				kind: "StatefulSet",
				metadata: {
					name: agentName,
					namespace: "agent-infra-verify",
					labels: { "agent-infra.agora.io/agent": agentName },
					annotations: { "agent-infra.agora.io/agent-id": agentId },
				},
			}),
		};
		const result = run("reset", env, ["agent-infra-verify"]);
		assert.equal(result.status, 0, result.stderr);
		assert.match(
			await readFile(f.log, "utf8"),
			new RegExp(`delete pvc/${agentName}-data`),
		);
	} finally {
		await f.close();
	}
});

test("local reset refuses a canonical Agent PVC with an owner reference", async () => {
	const f = await fixture();
	try {
		const agentId = "local-reset-owned-agent";
		const agentName = `agent-${createHash("sha256").update(agentId).digest("hex").slice(0, 32)}`;
		const env = {
			...f.env,
			PLATFORM_LOCAL_AGENT_PVC_NAMES: `${agentName}-data`,
			FAKE_AGENT_PVC_JSON: JSON.stringify({
				kind: "PersistentVolumeClaim",
				metadata: {
					name: `${agentName}-data`,
					namespace: "agent-infra-verify",
					labels: { "agent-infra.agora.io/agent": agentName },
					annotations: { "agent-infra.agora.io/agent-id": agentId },
					ownerReferences: [
						{
							apiVersion: "apps/v1",
							kind: "StatefulSet",
							name: "foreign-owner",
							controller: true,
						},
					],
				},
			}),
			FAKE_AGENT_STATEFULSET_JSON: JSON.stringify({
				kind: "StatefulSet",
				metadata: {
					name: agentName,
					namespace: "agent-infra-verify",
					labels: { "agent-infra.agora.io/agent": agentName },
					annotations: { "agent-infra.agora.io/agent-id": agentId },
				},
			}),
		};
		const result = run("reset", env, ["agent-infra-verify"]);
		assert.notEqual(result.status, 0);
		assert.match(
			result.stderr,
			/Refusing to delete an unowned Agent PVC: .*data/,
		);
		assert.doesNotMatch(await readFile(f.log, "utf8"), /delete pvc\//);
	} finally {
		await f.close();
	}
});

test("local reset refuses a same-namespace PVC with foreign or mismatched Agent ownership", async () => {
	const f = await fixture();
	try {
		const env = {
			...f.env,
			PLATFORM_LOCAL_AGENT_PVC_NAMES: "foreign-data",
			FAKE_AGENT_PVC_JSON: JSON.stringify({
				kind: "PersistentVolumeClaim",
				metadata: {
					name: "foreign-data",
					namespace: "agent-infra-verify",
					labels: { "agent-infra.agora.io/agent": "foreign" },
					annotations: { "agent-infra.agora.io/agent-id": "another-agent" },
					ownerReferences: [
						{
							apiVersion: "apps/v1",
							kind: "StatefulSet",
							name: "foreign",
							controller: true,
						},
					],
				},
			}),
		};
		const result = run("reset", env, ["agent-infra-verify"]);
		assert.notEqual(result.status, 0);
		assert.match(
			result.stderr,
			/Refusing to delete an unowned Agent PVC: foreign-data/,
		);
		assert.doesNotMatch(
			await readFile(f.log, "utf8"),
			/delete pvc\/foreign-data/,
		);
	} finally {
		await f.close();
	}
});
