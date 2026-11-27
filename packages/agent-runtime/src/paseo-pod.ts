import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
	lstat,
	mkdir,
	readdir,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { verifyClaudeInstallation } from "./claude-installation.js";
import { codexSessionMemoryConfig } from "./codex-memory-config.js";
import { spawnNativeProcess } from "./native-process.js";
import { verifyOpenCodeInstallation } from "./opencode-installation.js";
import {
	piDeploymentFiles,
	piSkillFolderName,
} from "./pi-deployment-skills.js";
import { verifyPiInstallation } from "./pi-installation.js";
import { writePiConfiguration } from "./pi-launch-configuration.js";

export const piPodPaths = {
	requests: "/run/pi-requests",
	sockets: "/run/pi-sockets",
	workspaces: "/var/lib/pi-workspaces",
	state: "/var/lib/pi-state",
} as const;
const port = 37651;
const level = z.enum(["low", "medium", "high", "xhigh", "max"]);
const requestSchema = z.strictObject({
	sessionRef: z.uuid(),
	model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/),
	effort: level,
	levels: z.array(level).min(1).max(5),
	textOnly: z.literal(true).optional(),
	piSkills: z.literal(true).optional(),
	proxyPort: z.number().int().min(1).max(65535),
	proxyToken: z.string().regex(/^(?:[a-f0-9]{64}|[A-Za-z0-9_-]{43})$/),
	password: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
const failure = () => new Error("RUNTIME_NATIVE_SESSION_UNAVAILABLE");
const textFlags = [
	"--no-extensions",
	"--no-skills",
	"--no-prompt-templates",
	"--no-themes",
	"--no-context-files",
];

async function directory(path: string) {
	await mkdir(path, { mode: 0o700, recursive: true });
	if ((await realpath(path)) !== path || !(await lstat(path)).isDirectory())
		throw failure();
	return path;
}

async function deploymentInstructions(
	root: string,
	name: "AGENTS.md" | "CLAUDE.md" = "AGENTS.md",
) {
	const path = join(root, name);
	try {
		return (await lstat(path)).isFile() ? path : undefined;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export async function fetchPiSkillFolders(endpoint: string, token: string) {
	const response = await fetch(`${endpoint}/pi/skills`, {
		headers: { "x-api-key": token },
		redirect: "error",
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) throw failure();
	return z
		.array(z.string().regex(piSkillFolderName))
		.parse(await response.json());
}

export async function piPodArguments(
	folders: readonly string[] = [],
	root = piDeploymentFiles,
) {
	const instructions = await deploymentInstructions(root);
	return [
		...(folders.length
			? [
					"--no-builtin-tools",
					"--extension",
					fileURLToPath(new URL("../dist/pi-skill-read.mjs", import.meta.url)),
				]
			: ["--no-tools"]),
		...textFlags,
		...folders.flatMap((folder) => [
			"--skill",
			join(root, ".agents", "skills", folder, "SKILL.md"),
		]),
		...(instructions ? ["--append-system-prompt", instructions] : []),
	];
}

export async function claudePodPrompt(root = piDeploymentFiles) {
	const path = await deploymentInstructions(root, "CLAUDE.md");
	return path ? await readFile(path, "utf8") : undefined;
}

export async function openCodePodConfig(
	permit: Pick<
		z.infer<typeof requestSchema>,
		"model" | "proxyToken" | "levels"
	>,
	endpoint: string,
	root = piDeploymentFiles,
) {
	const instructions = await deploymentInstructions(root);
	const modelId = `anthropic/${permit.model}`;
	return {
		...(instructions ? { instructions: [instructions] } : {}),
		model: modelId,
		small_model: modelId,
		enabled_providers: ["anthropic"],
		provider: {
			anthropic: {
				whitelist: [permit.model],
				options: { baseURL: `${endpoint}/v1`, apiKey: permit.proxyToken },
				models: {
					[permit.model]: {
						name: "Configured model",
						reasoning: true,
						variants: Object.fromEntries(
							permit.levels.map((effort) => [
								effort,
								{ thinking: { type: "adaptive" }, effort },
							]),
						),
					},
				},
			},
		},
		tools: { "*": false },
		permission: { "*": "deny" },
		autoupdate: false,
		share: "disabled",
		agent: { title: { disable: true }, summary: { disable: true } },
		formatter: false,
	};
}

// Fixed-size frames on a Pod-loopback connection. Grant material never goes on this channel.
async function frame(
	socket: Socket,
	length: number,
	timeout: number,
): Promise<Buffer> {
	const signal = AbortSignal.timeout(timeout);
	for (;;) {
		if (socket.destroyed || socket.readableEnded) throw failure();
		if (socket.readableLength > length) throw failure();
		const value = socket.read(length) as Buffer | null;
		if (value !== null) return value;
		await new Promise<void>((resolve, reject) => {
			const stop = () => {
				socket.off("readable", ready);
				socket.off("close", lost);
				socket.off("end", lost);
				signal.removeEventListener("abort", lost);
			};
			const ready = () => {
				stop();
				resolve();
			};
			const lost = () => {
				stop();
				reject(failure());
			};
			socket.once("readable", ready);
			socket.once("close", lost);
			socket.once("end", lost);
			signal.addEventListener("abort", lost, { once: true });
			if (signal.aborted) lost();
		});
	}
}

/** The companion never received a launch permit. Recovery of the original reference can be retried. */
export class PiCompanionNotReady extends Error {
	constructor() {
		super("RUNTIME_NATIVE_SESSION_UNAVAILABLE");
	}
}

// Retrying a connection is safe only before any permit exists or native launch is requested.
async function connectIdleCompanion() {
	const deadline = performance.now() + 30_000;
	while (performance.now() < deadline) {
		const socket = createConnection({ host: "127.0.0.1", port });
		socket.on("error", () => socket.destroy());
		try {
			await once(socket, "connect", { signal: AbortSignal.timeout(2000) });
			socket.write("L");
			const nonce = (await frame(socket, 36, 3000)).toString();
			if (!z.uuid().safeParse(nonce).success) throw failure();
			return { socket, nonce };
		} catch {
			socket.destroy();
			await delay(150);
		}
	}
	throw new PiCompanionNotReady();
}

export async function openPiPodDaemon(input: {
	textOnly?: boolean;
	piSkills?: boolean;
	sessionRef: string;
	model: string;
	effort: string;
	levels: readonly string[];
	endpoint: string;
	proxyToken: string;
}) {
	const endpoint = new URL(input.endpoint);
	if (endpoint.href !== `http://127.0.0.1:${endpoint.port}/`) throw failure();
	const password = randomBytes(32).toString("base64url");
	const permit = requestSchema.parse({
		sessionRef: input.sessionRef,
		model: input.model,
		effort: input.effort,
		levels: input.levels,
		...(input.textOnly ? { textOnly: true } : {}),
		...(input.piSkills ? { piSkills: true } : {}),
		proxyPort: Number(endpoint.port),
		proxyToken: input.proxyToken,
		password,
	});
	if (!permit.levels.includes(permit.effort)) throw failure();
	const { socket, nonce } = await connectIdleCompanion();
	const exited = new Promise<void>((resolve) => socket.once("close", resolve));
	let ownedPermit: string | undefined;
	try {
		const path = join(piPodPaths.requests, nonce);
		await writeFile(path, JSON.stringify(permit), { mode: 0o600, flag: "wx" });
		ownedPermit = path;
		socket.write("S");
		if ((await frame(socket, 1, 30000)).toString() !== "R") throw failure();
		return {
			socketPath: join(piPodPaths.sockets, `${nonce}.sock`),
			password,
			exited,
			close: async () => {
				if (socket.destroyed) return;
				socket.end();
				try {
					await Promise.race([
						exited,
						delay(6000, undefined, { ref: false }).then(() => {
							throw failure();
						}),
					]);
				} finally {
					socket.destroy();
				}
			},
		};
	} catch {
		socket.destroy();
		throw failure();
	} finally {
		if (ownedPermit) await rm(ownedPermit, { force: true });
	}
}

/** Dedicated PID namespace, read-only Host permits, fixed Pi executable and local model proxy. */
export async function runPiPodCompanion(
	template: "pi" | "codex" | "claude" | "opencode" = "pi",
) {
	return runPaseoPodCompanion(template);
}

/** Reject configuration from the previous process or workspace before starting the fixed provider. */
export async function assertTextOnlyCodexStartup(home: string, cwd: string) {
	for (const path of [
		join(cwd, ".codex"),
		...[
			"managed_config.toml",
			"hooks.json",
			"auth.json",
			"environments.toml",
			"plugins",
			"skills",
			"agents",
			".codex",
		].map((name) => join(home, name)),
	]) {
		const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
		if (stat) throw failure();
	}
	const config = await lstat(join(home, "config.toml")).catch(
		(error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		},
	);
	if (
		config &&
		(!config.isFile() ||
			config.nlink !== 1 ||
			config.uid !== process.getuid?.())
	)
		throw failure();
}

export async function runPaseoPodCompanion(
	template: "pi" | "codex" | "claude" | "opencode",
) {
	if (!["pi", "codex", "claude", "opencode"].includes(template))
		throw failure();
	if (
		process.platform !== "linux" ||
		process.ppid !== 1 ||
		(await realpath("/proc/1/exe")) !== "/usr/bin/tini" ||
		process.getuid?.() !== 1000
	)
		throw failure();
	const pi = template === "pi" ? await verifyPiInstallation() : undefined;
	const opencode =
		template === "opencode"
			? await verifyOpenCodeInstallation("/opt/opencode/bin/opencode")
			: undefined;
	const claude =
		template === "claude" ? await verifyClaudeInstallation() : undefined;
	if (!pi && !opencode && !claude && template !== "codex") throw failure();
	let busy = false;
	const server = createServer({ allowHalfOpen: true }, (socket) => {
		socket.on("error", () => socket.destroy());
		void (async () => {
			const initial = (await frame(socket, 1, 2000)).toString();
			if (initial === "?") {
				socket.end("R");
				return;
			}
			if (initial !== "L" || busy) throw failure();
			busy = true;
			try {
				await serve(socket);
			} finally {
				busy = false;
				socket.destroy();
			}
		})().catch(() => socket.destroy());
	});
	server.maxConnections = 8;
	async function serve(socket: Socket) {
		const nonce = randomUUID();
		socket.write(nonce);
		if ((await frame(socket, 1, 5000)).toString() !== "S") throw failure();
		const permitFile = join(piPodPaths.requests, nonce);
		const stat = await lstat(permitFile);
		if (
			!stat.isFile() ||
			stat.uid !== 1000 ||
			(stat.mode & 0o077) !== 0 ||
			stat.size > 4096
		)
			throw failure();
		const permit = requestSchema.parse(
			JSON.parse(await readFile(permitFile, "utf8")),
		);
		if (!permit.levels.includes(permit.effort)) throw failure();
		const base = await directory(join(piPodPaths.state, permit.sessionRef));
		const cwd = join(piPodPaths.workspaces, permit.sessionRef, "workspace");
		if ((await realpath(cwd)) !== cwd) throw failure();
		const [home, config, tmp, state] = await Promise.all(
			["home", "config", "tmp", "paseo"].map((key) =>
				directory(join(base, key)),
			),
		);
		if (!home || !config || !tmp || !state) throw failure();
		const endpoint = `http://127.0.0.1:${permit.proxyPort}`;
		let provider: string;
		let command: readonly string[];
		let env: Record<string, string>;
		if (pi) {
			await writePiConfiguration(
				config,
				permit.model,
				permit.levels,
				permit.effort,
				endpoint,
				false,
			);
			provider = "pi";
			command = [
				pi.executable,
				pi.cli,
				...(await piPodArguments(
					permit.piSkills
						? await fetchPiSkillFolders(endpoint, permit.proxyToken)
						: [],
				)),
			];
			env = {
				PATH: "/usr/local/bin:/usr/bin:/bin",
				HOME: home,
				TMPDIR: tmp,
				PI_CODING_AGENT_DIR: config,
				AGENT_INFRA_PI_WORKSPACE: cwd,
				AGENT_INFRA_PI_MODEL_TOKEN: permit.proxyToken,
				...(permit.piSkills
					? { AGENT_INFRA_PI_SKILL_READER: `${endpoint}/pi/skill-read` }
					: {}),
			};
		} else if (template === "codex") {
			if (permit.textOnly) await assertTextOnlyCodexStartup(home, cwd);
			await writeFile(
				join(home, "config.toml"),
				[
					'model_provider = "agent_infra"',
					'model_catalog_json = "/opt/codex/share/models.json"',
					`model = ${JSON.stringify(permit.model)}`,
					`model_reasoning_effort = ${JSON.stringify(permit.effort)}`,
					'approval_policy = "never"',
					'sandbox_mode = "workspace-write"',
					...(permit.textOnly
						? ["features.memories = false"]
						: Object.entries(codexSessionMemoryConfig).map(
								([name, enabled]) => `${name} = ${enabled}`,
							)),
					"[model_providers.agent_infra]",
					'name = "Agent Infra Active Model"',
					`base_url = "http://127.0.0.1:${permit.proxyPort}"`,
					'env_key = "OPENAI_API_KEY"',
					'wire_api = "responses"',
					"requires_openai_auth = false",
					"supports_websockets = false",
					"request_max_retries = 0",
					"stream_max_retries = 0",
					"",
				].join("\n"),
				{ mode: 0o600 },
			);
			provider = "codex";
			command = ["/opt/codex/bin/codex"];
			env = {
				PATH: "/usr/local/bin:/usr/bin:/bin",
				HOME: home,
				TMPDIR: tmp,
				CODEX_HOME: home,
				OPENAI_API_KEY: permit.proxyToken,
			};
		} else if (claude) {
			provider = "claude";
			command = [
				claude.executable,
				"--safe-mode",
				"--strict-mcp-config",
				"--tools=",
			];
			env = {
				PATH: "/usr/local/bin:/usr/bin:/bin",
				HOME: home,
				TMPDIR: tmp,
				CLAUDE_CONFIG_DIR: config,
				ANTHROPIC_BASE_URL: endpoint,
				ANTHROPIC_AUTH_TOKEN: permit.proxyToken,
				CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
				ANTHROPIC_SMALL_FAST_MODEL: permit.model,
				ANTHROPIC_DEFAULT_HAIKU_MODEL: permit.model,
			};
		} else if (opencode) {
			provider = "agent-infra-opencode";
			command = [opencode.executable, "acp", "--cwd", cwd];
			env = {
				PATH: "/usr/bin:/bin",
				HOME: "/opt/paseo/opencode-home",
				TMPDIR: tmp,
				XDG_CONFIG_HOME: "/opt/paseo/opencode-config",
				XDG_DATA_HOME: await directory(join(base, "data")),
				XDG_CACHE_HOME: await directory(join(base, "cache")),
				XDG_STATE_HOME: await directory(join(base, "state")),
				OPENCODE_DISABLE_PROJECT_CONFIG: "true",
				OPENCODE_DISABLE_MODELS_FETCH: "true",
				OPENCODE_DISABLE_AUTOUPDATE: "true",
				OPENCODE_DISABLE_PRUNE: "true",
				OPENCODE_CONFIG_CONTENT: JSON.stringify(
					await openCodePodConfig(permit, endpoint),
				),
			};
		} else throw failure();
		if (socket.destroyed || socket.readableEnded) throw failure();
		const native = await spawnNativeProcess(
			base,
			state,
			{
				command: "/opt/paseo/bin/node",
				args: ["/opt/paseo/daemon.mjs"],
				env: {
					PATH: "/usr/local/bin:/usr/bin:/bin",
					HOME: state,
					TMPDIR: tmp,
					PASEO_HOME: state,
				},
			},
			"AGENT_INFRA_PASEO_OWNER",
		);
		const lines = createInterface({ input: native.child.stdout });
		const lost = new AbortController();
		const abort = () => lost.abort();
		socket.once("end", abort);
		socket.once("close", abort);
		void native.exited.then(abort);
		native.child.stdin.on("error", abort);
		const socketPath = join(piPodPaths.sockets, `${nonce}.sock`);
		try {
			if (socket.destroyed || socket.readableEnded) throw failure();
			const ready = once(lines, "line", {
				signal: AbortSignal.any([lost.signal, AbortSignal.timeout(30000)]),
			});
			native.child.stdin.write(
				`${JSON.stringify({
					provider,
					...(claude
						? {
								model: permit.model,
								levels: permit.levels,
								appendSystemPrompt: await claudePodPrompt(),
							}
						: {}),
					home: state,
					socketPath,
					password: permit.password,
					command,
					env,
				})}\n`,
			);
			if ((await ready)[0] !== "AGENT_INFRA_PASEO_READY" || lost.signal.aborted)
				throw failure();
			socket.write("R");
			await new Promise<void>((resolve) => {
				lost.signal.addEventListener("abort", () => resolve(), { once: true });
				if (lost.signal.aborted) resolve();
			});
		} finally {
			const watchdog = setTimeout(() => process.exit(1), 5000);
			lines.close();
			native.child.stdin.end();
			await Promise.race([native.exited, delay(1500)]);
			// Exit the entire dedicated container if any provider process survives retirement.
			try {
				await native.close();
				for (let attempt = 0; ; attempt++) {
					const other = (await readdir("/proc")).some(
						(name) =>
							/^\d+$/.test(name) &&
							Number(name) !== process.pid &&
							name !== "1",
					);
					if (!other) break;
					if (attempt === 20) process.exit(1);
					await delay(50);
				}
			} catch {
				process.exit(1);
			}
			await rm(socketPath, { force: true });
			clearTimeout(watchdog);
		}
	}
	server.listen(port, "127.0.0.1");
	await once(server, "listening");
}
