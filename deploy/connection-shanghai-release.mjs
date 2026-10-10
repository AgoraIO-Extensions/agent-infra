import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	applyReviewedMigrations,
	migrationJob,
	reviewedMigrationPlan,
} from "./connection-reviewed-migrations.mjs";
import {
	expectedSourceEvidence,
	resolveVerifiedSubject,
	verifyRelease,
} from "./connection-supply-chain.mjs";

class ReleaseError extends Error {}

export const shanghai = {
	server: "https://106.14.182.204:6443",
	namespace: "agent-connector",
	databaseHost: "pgm-uf6c9w6165b2my7nbo.pg.rds.aliyuncs.com",
	databaseSecret: "connection-database-shanghai",
	caConfigMap: "connection-rds-ca",
	caPath: "/etc/connection-rds/ApsaraDB-CA-Chain.pem",
};

function requireCondition(condition, message) {
	if (!condition) throw new ReleaseError(message);
}

function execute(command, args, input) {
	try {
		return execFileSync(command, args, {
			encoding: "utf8",
			stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
			input,
			maxBuffer: 16 * 1024 * 1024,
		}).trim();
	} catch {
		throw new ReleaseError(
			"Release command failed; raw stderr withheld to protect runtime configuration",
		);
	}
}

export function validateTarget(config, versions, namespace) {
	requireCondition(
		config.clusters?.length === 1 &&
			config.clusters[0].cluster.server === shanghai.server,
		"Wrong cluster: use the approved hcicore-acs-sh-prod01 kubeconfig",
	);
	requireCondition(
		config.clusters[0].cluster["insecure-skip-tls-verify"] !== true,
		"Kubernetes TLS verification must remain enabled",
	);
	const client = versions.clientVersion;
	const server = versions.serverVersion;
	requireCondition(
		client?.major === "1" &&
			server?.major === "1" &&
			Math.abs(
				Number.parseInt(client.minor, 10) - Number.parseInt(server.minor, 10),
			) <= 1,
		"Use kubectl within one minor version of the Shanghai server",
	);
	requireCondition(
		namespace.metadata?.name === shanghai.namespace &&
			namespace.status?.phase === "Active",
		"Shanghai namespace must already exist and be Active",
	);
}

export function validateRuntime(api, web, databaseSecret, configSecret, ca) {
	requireCondition(
		api.metadata?.name === "connection-api" &&
			web.metadata?.name === "connection-web",
		"Unexpected deployment names",
	);
	requireCondition(
		api.spec?.replicas === 1 && api.spec?.strategy?.type === "Recreate",
		"Connection API must remain one writer with Recreate strategy",
	);
	requireCondition(
		web.spec?.replicas === 1,
		"Web must already have one desired replica",
	);
	const pod = api.spec.template.spec;
	const container = pod.containers.find((item) => item.name === "api");
	requireCondition(
		container &&
			web.spec.template.spec.containers.some((item) => item.name === "web"),
		"Missing API/Web containers",
	);
	const env = container.env ?? [];
	const database = env.find((item) => item.name === "DATABASE_URL")?.valueFrom
		?.secretKeyRef;
	requireCondition(
		database?.name === shanghai.databaseSecret &&
			database.key === "DATABASE_URL",
		"DATABASE_URL must use the Shanghai database Secret; do not restore the old database",
	);
	let url;
	try {
		url = new URL(
			Buffer.from(databaseSecret.data?.DATABASE_URL ?? "", "base64").toString(),
		);
	} catch {
		throw new ReleaseError("Shanghai database Secret contains an invalid URL");
	}
	requireCondition(
		["postgres:", "postgresql:"].includes(url.protocol) &&
			url.hostname === shanghai.databaseHost &&
			url.pathname === "/agent_connector" &&
			url.username === "agent_infra" &&
			["", "5432"].includes(url.port) &&
			[...url.searchParams.keys()].every((key) => key === "sslmode") &&
			url.searchParams.getAll("sslmode").length === 1 &&
			url.searchParams.get("sslmode") === "verify-full",
		"Shanghai database identity and verify-full TLS must match the deployment contract",
	);
	requireCondition(
		env.find((item) => item.name === "NODE_EXTRA_CA_CERTS")?.value ===
			shanghai.caPath,
		"Preserve NODE_EXTRA_CA_CERTS for RDS TLS",
	);
	requireCondition(
		!env.some((item) => item.name === "NODE_TLS_REJECT_UNAUTHORIZED"),
		"Do not override Node TLS verification",
	);
	const mount = container.volumeMounts?.find(
		(item) =>
			item.mountPath === "/etc/connection-rds" && item.readOnly === true,
	);
	requireCondition(
		mount &&
			pod.volumes?.some(
				(item) =>
					item.name === mount.name &&
					item.configMap?.name === shanghai.caConfigMap,
			),
		"Preserve the read-only RDS CA ConfigMap mount",
	);
	requireCondition(
		ca.data?.["ApsaraDB-CA-Chain.pem"]?.includes("BEGIN CERTIFICATE"),
		"RDS CA certificate must already exist",
	);
	requireCondition(
		configSecret.metadata?.name === "connection-config",
		"Runtime configuration Secret must already exist",
	);
}

export function imageUpdates(version) {
	requireCondition(
		/^connection-v\d+\.\d+\.\d+$/.test(version),
		"Expected a canonical Connection release tag",
	);
	return ["api", "web"].map((name) => ({
		deployment: `connection-${name}`,
		container: name,
		image: `ghcr.io/agoraio-extensions/agent-infra/connection-${name}:${version}`,
	}));
}

export function validatePublishedRun(run, sha) {
	requireCondition(
		run?.status === "completed" &&
			run.conclusion === "success" &&
			run.headSha === sha,
		"Exact-head GHCR publication must finish successfully before deployment",
	);
}

function publishedRelease(version, migrationPr) {
	requireCondition(
		!execute("git", ["status", "--porcelain"]),
		"Use a clean release worktree",
	);
	const sha = execute("git", ["rev-parse", "HEAD"]);
	const remoteSha = execute("git", [
		"ls-remote",
		"origin",
		"refs/heads/connection",
	]).split(/\s/)[0];
	const tagSha = execute("git", [
		"ls-remote",
		"--tags",
		"--refs",
		"origin",
		`refs/tags/${version}`,
	]).split(/\s/)[0];
	requireCondition(
		sha === remoteSha && sha === tagSha,
		"HEAD and the release tag must equal current origin/connection",
	);
	const tags = execute("git", [
		"ls-remote",
		"--tags",
		"--refs",
		"origin",
		"refs/tags/connection-v*",
	])
		.split("\n")
		.map((line) => line.split(/\s+/))
		.filter(
			([, ref]) =>
				ref &&
				ref !== `refs/tags/${version}` &&
				/^refs\/tags\/connection-v\d+\.\d+\.\d+$/.test(ref),
		)
		.sort((a, b) => b[1].localeCompare(a[1], "en", { numeric: true }));
	const [baselineSha, baselineRef] = tags[0] ?? [];
	requireCondition(
		baselineSha,
		"A previous canonical Connection release is required",
	);
	const migrationChanged = execute("git", [
		"diff",
		"--name-only",
		baselineSha,
		sha,
		"--",
		"migrations/connection",
	]);
	if (migrationChanged) reviewedMigrationPlan(migrationPr, baselineSha, sha);
	execute("node", [
		".github/scripts/connection-release-guard.mjs",
		"--baseline",
		baselineRef.replace("refs/tags/", ""),
	]);
	const runs = JSON.parse(
		execute("gh", [
			"run",
			"list",
			"--repo",
			"AgoraIO-Extensions/agent-infra",
			"--workflow",
			"publish-ghcr.yml",
			"--branch",
			version,
			"--limit",
			"1",
			"--json",
			"headSha,status,conclusion",
		]),
	);
	validatePublishedRun(runs[0], sha);
	return sha;
}

export async function main(args = process.argv.slice(2)) {
	const [mode, version, kubeconfig, migrationPr] = args;
	requireCondition(
		[3, 4].includes(args.length) && ["--preflight", "--deploy"].includes(mode),
		"Usage: --preflight|--deploy connection-vX.Y.Z KUBECONFIG",
	);
	const updates = imageUpdates(version);
	requireCondition(
		kubeconfig && existsSync(kubeconfig),
		"Explicit Shanghai kubeconfig file is required",
	);
	// biome-ignore lint/suspicious/noUndeclaredEnvVars: this release CLI runs directly, outside Turbo task caching.
	const binary = process.env.CONNECTION_KUBECTL || "kubectl";
	const kube = (...flags) =>
		execute(binary, [
			"--kubeconfig",
			kubeconfig,
			"--request-timeout=20s",
			...flags,
		]);
	const get = (kind, name) =>
		JSON.parse(kube("-n", shanghai.namespace, "get", kind, name, "-o", "json"));
	validateTarget(
		JSON.parse(kube("config", "view", "--minify", "-o", "json")),
		JSON.parse(kube("version", "-o", "json")),
		get("namespace", shanghai.namespace),
	);
	const api = get("deployment", "connection-api");
	const web = get("deployment", "connection-web");
	validateRuntime(
		api,
		web,
		get("secret", shanghai.databaseSecret),
		get("secret", "connection-config"),
		get("configmap", shanghai.caConfigMap),
	);
	for (const update of updates) {
		kube(
			"-n",
			shanghai.namespace,
			"set",
			"image",
			`deployment/${update.deployment}`,
			`${update.container}=${update.image}`,
			"--dry-run=server",
			"-o",
			"name",
		);
	}
	console.log(
		"Shanghai target, single writer, database/TLS and image-only patch preflight passed",
	);
	let migrationContext;
	if (migrationPr) {
		const tags = execute("git", [
			"ls-remote",
			"--tags",
			"--refs",
			"origin",
			"refs/tags/connection-v*",
		])
			.split("\n")
			.map((line) => line.split(/\s+/))
			.filter(
				([, ref]) =>
					ref &&
					ref !== `refs/tags/${version}` &&
					/^refs\/tags\/connection-v\d+\.\d+\.\d+$/.test(ref),
			)
			.sort((a, b) => b[1].localeCompare(a[1], "en", { numeric: true }));
		const plan = reviewedMigrationPlan(migrationPr, tags[0][0]);
		const job = migrationJob(version, plan, api, shanghai);
		const createJob = (manifest) =>
			execute(
				binary,
				[
					"--kubeconfig",
					kubeconfig,
					"--request-timeout=20s",
					"-n",
					shanghai.namespace,
					"create",
					"-f",
					"-",
				],
				JSON.stringify(manifest),
			);
		execute(
			binary,
			[
				"--kubeconfig",
				kubeconfig,
				"--request-timeout=20s",
				"-n",
				shanghai.namespace,
				"create",
				"--dry-run=server",
				"-f",
				"-",
			],
			JSON.stringify(job),
		);
		migrationContext = { plan, job, createJob };
	}
	if (mode === "--preflight") return;
	const sourceSha = publishedRelease(version, migrationPr);
	const expected = expectedSourceEvidence();
	for (const update of updates) {
		const subject = resolveVerifiedSubject(
			update.deployment,
			version,
			sourceSha,
		);
		update.image = verifyRelease(subject, expected);
		kube(
			"-n",
			shanghai.namespace,
			"set",
			"image",
			`deployment/${update.deployment}`,
			`${update.container}=${update.image}`,
			"--dry-run=server",
			"-o",
			"name",
		);
	}
	if (migrationContext) {
		const { plan, job, createJob } = migrationContext;
		job.spec.template.spec.containers.find(
			(container) => container.name === "migrate",
		).image = updates.find(
			(update) => update.deployment === "connection-api",
		).image;
		await applyReviewedMigrations(kube, job, plan, createJob);
		console.log(
			"Reviewed schema migration Job and committed ledger hashes verified",
		);
	}
	console.log(
		JSON.stringify({
			previousImages: [api, web].map((deployment) => ({
				name: deployment.metadata.name,
				images: deployment.spec.template.spec.containers.map(
					(item) => item.image,
				),
			})),
		}),
	);
	for (const update of updates) {
		kube(
			"-n",
			shanghai.namespace,
			"set",
			"image",
			`deployment/${update.deployment}`,
			`${update.container}=${update.image}`,
		);
	}
	const deadline = Date.now() + 300_000;
	while (Date.now() < deadline) {
		const ready = updates.every((update) => {
			const deployment = get("deployment", update.deployment);
			const status = deployment.status ?? {};
			const pods = JSON.parse(
				kube(
					"-n",
					shanghai.namespace,
					"get",
					"pods",
					"-l",
					`app.kubernetes.io/name=${update.deployment}`,
					"-o",
					"json",
				),
			).items;
			return (
				deployment.spec.template.spec.containers.find(
					(item) => item.name === update.container,
				)?.image === update.image &&
				status.observedGeneration >= deployment.metadata.generation &&
				status.readyReplicas === 1 &&
				status.updatedReplicas === 1 &&
				pods.some(
					(pod) =>
						!pod.metadata.deletionTimestamp &&
						pod.spec.containers.some(
							(item) =>
								item.name === update.container && item.image === update.image,
						) &&
						pod.status.containerStatuses?.some(
							(item) => item.name === update.container && item.ready,
						),
				)
			);
		});
		if (ready) {
			console.log(
				`Shanghai deployment ready: ${version}. Complete public and authorized Provider READ verification.`,
			);
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 5000));
	}
	throw new ReleaseError(
		"Shanghai rollout did not become ready in 300s; inspect before rollback, never switch databases automatically",
	);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(
			error instanceof ReleaseError
				? error.message
				: "Release inspection failed; raw exception withheld to protect runtime configuration",
		);
		process.exitCode = 1;
	});
}
