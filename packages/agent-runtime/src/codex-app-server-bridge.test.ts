import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import {
	access,
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

// Exercise Linux admission on every test host; the helper itself is synthetic.
vi.mock("node:process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:process")>()),
	platform: "linux",
}));

vi.mock("node:crypto", () => ({
	createHash: () => {
		let value = "";
		return {
			update: (input: Uint8Array) => {
				value += Buffer.from(input).toString("utf8");
				return {
					digest: () =>
						value === "schema-matches"
							? "d3eace08be5dca386bfd1f1e8df650058b4113f1e10870a284d775d75517576a"
							: "0".repeat(64),
				};
			},
		};
	},
}));

import {
	CODEX_APP_SERVER_V2_PROVENANCE,
	CodexAppServerBridge,
	validateModelAccess,
} from "./codex-app-server-bridge.js";

const directories: string[] = [];
const originalPath = process.env.PATH;
const originalHome = process.env.HOME;
const originalCodexHome = process.env.CODEX_HOME;
const originalMcpConfiguration = process.env.AGENT_INFRA_TEST_MCP_CONFIGURATION;
const originalConnectionCredential =
	process.env.AGENT_INFRA_TEST_CONNECTION_CREDENTIAL;
const childPids: number[] = [];
const isolatedEnvironmentKeys = [
	"CODEX_HOME",
	"HOME",
	"PATH",
	...(process.platform === "darwin" ? ["__CF_USER_TEXT_ENCODING"] : []),
].sort();

async function installFakeCodex(mode: string) {
	const directory = await mkdtemp(
		join(tmpdir(), "agent-runtime-codex-bridge-"),
	);
	directories.push(directory);
	const executable = join(directory, "codex");
	const capturePath = join(directory, "captured-arguments.json");
	await writeFile(
		executable,
		`#!/usr/bin/env node
const { appendFileSync, closeSync, mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2);
const mode = ${JSON.stringify(mode)};
const capturePath = ${JSON.stringify(capturePath)};
if (mode === "stdin-closed" && args[0] === "app-server" && args[1] !== "generate-json-schema") {
  closeSync(0);
}
if (capturePath) {
  appendFileSync(capturePath, JSON.stringify({
    args,
    executable: process.argv[1],
    launchPath: process.env.PATH,
    pid: process.pid,
    cwd: process.cwd(),
    environmentKeys: Object.keys(process.env).sort(),
    environment: {
      codexHome: process.env.CODEX_HOME,
      home: process.env.HOME,
      cfUserTextEncoding: process.env.__CF_USER_TEXT_ENCODING,
      hasMcpConfiguration: Object.hasOwn(process.env, "AGENT_INFRA_TEST_MCP_CONFIGURATION"),
      hasConnectionCredential: Object.hasOwn(process.env, "AGENT_INFRA_TEST_CONNECTION_CREDENTIAL"),
      modelCredentialMatches: process.env.AGENT_INFRA_CODEX_MODEL_CREDENTIAL === "synthetic-loopback-token",
    },
  }) + "\\n");
}
if (args[0] === "--version") {
  if (mode === "version-hangs") setInterval(() => {}, 1_000);
  if (mode === "version-mismatch") process.stdout.write("codex-cli 0.0.0\\n");
  else process.stdout.write("codex-cli 0.153.0\\n");
  if (mode !== "version-hangs") process.exit(0);
}
if (args[0] === "app-server" && args[1] === "generate-json-schema") {
  if (mode === "schema-hangs") {
    setInterval(() => {}, 1_000);
  } else {
    const output = args[args.indexOf("--out") + 1];
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "codex_app_server_protocol.v2.schemas.json"), mode === "schema-mismatch" ? "schema-mismatch" : "schema-matches");
    process.exit(0);
  }
}
if (mode === "startup-exit") process.exit(9);
if (mode === "malformed-frame") process.stdout.write("not-json\\n");
if (mode === "oversized-frame") process.stdout.write("x".repeat(65_537) + "\\n");
if (mode === "queue-overflow") {
  for (let index = 0; index <= 256; index += 1) {
    process.stdout.write(JSON.stringify({ id: index }) + "\\n");
  }
}
if (mode === "stderr-exit") {
  process.stderr.write("redacted-child-output\\n");
  process.exit(9);
}
if (["shutdown-hangs", "schema-hangs", "version-hangs", "stdin-closed"].includes(mode)) {
	if (mode === "shutdown-hangs") {
		process.on("SIGTERM", () => {});
		setInterval(() => {}, 1_000);
	}
	if (mode === "stdin-closed") setInterval(() => {}, 1_000);
	else process.stdin.resume();
} else {
  process.stdin.on("data", (chunk) => process.stdout.write(chunk));
  process.stdin.on("end", () => process.exit(0));
}
`,
	);
	await chmod(executable, 0o755);
	const sandboxCapturePath = join(directory, "sandbox-admission.json");
	const helper = join(directory, "setpriv");
	await writeFile(
		helper,
		`#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
writeFileSync(${JSON.stringify(sandboxCapturePath)}, JSON.stringify({
  args: process.argv.slice(2),
  pid: process.pid,
  cwd: process.cwd(),
  environmentKeys: Object.keys(process.env).sort(),
}));
if (${JSON.stringify(mode)} === "sandbox-hangs") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
} else process.exit(${JSON.stringify(mode)} === "sandbox-unsupported" ? 127 : 0);
`,
	);
	await chmod(helper, 0o755);
	process.env.PATH = `${directory}${process.platform === "win32" ? ";" : ":"}${originalPath ?? ""}`;
	return { capturePath, sandboxCapturePath };
}

function options(overrides: Record<string, unknown> = {}) {
	const directory = mkdtempSync(join(tmpdir(), "agent-runtime-codex-pvc-"));
	directories.push(directory);
	return {
		dataDirectory: join(directory, "native"),
		model: "gpt-5.3-codex",
		reasoningEffort: "high",
		provenance: CODEX_APP_SERVER_V2_PROVENANCE,
		startupTimeoutMs: 5_000,
		shutdownTimeoutMs: 1_000,
		...overrides,
	};
}

function createStalledBridge(isolatedDirectory: string) {
	const process = new EventEmitter();
	Object.assign(process, {
		stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
		stdout: new EventEmitter(),
		stderr: Object.assign(new EventEmitter(), { resume: vi.fn() }),
		kill: vi.fn(),
	});
	const Bridge = CodexAppServerBridge as unknown as new (
		child: never,
		shutdownTimeoutMs: number,
		directory: string,
	) => CodexAppServerBridge;
	return {
		bridge: new Bridge(process as never, 25, isolatedDirectory),
		process,
	};
}

async function readAppCapture(path: string) {
	const captures = await readCaptures(path, 3);
	const capture = captures.at(-1);
	if (capture?.args[0] !== "app-server") {
		throw new Error("fake Codex did not record its app-server launch");
	}
	return capture;
}

async function readCaptures(path: string, minimum = 1) {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		try {
			const contents = await readFile(path, "utf8");
			const captures = contents
				.trim()
				.split("\n")
				.filter(Boolean)
				.map(
					(line) =>
						JSON.parse(line) as {
							args: string[];
							executable: string;
							launchPath: string;
							pid: number;
							cwd: string;
							environmentKeys: string[];
							environment: {
								codexHome?: string;
								home?: string;
								cfUserTextEncoding?: string;
								hasMcpConfiguration: boolean;
								hasConnectionCredential: boolean;
								modelCredentialMatches: boolean;
							};
						},
				);
			if (captures.length >= minimum) return captures;
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("fake Codex did not record its launch");
}

async function expectChildExited(pid: number) {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		try {
			process.kill(pid, 0);
		} catch {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("bridge child remained alive after a fatal error");
}

async function expectPathRemoved(path: string) {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		try {
			await access(path);
		} catch {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("bridge private runtime directory remained after child exit");
}

afterEach(async () => {
	for (const pid of childPids.splice(0)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// The test already confirmed this child exited.
		}
	}
	process.env.PATH = originalPath;
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
	else process.env.CODEX_HOME = originalCodexHome;
	if (originalMcpConfiguration === undefined) {
		delete process.env.AGENT_INFRA_TEST_MCP_CONFIGURATION;
	} else {
		process.env.AGENT_INFRA_TEST_MCP_CONFIGURATION = originalMcpConfiguration;
	}
	if (originalConnectionCredential === undefined) {
		delete process.env.AGENT_INFRA_TEST_CONNECTION_CREDENTIAL;
	} else {
		process.env.AGENT_INFRA_TEST_CONNECTION_CREDENTIAL =
			originalConnectionCredential;
	}
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true })),
	);
});

describe.sequential("Codex app-server v2 bridge", () => {
	it("admits Linux sandbox capabilities before sharing model credentials", async () => {
		const { sandboxCapturePath } = await installFakeCodex("echo");
		const bridge = await CodexAppServerBridge.open(
			options({
				model: "option_a/synthetic-model",
				modelAccess: {
					endpoint: "http://127.0.0.1:12345",
					credential: "synthetic-loopback-token",
				},
			}),
		);
		await bridge.close();
		const capture = JSON.parse(await readFile(sandboxCapturePath, "utf8"));
		expect(capture.args).toEqual([
			"--no-new-privs",
			"--landlock-access",
			"fs:ioctl-dev",
			"--",
			"/bin/true",
		]);
		expect(capture.environmentKeys).toEqual(isolatedEnvironmentKeys);
		await expectPathRemoved(capture.cwd);
	});

	it.each(["sandbox-unsupported", "sandbox-hangs", "sandbox-missing"])(
		"rejects %s before starting app-server or creating persistent storage",
		async (mode) => {
			const { capturePath, sandboxCapturePath } = await installFakeCodex(mode);
			if (mode === "sandbox-missing")
				await rm(join(dirname(capturePath), "setpriv"));
			const configuration = options({
				launchPath: `${dirname(capturePath)}:${dirname(process.execPath)}`,
				startupTimeoutMs: 2_000,
				model: "option_a/synthetic-model",
				modelAccess: {
					endpoint: "http://127.0.0.1:12345",
					credential: "synthetic-loopback-token",
				},
			});
			await expect(
				CodexAppServerBridge.open(configuration).then(async (bridge) => {
					await bridge.close();
					return bridge;
				}),
			).rejects.toMatchObject({
				code: "CODEX_APP_SERVER_SANDBOX_UNAVAILABLE",
				retryable: false,
			});
			const captures = await readCaptures(capturePath, 2);
			expect(captures).toHaveLength(2);
			expect(captures.map((capture) => capture.args[0])).toEqual([
				"--version",
				"app-server",
			]);
			expect(captures[1]?.args[1]).toBe("generate-json-schema");
			for (const capture of captures)
				expect(capture.environmentKeys).toEqual(isolatedEnvironmentKeys);
			await expect(access(configuration.dataDirectory)).rejects.toMatchObject({
				code: "ENOENT",
			});
			if (mode !== "sandbox-missing") {
				const capture = JSON.parse(await readFile(sandboxCapturePath, "utf8"));
				expect(capture.environmentKeys).toEqual(isolatedEnvironmentKeys);
				await expectPathRemoved(capture.cwd);
				expect(() => process.kill(capture.pid, 0)).toThrow();
			}
		},
		15_000,
	);

	it("isolates concurrent explicit launch paths from the parent PATH", async () => {
		const first = await installFakeCodex("echo");
		const second = await installFakeCodex("echo");
		process.env.PATH = "/synthetic-parent-path-without-codex";
		const captures = [first, second];
		const paths = captures.map(
			({ capturePath }) =>
				`${dirname(capturePath)}:${dirname(process.execPath)}`,
		);
		const bridges = await Promise.all(
			paths.map((launchPath) =>
				CodexAppServerBridge.open(options({ launchPath })),
			),
		);
		try {
			expect(process.env.PATH).toBe("/synthetic-parent-path-without-codex");
			for (const [index, capture] of captures.entries()) {
				const launches = await readCaptures(capture.capturePath, 3);
				expect(launches).toHaveLength(3);
				for (const launch of launches) {
					expect(launch.launchPath).toBe(paths[index]);
					expect(launch.executable).toBe(
						await realpath(join(dirname(capture.capturePath), "codex")),
					);
				}
			}
		} finally {
			await Promise.all(bridges.map((bridge) => bridge.close()));
		}
	});
	it.each([
		["empty", ""],
		["relative", "bin"],
		["mixed relative", "/usr/bin:bin"],
		["leading empty component", ":/usr/bin"],
		["trailing empty component", "/usr/bin:"],
		["interior empty component", "/usr/bin::/bin"],
		["NUL", "/usr/bin\0"],
		["newline", "/usr/bin\n"],
		["DEL", "/usr/bin\x7f"],
		["null", null],
		["array", ["/usr/bin"]],
	])(
		"rejects an explicit launch PATH with %s before spawning",
		async (_name, launchPath) => {
			const { capturePath } = await installFakeCodex("echo");
			const parentPath = process.env.PATH;
			await expect(
				CodexAppServerBridge.open(options({ launchPath })),
			).rejects.toMatchObject({
				code: "CODEX_APP_SERVER_CONFIGURATION_INVALID",
			});
			expect(process.env.PATH).toBe(parentPath);
			await expect(readFile(capturePath, "utf8")).rejects.toMatchObject({
				code: "ENOENT",
			});
		},
	);

	it("does not fall back to parent PATH when an explicit launch path is unavailable", async () => {
		await installFakeCodex("echo");
		const parentPath = process.env.PATH;
		await expect(
			CodexAppServerBridge.open(
				options({ launchPath: "/synthetic-missing-codex" }),
			),
		).rejects.toMatchObject({ code: "CODEX_APP_SERVER_UNAVAILABLE" });
		expect(process.env.PATH).toBe(parentPath);
	});
	it("reuses native storage while replacing and cleaning only the temporary HOME", async () => {
		const { capturePath } = await installFakeCodex("echo");
		const configuration = options();
		const first = await CodexAppServerBridge.open(configuration);
		const before = await readAppCapture(capturePath);
		await writeFile(join(before.cwd, "synthetic.txt"), "persisted");
		await first.close();
		const second = await CodexAppServerBridge.open(configuration);
		const captures = await readCaptures(capturePath, 6);
		const after = captures.at(-1);
		expect(after?.cwd).toBe(before.cwd);
		expect(after?.environment.codexHome).toBe(before.environment.codexHome);
		expect(after?.environment.home).not.toBe(before.environment.home);
		expect(await readFile(join(before.cwd, "synthetic.txt"), "utf8")).toBe(
			"persisted",
		);
		await second.close();
		for (const launch of [before, after]) {
			if (!launch?.environment.home)
				throw new Error("Missing synthetic launch");
			await expectPathRemoved(launch.environment.home);
		}
	});

	it.each(["", "/", "relative", "/tmp/../native"])(
		"rejects an uncontrolled storage path %s",
		async (dataDirectory) => {
			await installFakeCodex("echo");
			await expect(
				CodexAppServerBridge.open(options({ dataDirectory })),
			).rejects.toMatchObject({
				code: "CODEX_APP_SERVER_CONFIGURATION_INVALID",
			});
		},
	);

	it.each(["root", "home", "workspace"])(
		"rejects permissions exposing persistent %s to other users",
		async (target) => {
			if (!process.getuid) return;
			const { capturePath } = await installFakeCodex("echo");
			const configuration = options();
			const bridge = await CodexAppServerBridge.open(configuration);
			await bridge.close();
			const path =
				target === "root"
					? configuration.dataDirectory
					: join(configuration.dataDirectory, target);
			await writeFile(join(path, "sentinel"), "unchanged");
			for (const mode of [0o740, 0o702]) {
				await chmod(path, mode);
				await expect(
					CodexAppServerBridge.open(configuration),
				).rejects.toMatchObject({
					code: "CODEX_APP_SERVER_CONFIGURATION_INVALID",
				});
				expect((await lstat(path)).mode & 0o777).toBe(mode);
			}
			expect(await readFile(join(path, "sentinel"), "utf8")).toBe("unchanged");
			expect(
				(await readCaptures(capturePath, 7)).filter(({ args }) =>
					args.includes("--stdio"),
				),
			).toHaveLength(1);
		},
	);

	it("rejects persistent storage owned by a different runtime UID", async () => {
		if (!process.getuid) return;
		await installFakeCodex("echo");
		const configuration = options();
		const bridge = await CodexAppServerBridge.open(configuration);
		await bridge.close();
		const uid = vi
			.spyOn(process, "getuid")
			.mockReturnValue(process.getuid() + 1);
		try {
			await expect(
				CodexAppServerBridge.open(configuration),
			).rejects.toMatchObject({
				code: "CODEX_APP_SERVER_CONFIGURATION_INVALID",
			});
		} finally {
			uid.mockRestore();
		}
	});

	it.each(["HOME", "CODEX_HOME", "cwd"])(
		"rejects both directions of persistent storage overlap with %s",
		async (source) => {
			const { capturePath } = await installFakeCodex("echo");
			for (const relation of ["equal", "ancestor", "descendant"]) {
				const configuration = options();
				const personal =
					relation === "equal"
						? configuration.dataDirectory
						: relation === "ancestor"
							? join(configuration.dataDirectory, "personal")
							: dirname(configuration.dataDirectory);
				await mkdir(personal, { recursive: true });
				await writeFile(join(personal, "sentinel"), "unchanged");
				const cwd =
					source === "cwd"
						? vi.spyOn(process, "cwd").mockReturnValue(personal)
						: undefined;
				if (source !== "cwd") vi.stubEnv(source, personal);
				try {
					await expect(
						CodexAppServerBridge.open(configuration),
					).rejects.toMatchObject({
						code: "CODEX_APP_SERVER_CONFIGURATION_INVALID",
					});
				} finally {
					cwd?.mockRestore();
					vi.unstubAllEnvs();
				}
				expect(await readFile(join(personal, "sentinel"), "utf8")).toBe(
					"unchanged",
				);
			}
			expect(
				(await readCaptures(capturePath, 6)).some(({ args }) =>
					args.includes("--stdio"),
				),
			).toBe(false);
		},
	);

	it.each(["root", "home", "workspace"])(
		"rejects symlinked persistent %s without touching its target",
		async (target) => {
			await installFakeCodex("echo");
			const configuration = options();
			const bridge = await CodexAppServerBridge.open(configuration);
			await bridge.close();
			const linkedPath =
				target === "root"
					? configuration.dataDirectory
					: join(configuration.dataDirectory, target);
			const personal = await mkdtemp(join(tmpdir(), "synthetic-personal-"));
			directories.push(personal);
			await writeFile(join(personal, "sentinel"), "unchanged");
			await rm(linkedPath, { recursive: true });
			await symlink(personal, linkedPath);
			await expect(
				CodexAppServerBridge.open(configuration),
			).rejects.toMatchObject({
				code: "CODEX_APP_SERVER_CONFIGURATION_INVALID",
			});
			expect(await readFile(join(personal, "sentinel"), "utf8")).toBe(
				"unchanged",
			);
		},
	);

	it.each([
		"config.toml",
		"auth.json",
		"managed_config.toml",
		"workspace config",
	])(
		"rejects persistent %s as an untrusted configuration source",
		async (source) => {
			await installFakeCodex("echo");
			const configuration = options();
			const bridge = await CodexAppServerBridge.open(configuration);
			await bridge.close();
			if (source === "workspace config")
				await mkdir(join(configuration.dataDirectory, "workspace", ".codex"));
			else
				await writeFile(
					join(configuration.dataDirectory, "home", source),
					"synthetic-untrusted-configuration",
				);
			await expect(
				CodexAppServerBridge.open(configuration),
			).rejects.toMatchObject({
				code: "CODEX_APP_SERVER_CONFIGURATION_INVALID",
			});
		},
	);

	it("retains native session data and workspace when the process closes", async () => {
		const { capturePath } = await installFakeCodex("echo");
		const bridge = await CodexAppServerBridge.open(options());
		const captures = await readCaptures(capturePath, 3);
		const launch = captures[2];
		if (!launch?.environment.codexHome) throw new Error("missing launch");
		await writeFile(
			join(launch.environment.codexHome, "synthetic-session"),
			"session",
		);
		await writeFile(join(launch.cwd, "synthetic-workspace"), "workspace");
		await bridge.close();
		expect(
			await readFile(
				join(launch.environment.codexHome, "synthetic-session"),
				"utf8",
			),
		).toBe("session");
		expect(
			await readFile(join(launch.cwd, "synthetic-workspace"), "utf8"),
		).toBe("workspace");
	});

	it("starts every Codex subprocess with an isolated deployment-owned tool configuration", async () => {
		process.env.CODEX_HOME = "/parent-codex-home";
		process.env.HOME = "/parent-home";
		process.env.AGENT_INFRA_TEST_MCP_CONFIGURATION = "mcp-private";
		process.env.AGENT_INFRA_TEST_CONNECTION_CREDENTIAL = "connection-private";
		const { capturePath } = await installFakeCodex("echo");
		const bridge = await CodexAppServerBridge.open(options());
		const captures = await readCaptures(capturePath, 3);
		try {
			for (const capture of captures) {
				expect(capture.cwd).not.toBe(process.cwd());
				expect(capture.environmentKeys).toEqual(
					capture.args.includes("--stdio")
						? [...isolatedEnvironmentKeys, "TMPDIR"].sort()
						: isolatedEnvironmentKeys,
				);
				expect(capture.environment.codexHome).toBeDefined();
				expect(capture.environment.home).toBeDefined();
				if (process.platform === "darwin") {
					expect(capture.environment.cfUserTextEncoding).toBe(
						process.env.__CF_USER_TEXT_ENCODING ?? "",
					);
				}
				if (!capture.args.includes("--stdio")) {
					expect(capture.environment.codexHome).toBe(capture.environment.home);
				} else {
					expect(capture.environment.codexHome).not.toBe(
						capture.environment.home,
					);
				}
				expect(capture.environment.hasMcpConfiguration).toBe(false);
				expect(capture.environment.hasConnectionCredential).toBe(false);
			}
			expect(captures[2]?.args).toEqual([
				"app-server",
				"--stdio",
				"--strict-config",
				"--config",
				'model="gpt-5.3-codex"',
				"--config",
				'model_reasoning_effort="high"',
				"--config",
				"mcp_servers={}",
				"--config",
				"features.plugins=false",
				"--config",
				"features.use_legacy_landlock=true",
			]);
		} finally {
			await bridge.close();
		}
		for (const capture of captures) {
			if (capture.args.includes("--stdio"))
				await expect(access(capture.cwd)).resolves.toBeUndefined();
			else await expect(access(capture.cwd)).rejects.toThrow();
		}
	});

	it("measures one resolved executable before starting supported bounded argv", async () => {
		const { capturePath } = await installFakeCodex("echo");
		const bridge = await CodexAppServerBridge.open(options());
		const iterator = bridge.frames()[Symbol.asyncIterator]();
		await bridge.send({ id: 1, method: "synthetic/request" });
		await iterator.next();
		expect(bridge).not.toHaveProperty("process");
		const captures = await readCaptures(capturePath);
		expect(captures).toHaveLength(3);
		expect(captures.map(({ executable }) => executable)).toEqual([
			captures[0]?.executable,
			captures[0]?.executable,
			captures[0]?.executable,
		]);
		expect(captures[0]?.args).toEqual(["--version"]);
		expect(captures[1]?.args).toEqual([
			"app-server",
			"generate-json-schema",
			"--out",
			expect.any(String),
		]);
		const schemaDirectory = captures[1]?.args[3];
		if (!schemaDirectory) throw new Error("expected schema directory");
		await expect(access(schemaDirectory)).rejects.toThrow();
		const captured = captures[2];
		if (!captured) throw new Error("expected app-server launch");
		expect(captured.args).toEqual([
			"app-server",
			"--stdio",
			"--strict-config",
			"--config",
			'model="gpt-5.3-codex"',
			"--config",
			'model_reasoning_effort="high"',
			"--config",
			"mcp_servers={}",
			"--config",
			"features.plugins=false",
			"--config",
			"features.use_legacy_landlock=true",
		]);
		expect(captured.args).not.toContain("--session-source");
		expect(bridge.provenance()).toEqual(CODEX_APP_SERVER_V2_PROVENANCE);
		await bridge.close();
	});

	it("pins the loopback Responses provider and exposes only its short-lived token", async () => {
		const { capturePath } = await installFakeCodex("echo");
		const bridge = await CodexAppServerBridge.open(
			options({
				model: "synthetic/gpt-5.3-codex",
				modelAccess: {
					endpoint: "http://127.0.0.1:8080",
					credential: "synthetic-loopback-token",
				},
			}),
		);
		const captures = await readCaptures(capturePath, 3);
		const server = captures[2];
		if (!server) throw new Error("expected app-server launch");
		expect(
			captures
				.slice(0, 2)
				.every(
					(capture) =>
						!capture.environmentKeys.includes(
							"AGENT_INFRA_CODEX_MODEL_CREDENTIAL",
						),
				),
		).toBe(true);
		expect(server.environmentKeys).toEqual(
			[
				...isolatedEnvironmentKeys,
				"AGENT_INFRA_CODEX_MODEL_CREDENTIAL",
				"TMPDIR",
			].sort(),
		);
		expect(server.environment.modelCredentialMatches).toBe(true);
		expect(server.args).toEqual(
			expect.arrayContaining([
				'model_provider="agent_infra"',
				'model_providers.agent_infra.name="Agent Infra Active Model"',
				'model_providers.agent_infra.base_url="http://127.0.0.1:8080"',
				'model_providers.agent_infra.env_key="AGENT_INFRA_CODEX_MODEL_CREDENTIAL"',
				'model_providers.agent_infra.wire_api="responses"',
				"model_providers.agent_infra.requires_openai_auth=false",
				"model_providers.agent_infra.supports_websockets=false",
				"model_providers.agent_infra.request_max_retries=0",
				"model_providers.agent_infra.stream_max_retries=0",
			]),
		);
		await bridge.close();
	});

	it("rejects unpinned provenance and unsafe launch configuration before spawning", async () => {
		const { capturePath } = await installFakeCodex("echo");
		await expect(
			CodexAppServerBridge.open(
				options({
					provenance: {
						...CODEX_APP_SERVER_V2_PROVENANCE,
						schemaSha256: `sha256:${"0".repeat(64)}`,
					},
				}),
			),
		).rejects.toMatchObject({ code: "CODEX_APP_SERVER_PROVENANCE_MISMATCH" });
		await expect(
			CodexAppServerBridge.open(options({ model: "model\nunsafe" })),
		).rejects.toMatchObject({ code: "CODEX_APP_SERVER_CONFIGURATION_INVALID" });
		for (const modelAccess of [
			{ endpoint: "https://model.invalid/v1?private=value", credential: "x" },
			{ endpoint: "file:///private", credential: "x" },
			{ endpoint: "https://model.invalid/v1", credential: "contains space" },
			{ endpoint: "https://model.invalid/v1", credential: "line\nbreak" },
		]) {
			await expect(
				CodexAppServerBridge.open(options({ modelAccess })),
			).rejects.toMatchObject({
				code: "CODEX_APP_SERVER_CONFIGURATION_INVALID",
			});
		}
		await expect(readFile(capturePath, "utf8")).rejects.toThrow();
	});

	it("fails closed when the executable version differs from the pin without leaking stderr", async () => {
		await installFakeCodex("version-mismatch");
		await expect(CodexAppServerBridge.open(options())).rejects.toEqual(
			expect.objectContaining({
				code: "CODEX_APP_SERVER_PROVENANCE_MISMATCH",
				message:
					"Codex app-server provenance does not match the pinned release",
			}),
		);
		await installFakeCodex("stderr-exit");
		const bridge = await CodexAppServerBridge.open(options());
		const error = await bridge
			.frames()
			[Symbol.asyncIterator]()
			.next()
			.catch((value: unknown) => value);
		expect(error).toEqual(
			expect.objectContaining({ code: "CODEX_APP_SERVER_EXITED" }),
		);
		expect(error).not.toMatchObject({
			message: expect.stringContaining("redacted-child-output"),
		});
		await bridge.close();
	});

	it("fails closed when the measured app-server schema differs from the pin", async () => {
		const { capturePath } = await installFakeCodex("schema-mismatch");
		const error = await CodexAppServerBridge.open(options()).catch(
			(value: unknown) => value,
		);
		expect(error).toMatchObject({
			code: "CODEX_APP_SERVER_PROVENANCE_MISMATCH",
		});
		expect(error).not.toMatchObject({
			message: expect.stringContaining("agent-runtime-codex-schema"),
		});
		const captures = await readCaptures(capturePath);
		expect(captures.map(({ args }) => args.slice(0, 2))).toEqual([
			["--version"],
			["app-server", "generate-json-schema"],
		]);
	});

	it("frames JSONL without exposing the child process", async () => {
		await installFakeCodex("echo");
		const bridge = await CodexAppServerBridge.open(options());
		const iterator = bridge.frames()[Symbol.asyncIterator]();
		await bridge.send({ id: 7, method: "synthetic/request" });
		expect(await iterator.next()).toEqual({
			done: false,
			value: { id: 7, method: "synthetic/request" },
		});
		await bridge.close();
		await expect(
			bridge.send({ id: 8, method: "synthetic/request" }),
		).rejects.toMatchObject({ code: "CODEX_APP_SERVER_CLOSED" });
	});

	it.each([
		["undefined", { toJSON: (): undefined => undefined }],
		["a scalar", { toJSON: (): number => 1 }],
	] as const)(
		"rejects a frame whose toJSON serializes to %s",
		async (_name, frame) => {
			await installFakeCodex("echo");
			const bridge = await CodexAppServerBridge.open(options());
			await expect(bridge.send(frame)).rejects.toMatchObject({
				code: "CODEX_APP_SERVER_FRAME_INVALID",
			});
			await bridge.close();
		},
	);

	it.each([
		["malformed-frame", "CODEX_APP_SERVER_FRAME_INVALID"],
		["oversized-frame", "CODEX_APP_SERVER_FRAME_INVALID"],
		["startup-exit", "CODEX_APP_SERVER_EXITED"],
	] as const)("returns a stable redacted error for %s", async (mode, code) => {
		await installFakeCodex(mode);
		const bridge = await CodexAppServerBridge.open(options());
		const iterator = bridge.frames()[Symbol.asyncIterator]();
		await expect(iterator.next()).rejects.toEqual(
			expect.objectContaining({ code }),
		);
		await bridge.close();
	});

	it("removes only its temporary HOME after an unexpected child exit", async () => {
		const { capturePath } = await installFakeCodex("startup-exit");
		const bridge = await CodexAppServerBridge.open(options());
		const { cwd, environment } = await readAppCapture(capturePath);
		await expect(
			bridge.frames()[Symbol.asyncIterator]().next(),
		).rejects.toMatchObject({ code: "CODEX_APP_SERVER_EXITED" });
		await expectPathRemoved(environment.home ?? "");
		await expect(access(cwd)).resolves.toBeUndefined();
		await bridge.close();
	});

	it.each(["malformed-frame", "oversized-frame", "queue-overflow"])(
		"reaps its child after fatal %s output without an explicit close",
		async (mode) => {
			const { capturePath } = await installFakeCodex(mode);
			const bridge = await CodexAppServerBridge.open(options());
			const { pid } = await readAppCapture(capturePath);
			childPids.push(pid);
			await expectChildExited(pid);
			await expect(
				bridge.frames()[Symbol.asyncIterator]().next(),
			).rejects.toMatchObject({ code: "CODEX_APP_SERVER_FRAME_INVALID" });
		},
	);

	it("fails queue consumers and reaps a process whose stdin rejects writes", async () => {
		const { capturePath } = await installFakeCodex("stdin-closed");
		const bridge = await CodexAppServerBridge.open(options());
		const { pid } = await readAppCapture(capturePath);
		childPids.push(pid);
		const iterator = bridge.frames()[Symbol.asyncIterator]();
		await expect(
			bridge.send({ id: 9, method: "synthetic/request" }),
		).rejects.toMatchObject({ code: "CODEX_APP_SERVER_EXITED" });
		await expect(iterator.next()).rejects.toMatchObject({
			code: "CODEX_APP_SERVER_EXITED",
		});
		await expectChildExited(pid);
	});

	it("bounds a hanging provenance probe", async () => {
		await installFakeCodex("version-hangs");
		await expect(
			CodexAppServerBridge.open(options({ startupTimeoutMs: 25 })),
		).rejects.toMatchObject({ code: "CODEX_APP_SERVER_TIMEOUT" });
	});

	it("bounds a hanging schema probe", async () => {
		const { capturePath } = await installFakeCodex("schema-hangs");
		await expect(CodexAppServerBridge.open(options())).rejects.toMatchObject({
			code: "CODEX_APP_SERVER_TIMEOUT",
		});
		const captures = await readCaptures(capturePath, 2);
		expect(captures[1]?.args.slice(0, 2)).toEqual([
			"app-server",
			"generate-json-schema",
		]);
	}, 10_000);

	it("kills a bridge process that ignores graceful shutdown", async () => {
		const { capturePath } = await installFakeCodex("shutdown-hangs");
		const bridge = await CodexAppServerBridge.open(
			options({ shutdownTimeoutMs: 25 }),
		);
		const { pid } = await readAppCapture(capturePath);
		childPids.push(pid);
		await expect(bridge.close()).rejects.toMatchObject({
			code: "CODEX_APP_SERVER_TIMEOUT",
		});
		await expectChildExited(pid);
	});

	it("keeps its private runtime directory until an unreaped child closes", async () => {
		const isolatedDirectory = await mkdtemp(
			join(tmpdir(), "agent-runtime-codex-bridge-stalled-"),
		);
		directories.push(isolatedDirectory);
		const { bridge, process } = createStalledBridge(isolatedDirectory);
		await expect(bridge.close()).rejects.toMatchObject({
			code: "CODEX_APP_SERVER_TIMEOUT",
		});
		await expect(access(isolatedDirectory)).resolves.toBeUndefined();
		process.emit("close");
		await expectPathRemoved(isolatedDirectory);
		directories.splice(directories.indexOf(isolatedDirectory), 1);
	});

	it("waits for private runtime cleanup after a concurrent reap", async () => {
		const isolatedDirectory = await mkdtemp(
			join(tmpdir(), "agent-runtime-codex-bridge-reaping-"),
		);
		directories.push(isolatedDirectory);
		const { bridge, process } = createStalledBridge(isolatedDirectory);
		const internals = bridge as unknown as {
			reapOwnedChild(): Promise<void>;
			cleanIsolatedDirectory(): Promise<void>;
		};
		let releaseCleanup!: () => void;
		const cleanup = new Promise<void>((resolve) => {
			releaseCleanup = resolve;
		});
		const clean = vi
			.spyOn(internals, "cleanIsolatedDirectory")
			.mockReturnValue(cleanup);
		const reaping = internals.reapOwnedChild();
		const closing = bridge.close();
		process.emit("close");
		await reaping;
		await vi.waitFor(() => expect(clean).toHaveBeenCalled());
		let settled = false;
		void closing.then(() => {
			settled = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(settled).toBe(false);
		releaseCleanup();
		await closing;
		clean.mockRestore();
	});
});

describe("model access admission", () => {
	it.each([
		"https://model.invalid/v1?",
		"https://model.invalid/v1#",
		"https://model.invalid/v1?query=value",
		"https://model.invalid/v1#fragment",
		"http://127.0.0.1:1234/v1?",
		"http://[::1]:1234/v1#",
	])("rejects endpoint query or fragment delimiters %s", (endpoint) => {
		expect(() =>
			validateModelAccess({
				endpoint,
				credential: "synthetic-model-credential",
			}),
		).toThrow();
	});
	it.each([
		"e",
		"x".repeat(15),
		"x".repeat(8193),
		"contains a space",
		"synthetic\ncredential",
	])("rejects inadmissible credential length or characters", (credential) => {
		expect(() =>
			validateModelAccess({ endpoint: "https://model.invalid/v1", credential }),
		).toThrow();
	});
	it.each(["x".repeat(16), "x".repeat(8192)])(
		"accepts credential boundary lengths",
		(credential) => {
			expect(
				validateModelAccess({
					endpoint: "https://model.invalid/v1",
					credential,
				}),
			).toEqual({ endpoint: "https://model.invalid/v1", credential });
		},
	);
	it.each([
		"http://model.invalid/v1",
		"http://localhost/v1",
		"http://127.1/v1",
		"http://2130706433/v1",
		"http://0x7f000001/v1",
		"http://127.0.0.2/v1",
		"http://[::ffff:127.0.0.1]/v1",
		"http://127.0.0.1@model.invalid/v1",
	])("rejects cleartext nonliteral loopback %s", (endpoint) => {
		expect(() =>
			validateModelAccess({
				endpoint,
				credential: "synthetic-model-credential",
			}),
		).toThrow();
	});
	it.each([
		"https://model.invalid/v1",
		"http://127.0.0.1:1234/v1",
		"http://[::1]:1234/v1",
	])("accepts approved transport scheme %s", (endpoint) => {
		expect(
			validateModelAccess({
				endpoint,
				credential: "synthetic-model-credential",
			})?.endpoint,
		).toBe(endpoint);
	});
});
