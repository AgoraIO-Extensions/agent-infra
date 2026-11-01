import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { privateJson } from "./private-input.ts";
import { sessionSandboxReserveDigestV1 } from "../../packages/platform-core/src/session-sandbox-reserves.ts";
import {
	prepareReserveInput,
	readReserveWorker,
	type ReadReserveWorker,
} from "./session-reserve-inputs.ts";

const commands = new Set(["plan", "bootstrap-plan", "bootstrap-inputs", "bootstrap-database", "template-preflight", "bootstrap-login", "runtime-inputs", "bootstrap-credential", "provision", "validate", "cleanup-plan", "destroy", "all"]);
const variables = new Set([
	"ACK_KUBECONFIG", "ACK_NAMESPACE", "ACK_RELEASE", "ACK_VALUES_FILE", "ACK_IMAGE_MANIFEST", "ACK_RUNTIME_IMAGE_MANIFEST",
	"ACK_TEMPLATE_IMAGE_MANIFEST", "ACK_TEMPLATE_PREFLIGHT_JOBS_FILE", "ACK_TEMPLATE_VALIDATIONS_FILE", "ACK_WORKLOAD_CAPACITY_FILE",
	"ACK_PUBLIC_ORIGIN", "ACK_CA_CERT_FILE", "ACK_EVIDENCE_DIR", "ACK_BOOTSTRAP_INPUTS_FILE", "ACK_CREDENTIAL_BOOTSTRAP_FILE",
	"ACK_LOGIN_BOOTSTRAP_FILE", "ACK_AGENT_REQUESTS_FILE", "ACK_AGENT_STATE_DIR", "ACK_BROWSER_BLUEPRINT_DIR", "ACK_TEMPLATE_CONFIG_DIR",
	"ACK_SESSION_RESERVES_FILE",
	"ACK_CUSTOM_AGENT_CONFIGS", "ACK_CUSTOM_AGENT_PROBE", "ACK_CLEANUP_PLAN_FILE", "ACK_HELM_TIMEOUT", "NODE_EXTRA_CA_CERTS",
]);
const capsulePrefix = "@CAPSULE_ROOT@/";
const sourceToken = "@SOURCE_ROOT@";

type MaterializedCapsule = {
	sourceRoot: string;
	environment: Record<string, string>;
	inputCount: number;
	sourceSha: string;
	reserve?: Awaited<ReturnType<typeof prepareReserveInput>>;
	canonicalRoot: string;
	runDirectory: string;
	inputs: string[];
	resolvedFiles: Map<string, string>;
	canonicalBefore: Map<string, Buffer | null>;
};

function relativePath(value: unknown): string {
	assert(typeof value === "string" && value.length > 0 && value.length <= 1024 && !isAbsolute(value) && !/[\\\0\r\n]/u.test(value));
	assert(value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".."), "CAPSULE_PATH_INVALID");
	return value;
}

async function inspectPath(root: string, relative: string, mayCreate = false) {
	let path = root;
	const parts = relativePath(relative).split("/");
	for (const [index, part] of parts.entries()) {
		path = join(path, part);
		const stat = await lstat(path).catch((error) => { if (mayCreate && error.code === "ENOENT") return null; throw error; });
		if (stat === null) return;
		assert(!stat.isSymbolicLink() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0, "CAPSULE_PATH_NOT_PRIVATE");
		assert(index === parts.length - 1 ? stat.isFile() || stat.isDirectory() : stat.isDirectory());
	}
}

export async function materializeCapsule(manifestFile: string, sourceRoot: string, readWorker?: ReadReserveWorker): Promise<MaterializedCapsule> {
	assert(isAbsolute(manifestFile) && isAbsolute(sourceRoot));
	assert(resolve(manifestFile) === manifestFile && resolve(sourceRoot) === sourceRoot);
	const root = dirname(manifestFile);
	const stat = await lstat(root);
	assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0);
	const canonicalRoot = await realpath(root);
	let inGit = false;
	try { inGit = execFileSync("git", ["-C", canonicalRoot, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() === "true"; } catch {}
	assert(!inGit, "CAPSULE_INSIDE_WORKTREE");
	const input = await privateJson(manifestFile);
	assert(input.schemaVersion === 1 && Object.keys(input).every((key) => ["schemaVersion", "sourceSha", "inputs", "directories", "environment"].includes(key)));
	assert(/^[a-f0-9]{40}$/u.test(input.sourceSha));
	const sourceSha = execFileSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	assert.equal(input.sourceSha, sourceSha, "CAPSULE_SOURCE_MISMATCH");
	assert(Array.isArray(input.inputs) && input.inputs.length > 0 && input.inputs.length <= 100 && new Set(input.inputs).size === input.inputs.length);
	assert(Array.isArray(input.directories) && input.directories.length <= 32 && new Set(input.directories).size === input.directories.length);
	assert(input.environment && typeof input.environment === "object" && !Array.isArray(input.environment));
	for (const [name, value] of Object.entries(input.environment)) {
		assert(variables.has(name), "CAPSULE_ENVIRONMENT_INVALID");
		assert(typeof value === "string" || (name === "ACK_CUSTOM_AGENT_CONFIGS" && Array.isArray(value) && value.length <= 20 && value.every((v) => typeof v === "string")));
		if (!["ACK_NAMESPACE", "ACK_RELEASE", "ACK_PUBLIC_ORIGIN", "ACK_CUSTOM_AGENT_PROBE", "ACK_HELM_TIMEOUT"].includes(name))
			for (const path of Array.isArray(value) ? value : [value]) assert(path === "" || (typeof path === "string" && path.startsWith(capsulePrefix)), "CAPSULE_ENVIRONMENT_PATH_INVALID");
	}
	const directories = input.directories.map(relativePath);
	const generated = input.environment.ACK_TEMPLATE_VALIDATIONS_FILE?.slice(capsulePrefix.length);
	const optionalOutput = typeof generated === "string" && directories.some((dir: string) => generated.startsWith(`${dir}/`)) ? generated : undefined;
	const declaredInputs = [...new Set<string>([...input.inputs, ...(optionalOutput ? [optionalOutput] : [])])];
	const files = new Map<string, any>();
	for (const relative of declaredInputs) {
		relativePath(relative);
		assert(relative.endsWith(".json") && join(root, relative) !== manifestFile);
		await inspectPath(canonicalRoot, relative, relative === optionalOutput);
		files.set(relative, await privateJson(join(canonicalRoot, relative)).catch((error) => {
			if (relative === optionalOutput && error.code === "ENOENT") return null;
			throw error;
		}));
	}
	for (const path of directories) {
		assert(!input.inputs.includes(path) && !input.inputs.some((file: string) => path.startsWith(`${file}/`)));
		await inspectPath(canonicalRoot, path, true);
	}
	const references = new Set<string>();
	const collect = (value: any, depth = 0): void => {
		assert(depth <= 30, "CAPSULE_INPUT_TOO_DEEP");
		if (typeof value === "string") {
			assert(!value.includes("\0"));
			if (value.startsWith(capsulePrefix)) references.add(relativePath(value.slice(capsulePrefix.length)));
			else assert(!value.includes("@CAPSULE_ROOT@") && (!value.includes(sourceToken) || value === sourceToken || value.startsWith(`${sourceToken}/`)), "CAPSULE_REFERENCE_INVALID");
		} else if (Array.isArray(value)) for (const child of value) collect(child, depth + 1);
		else if (value && typeof value === "object") for (const child of Object.values(value)) collect(child, depth + 1);
	};
	for (const value of [...files.values(), input.environment]) collect(value);
	for (const relative of references) if (!files.has(relative)) {
		const output = directories.some((dir: string) => relative === dir || relative.startsWith(`${dir}/`));
		await inspectPath(canonicalRoot, relative, output);
	}
	const original = (value: any): any => {
		if (typeof value === "string" && value.startsWith(capsulePrefix)) return join(canonicalRoot, relativePath(value.slice(capsulePrefix.length)));
		if (Array.isArray(value)) return value.map(original);
		if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, original(child)]));
		return value;
	};
	let reserve: Awaited<ReturnType<typeof prepareReserveInput>> | undefined;
	if (input.environment.ACK_SESSION_RESERVES_FILE !== undefined) {
		const reserveReference = input.environment.ACK_SESSION_RESERVES_FILE.slice(capsulePrefix.length);
		const bootstrapReference = input.environment.ACK_BOOTSTRAP_INPUTS_FILE?.slice(capsulePrefix.length);
		assert(files.has(reserveReference) && files.has(bootstrapReference), "CAPSULE_RESERVE_DECLARED_INPUT_REQUIRED");
		reserve = await prepareReserveInput(original(input.environment), sourceSha, {
			readJson: async (file) => original(await privateJson(file)),
			readWorker,
		});
		assert(sessionSandboxReserveDigestV1(files.get(reserveReference)) === reserve.receipt.configHash, "CAPSULE_RESERVE_INPUT_CHANGED");
	}
	// All inputs are checked before creating a generated run or invoking any deployment command.
	const runDirectory = await mkdtemp(join(canonicalRoot, ".resolved-"));
	const resolvedFiles = new Map([...files.keys()].map((relative) => [relative, join(runDirectory, relative)]));
	const canonicalBefore = new Map<string, Buffer | null>();
	for (const relative of files.keys()) {
		canonicalBefore.set(relative, await readFile(join(canonicalRoot, relative)).catch((error) => {
			if (error?.code === "ENOENT") return null;
			throw error;
		}));
	}
	const inputDirectories = new Set<string>();
	for (const file of files.keys()) {
		let parent = dirname(file);
		while (parent !== ".") { inputDirectories.add(parent); parent = dirname(parent); }
	}
	const materialize = (value: any): any => {
		if (typeof value === "string") {
			if (value === sourceToken) return sourceRoot;
			if (value.startsWith(`${sourceToken}/`)) return join(sourceRoot, relativePath(value.slice(sourceToken.length + 1)));
			if (value.startsWith(capsulePrefix)) {
				const relative = value.slice(capsulePrefix.length);
				return resolvedFiles.get(relative) ?? join(inputDirectories.has(relative) ? runDirectory : canonicalRoot, relative);
			}
			return value;
		}
		if (Array.isArray(value)) return value.map(materialize);
		if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, materialize(child)]));
		return value;
	};
	for (const path of directories) await mkdir(join(canonicalRoot, path), { recursive: true, mode: 0o700 });
	for (const [relative, value] of files) {
		const target = resolvedFiles.get(relative)!;
		await mkdir(dirname(target), { recursive: true, mode: 0o700 });
		if (value === null && relative === optionalOutput) continue;
		const resolved = materialize(value);
		if (reserve && target === materialize(input.environment.ACK_BOOTSTRAP_INPUTS_FILE)) {
			const worker = resolved.objects.find((object: any) => object.kind === "Secret" && object.name === reserve.workerSecretName);
			if (reserve.observed?.storedReserveBytes) {
				const baseline = join(runDirectory, ".session-reserves-before.json");
				assert(!files.has(".session-reserves-before.json"), "CAPSULE_RESERVE_INPUT_CONFLICT");
				await writeFile(baseline, reserve.observed.storedReserveBytes, { mode: 0o600, flag: "wx" });
				worker.files["session-reserves.json"] = baseline;
			} else if (reserve.observed) {
				// Bootstrap verifies the existing Secret; runtime-inputs publishes the candidate later.
				assert(worker.files["session-reserves.json"] === undefined, "CAPSULE_RESERVE_BASELINE_MISSING");
			} else {
				worker.files["session-reserves.json"] = materialize(input.environment.ACK_SESSION_RESERVES_FILE);
			}
		}
		await writeFile(target, `${JSON.stringify(resolved, null, 2)}\n`, { mode: 0o600, flag: "wx" });
	}
	const environment: Record<string, string> = { ACK_SOURCE_SHA: sourceSha };
	const canonicalDirectories = new Set(["ACK_AGENT_STATE_DIR", "ACK_EVIDENCE_DIR"]);
	for (const [name, value] of Object.entries(input.environment)) {
		if (canonicalDirectories.has(name) && typeof value === "string" && value.startsWith(capsulePrefix))
			environment[name] = join(canonicalRoot, relativePath(value.slice(capsulePrefix.length)));
		else {
			const resolved = materialize(value);
			environment[name] = Array.isArray(resolved) ? resolved.join("\n") : resolved as string;
		}
	}
	return { environment, inputCount: files.size, sourceSha, sourceRoot, reserve, canonicalRoot, runDirectory, inputs: [...files.keys()], resolvedFiles, canonicalBefore };
}

function promotionTargets(command: string, materialized: MaterializedCapsule) {
	const { environment, resolvedFiles, inputs } = materialized;
	const targets = new Set<string>();
	const add = (variable: string) => {
		for (const [relative, file] of resolvedFiles) if (file === environment[variable]) targets.add(relative);
	};
	if (["bootstrap-login", "all"].includes(command))
		for (const input of inputs) if (input.startsWith("blueprints/") && input.endsWith(".json")) targets.add(input);
	if (["template-preflight", "runtime-inputs", "all"].includes(command)) add("ACK_TEMPLATE_VALIDATIONS_FILE");
	if (["runtime-inputs", "all"].includes(command)) {
		add("ACK_BOOTSTRAP_INPUTS_FILE");
		add("ACK_WORKLOAD_CAPACITY_FILE");
	}
	if (["bootstrap-credential", "provision", "all"].includes(command)) {
		add("ACK_CREDENTIAL_BOOTSTRAP_FILE");
		add("ACK_AGENT_REQUESTS_FILE");
	}
	return [...targets];
}

function portableValue(value: any, materialized: MaterializedCapsule): any {
	const { canonicalRoot, runDirectory, sourceRoot, environment, resolvedFiles } = materialized;
	if (typeof value === "string") {
		if (value === sourceRoot) return sourceToken;
		if (value.startsWith(`${sourceRoot}/`)) return `${sourceToken}/${value.slice(sourceRoot.length + 1)}`;
		if (value === join(runDirectory, ".session-reserves-before.json"))
			return portableValue(environment.ACK_SESSION_RESERVES_FILE, materialized);
		for (const [relative, file] of resolvedFiles) if (value === file) return capsulePrefix + relative;
		assert(value !== runDirectory && !value.startsWith(`${runDirectory}/`), "CAPSULE_OUTPUT_UNDECLARED_PATH");
		if (value.startsWith(`${canonicalRoot}/`)) return capsulePrefix + value.slice(canonicalRoot.length + 1);
		return value;
	}
	if (Array.isArray(value)) return value.map((child) => portableValue(child, materialized));
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, portableValue(child, materialized)]));
	return value;
}

async function promoteGeneratedInputs(materialized: MaterializedCapsule, command: string) {
	const plans: Array<{ relative: string; destination: string; bytes: Buffer }> = [];
	for (const relative of promotionTargets(command, materialized)) {
		const source = materialized.resolvedFiles.get(relative);
		if (!source) continue;
		const destination = join(materialized.canonicalRoot, relative);
		const before = materialized.canonicalBefore.get(relative) ?? null;
		const current = await readFile(destination).catch((error) => {
			if (error?.code === "ENOENT") return null;
			throw error;
		});
		assert((current === null && before === null) || (current !== null && before !== null && current.equals(before)), "CAPSULE_OUTPUT_LOCAL_DRIFT");
		const raw = await privateJson(source);
		const value = portableValue(raw, materialized);
		if (current && JSON.stringify(JSON.parse(current.toString("utf8"))) === JSON.stringify(value)) continue;
		const bytes = JSON.stringify(raw) === JSON.stringify(value) ? await readFile(source) : Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
		await inspectPath(materialized.canonicalRoot, relative, true);
		plans.push({ relative, destination, bytes });
	}
	const promoted: string[] = [];
	for (const { relative, destination, bytes } of plans) {
		const temporary = `${destination}.promotion-${process.pid}-${Date.now()}`;
		try {
			await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
			await rename(temporary, destination);
		} finally {
			await unlink(temporary).catch(() => undefined);
		}
		promoted.push(relative);
	}
	return promoted;
}

export async function runCapsule(manifest: string, command: string, sourceRoot: string, readWorker?: ReadReserveWorker) {
	assert(commands.has(command), "CAPSULE_COMMAND_INVALID");
	const materialized = await materializeCapsule(manifest, sourceRoot, readWorker);
	const { environment, inputCount, sourceSha, reserve } = materialized;
	const inherited = { ...process.env };
	for (const key of Object.keys(inherited)) if ((key.startsWith("ACK_") && !["ACK_CLEAN_CONFIRM", "ACK_CLEAN_ALLOW_FOREIGN"].includes(key)) || key === "NODE_EXTRA_CA_CERTS") delete inherited[key];
	const child = spawn("bash", [join(sourceRoot, "deploy/ack/redeploy.sh"), command], { cwd: sourceRoot, env: { ...inherited, ...environment }, stdio: "inherit" });
	const exitCode = await new Promise<number>((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => resolve(code ?? 1)); });
	let mountedInputVerified = false;
	if (exitCode === 0 && reserve && ["all", "runtime-inputs", "provision", "validate"].includes(command)) {
		const bootstrap = JSON.parse(await readFile(environment.ACK_BOOTSTRAP_INPUTS_FILE!, "utf8"));
		const actual = (readWorker ?? readReserveWorker)(environment, bootstrap, reserve.workerSecretName);
		assert(actual?.configurationHash === reserve.receipt.configHash && actual.configuration?.revision === reserve.receipt.revision && actual.configuration?.enabled === reserve.receipt.enabled && actual.sourceSha === reserve.receipt.sourceSha, "CAPSULE_RESERVE_ADOPTION_MISMATCH");
		mountedInputVerified = true;
	}
	const promotedInputs = exitCode === 0 ? await promoteGeneratedInputs(materialized, command) : [];
	return { schemaVersion: 1, kind: "ack-portable-capsule", sourceSha, inputCount, command, exitCode, promotedInputs, ...(reserve ? { reserve: { ...reserve.receipt, mountedInputVerified } } : {}) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		const result = await runCapsule(process.argv[2], process.argv[3] ?? "all", resolve(import.meta.dirname, "../.."));
		process.stdout.write(`${JSON.stringify(result)}\n`);
		process.exitCode = result.exitCode;
	} catch {
		process.stderr.write("ACK_CAPSULE_INVALID\n");
		process.exitCode = 1;
	}
}
