import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { privateJson } from "./private-input.ts";

const commands = new Set(["plan", "bootstrap-plan", "bootstrap-inputs", "bootstrap-database", "template-preflight", "bootstrap-login", "runtime-inputs", "bootstrap-credential", "provision", "validate", "cleanup-plan", "destroy", "all"]);
const variables = new Set([
	"ACK_KUBECONFIG", "ACK_NAMESPACE", "ACK_RELEASE", "ACK_VALUES_FILE", "ACK_IMAGE_MANIFEST", "ACK_RUNTIME_IMAGE_MANIFEST",
	"ACK_TEMPLATE_IMAGE_MANIFEST", "ACK_TEMPLATE_PREFLIGHT_JOBS_FILE", "ACK_TEMPLATE_VALIDATIONS_FILE", "ACK_WORKLOAD_CAPACITY_FILE",
	"ACK_PUBLIC_ORIGIN", "ACK_CA_CERT_FILE", "ACK_EVIDENCE_DIR", "ACK_BOOTSTRAP_INPUTS_FILE", "ACK_CREDENTIAL_BOOTSTRAP_FILE",
	"ACK_LOGIN_BOOTSTRAP_FILE", "ACK_AGENT_REQUESTS_FILE", "ACK_AGENT_STATE_DIR", "ACK_BROWSER_BLUEPRINT_DIR", "ACK_TEMPLATE_CONFIG_DIR",
	"ACK_CUSTOM_AGENT_CONFIGS", "ACK_CUSTOM_AGENT_PROBE", "ACK_CLEANUP_PLAN_FILE", "ACK_HELM_TIMEOUT", "NODE_EXTRA_CA_CERTS",
]);
const capsulePrefix = "@CAPSULE_ROOT@/";
const sourceToken = "@SOURCE_ROOT@";

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

export async function materializeCapsule(manifestFile: string, sourceRoot: string) {
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
	const files = new Map<string, any>();
	for (const relative of input.inputs) {
		relativePath(relative);
		assert(relative.endsWith(".json") && join(root, relative) !== manifestFile);
		await inspectPath(canonicalRoot, relative);
		files.set(relative, await privateJson(join(canonicalRoot, relative)));
	}
	const directories = input.directories.map(relativePath);
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
			else assert(!value.includes("@CAPSULE_ROOT@") && (!value.includes(sourceToken) || value === sourceToken), "CAPSULE_REFERENCE_INVALID");
		} else if (Array.isArray(value)) for (const child of value) collect(child, depth + 1);
		else if (value && typeof value === "object") for (const child of Object.values(value)) collect(child, depth + 1);
	};
	for (const value of [...files.values(), input.environment]) collect(value);
	for (const relative of references) if (!files.has(relative)) {
		const output = directories.some((dir: string) => relative === dir || relative.startsWith(`${dir}/`));
		await inspectPath(canonicalRoot, relative, output);
	}
	// All inputs are checked before creating a generated run or invoking any deployment command.
	const runDirectory = await mkdtemp(join(canonicalRoot, ".resolved-"));
	const resolvedFiles = new Map([...files.keys()].map((relative) => [relative, join(runDirectory, relative)]));
	const inputDirectories = new Set<string>();
	for (const file of files.keys()) {
		let parent = dirname(file);
		while (parent !== ".") { inputDirectories.add(parent); parent = dirname(parent); }
	}
	const materialize = (value: any): any => {
		if (typeof value === "string") {
			if (value === sourceToken) return sourceRoot;
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
		await writeFile(target, `${JSON.stringify(materialize(value), null, 2)}\n`, { mode: 0o600, flag: "wx" });
	}
	const environment: Record<string, string> = { ACK_SOURCE_SHA: sourceSha };
	for (const [name, value] of Object.entries(materialize(input.environment))) environment[name] = Array.isArray(value) ? value.join("\n") : value as string;
	return { environment, inputCount: files.size, sourceSha };
}

export async function runCapsule(manifest: string, command: string, sourceRoot: string) {
	assert(commands.has(command), "CAPSULE_COMMAND_INVALID");
	const { environment, inputCount, sourceSha } = await materializeCapsule(manifest, sourceRoot);
	const inherited = { ...process.env };
	for (const key of Object.keys(inherited)) if ((key.startsWith("ACK_") && !["ACK_CLEAN_CONFIRM", "ACK_CLEAN_ALLOW_FOREIGN"].includes(key)) || key === "NODE_EXTRA_CA_CERTS") delete inherited[key];
	const child = spawn("bash", [join(sourceRoot, "deploy/ack/redeploy.sh"), command], { cwd: sourceRoot, env: { ...inherited, ...environment }, stdio: "inherit" });
	const exitCode = await new Promise<number>((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => resolve(code ?? 1)); });
	return { schemaVersion: 1, kind: "ack-portable-capsule", sourceSha, inputCount, command, exitCode };
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
