import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const webRequire = createRequire(
	new URL("../apps/web/package.json", import.meta.url),
);
const playwright = webRequire.resolve("@playwright/test");
const cli = webRequire.resolve("@playwright/test/cli");

test("Playwright keeps Docker fixture lifecycles outside other browser projects and runs each viewport once", {
	timeout: 30_000,
}, async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "web-project-isolation-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const eventsFile = join(directory, "events.jsonl");
	const fixtures = [
		"layout",
		"auth",
		"collection-session",
		"evaluation-data",
		"evaluation-workflow",
		"task-feedback",
	];
	for (const name of fixtures) {
		await writeFile(
			join(directory, `${name}.spec.ts`),
			`
import { test } from ${JSON.stringify(playwright)};
import { appendFileSync } from 'node:fs';
test(${JSON.stringify(name)}, async ({}, info) => {
 const record = phase => appendFileSync(${JSON.stringify(eventsFile)}, JSON.stringify({ name: ${JSON.stringify(name)}, project: info.project.name, mobile: info.project.use.isMobile === true, phase }) + String.fromCharCode(10));
 record('start');
 await new Promise(resolve => setTimeout(resolve, 100));
 record('end');
});
`,
		);
	}
	const config = join(directory, "playwright.config.mjs");
	await writeFile(
		config,
		`
import original from ${JSON.stringify(pathToFileURL(join(root, "apps/web/playwright.config.ts")).href)};
export default { ...original, testDir: ${JSON.stringify(directory)}, testMatch: '**/*.spec.ts', webServer: [], reporter: 'json', outputDir: ${JSON.stringify(join(directory, "results"))} };
`,
	);
	const result = await run(
		process.execPath,
		[cli, "test", "--config", config],
		{
			cwd: root,
			timeout: 25_000,
			maxBuffer: 2 * 1024 * 1024,
			env: { ...process.env, PLAYWRIGHT_HTML_OPEN: "never" },
		},
	).catch((error) => ({
		stdout: error.stdout ?? "",
		stderr: error.stderr ?? "",
		failed: true,
	}));
	const report = JSON.parse(result.stdout);
	assert(
		!result.failed,
		JSON.stringify(report.errors?.map((error) => error.message.slice(0, 500))),
	);
	assert.equal(report.stats.unexpected, 0);
	assert.equal(report.stats.expected, 12);
	const events = (await readFile(eventsFile, "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const realNames = new Set([
		"evaluation-data",
		"evaluation-workflow",
		"task-feedback",
	]);
	const starts = events.filter((event) => event.phase === "start");
	for (const name of fixtures) {
		assert.equal(
			starts.filter((event) => event.name === name && event.mobile).length,
			1,
			`${name} mobile coverage`,
		);
		assert.equal(
			starts.filter((event) => event.name === name && !event.mobile).length,
			1,
			`${name} desktop coverage`,
		);
	}
	const lastOrdinaryEnd = events.findLastIndex(
		(event) => event.phase === "end" && !realNames.has(event.name),
	);
	const firstDockerStart = events.findIndex(
		(event) => event.phase === "start" && realNames.has(event.name),
	);
	assert(
		firstDockerStart > lastOrdinaryEnd,
		"Docker lifecycle started while ordinary browser projects were still active",
	);
	let active = 0;
	for (const event of events.filter((event) => realNames.has(event.name))) {
		active += event.phase === "start" ? 1 : -1;
		assert(active >= 0 && active <= 1, "Docker-backed projects overlapped");
	}
	assert.equal(active, 0);
});
