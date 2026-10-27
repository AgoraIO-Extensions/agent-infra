import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseAllDocuments } from "yaml";
import { bootstrapInputs, prepareBootstrapInputs } from "./bootstrap-inputs.ts";
import { initializationFromResources } from "./database-initialization.ts";
import { privateBytes, privateJson } from "./private-input.ts";

type Run = (args: string[], input?: string) => string;
const ownerLabel = "agent-infra.agora.io/bootstrap-id";

async function databasePlan(input: any, rendered: string) {
	assert(input.initializeDatabase === true);
	const objects = await prepareBootstrapInputs(input, rendered);
	const documents = parseAllDocuments(rendered)
		.map((doc) => {
			assert.equal(doc.errors.length, 0);
			return doc.toJSON();
		})
		.filter(Boolean);
	const initialization = initializationFromResources(
		documents,
		objects,
		input.namespace,
		input.installationId,
	);
	const desired = documents.find(
		(item) =>
			item.kind === "StatefulSet" &&
			item.metadata.name === "agent-infra-postgres",
	);
	assert(desired?.metadata.labels?.[ownerLabel] === input.installationId);
	assert(
		desired.spec.volumeClaimTemplates[0]?.metadata.labels?.[ownerLabel] ===
			input.installationId,
	);
	return { initialization, desired };
}

export async function bootstrapDatabase(
	input: any,
	rendered: string,
	options: {
		release: string;
		chart: string;
		values: string;
		kubectl: Run;
		helm: Run;
	},
) {
	assert(/^[a-z0-9][a-z0-9-]{0,62}$/u.test(options.release));
	const { initialization, desired } = await databasePlan(input, rendered);
	assert(
		(await bootstrapInputs(input, rendered, options.kubectl)).createCount === 0,
	);
	const k = (args: string[], body?: string) =>
		options.kubectl(["-n", input.namespace, ...args], body);
	const read = (kind: string, name: string, optional = false) => {
		const raw = k([
			"get",
			kind,
			name,
			...(optional ? ["--ignore-not-found"] : []),
			"-o",
			"json",
		]);
		return raw.trim() ? JSON.parse(raw) : undefined;
	};
	const namespace = JSON.parse(
		options.kubectl(["get", "namespace", input.namespace, "-o", "json"]),
	);
	const owned = (object: any) =>
		assert(object?.metadata.labels?.[ownerLabel] === input.installationId);
	owned(namespace);
	const pvc = read("pvc", "data-agent-infra-postgres-0", true);
	if (pvc) owned(pvc);
	const preview = parseAllDocuments(
		options.helm(
			[
				"template",
				options.release,
				options.chart,
				"-n",
				input.namespace,
				"--values",
				"-",
				"--set",
				"bootstrap.databaseOnly=true",
			],
			options.values,
		),
	)
		.map((doc) => {
			assert.equal(doc.errors.length, 0);
			return doc.toJSON();
		})
		.filter(Boolean);
	assert(
		preview.every(
			(item) =>
				item.kind === "ResourceQuota" ||
				(["Service", "StatefulSet"].includes(item.kind) &&
					item.metadata.name === "agent-infra-postgres"),
		),
	);
	assert(
		preview.filter((item) => item.kind === "StatefulSet").length === 1 &&
			preview.filter((item) => item.kind === "Service").length === 1,
	);
	assert.deepEqual(
		preview.find((item) => item.kind === "StatefulSet").spec,
		desired.spec,
	);
	const releases = JSON.parse(
		options.helm(["list", "-n", input.namespace, "-o", "json"]),
	);
	const existing = releases.filter(
		(item: any) => item.name === options.release,
	);
	assert(existing.length <= 1);
	let databaseOnly = true;
	if (existing.length) {
		const currentValues = JSON.parse(
			options.helm([
				"get",
				"values",
				options.release,
				"-n",
				input.namespace,
				"-o",
				"json",
			]),
		);
		assert(
			currentValues.postgres?.bootstrapInstallationId === input.installationId,
		);
		databaseOnly = currentValues.bootstrap?.databaseOnly === true;
	}
	// Never switch an installed Platform release back to database-only (which would delete its services).
	if (!existing.length || databaseOnly) {
		const currentNamespace = JSON.parse(
			options.kubectl(["get", "namespace", input.namespace, "-o", "json"]),
		);
		assert(currentNamespace.metadata.uid === namespace.metadata.uid);
		owned(currentNamespace);
		options.helm(
			[
				"upgrade",
				"--install",
				options.release,
				options.chart,
				"-n",
				input.namespace,
				"--values",
				"-",
				"--set",
				"bootstrap.databaseOnly=true",
				"--wait",
				"--timeout",
				"10m",
			],
			options.values,
		);
	}
	k(["rollout", "status", "statefulset/agent-infra-postgres", "--timeout=10m"]);
	const stateful = read("statefulset", "agent-infra-postgres");
	owned(stateful);
	owned(read("pvc", "data-agent-infra-postgres-0"));
	const pod = read("pod", "agent-infra-postgres-0");
	assert(
		pod.metadata.ownerReferences?.some(
			(owner: any) =>
				owner.kind === "StatefulSet" && owner.uid === stateful.metadata.uid,
		),
	);
	const expectedImage = desired.spec.template.spec.containers[0].image;
	assert(
		stateful.spec.template.spec.containers[0].image === expectedImage &&
			pod.spec.containers[0].image === expectedImage,
	);
	assert(
		pod.status.containerStatuses?.length === 1 &&
			pod.status.containerStatuses[0].ready === true,
	);
	const result = k(
		[
			"exec",
			"-i",
			"agent-infra-postgres-0",
			"--",
			"psql",
			"-X",
			"-qAt",
			"-U",
			initialization.adminRole,
			"-d",
			"postgres",
			"-v",
			"ON_ERROR_STOP=1",
			"-f",
			"-",
		],
		initialization.verificationSql,
	);
	assert(result.trim() === "t");
	assert(
		read("pod", "agent-infra-postgres-0").metadata.uid === pod.metadata.uid,
	);
	const currentNamespace = JSON.parse(
		options.kubectl(["get", "namespace", input.namespace, "-o", "json"]),
	);
	assert(currentNamespace.metadata.uid === namespace.metadata.uid);
	owned(currentNamespace);
	return {
		schemaVersion: 1,
		kind: "ack-database-bootstrap",
		postgresReady: true,
		rolesVerified: 3,
		databasesVerified: 2,
		schemaMigrationsVerified: false,
		businessVerified: false,
	};
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		const [mode, configFile, renderedFile, chart, valuesFile] =
			process.argv.slice(2);
		assert(["check", "apply"].includes(mode));
		const input = await privateJson(configFile);
		assert(
			input.namespace === process.env.ACK_NAMESPACE &&
				process.env.ACK_KUBECONFIG,
		);
		if (mode === "check") {
			await databasePlan(input, await readFile(renderedFile, "utf8"));
			process.stdout.write(
				JSON.stringify({
					schemaVersion: 1,
					kind: "configuration-only",
					endpointChecked: false,
				}) + "\n",
			);
			process.exit(0);
		}
		const execute = (command: string, args: string[], input?: string) =>
			execFileSync(command, args, {
				input,
				encoding: "utf8",
				timeout:
					args.includes("rollout") || args.includes("upgrade")
						? 620_000
						: 30_000,
				maxBuffer: 16 * 1024 * 1024,
				stdio: ["pipe", "pipe", "pipe"],
				env: { ...process.env, KUBECONFIG: process.env.ACK_KUBECONFIG },
			});
		const receipt = await bootstrapDatabase(
			input,
			await readFile(renderedFile, "utf8"),
			{
				release: process.env.ACK_RELEASE ?? "agent-infra-ack",
				chart,
				values: (await privateBytes(valuesFile)).toString("utf8"),
				kubectl: (args, body) =>
					execute("kubectl", ["--request-timeout=20s", ...args], body),
				helm: (args, body) => execute("helm", args, body),
			},
		);
		process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
	} catch {
		process.stderr.write("ACK_DATABASE_BOOTSTRAP_FAILED\n");
		process.exitCode = 1;
	}
}
