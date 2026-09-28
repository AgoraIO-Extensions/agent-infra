import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = join(import.meta.dirname, "conversation-browser.mjs");

async function fixtureDirectory() {
	const directory = await mkdtemp(
		join(tmpdir(), "agent-infra-conversation-config-"),
	);
	const ownerState = join(directory, "owner-state.json");
	const otherState = join(directory, "other-state.json");
	const config = join(directory, "journey.json");
	const storageState = JSON.stringify({ cookies: [], origins: [] });
	await writeFile(ownerState, storageState, { mode: 0o600 });
	await writeFile(otherState, storageState, { mode: 0o600 });
	await writeFile(
		config,
		JSON.stringify({
			origin: "http://127.0.0.1:3511",
			agentId: "agent-under-test",
			prompt: "synthetic smoke prompt",
			owner: { userId: "owner", stateFile: ownerState },
			other: { userId: "other", stateFile: otherState },
		}),
		{ mode: 0o600 },
	);
	return { config, ownerState, otherState, directory };
}

test("configuration-only smoke validates private Playwright state without an endpoint", async () => {
	const fixture = await fixtureDirectory();
	try {
		const result = spawnSync(
			process.execPath,
			[script, "--check-config", fixture.config],
			{ cwd: process.cwd(), encoding: "utf8" },
		);
		if (result.error) throw result.error;
		if (result.status !== 0)
			throw new Error(`${result.stderr}\n${result.stdout}`);
		const summary = JSON.parse(result.stdout);
		assert.equal(summary.mode, "configuration-only");
		assert.equal(summary.endpointChecked, false);
		assert.equal(summary.origin, "http://127.0.0.1:3511");
		assert.match(summary.agentHash, /^[a-f0-9]{64}$/);
		assert.match(summary.ownerUserHash, /^[a-f0-9]{64}$/);
		assert.match(summary.otherUserHash, /^[a-f0-9]{64}$/);
	} finally {
		await rm(fixture.directory, { recursive: true, force: true });
	}
});

test("configuration-only smoke rejects a state file readable by other users", async () => {
	const fixture = await fixtureDirectory();
	try {
		await chmod(fixture.otherState, 0o644);
		const result = spawnSync(
			process.execPath,
			[script, "--check-config", fixture.config],
			{ cwd: process.cwd(), encoding: "utf8" },
		);
		if (result.error) throw result.error;
		assert.notEqual(result.status, 0);
		assert.match(`${result.stderr}${result.stdout}`, /must be private/);
	} finally {
		await rm(fixture.directory, { recursive: true, force: true });
	}
});

test("configuration-only smoke does not expose malformed state file contents", async () => {
	const fixture = await fixtureDirectory();
	try {
		const secret = "cookie-secret-must-not-leak";
		await writeFile(fixture.ownerState, `not-json ${secret}`, { mode: 0o600 });
		const result = spawnSync(
			process.execPath,
			[script, "--check-config", fixture.config],
			{ cwd: process.cwd(), encoding: "utf8" },
		);
		if (result.error) throw result.error;
		assert.notEqual(result.status, 0);
		assert.match(`${result.stderr}${result.stdout}`, /must contain valid JSON/);
		assert.doesNotMatch(`${result.stderr}${result.stdout}`, new RegExp(secret));
	} finally {
		await rm(fixture.directory, { recursive: true, force: true });
	}
});

test("configuration-only smoke does not expose malformed config contents", async () => {
	const fixture = await fixtureDirectory();
	try {
		const secret = "prompt-secret-must-not-leak";
		await writeFile(fixture.config, `not-json ${secret}`, { mode: 0o600 });
		const result = spawnSync(
			process.execPath,
			[script, "--check-config", fixture.config],
			{ cwd: process.cwd(), encoding: "utf8" },
		);
		if (result.error) throw result.error;
		assert.notEqual(result.status, 0);
		assert.match(`${result.stderr}${result.stdout}`, /must contain valid JSON/);
		assert.doesNotMatch(`${result.stderr}${result.stdout}`, new RegExp(secret));
	} finally {
		await rm(fixture.directory, { recursive: true, force: true });
	}
});
