import assert from "node:assert/strict";
import {
	access,
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	privateJson,
	provisionWithBindings,
} from "../deploy/ack/agent-bindings.ts";

const source = "a".repeat(40);
const origin = "https://platform.example.test";
async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "ack-bindings-"));
	const state = join(directory, "state");
	const blueprints = join(directory, "blueprints");
	await mkdir(state, { mode: 0o700 });
	await mkdir(blueprints, { mode: 0o700 });
	const json = async (name, value) => {
		const file = join(directory, name);
		await writeFile(file, JSON.stringify(value, null, 2), { mode: 0o600 });
		return file;
	};
	const owner = await json("owner.json", { cookies: [], origins: [] });
	const other = await json("other.json", { cookies: [], origins: [] });
	const body = {
		schemaVersion: 3,
		source: { kind: "standard", templateId: "codex" },
		name: "controlled",
		defaultRelayKey: "private-model-canary",
	};
	const bodyFile = await json("body.json", body);
	const credentialFile = join(directory, "token");
	await writeFile(credentialFile, "private-api-canary", { mode: 0o600 });
	const request = {
		name: "codex-rebuild",
		bodyFile,
		credentialFile,
		idempotencyKey: "stable-create-key",
	};
	const config = {
		schemaVersion: 1,
		origin,
		waitSeconds: 0,
		requests: [request],
	};
	const configFile = await json("requests.json", config);
	const blueprint = {
		origin,
		agentId: "stale-id",
		prompt: "controlled prompt",
		owner: { userId: "owner", stateFile: owner },
		other: { userId: "other", stateFile: other },
	};
	await json("blueprints/codex.json", blueprint);
	return {
		directory,
		state,
		blueprints,
		json,
		body,
		request,
		config,
		configFile,
		blueprint,
		run: (options) =>
			provisionWithBindings(configFile, state, blueprints, source, options),
	};
}
function mockApi(t, { wrongStateId = false } = {}) {
	const calls = [];
	t.mock.method(globalThis, "fetch", async (url, init) => {
		calls.push({ url: String(url), method: init.method ?? "GET" });
		if (init.method === "POST")
			return Response.json(
				{
					schemaVersion: 1,
					agentId: "fresh-agent-id",
					status: "creating",
					revision: 1,
					replayed: false,
				},
				{ status: 201 },
			);
		return Response.json({
			schemaVersion: 1,
			agentId: wrongStateId ? "foreign-agent-id" : "fresh-agent-id",
			status: "available",
			serviceAvailability: "ready",
			revision: 2,
		});
	});
	return calls;
}

test("creation persists private IDs and replaces stale browser IDs; rerun never recreates an observed Agent", async (t) => {
	const f = await fixture();
	const calls = mockApi(t);
	const result = await f.run();
	assert.equal(result.pass, true);
	const mapFile = join(f.state, "agent-bindings.json");
	const saved = await privateJson(mapFile);
	assert.equal(saved.agents["codex-rebuild"].agentId, "fresh-agent-id");
	assert.equal((await stat(mapFile)).mode & 0o777, 0o600);
	const config = await privateJson(join(f.state, "browser/codex.json"));
	assert.equal(config.agentId, "fresh-agent-id");
	assert.equal(config.owner.stateFile, f.blueprint.owner.stateFile);
	assert.equal(config.prompt, f.blueprint.prompt);
	for (const secret of [
		"fresh-agent-id",
		"private-model-canary",
		"private-api-canary",
	])
		assert(!JSON.stringify(result).includes(secret));
	assert(!(await readFile(mapFile, "utf8")).includes("private-model-canary"));
	assert.equal((await f.run()).pass, true);
	assert.equal(calls.filter((call) => call.method === "POST").length, 1);
});

test("mismatched state identity never generates browser configs and retains the created ID for recovery", async (t) => {
	const f = await fixture();
	mockApi(t, { wrongStateId: true });
	const result = await f.run();
	assert.equal(result.pass, false);
	assert.equal(result.results[0].error, "STATE_BINDING_INVALID");
	const saved = await privateJson(join(f.state, "agent-bindings.json"));
	assert.equal(saved.agents["codex-rebuild"].agentId, "fresh-agent-id");
	assert.equal(saved.agents["codex-rebuild"].ready, false);
	await assert.rejects(access(join(f.state, "browser")));
	t.mock.restoreAll();
	const recoveryCalls = mockApi(t);
	assert.equal((await f.run()).pass, true);
	assert.equal(
		recoveryCalls.filter((call) => call.method === "POST").length,
		0,
	);
});

test("changed request content cannot reuse a previous private binding", async (t) => {
	const f = await fixture();
	const calls = mockApi(t);
	await f.run();
	const count = calls.length;
	await f.json("body.json", { ...f.body, name: "changed" });
	await assert.rejects(f.run());
	assert.equal(calls.length, count);
});

test("all blueprints are checked before any mutation; wrong origin and missing matrix fail locally", async (t) => {
	const f = await fixture();
	const calls = mockApi(t);
	await assert.rejects(f.run({ checkOnly: true, requireMatrix: true }));
	assert.equal(calls.length, 0);
	await f.json("blueprints/codex.json", {
		...f.blueprint,
		origin: "https://foreign.example.test",
	});
	await assert.rejects(f.run());
	assert.equal(calls.length, 0);
});

test("private state/inputs reject shared permissions and symlinks before networking", async (t) => {
	const f = await fixture();
	const calls = mockApi(t);
	await chmod(f.request.credentialFile, 0o644);
	await assert.rejects(f.run());
	assert.equal(calls.length, 0);
	const link = join(f.directory, "link.json");
	await symlink(f.configFile, link);
	await assert.rejects(privateJson(link));
	await chmod(f.state, 0o755);
	await assert.rejects(f.run());
	assert.equal(calls.length, 0);
});

test("four standard and two custom Agents generate fresh standard/ACP configs; materialize repairs a stale local ID without POST", async (t) => {
	const f = await fixture();
	const requests = [];
	for (const name of ["codex", "claude", "opencode", "pi", "acp", "web"]) {
		const standard = !["acp", "web"].includes(name);
		const body = {
			...f.body,
			source: standard
				? { kind: "standard", templateId: name }
				: {
						kind: "custom",
						interactionMode:
							name === "acp" ? "platform-adapter" : "self-managed",
					},
		};
		const bodyFile = await f.json(`body-${name}.json`, body);
		requests.push({
			...f.request,
			name,
			bodyFile,
			idempotencyKey: `stable-create-${name}`,
		});
		if (name !== "web")
			await f.json(
				`blueprints/${standard ? name : "custom-acp"}.json`,
				f.blueprint,
			);
	}
	await f.json("requests.json", { ...f.config, requests });
	const calls = [];
	t.mock.method(globalThis, "fetch", async (url, init) => {
		calls.push(init.method ?? "GET");
		const agentId =
			init.method === "POST"
				? `new-${init.headers["Idempotency-Key"]}`
				: decodeURIComponent(new URL(url).pathname.split("/").at(-2));
		return Response.json(
			{
				schemaVersion: 1,
				agentId,
				revision: 1,
				replayed: false,
				status: "available",
				serviceAvailability: "ready",
			},
			{ status: init.method === "POST" ? 201 : 200 },
		);
	});
	assert.equal((await f.run({ requireMatrix: true })).pass, true);
	assert.equal(calls.filter((method) => method === "POST").length, 6);
	const acp = await privateJson(join(f.state, "browser/custom-acp.json"));
	assert.equal(acp.agentId, "new-stable-create-acp");
	const path = join(f.state, "browser/codex.json");
	await writeFile(path, JSON.stringify({ ...f.blueprint, agentId: "old-id" }));
	const count = calls.length;
	assert.equal(
		(await f.run({ requireMatrix: true, materializeOnly: true })).pass,
		true,
	);
	assert.equal((await privateJson(path)).agentId, "new-stable-create-codex");
	assert.equal(calls.length, count);
});
