import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import {
	type NativeProcessLaunch,
	retireNativeProcess,
	spawnNativeProcess,
} from "./native-process.js";

const unavailable = () => new Error("RUNTIME_NATIVE_SESSION_UNAVAILABLE");
const helper = "/usr/bin/setpriv";
const data =
	"write-file,read-file,read-dir,remove-dir,remove-file,make-dir,make-reg,make-sock,make-fifo,make-sym,refer,truncate";
const program = "execute,read-file,read-dir";
const handled = `execute,${data},make-char,make-block,ioctl-dev`;

async function privateDirectory(path: string) {
	await mkdir(path, { mode: 0o700, recursive: true });
	const metadata = await lstat(path);
	if (
		!metadata.isDirectory() ||
		metadata.mode & 0o077 ||
		metadata.uid !== process.getuid?.() ||
		(await realpath(path)) !== path
	)
		throw unavailable();
	return path;
}

async function sandboxRules() {
	const args = ["--no-new-privs", "--landlock-access", `fs:${handled}`];
	const rule = (rights: string, path: string) =>
		args.push("--landlock-rule", `path-beneath:${rights}:${path}`);
	for (const path of ["/usr", "/opt/paseo", "/app/node_modules"])
		rule(program, path);
	for (const path of ["/etc/ssl/certs", "/opt/agent-infra-skill-hub/.agents"])
		rule("read-file,read-dir", path);
	for (const path of [
		"/etc/ssl/openssl.cnf",
		"/etc/hosts",
		"/etc/resolv.conf",
		"/etc/passwd",
		"/etc/group",
		"/etc/nsswitch.conf",
	])
		rule("read-file", await realpath(path));
	for (const path of ["/dev/null", "/dev/zero", "/dev/urandom", "/dev/random"])
		rule("read-file,write-file", path);
	return args;
}

export async function retirePaseoDaemon(directory: string) {
	const root = join(directory, "paseo");
	try {
		if ((await realpath(root)) !== root) throw unavailable();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	await retireNativeProcess(root, "AGENT_INFRA_PASEO_OWNER");
}

export async function launchPaseoDaemon(input: {
	directory: string;
	cwd: string;
	provider: "pi";
	launch: NativeProcessLaunch;
}) {
	const { directory, cwd, provider, launch } = input;
	if (
		cwd !== join(directory, "workspace") ||
		process.platform !== "linux" ||
		process.getuid?.() === 0 ||
		launch.command !== "/usr/local/bin/node" ||
		!launch.args[0]?.startsWith("/app/node_modules/")
	)
		throw unavailable();
	if (
		(await realpath(directory)) !== directory ||
		(await realpath(cwd)) !== cwd
	)
		throw unavailable();
	const common = await sandboxRules();
	const rule = (path: string, rights = data) => [
		"--landlock-rule",
		`path-beneath:${rights}:${path}`,
	];
	const childRules = [...common, ...rule(cwd)];
	for (const name of ["home", "tmp", "config"]) {
		const path = join(directory, name);
		if ((await realpath(path)) !== path) throw unavailable();
		childRules.push(...rule(path));
	}
	const root = await privateDirectory(join(directory, "paseo"));
	const state = await privateDirectory(join(root, "state"));
	// The upstream Pi adapter creates a temporary JS extension during launch.
	// The provider only reads this directory, and cannot access daemon identity/state.
	const extensions = await privateDirectory(join(root, "extensions"));
	childRules.push(...rule(extensions, "read-dir,read-file"));
	const socketDir = await privateDirectory(
		join(
			"/tmp",
			"paseo-" +
				createHash("sha256").update(directory).digest("hex").slice(0, 32),
		),
	);
	const socketPath = join(socketDir, "control.sock");
	const native = await spawnNativeProcess(
		root,
		state,
		{
			command: helper,
			args: [
				...childRules,
				...rule(extensions),
				...rule(state),
				...rule(socketDir),
				"--",
				"/opt/paseo/bin/node",
				"/opt/paseo/daemon.mjs",
			],
			env: {
				PATH: "/usr/local/bin:/usr/bin:/bin",
				HOME: state,
				PASEO_HOME: state,
				TMPDIR: extensions,
			},
		},
		"AGENT_INFRA_PASEO_OWNER",
	);
	const password = randomBytes(32).toString("base64url");
	const lines = createInterface({ input: native.child.stdout });
	const ready = new Promise<void>((resolve, reject) => {
		lines.on("line", (value) => {
			if (value === "AGENT_INFRA_PASEO_READY") resolve();
		});
		lines.once("close", () => reject(unavailable()));
		native.child.stdin.on("error", () => reject(unavailable()));
	});
	const abort = new AbortController();
	try {
		native.child.stdin.write(
			`${JSON.stringify({
				provider,
				home: state,
				socketPath,
				password,
				env: {
					PATH: "/usr/local/bin:/usr/bin:/bin",
					HOME: join(directory, "home"),
					TMPDIR: join(directory, "tmp"),
					PI_CODING_AGENT_DIR: join(directory, "config"),
					AGENT_INFRA_PI_WORKSPACE: cwd,
					AGENT_INFRA_PI_MODEL_TOKEN: launch.env.AGENT_INFRA_PI_MODEL_TOKEN,
					...(launch.env.AGENT_INFRA_PI_BROWSER_MCP_URL
						? {
								AGENT_INFRA_PI_BROWSER_MCP_URL:
									launch.env.AGENT_INFRA_PI_BROWSER_MCP_URL,
								AGENT_INFRA_PI_BROWSER_MCP_TOKEN:
									launch.env.AGENT_INFRA_PI_BROWSER_MCP_TOKEN,
							}
						: {}),
				},
				command: [helper, ...childRules, "--", launch.command, ...launch.args],
			})}\n`,
		);
		await Promise.race([
			ready,
			delay(30_000, undefined, { signal: abort.signal }).then(() => {
				throw unavailable();
			}),
		]);
	} catch {
		await native.close();
		throw unavailable();
	} finally {
		abort.abort();
	}
	let retiring: Promise<void> | undefined;
	const close = () =>
		(retiring ??= (async () => {
			native.child.stdin.end();
			await Promise.race([
				native.exited,
				delay(3000, undefined, { ref: false }),
			]);
			await native.close();
		})());
	return { socketPath, password, exited: native.exited, close };
}
