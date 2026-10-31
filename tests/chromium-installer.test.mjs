import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function cleanFixture(path) {
	const info = await lstat(path);
	if (info.isDirectory()) {
		await chmod(path, 0o755);
		for (const name of await readdir(path))
			await cleanFixture(join(path, name));
	} else await chmod(path, 0o644);
	await rm(path, { recursive: true, force: true });
}

async function setup(t, { mode = "success", badHash } = {}) {
	const root = await mkdtemp(join(tmpdir(), "chromium-installer-test-"));
	t.after(() => cleanFixture(root));
	const sourceDir = join(root, "chrome-linux64");
	await mkdir(sourceDir, { recursive: true });
	const executable = Buffer.from("synthetic chromium executable");
	await writeFile(join(sourceDir, "chrome"), executable);
	const archive = join(root, "release.zip");
	execFileSync("zip", ["-q", "-r", archive, "chrome-linux64"], { cwd: root });
	const archiveBytes = await readFile(archive);
	const destination = join(root, "installed");
	const temporary = join(root, "temporary");
	await mkdir(temporary);
	await mkdir(join(root, "deploy/runtime"), { recursive: true });
	await mkdir(join(root, "packages/agent-runtime/src"), { recursive: true });
	await writeFile(
		join(root, "packages/agent-runtime/src/browser-release.json"),
		JSON.stringify({
			artifacts: {
				amd64: {
					directory: "chrome-linux64",
					executable: "chrome-linux64/chrome",
					url: "https://example.invalid/release.zip",
					archiveSha256:
						badHash === "archive" ? "0".repeat(64) : digest(archiveBytes),
					executableSha256:
						badHash === "executable" ? "0".repeat(64) : digest(executable),
				},
			},
		}),
	);
	const installer = join(root, "deploy/runtime/install-chromium.mjs");
	await writeFile(
		installer,
		await readFile(
			new URL("../deploy/runtime/install-chromium.mjs", import.meta.url),
		),
	);
	const calls = join(root, "calls");
	const fakeCurl = join(root, "fake-curl.mjs");
	await writeFile(
		fakeCurl,
		`import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const callsFile = process.env.CALLS_FILE;
const calls = Number.parseInt(readFileSync(callsFile, "utf8") || "0", 10) + 1;
writeFileSync(callsFile, String(calls));
const mode = ${JSON.stringify(mode)};
if (mode === "transport") { console.error("curl: (7) Failed to connect secret-url-token"); process.exit(7); }
if (mode === "http") { console.error("curl: (22) The requested URL returned error: 503"); process.exit(22); }
if (mode === "timeout") { console.error("curl: (28) Operation timed out after 30000 milliseconds"); process.exit(28); }
if (mode === "runner") { console.error("BuildKit: only one connection allowed"); process.exit(1); }
const args = process.argv.slice(2);
const output = args[args.indexOf("--output") + 1];
const bytes = readFileSync(${JSON.stringify(archive)});
writeFileSync(output, mode === "interrupted" && calls === 1 ? bytes.subarray(0, 16) : bytes);
if (mode === "interrupted" && calls === 1) { console.error("curl: (18) transfer closed with outstanding read data remaining"); process.exit(18); }
`,
	);
	await writeFile(calls, "0");
	const preload = join(root, "preload.mjs");
	await writeFile(
		preload,
		`import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const original = childProcess.execFileSync;
childProcess.execFileSync = (file, args, options) => file === "/usr/bin/curl"
  ? original(process.execPath, [process.env.FAKE_CURL, ...args], options)
  : file === "chown" ? undefined : original(file, args, options);
syncBuiltinESMExports();
`,
	);
	const run = () =>
		execFileSync(
			process.execPath,
			["--import", preload, installer, "amd64", destination],
			{
				env: {
					...process.env,
					CALLS_FILE: calls,
					FAKE_CURL: fakeCurl,
					TMPDIR: temporary,
					TMP: temporary,
					TEMP: temporary,
				},
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
	return { root, destination, temporary, calls, run, executable };
}

test("restarts an interrupted Chromium archive and installs the complete pin", async (t) => {
	const result = await setup(t, { mode: "interrupted" });
	result.run();
	assert.deepEqual(
		await readFile(join(result.destination, "chrome-linux64/chrome")),
		result.executable,
	);
	assert.equal(await readFile(result.calls, "utf8"), "2");
	assert.deepEqual(await readdir(result.temporary), []);
});

for (const category of ["transport", "http", "timeout", "runner"])
	test(`reports a redacted ${category} download category`, async (t) => {
		const result = await setup(t, { mode: category });
		assert.throws(result.run, (error) => {
			assert.match(error.stderr.toString(), new RegExp(`category=${category}`));
			assert.doesNotMatch(error.stderr.toString(), /secret-url-token/);
			return true;
		});
		assert.equal(
			await readFile(result.calls, "utf8"),
			category === "http" ? "1" : "10",
		);
		assert.deepEqual(await readdir(result.temporary), []);
	});

for (const badHash of ["archive", "executable"])
	test(`rejects a Chromium ${badHash} checksum mismatch`, async (t) => {
		const result = await setup(t, { badHash });
		assert.throws(result.run, (error) => {
			assert.match(
				error.stderr.toString(),
				new RegExp(`Chromium ${badHash} checksum mismatch`),
			);
			assert.match(
				error.stderr.toString(),
				new RegExp(`category=${badHash}_checksum`),
			);
			return true;
		});
		assert.equal(await readFile(result.calls, "utf8"), "1");
		assert.deepEqual(await readdir(result.temporary), []);
	});
