import { type ChildProcess, execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const appDirectory = fileURLToPath(new URL("..", import.meta.url));
const guardUrl = new URL("./process-protection.ts", import.meta.url).href;
const launcher = new URL("../start-runtime-host.sh", import.meta.url);
const directories: string[] = [];
const processes = new Set<ChildProcess>();
const environment = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` };
const failure = "RUNTIME_PROCESS_PROTECTION_INVALID";

afterEach(async () => {
	for (const child of processes) {
		if (child.exitCode === null && child.signalCode === null) {
			const exited = once(child, "exit");
			child.kill("SIGKILL");
			await exited;
		}
	}
	processes.clear();
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true });
});

async function directory() {
	const value = await mkdtemp(join(tmpdir(), "runtime-process-protection-"));
	directories.push(value);
	return value;
}

async function runGuard(
	options: { flags?: string[]; preamble?: string; coreLimit?: string } = {},
) {
	return execute(
		"/bin/sh",
		[
			"-c",
			options.coreLimit ?? 'ulimit -S -c 0\nulimit -H -c 0\nexec "$@"',
			"protected-runtime-test",
			process.execPath,
			...(options.flags ?? ["--disable-sigusr1"]),
			"--experimental-strip-types",
			"--input-type=module",
			"-e",
			`import { assertRuntimeProcessProtection } from ${JSON.stringify(guardUrl)};
		${options.preamble ?? ""}
		try { assertRuntimeProcessProtection(); console.log("protected"); }
		catch (error) { console.log(error.code); process.exitCode = 17; }
		`,
		],
		{ cwd: appDirectory, env: environment, timeout: 10_000 },
	);
}

async function launchFixture(script: string) {
	const cwd = await directory();
	await mkdir(join(cwd, "dist"));
	await copyFile(launcher, join(cwd, "start-runtime-host.sh"));
	await writeFile(join(cwd, "dist/index.mjs"), script);
	return cwd;
}

describe("credential holder process protection", () => {
	it("accepts the real protected Node process before private configuration", async () => {
		await expect(runGuard()).resolves.toMatchObject({
			stdout: "protected\n",
			stderr: "",
		});
	});

	it.each([
		{ flags: [] },
		{ flags: ["--disable-sigusr1", "--inspect=127.0.0.1:0"] },
		{ flags: ["--disable-sigusr1", "--report-on-fatalerror"] },
		{ flags: ["--disable-sigusr1", "--cpu-prof"] },
		{ flags: ["--disable-sigusr1", "--trace-events-enabled"] },
		{ flags: ["--disable-sigusr1", "--import=data:text/javascript,void 0"] },
		{ flags: ["--disable-sigusr1", "--require=node:fs"] },
		{ preamble: "process.report.reportOnSignal = true;" },
		{ preamble: 'process.env.NODE_OPTIONS = "sentinel-private-value";' },
		{
			preamble:
				'const inspector = await import("node:inspector"); inspector.open(0, "127.0.0.1");',
		},
		{ coreLimit: 'ulimit -S -c 0\nexec "$@"' },
	])("rejects an unprotected process: %j", async (options) => {
		await expect(runGuard(options)).rejects.toMatchObject({
			code: 17,
			stdout: `${failure}\n`,
		});
	});

	it("refuses diagnostic environment before Node or any preload starts", async () => {
		const cwd = await launchFixture('console.log("application-entered");');
		const marker = join(cwd, "preload-entered");
		const preload = join(cwd, "preload.cjs");
		await writeFile(
			preload,
			`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "entered");`,
		);
		for (const name of [
			"NODE_OPTIONS",
			"NODE_DEBUG",
			"NODE_DEBUG_NATIVE",
			"NODE_V8_COVERAGE",
		]) {
			await expect(
				execute("/bin/sh", ["./start-runtime-host.sh"], {
					cwd,
					env: {
						...environment,
						[name]:
							name === "NODE_OPTIONS"
								? `--require=${preload}`
								: "sentinel-private-value",
					},
					timeout: 5000,
				}),
			).rejects.toMatchObject({
				code: 1,
				stdout: "",
				stderr: `{"service":"agent-runtime-host","code":"${failure}"}\n`,
			});
		}
		await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("starts with immutable zero core limits and cannot enable inspector through SIGUSR1", async () => {
		const cwd = await launchFixture(`
			import { execFileSync } from "node:child_process";
			import { url } from "node:inspector";
			import { createInterface } from "node:readline";
			function report() {
				console.log(JSON.stringify({
					inspector: url() ?? null,
					args: process.execArgv,
					limits: execFileSync("/bin/sh", ["-c", "ulimit -S -c\\nulimit -H -c"], { encoding: "utf8" }).trim().split(/\\s+/)
				}));
			}
			createInterface({input: process.stdin}).on("line", () => {report(); process.exit();});
			report();
		`);
		const child = spawn("/bin/sh", ["./start-runtime-host.sh"], {
			cwd,
			env: environment,
			stdio: ["pipe", "pipe", "pipe"],
		});
		processes.add(child);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		const exited = once(child, "exit");
		await once(child.stdout, "data");
		expect(child.kill("SIGUSR1")).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 100));
		child.stdin.end("probe\n");
		expect(await exited).toEqual([0, null]);
		expect(
			stdout
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line)),
		).toEqual([
			{ inspector: null, args: ["--disable-sigusr1"], limits: ["0", "0"] },
			{ inspector: null, args: ["--disable-sigusr1"], limits: ["0", "0"] },
		]);
		expect(stderr).toBe("");
	});
});
