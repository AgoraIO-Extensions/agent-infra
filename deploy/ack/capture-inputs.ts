import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse, stringify } from "yaml";
import { prepareBootstrapInputs, requiredInputs } from "./bootstrap-inputs.ts";

type AnyRecord = Record<string, any>;
type Kind = "Secret" | "ConfigMap";
type Requirement = { kind: Kind; name: string; keys: Set<string> };

const printable = /^[A-Za-z0-9._~-]{16,256}$/u;

function hashFile(file: string) {
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function privatePath(file: string) {
	assert(resolve(file) === file);
	return file;
}

function randomPassword() {
	let value = "";
	while (value.length < 32) value += randomBytes(32).toString("base64url");
	value = value.slice(0, 32);
	assert(printable.test(value));
	return value;
}

/** Keep only values accepted by schemas that explicitly reject unknown keys. */
export function sanitizeValues(value: any, schema: AnyRecord): any {
	if (Array.isArray(value))
		return value.map((item) => sanitizeValues(item, schema.items ?? {}));
	if (!value || typeof value !== "object") return value;
	if (schema.type !== "object") return value;
	const properties = schema.properties ?? {};
	const rejectUnknown = schema.additionalProperties === false;
	const result: AnyRecord = {};
	for (const [key, item] of Object.entries(value)) {
		if (rejectUnknown && !Object.hasOwn(properties, key)) continue;
		result[key] = Object.hasOwn(properties, key)
			? sanitizeValues(item, properties[key])
			: item;
	}
	return result;
}

export function freshDatabaseValues(values: AnyRecord, installationId: string) {
	assert(/^[a-f0-9-]{36}$/u.test(installationId));
	const result = structuredClone(values);
	result.bootstrap = { ...(result.bootstrap ?? {}), databaseOnly: false };
	result.migrations = { ...(result.migrations ?? {}), enabled: true };
	result.postgres = {
		...(result.postgres ?? {}),
		enabled: true,
		adminUser: "agent_infra_admin",
		initialDatabase: "postgres",
		adminSecret: "agent-infra-postgres-admin",
		initializationSecret: "agent-infra-postgres-initialization",
		bootstrapInstallationId: installationId,
	};
	result.directory = {
		...(result.directory ?? {}),
		runtimeDatabaseRole: "agent_infra_directory",
	};
	return result;
}

export function freshDatabaseAccounts(namespace: string) {
	assert(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(namespace));
	const host = `agent-infra-postgres.${namespace}.svc.cluster.local`;
	const accounts = {
		platform: { role: "agent_infra_platform", database: "agent_infra_platform", password: randomPassword() },
		directory: { role: "agent_infra_directory", database: "agent_infra_directory", password: randomPassword() },
		migration: { role: "agent_infra_directory_migration", database: "agent_infra_directory", password: randomPassword() },
		admin: { role: "agent_infra_admin", password: randomPassword() },
	};
	const url = (account: { role: string; database: string; password: string }) =>
		`postgresql://${encodeURIComponent(account.role)}:${encodeURIComponent(account.password)}@${host}:5432/${account.database}`;
	return {
		accounts,
		urls: {
			platform: url(accounts.platform),
			directory: url(accounts.directory),
			migration: url(accounts.migration),
		},
	};
}

function writePrivate(file: string, data: string | Buffer) {
	return writeFile(privatePath(file), data, { mode: 0o600 });
}

function execute(command: string, args: string[], kubeconfig: string, input?: string) {
	return execFileSync(command, ["--kubeconfig", kubeconfig, ...args], {
		input,
		encoding: "utf8",
		stdio: ["pipe", "pipe", "pipe"],
		timeout: 30_000,
		maxBuffer: 16 * 1024 * 1024,
	});
}

function objectFiles(
	output: string,
	object: AnyRecord,
	kind: Kind,
	name: string,
) {
	const directory = join(output, "objects", `${kind}-${name}`);
	return mkdir(directory, { recursive: true, mode: 0o700 }).then(async () => {
		const files: Record<string, string> = {};
		for (const [key, encoded] of Object.entries(object.data ?? {})) {
			const file = join(directory, key);
			await writePrivate(
				file,
				kind === "Secret" ? Buffer.from(encoded, "base64") : encoded,
			);
			files[key] = file;
		}
		return {
			kind,
			name,
			...(kind === "Secret" ? { secretType: object.type ?? "Opaque" } : {}),
			files,
		};
	});
}

async function captureObjects(
	output: string,
	kubeconfig: string,
	namespace: string,
	requirements: Requirement[],
) {
	const objects = [];
	for (const requirement of requirements) {
		const raw = execute(
			"kubectl",
			["-n", namespace, "get", requirement.kind, requirement.name, "-o", "json"],
			kubeconfig,
		);
		const object = JSON.parse(raw);
		assert(object.kind === requirement.kind && object.metadata?.name === requirement.name);
		assert([...requirement.keys].every((key) => Object.hasOwn(object.data ?? {}, key)));
		objects.push(await objectFiles(output, object, requirement.kind, requirement.name));
	}
	return objects;
}

async function replaceFile(objects: AnyRecord[], kind: Kind, name: string, key: string, value: string, output: string) {
	const object = objects.find((item) => item.kind === kind && item.name === name);
	assert(object);
	const file = join(output, "objects", `${kind}-${name}`, key);
	await writePrivate(file, value);
	object.files[key] = file;
}

async function copyObjectFiles(objects: AnyRecord[], output: string) {
	const copied = [];
	for (const object of objects) {
		const files: Record<string, string> = {};
		for (const [key, source] of Object.entries(object.files)) {
			const targetDirectory = join(output, "objects-reuse", `${object.kind}-${object.name}`);
			await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
			const target = join(targetDirectory, key);
			await copyFile(source, target);
			files[key] = target;
		}
		copied.push({ ...object, files });
	}
	return copied;
}

function withBootstrapConfig(
	objects: AnyRecord[],
	installationId: string,
	clusterUid: string,
	namespace: string,
) {
	return {
		schemaVersion: 1,
		installationId,
		initializeDatabase: true,
		clusterUid,
		namespace,
		objects: objects.map((object) => ({ ...object, files: { ...object.files } })),
	};
}

export async function captureInputs(options: {
	chart: string;
	output: string;
	kubeconfig: string;
	namespace: string;
	release: string;
}) {
	assert(resolve(options.output) === options.output);
	await mkdir(join(options.output, "objects"), { recursive: true, mode: 0o700 });
	const helm = (args: string[], input?: string) =>
		execFileSync("helm", args, {
			input,
			encoding: "utf8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: 30_000,
			maxBuffer: 16 * 1024 * 1024,
		});
	const rawValues = helm([
		"--kubeconfig",
		options.kubeconfig,
		"-n",
		options.namespace,
		"get",
		"values",
		options.release,
		"-a",
		"-o",
		"yaml",
	]);
	const schema = JSON.parse(await readFile(join(options.chart, "values.schema.json"), "utf8"));
	const values = sanitizeValues(parse(rawValues) ?? {}, schema);
	const valuesFile = join(options.output, "values.reuse.yaml");
	await writePrivate(valuesFile, stringify(values));
	const versionRaw = execute("kubectl", ["version", "-o", "json"], options.kubeconfig);
	const kubeVersion = JSON.parse(versionRaw).serverVersion?.gitVersion;
	assert(typeof kubeVersion === "string" && /^v\d+\.\d+\.\d+/u.test(kubeVersion));
	const render = (input: AnyRecord) =>
		helm([
			"template",
			options.release,
			options.chart,
			"--namespace",
			options.namespace,
			"--kube-version",
			kubeVersion,
			"--values",
			"-",
		], stringify(input));
	const renderedReuse = render(values);
	const cluster = JSON.parse(execute("kubectl", ["get", "namespace", "kube-system", "-o", "json"], options.kubeconfig));
	const clusterUid = cluster.metadata?.uid;
	assert(/^[a-f0-9-]{36}$/u.test(clusterUid));
	const installationId = randomUUID();
	const accounts = freshDatabaseAccounts(options.namespace);
	const freshValues = freshDatabaseValues(values, installationId);
	const renderedFresh = render(freshValues);
	const requirementMap = new Map<string, Requirement>();
	for (const requirement of [...requiredInputs(renderedReuse), ...requiredInputs(renderedFresh)]) {
		const key = `${requirement.kind}/${requirement.name}`;
		const existing = requirementMap.get(key);
		if (!existing) requirementMap.set(key, { ...requirement, keys: new Set(requirement.keys) });
		else for (const keyName of requirement.keys) existing.keys.add(keyName);
	}
	const requirements = [...requirementMap.values()].filter(
		(requirement) =>
			!(requirement.kind === "Secret" &&
				["agent-infra-postgres-admin", "agent-infra-postgres-initialization"].includes(requirement.name)),
	);
	const objects = await captureObjects(options.output, options.kubeconfig, options.namespace, requirements);
	const reuseObjects = await copyObjectFiles(objects, options.output);
	await replaceFile(objects, "Secret", values.secrets.database, "url", accounts.urls.platform, options.output);
	await replaceFile(objects, "Secret", values.secrets.database, "password", accounts.accounts.platform.password, options.output);
	await replaceFile(objects, "Secret", values.secrets.directoryDatabase, "url", accounts.urls.directory, options.output);
	await replaceFile(objects, "Secret", values.secrets.directoryMigrationDatabase, "url", accounts.urls.migration, options.output);
	const adminDirectory = join(options.output, "objects", "Secret-agent-infra-postgres-admin");
	await mkdir(adminDirectory, { recursive: true, mode: 0o700 });
	const adminPasswordFile = join(adminDirectory, "password");
	await writePrivate(adminPasswordFile, accounts.accounts.admin.password);
	objects.push({ kind: "Secret", name: "agent-infra-postgres-admin", secretType: "Opaque", files: { password: adminPasswordFile } });
	const freshValuesFile = join(options.output, "values.fresh.yaml");
	await writePrivate(freshValuesFile, stringify(freshValues));
	await prepareBootstrapInputs(
		{ schemaVersion: 1, installationId, initializeDatabase: true, clusterUid, namespace: options.namespace, objects },
		renderedFresh,
	);
	const reuseConfig = {
		schemaVersion: 1,
		installationId,
		initializeDatabase: false,
		clusterUid,
		namespace: options.namespace,
		objects: reuseObjects,
	};
	const freshConfig = withBootstrapConfig(objects, installationId, clusterUid, options.namespace);
	const reuseFile = join(options.output, "bootstrap-inputs.reuse.json");
	const freshFile = join(options.output, "bootstrap-inputs.fresh.json");
	await writePrivate(reuseFile, JSON.stringify(reuseConfig, null, 2));
	await writePrivate(freshFile, JSON.stringify(freshConfig, null, 2));
	const reuseEnvFile = join(options.output, "reuse.env");
	await writePrivate(
		reuseEnvFile,
		`export ACK_KUBECONFIG=${options.kubeconfig}\nexport ACK_NAMESPACE=${options.namespace}\nexport ACK_RELEASE=${options.release}\nexport ACK_VALUES_FILE=${valuesFile}\nexport ACK_BOOTSTRAP_INPUTS_FILE=${reuseFile}\nexport ACK_EVIDENCE_DIR=${join(options.output, "evidence-reuse")}\n# Fill ACK_SOURCE_SHA, ACK_IMAGE_MANIFEST and ACK_RUNTIME_IMAGE_MANIFEST for the exact image build.\n`,
	);
	const freshEnvFile = join(options.output, "fresh.env");
	await writePrivate(
		freshEnvFile,
		`export ACK_KUBECONFIG=${options.kubeconfig}\nexport ACK_NAMESPACE=${options.namespace}\nexport ACK_RELEASE=${options.release}\nexport ACK_VALUES_FILE=${freshValuesFile}\nexport ACK_BOOTSTRAP_INPUTS_FILE=${freshFile}\nexport ACK_EVIDENCE_DIR=${join(options.output, "evidence-fresh")}\n# Fill ACK_SOURCE_SHA, ACK_IMAGE_MANIFEST and ACK_RUNTIME_IMAGE_MANIFEST for the exact image build.\n`,
	);
	const receipt = {
		schemaVersion: 1,
		kind: "ack-input-capture",
		readOnly: true,
		namespace: options.namespace,
		release: options.release,
		kubeVersion,
		clusterHash: createHash("sha256").update(clusterUid).digest("hex"),
		installationHash: createHash("sha256").update(installationId).digest("hex"),
		dependencyCount: requirements.length,
		objectCount: objects.length,
		freshDatabaseGenerated: true,
		legacyValuesSanitized: true,
		valuesReuseSha256: hashFile(valuesFile),
		valuesFreshSha256: hashFile(freshValuesFile),
		bootstrapInputsFreshSha256: hashFile(freshFile),
	};
	await writePrivate(join(options.output, "capture.receipt.json"), JSON.stringify(receipt, null, 2));
	return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		const output = resolve(process.argv[2] ?? process.env.ACK_CAPTURE_DIR ?? "");
		assert(output && output !== "/");
		const chart = resolve(process.env.ACK_CHART_DIR ?? join(dirname(process.argv[1]), "chart"));
		const receipt = await captureInputs({
			chart,
			output,
			kubeconfig: process.env.ACK_KUBECONFIG ?? "",
			namespace: process.env.ACK_NAMESPACE ?? "agent-infra",
			release: process.env.ACK_RELEASE ?? "agent-infra-ack",
		});
		process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
	} catch {
		process.stderr.write("ACK_INPUT_CAPTURE_FAILED\n");
		process.exitCode = 1;
	}
}
