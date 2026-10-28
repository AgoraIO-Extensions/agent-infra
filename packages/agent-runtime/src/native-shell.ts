#!/usr/local/bin/node
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const helper = "/usr/bin/setpriv";
const shell = "/bin/bash";
const dataRights = [
	"execute",
	"write-file",
	"read-file",
	"read-dir",
	"remove-dir",
	"remove-file",
	"make-char",
	"make-dir",
	"make-reg",
	"make-sock",
	"make-fifo",
	"make-block",
	"make-sym",
	"refer",
	"truncate",
].join(",");
const unavailable = () => new Error("RUNTIME_NATIVE_SHELL_UNAVAILABLE");

function inside(root: string, path: string) {
	const name = relative(root, path);
	return (
		name === "" ||
		(!isAbsolute(name) && name !== ".." && !name.startsWith("../"))
	);
}

/** No caller environment survives into the tool child, including shell startup hooks. */
export function nativeShellEnvironment(workspace: string): NodeJS.ProcessEnv {
	return {
		PATH: "/usr/local/bin:/usr/bin:/bin",
		HOME: workspace,
		TMPDIR: workspace,
		LANG: "C.UTF-8",
	};
}

async function immutableFile(path: string) {
	const actual = await realpath(path);
	const metadata = await stat(actual);
	if (!metadata.isFile() || (metadata.mode & 0o022) !== 0) throw unavailable();
	if (
		await access(actual, constants.W_OK).then(
			() => true,
			() => false,
		)
	)
		throw unavailable();
	return actual;
}

async function probe(environment: NodeJS.ProcessEnv) {
	await new Promise<void>((accept, reject) => {
		const child = spawn(
			helper,
			[
				"--no-new-privs",
				"--landlock-access",
				"fs:ioctl-dev",
				"--",
				"/bin/true",
			],
			{ env: environment, stdio: "ignore" },
		);
		const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
		child.once("error", () => {
			clearTimeout(timer);
			reject(unavailable());
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			if (code === 0) accept();
			else reject(unavailable());
		});
	});
}

/** Candidate child boundary for fixed native shell hooks; not production tool admission. */
export async function nativeShellPlan(
	workspace: string,
	cwd: string,
	args: readonly string[],
) {
	if (
		process.platform !== "linux" ||
		process.getuid?.() === 0 ||
		!isAbsolute(workspace) ||
		resolve(workspace) !== workspace ||
		!workspace.endsWith("/workspace") ||
		(await realpath(workspace)) !== workspace ||
		(await realpath(cwd)) !== cwd ||
		!inside(workspace, cwd) ||
		args.length !== 2 ||
		(args[0] !== "-c" && args[0] !== "-lc") ||
		typeof args[1] !== "string" ||
		args[1].includes("\0")
	)
		throw unavailable();
	const program = await immutableFile(fileURLToPath(import.meta.url));
	const installedHelper = await immutableFile(helper);
	const installedShell = await immutableFile(shell);
	if (
		[program, installedHelper, installedShell].some((path) =>
			inside(workspace, path),
		)
	)
		throw unavailable();
	const environment = nativeShellEnvironment(workspace);
	// Same complete ABI gate as Codex; a basic Landlock success is insufficient.
	await probe(environment);
	const rules: string[] = [];
	const grant = async (rights: string, path: string) => {
		const actual = await realpath(path).catch(() => undefined);
		if (!actual) return;
		if (inside(actual, workspace) || inside(workspace, actual))
			throw unavailable();
		rules.push("--landlock-rule", `path-beneath:${rights}:${actual}`);
	};
	for (const path of ["/bin", "/sbin", "/usr", "/lib", "/lib64"])
		await grant("execute,read-file,read-dir", path);
	await grant("read-file,read-dir", "/opt/codex/agent-infra-skills");
	await grant("read-dir", "/proc");
	await grant("read-file,read-dir", "/etc/ssl/certs");
	// Node/OpenSSL reads this system file at startup, before the probe script runs.
	await grant("read-file", await immutableFile("/etc/ssl/openssl.cnf"));
	for (const path of [
		"/etc/resolv.conf",
		"/etc/hosts",
		"/etc/nsswitch.conf",
		"/etc/passwd",
		"/etc/group",
	])
		await grant("read-file", path);
	for (const path of ["/dev/null", "/dev/zero", "/dev/random", "/dev/urandom"])
		await grant("read-file,write-file", path);
	rules.push("--landlock-rule", `path-beneath:${dataRights}:${workspace}`);
	return {
		command: helper,
		args: [
			"--no-new-privs",
			"--landlock-access",
			`fs:${dataRights},ioctl-dev`,
			...rules,
			"--",
			shell,
			"--noprofile",
			"--norc",
			"-c",
			args[1],
		],
		environment,
		cwd,
	};
}

async function main() {
	const workspace = process.env.AGENT_INFRA_NATIVE_SHELL_WORKSPACE;
	if (!workspace) throw unavailable();
	const plan = await nativeShellPlan(
		workspace,
		process.cwd(),
		process.argv.slice(2),
	);
	// A fresh spawn inherits only stdin/stdout/stderr, never extra native/Host FDs.
	const child = spawn(plan.command, plan.args, {
		cwd: plan.cwd,
		env: plan.environment,
		stdio: "inherit",
		detached: false,
	});
	const term = () => child.kill("SIGTERM");
	const interrupt = () => child.kill("SIGINT");
	process.on("SIGTERM", term);
	process.on("SIGINT", interrupt);
	await new Promise<void>((accept, reject) => {
		child.once("error", () => reject(unavailable()));
		child.once("close", (code, signal) => {
			process.exitCode = code ?? (signal === "SIGINT" ? 130 : 143);
			accept();
		});
	});
	process.off("SIGTERM", term);
	process.off("SIGINT", interrupt);
}

if (
	process.argv[1] &&
	pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
	await main().catch(() => {
		process.stderr.write("RUNTIME_NATIVE_SHELL_UNAVAILABLE\n");
		process.exitCode = 1;
	});
}
