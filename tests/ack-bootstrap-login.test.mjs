import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
	chmod,
	lstat,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	bootstrapLogin,
	verifiedLoginCandidate,
	verifyLoginAfterRollout,
} from "../deploy/ack/bootstrap-login.ts";

const source = "a".repeat(40);
const ids = [
	"11111111-1111-4111-8111-111111111111",
	"22222222-2222-4222-8222-222222222222",
];
const externalTrialTarget = {
	sourceCommit: source,
	clusterUid: ids[0],
	namespace: "agent-infra-ext4425",
	namespaceUid: ids[1],
	installationId: "33333333-3333-4333-8333-333333333333",
};

async function fixture(t, scenario = "success") {
	const directory = await mkdtemp(join(tmpdir(), "ack-bootstrap-login-"));
	const calls = [];
	const reads = [0, 0];
	const server = createServer(async (request, response) => {
		calls.push(request.url);
		const origin = `http://127.0.0.1:${server.address().port}`;
		if (request.url === "/api/v1/session") {
			const index = request.headers.cookie?.includes("B".repeat(43)) ? 1 : 0;
			assert.equal(request.method, "GET");
			assert.equal(
				request.headers.cookie,
				`__Host-platform-session=${String.fromCharCode(65 + index).repeat(43)}`,
			);
			reads[index] += 1;
			if (scenario === "redirect") {
				response.writeHead(307, { Location: origin + "/unexpected" }).end();
				return;
			}
			if (scenario === "second-login-failed" && index === 1) {
				response.writeHead(401).end();
				return;
			}
			if (scenario === "session-failed") {
				response.writeHead(503);
				response.end();
				return;
			}
			let userId = scenario === "duplicate-user" ? ids[0] : ids[index];
			if (scenario === "session-changed" && reads[index] > 1)
				userId = "33333333-3333-4333-8333-333333333333";
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(
				JSON.stringify({
					schemaVersion: 1,
					user: { userId, roles: ["employee"] },
				}),
			);
			return;
		}
		response.writeHead(404);
		response.end();
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(async () => {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
		await rm(directory, { recursive: true, force: true });
	});
	const origin = `http://127.0.0.1:${server.address().port}`;
	const subjects = [];
	const save = async (file, value) => {
		await writeFile(
			file,
			typeof value === "string" ? value : JSON.stringify(value),
			{ mode: 0o600 },
		);
		return file;
	};
	for (const [index, name] of ["owner", "other"].entries())
		subjects.push({
			name,
			oidcStorageStateFile: await save(join(directory, name + ".input.json"), {
				cookies: [
					{
						name: "sso",
						value: "must-never-send",
						domain: "127.0.0.1",
						path: "/",
					},
					...(scenario === "missing-cookie"
						? []
						: [
								{
									name: "__Host-platform-session",
									value: String.fromCharCode(65 + index).repeat(43),
									domain: "127.0.0.1",
									path: "/",
									httpOnly: true,
									secure: false,
									sameSite: "Lax",
									expires: -1,
								},
							]),
				],
				origins: [
					{
						origin: "https://sso.example.test",
						localStorage: [{ name: "idp", value: "must-never-publish" }],
					},
				],
			}),
			storageStateFile: await save(join(directory, `${name}.state.json`), {
				cookies: [{ previous: true }],
				origins: [],
			}),
		});
	const blueprintFile = await save(join(directory, "blueprint.json"), {
		origin,
		owner: {
			userId: "historical-owner",
			stateFile: subjects[0].storageStateFile,
		},
		other: {
			userId: "historical-other",
			stateFile: subjects[1].storageStateFile,
		},
		prompt: "Reply ready",
		followUpPrompts: ["Reply ready", "Reply ready"],
		expectedReplies: ["ready", "ready", "ready"],
	});
	const config = {
		schemaVersion: 1,
		origin,
		identityFile: await save(join(directory, "identities.candidate.json"), {
			old: true,
		}),
		identitySecretRef: {
			name: "api-config",
			key: "deployment-identities.json",
		},
		subjects,
		blueprints: [blueprintFile],
	};
	const file = await save(join(directory, "login.json"), config);
	const outputs = [
		config.identityFile,
		blueprintFile,
		...subjects.map((s) => s.storageStateFile),
	];
	const before = await Promise.all(outputs.map((p) => readFile(p)));
	return {
		config,
		file,
		calls,
		outputs,
		before,
		save,
		blueprintFile,
		directory,
	};
}

async function singleOwnerFixture(t) {
	const f = await fixture(t);
	const other = f.config.subjects.pop();
	await rm(other.oidcStorageStateFile);
	await rm(other.storageStateFile);
	f.config.blueprints = [];
	await f.save(f.file, f.config);
	return f;
}

test("external-service trial verifies one owner through bootstrap, candidate and post-rollout sessions", async (t) => {
	const f = await singleOwnerFixture(t);
	const blueprintBefore = await readFile(f.blueprintFile);
	const result = await bootstrapLogin(
		f.file,
		source,
		f.config.origin,
		externalTrialTarget,
	);
	assert.equal(result.subjectCount, 1);
	assert.equal(result.blueprintCount, 0);
	assert.equal(result.loginVerified, true);
	assert.equal(result.businessVerified, false);
	const candidate = await verifiedLoginCandidate(
		f.file,
		source,
		f.config.origin,
		externalTrialTarget,
	);
	assert.deepEqual(JSON.parse(candidate.bytes).subjects, {
		owner: { userId: ids[0] },
	});
	const verified = await verifyLoginAfterRollout(
		f.file,
		source,
		f.config.origin,
		candidate.bytes,
		externalTrialTarget,
	);
	assert.deepEqual(verified, {
		loginVerified: true,
		sessionVerified: true,
		subjectCount: 1,
	});
	assert.deepEqual(await readFile(f.blueprintFile), blueprintBefore);
	assert(f.calls.length >= 6);
	await assert.rejects(verifiedLoginCandidate(f.file, source, f.config.origin));
});

for (const scenario of [
	"default",
	"community",
	"source",
	"missing-uid",
	"name",
	"blueprint",
]) {
	test(`single-owner login rejects ${scenario} outside the external-service scope before HTTP`, async (t) => {
		const f = await singleOwnerFixture(t);
		const target = structuredClone(externalTrialTarget);
		if (scenario === "community") target.namespace = "ack-community-m1-4403";
		if (scenario === "source") target.sourceCommit = "b".repeat(40);
		if (scenario === "missing-uid") delete target.namespaceUid;
		if (scenario === "name") f.config.subjects[0].name = "other";
		if (scenario === "blueprint") f.config.blueprints = [f.blueprintFile];
		await f.save(f.file, f.config);
		await assert.rejects(
			bootstrapLogin(
				f.file,
				source,
				f.config.origin,
				scenario === "default" ? undefined : target,
			),
		);
		assert.equal(f.calls.length, 0);
	});
}

test("external-service scope still rejects two sessions resolving to the same UUID", async (t) => {
	const f = await fixture(t, "duplicate-user");
	await assert.rejects(
		bootstrapLogin(f.file, source, f.config.origin, externalTrialTarget),
		/LOGIN_SUBJECTS_NOT_DISTINCT/,
	);
});

for (const mismatch of ["source", "origin", "user", "expired"]) {
	test(`single-owner publication rejects ${mismatch} candidate drift`, async (t) => {
		const f = await singleOwnerFixture(t);
		await bootstrapLogin(f.file, source, f.config.origin, externalTrialTarget);
		const candidate = JSON.parse(await readFile(f.config.identityFile));
		if (mismatch === "source") candidate.sourceSha = "b".repeat(40);
		if (mismatch === "origin") candidate.origin = "https://wrong.example.test";
		if (mismatch === "user") candidate.subjects.owner.userId = ids[1];
		if (mismatch === "expired") candidate.createdAt -= 700_000;
		await f.save(f.config.identityFile, candidate);
		await assert.rejects(
			verifiedLoginCandidate(
				f.file,
				source,
				f.config.origin,
				externalTrialTarget,
			),
		);
	});
}

test("single-owner post-rollout verification re-reads the original real input identity", async (t) => {
	const f = await singleOwnerFixture(t);
	await bootstrapLogin(f.file, source, f.config.origin, externalTrialTarget);
	const candidate = await readFile(f.config.identityFile);
	const file = f.config.subjects[0].oidcStorageStateFile;
	const state = JSON.parse(await readFile(file));
	state.cookies[1].value = "B".repeat(43);
	await f.save(file, state);
	await assert.rejects(
		verifyLoginAfterRollout(
			f.file,
			source,
			f.config.origin,
			candidate,
			externalTrialTarget,
		),
		/LOGIN_CANDIDATE_SESSION_MISMATCH/,
	);
});

test("external-service bootstrap CLI accepts the single owner only with its trusted target", async (t) => {
	const f = await singleOwnerFixture(t);
	const target = await f.save(
		join(f.directory, "target.json"),
		externalTrialTarget,
	);
	const child = spawn(
		process.execPath,
		["deploy/ack/bootstrap-login.ts", f.file, "--external-service-trial"],
		{
			env: {
				...process.env,
				ACK_SOURCE_SHA: source,
				ACK_PUBLIC_ORIGIN: f.config.origin,
				ACK_TRUSTED_TRIAL_TARGET_FILE: target,
			},
		},
	);
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (bytes) => {
		stdout += bytes;
	});
	child.stderr.on("data", (bytes) => {
		stderr += bytes;
	});
	const [code] = await once(child, "close");
	assert.equal(code, 0, stderr);
	assert.equal(JSON.parse(stdout).subjectCount, 1);
});

test("OIDC session readback derives distinct canonical identities, updates blueprints and exposes only hashes", async (t) => {
	const f = await fixture(t);
	const result = await bootstrapLogin(f.file, source);
	assert.equal(result.loginVerified, true);
	assert.equal(result.subjectCount, 2);
	assert.equal(result.blueprintCount, 1);
	for (const value of [
		...ids,
		"fixture-owner",
		"must-never-publish",
		"A".repeat(43),
	])
		assert(!JSON.stringify(result).includes(value));
	const identities = JSON.parse(await readFile(f.config.identityFile));
	assert.deepEqual(identities.subjects, {
		owner: { userId: ids[0] },
		other: { userId: ids[1] },
	});
	const blueprint = JSON.parse(await readFile(f.blueprintFile));
	assert.equal(blueprint.owner.userId, ids[0]);
	assert.equal(blueprint.other.userId, ids[1]);
	assert.equal(blueprint.prompt, "Reply ready");
	for (const file of f.outputs)
		assert.equal((await lstat(file)).mode & 0o777, 0o600);
	const candidate = await verifiedLoginCandidate(
		f.file,
		source,
		f.config.origin,
	);
	assert.deepEqual(candidate.bytes, await readFile(f.config.identityFile));
	assert.deepEqual(candidate.secretRef, f.config.identitySecretRef);
});

test("the deployment origin must match before any sessions are read", async (t) => {
	const f = await fixture(t);
	await assert.rejects(
		bootstrapLogin(f.file, source, "https://different.example.test"),
		/LOGIN_ORIGIN_MISMATCH/,
	);
	assert.equal(f.calls.length, 0);
});

test("promotes only the target-origin platform cookie and discards IdP and localStorage data", async (t) => {
	const f = await fixture(t);
	await bootstrapLogin(f.file, source);
	for (const subject of f.config.subjects) {
		const output = JSON.parse(await readFile(subject.storageStateFile));
		assert.deepEqual(output.origins, []);
		assert.equal(output.cookies.length, 1);
		assert.equal(output.cookies[0].name, "__Host-platform-session");
	}
});
for (const override of [
	{ domain: ".127.0.0.1" },
	{ domain: "unrelated.example.test" },
	{ path: "/other" },
	{ httpOnly: false },
	{ expires: 0 },
	{ partitionKey: "https://unrelated.example.test" },
]) {
	test(
		"rejects invalid imported cookie before network: " +
			JSON.stringify(override),
		async (t) => {
			const f = await fixture(t);
			const file = f.config.subjects[1].oidcStorageStateFile;
			const state = JSON.parse(await readFile(file));
			Object.assign(state.cookies[1], override);
			await f.save(file, state);
			await assert.rejects(
				bootstrapLogin(f.file, source),
				/LOGIN_COOKIE_INVALID/,
			);
			assert.equal(f.calls.length, 0);
		},
	);
}
for (const scenario of [
	"redirect",
	"second-login-failed",
	"missing-cookie",
	"session-failed",
	"duplicate-user",
	"session-changed",
]) {
	test(`login bootstrap rejects ${scenario} without replacing private outputs`, async (t) => {
		const f = await fixture(t, scenario);
		await assert.rejects(bootstrapLogin(f.file, source));
		assert.deepEqual(
			await Promise.all(f.outputs.map((p) => readFile(p))),
			f.before,
		);
		assert(!f.calls.includes("/unexpected"));
	});
}

for (const scenario of [
	"unknown-blueprint",
	"input-output-alias",
	"public-input-state",
	"public-output",
	"insecure-origin",
	"duplicate-input-state",
]) {
	test(`login preflight rejects ${scenario} before network calls`, async (t) => {
		const f = await fixture(t);
		if (scenario === "unknown-blueprint") {
			const b = JSON.parse(await readFile(f.blueprintFile));
			b.other.stateFile = join(f.directory, "unbound-state");
			await f.save(f.blueprintFile, b);
		}
		if (scenario === "input-output-alias")
			f.config.identityFile = f.config.subjects[0].oidcStorageStateFile;
		if (scenario === "public-input-state")
			await chmod(f.config.subjects[0].oidcStorageStateFile, 0o644);
		if (scenario === "public-output") await chmod(f.config.identityFile, 0o644);
		if (scenario === "insecure-origin")
			f.config.origin = "http://outside.example.test";
		if (scenario === "duplicate-input-state")
			f.config.subjects[1].oidcStorageStateFile =
				f.config.subjects[0].oidcStorageStateFile;
		await f.save(f.file, f.config);
		await assert.rejects(bootstrapLogin(f.file, source));
		assert.equal(f.calls.length, 0);
	});
}

for (const mismatch of ["source", "origin", "user", "expired"]) {
	test(`publication rejects a login candidate with ${mismatch} mismatch`, async (t) => {
		const f = await fixture(t);
		await bootstrapLogin(f.file, source);
		const candidate = JSON.parse(await readFile(f.config.identityFile));
		if (mismatch === "source") candidate.sourceSha = "b".repeat(40);
		if (mismatch === "origin") candidate.origin = "https://wrong.example.test";
		if (mismatch === "user")
			candidate.subjects.owner.userId = "44444444-4444-4444-8444-444444444444";
		if (mismatch === "expired") candidate.createdAt -= 700_000;
		await f.save(f.config.identityFile, candidate);
		await assert.rejects(
			verifiedLoginCandidate(f.file, source, f.config.origin),
		);
	});
}

test("CLI redacts invalid OIDC state files", async (t) => {
	const f = await fixture(t);
	await chmod(f.config.subjects[0].oidcStorageStateFile, 0o644);
	const result = spawnSync(
		process.execPath,
		["deploy/ack/bootstrap-login.ts", f.file],
		{
			encoding: "utf8",
			env: {
				...process.env,
				ACK_SOURCE_SHA: source,
				ACK_PUBLIC_ORIGIN: f.config.origin,
			},
		},
	);
	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.equal(result.stderr.trim(), "ACK_LOGIN_BOOTSTRAP_FAILED");
});

async function initialJournal(directory) {
	const { readdir } = await import("node:fs/promises");
	const names = (await readdir(directory)).filter((name) =>
		/^journal(?:\.[a-f0-9-]{36})?\.json$/u.test(name),
	);
	assert.equal(names.length, 1);
	return join(directory, names[0]);
}

async function promotionFixture(t, missing = false) {
	const f = await fixture(t);
	if (missing) await rm(f.config.identityFile);
	const { loginOutputBytes } = await import(
		"../deploy/ack/login-output-promotion.ts"
	);
	const before = new Map(
		await Promise.all(
			f.outputs.map(async (file) => [file, await loginOutputBytes(file)]),
		),
	);
	const outputs = new Map(
		f.outputs.map((file, index) => [file, { generation: "new", index }]),
	);
	return { ...f, before, outputs };
}

for (const missing of [false, true]) {
	test(`promotion failure after first output restores exact original bytes (missing=${missing})`, async (t) => {
		const f = await promotionFixture(t, missing);
		const fs = await import("node:fs/promises");
		const {
			promoteLoginOutputs,
			assertLoginOutputsCommitted,
			loginOutputBytes,
		} = await import("../deploy/ack/login-output-promotion.ts");
		let published = 0;
		await assert.rejects(
			promoteLoginOutputs(f.config.identityFile, f.before, f.outputs, {
				rename: fs.rename,
				link: async (from, to) => {
					if (String(from).endsWith(".next") && ++published === 2)
						throw new Error("INJECTED_PROMOTION_FAILURE");
					return fs.link(from, to);
				},
			}),
			/INJECTED_PROMOTION_FAILURE/,
		);
		assert.equal(published, 2);
		for (const [file, before] of f.before)
			assert.deepEqual(await loginOutputBytes(file), before);
		await assertLoginOutputsCommitted(f.config.identityFile);
	});
}

test("rollback preserves a concurrent replacement and leaves publication blocked", async (t) => {
	const f = await promotionFixture(t);
	const fs = await import("node:fs/promises");
	const {
		promoteLoginOutputs,
		assertLoginOutputsCommitted,
		recoverLoginOutputs,
	} = await import("../deploy/ack/login-output-promotion.ts");
	let published = 0;
	await assert.rejects(
		promoteLoginOutputs(f.config.identityFile, f.before, f.outputs, {
			rename: fs.rename,
			link: async (from, to) => {
				if (String(from).endsWith(".next") && ++published === 2) {
					// Replace the first output with a different inode, as another writer would.
					const replacement = join(f.directory, "other-writer");
					await fs.writeFile(replacement, "concurrent-private-state", {
						mode: 0o600,
					});
					await fs.rename(replacement, f.config.identityFile);
					throw new Error("INJECTED_PROMOTION_FAILURE");
				}
				return fs.link(from, to);
			},
		}),
		/LOGIN_OUTPUT_RECOVERY_REQUIRED/,
	);
	assert.equal(
		await readFile(f.config.identityFile, "utf8"),
		"concurrent-private-state",
	);
	await assert.rejects(
		assertLoginOutputsCommitted(f.config.identityFile),
		/PROMOTION_INCOMPLETE/,
	);
	await assert.rejects(verifiedLoginCandidate(f.file, source, f.config.origin));
	await assert.rejects(
		recoverLoginOutputs(f.config.identityFile, f.outputs.keys().toArray()),
		/WRITER_NOT_RETIRED/,
	);
});

test("backup drift at restore link keeps recovery evidence and publication blocked", async (t) => {
	const f = await promotionFixture(t);
	const fs = await import("node:fs/promises");
	const { promoteLoginOutputs, assertLoginOutputsCommitted } = await import(
		"../deploy/ack/login-output-promotion.ts"
	);
	let published = 0;
	let changedBackup;
	await assert.rejects(
		promoteLoginOutputs(f.config.identityFile, f.before, f.outputs, {
			rename: fs.rename,
			link: async (from, to) => {
				if (String(from).endsWith(".next") && ++published === 2)
					throw new Error("INJECTED_PROMOTION_FAILURE");
				if (String(from).endsWith(".before") && to === f.config.identityFile) {
					changedBackup = from;
					await fs.writeFile(from, "concurrent-backup-drift", { mode: 0o600 });
				}
				return fs.link(from, to);
			},
		}),
		/LOGIN_OUTPUT_RECOVERY_REQUIRED/,
	);
	assert(changedBackup);
	assert.equal(
		await readFile(changedBackup, "utf8"),
		"concurrent-backup-drift",
	);
	await assert.rejects(
		assertLoginOutputsCommitted(f.config.identityFile),
		/PROMOTION_INCOMPLETE/,
	);
	await assert.rejects(verifiedLoginCandidate(f.file, source, f.config.origin));
});

test("incomplete promotion blocks session import before network I/O", async (t) => {
	const f = await fixture(t);
	const { mkdir } = await import("node:fs/promises");
	await mkdir(`${f.config.identityFile}.promotion`, { mode: 0o700 });
	await assert.rejects(bootstrapLogin(f.file, source), /PROMOTION_INCOMPLETE/);
	assert.equal(f.calls.length, 0);
});

for (const stop of [
	"first-publish",
	"rollback-failure",
	"corrupted-backup",
	"legacy-directory",
]) {
	test(`dead writer recovery restores originals after ${stop}`, async (t) => {
		const f = await promotionFixture(t);
		const { pathToFileURL } = await import("node:url");
		const module = pathToFileURL(
			new URL("../deploy/ack/login-output-promotion.ts", import.meta.url)
				.pathname,
		).href;
		const inputFile = await f.save(join(f.directory, "recovery-input.json"), {
			identityFile: f.config.identityFile,
			before: [...f.before].map(([file, bytes]) => [
				file,
				bytes?.toString("base64") ?? null,
			]),
			outputs: [...f.outputs],
		});
		const code = `
import * as fs from 'node:fs/promises';
import { promoteLoginOutputs } from ${JSON.stringify(module)};
const input=JSON.parse(await fs.readFile(${JSON.stringify(inputFile)},'utf8'));
let count=0;
try { await promoteLoginOutputs(input.identityFile,new Map(input.before.map(([p,b])=>[p,b===null?null:Buffer.from(b,'base64')])),new Map(input.outputs),{
 rename: async(from,to)=>{if(${JSON.stringify(stop)}==='rollback-failure' && String(to).endsWith('.rollback'))throw Error('INJECTED_ROLLBACK_FAILURE');return fs.rename(from,to);},
 link: async(from,to)=>{
  if(String(from).endsWith('.next')){
   count++;
   if(count===2)throw Error('INJECTED_PROMOTION_FAILURE');
   await fs.link(from,to);
   if(${JSON.stringify(stop)}!=='rollback-failure')process.exit(71);
   return;
  }
  return fs.link(from,to);
 }
}); } catch {process.exit(72);}
`;
		const result = spawnSync(
			process.execPath,
			["--experimental-strip-types", "--input-type=module", "-e", code],
			{ encoding: "utf8" },
		);
		assert.equal(
			result.status,
			stop === "rollback-failure" ? 72 : 71,
			result.stderr,
		);
		if (stop === "legacy-directory") {
			const fs = await import("node:fs/promises");
			const gate = `${f.config.identityFile}.promotion`;
			const prepared = await fs.readlink(gate);
			await fs.unlink(gate);
			await fs.rename(prepared, gate);
			await fs.rename(await initialJournal(gate), join(gate, "journal.json"));
		}
		const {
			assertLoginOutputsCommitted,
			recoverLoginOutputs,
			loginOutputBytes,
		} = await import("../deploy/ack/login-output-promotion.ts");
		await assert.rejects(
			assertLoginOutputsCommitted(f.config.identityFile),
			/PROMOTION_INCOMPLETE/,
		);
		await assert.rejects(
			verifiedLoginCandidate(f.file, source, f.config.origin),
		);
		await assert.rejects(
			recoverLoginOutputs(f.config.identityFile, [f.config.identityFile]),
			/AssertionError/,
		);
		if (stop === "corrupted-backup") {
			const journal = JSON.parse(
				await readFile(
					await initialJournal(`${f.config.identityFile}.promotion`),
					"utf8",
				),
			);
			const original = await readFile(f.config.identityFile);
			await writeFile(journal.entries[0].backup, "corrupted-private-backup", {
				mode: 0o600,
			});
			await assert.rejects(
				recoverLoginOutputs(f.config.identityFile, [...f.outputs.keys()]),
				/RECOVERY_REQUIRED/,
			);
			assert.deepEqual(await readFile(f.config.identityFile), original);
			await assert.rejects(
				assertLoginOutputsCommitted(f.config.identityFile),
				/PROMOTION_INCOMPLETE/,
			);
			return;
		}
		await recoverLoginOutputs(f.config.identityFile, [...f.outputs.keys()]);
		for (const [file, before] of f.before)
			assert.deepEqual(await loginOutputBytes(file), before);
		await assertLoginOutputsCommitted(f.config.identityFile);
		// A retry performs fresh authentication after the old private bundle is restored.
		assert.equal((await bootstrapLogin(f.file, source)).loginVerified, true);
	});
}

for (const stop of [
	"journal-open",
	"journal-partial",
	"journal-ready",
	"gate-published",
	"commit-open",
	"commit-partial",
	"commit-published",
]) {
	test(`process exit at ${stop} leaves only a complete published recovery decision`, async (t) => {
		const f = await promotionFixture(t);
		const fs = await import("node:fs/promises");
		const module = new URL(
			"../deploy/ack/login-output-promotion.ts",
			import.meta.url,
		).href;
		const inputFile = await f.save(
			join(f.directory, "interruption-input.json"),
			{
				identityFile: f.config.identityFile,
				before: [...f.before].map(([file, bytes]) => [
					file,
					bytes?.toString("base64") ?? null,
				]),
				outputs: [...f.outputs],
			},
		);
		const code = `
import * as fs from 'node:fs/promises';
import { promoteLoginOutputs } from ${JSON.stringify(module)};
const stop = ${JSON.stringify(stop)};
const input = JSON.parse(await fs.readFile(${JSON.stringify(inputFile)}, 'utf8'));
await promoteLoginOutputs(input.identityFile,
 new Map(input.before.map(([p,b]) => [p,b === null ? null : Buffer.from(b,'base64')])),
 new Map(input.outputs), {
 rename: fs.rename,
 open: async (file, ...args) => {
  const handle = await fs.open(file, ...args);
  const kind = String(file).split('/').at(-1).startsWith('journal.') ? 'journal' : 'commit';
  if (stop === kind + '-open') process.exit(73);
  return {
   writeFile: async bytes => {
    if (stop === kind + '-partial') {
     await handle.writeFile(bytes.slice(0, 3));
     await handle.sync();
     process.exit(73);
    }
    return handle.writeFile(bytes);
   },
   sync: () => handle.sync(), close: () => handle.close()
  };
 },
 symlink: async (from, to) => {
  if (stop === 'journal-ready') process.exit(73);
  await fs.symlink(from, to);
  if (stop === 'gate-published') process.exit(73);
 },
 link: async (from, to) => {
  await fs.link(from, to);
  if (stop === 'commit-published' && String(to).endsWith('/committed')) process.exit(73);
 }
});
`;
		const result = spawnSync(
			process.execPath,
			["--experimental-strip-types", "--input-type=module", "-e", code],
			{ encoding: "utf8" },
		);
		assert.equal(result.status, 73, result.stderr);
		const {
			assertLoginOutputsCommitted,
			recoverLoginOutputs,
			loginOutputBytes,
			promoteLoginOutputs,
		} = await import(module);
		const gate = `${f.config.identityFile}.promotion`;
		const beforeGate = stop.startsWith("journal-");
		if (beforeGate) {
			await assertLoginOutputsCommitted(f.config.identityFile);
			const names = await fs.readdir(f.directory);
			assert.equal(
				names.filter((name) => name.endsWith(".prepared")).length,
				1,
			);
			assert(!names.some((name) => /\.(next|before|rollback)$/u.test(name)));
		} else {
			await assert.rejects(
				assertLoginOutputsCommitted(f.config.identityFile),
				/PROMOTION_INCOMPLETE/,
			);
			const prepared = await fs.readlink(gate);
			const journal = JSON.parse(
				await fs.readFile(await initialJournal(prepared), "utf8"),
			);
			assert.equal(prepared, `${gate}.${journal.generation}.prepared`);
			await assert.rejects(
				verifiedLoginCandidate(f.file, source, f.config.origin),
			);
			if (stop.startsWith("commit-") && stop !== "commit-published") {
				await assert.rejects(fs.lstat(join(prepared, "committed")), {
					code: "ENOENT",
				});
				assert.equal(
					(await fs.readFile(join(prepared, "commit.next"))).length,
					stop === "commit-open" ? 0 : 3,
				);
			}
			await recoverLoginOutputs(f.config.identityFile, [...f.outputs.keys()]);
			await assert.rejects(fs.lstat(prepared), { code: "ENOENT" });
			await assertLoginOutputsCommitted(f.config.identityFile);
		}
		for (const [file, before] of f.before) {
			const expected =
				stop === "commit-published"
					? Buffer.from(`${JSON.stringify(f.outputs.get(file), null, 2)}\n`)
					: before;
			assert.deepEqual(await loginOutputBytes(file), expected);
		}
		if (beforeGate) {
			await promoteLoginOutputs(f.config.identityFile, f.before, f.outputs);
			await assertLoginOutputsCommitted(f.config.identityFile);
		}
	});
}

for (const existing of [
	"empty-directory",
	"truncated-directory",
	"other-writer-symlink",
]) {
	test(`gate publication preserves a concurrent ${existing} and cleans only its own preparation`, async (t) => {
		const f = await promotionFixture(t);
		const fs = await import("node:fs/promises");
		const { randomUUID } = await import("node:crypto");
		const { promoteLoginOutputs, recoverLoginOutputs, loginOutputBytes } =
			await import("../deploy/ack/login-output-promotion.ts");
		const gate = `${f.config.identityFile}.promotion`;
		let otherDirectory;
		let gateInode;
		await assert.rejects(
			promoteLoginOutputs(f.config.identityFile, f.before, f.outputs, {
				rename: fs.rename,
				link: fs.link,
				symlink: async (from, to) => {
					otherDirectory =
						existing === "other-writer-symlink"
							? `${gate}.${randomUUID()}.prepared`
							: gate;
					await fs.mkdir(otherDirectory, { mode: 0o700 });
					if (existing !== "empty-directory")
						await fs.writeFile(join(otherDirectory, "journal.json"), "{", {
							mode: 0o600,
						});
					if (existing === "other-writer-symlink")
						await fs.symlink(otherDirectory, gate);
					gateInode = (await fs.lstat(gate)).ino;
					return fs.symlink(from, to);
				},
			}),
			{ code: "EEXIST" },
		);
		assert.equal((await fs.lstat(gate)).ino, gateInode);
		assert.deepEqual(
			(await fs.readdir(f.directory)).filter((name) =>
				name.endsWith(".prepared"),
			),
			existing === "other-writer-symlink"
				? [otherDirectory.split("/").at(-1)]
				: [],
		);
		await assert.rejects(
			recoverLoginOutputs(f.config.identityFile, [...f.outputs.keys()]),
		);
		assert.equal((await fs.lstat(gate)).ino, gateInode);
		for (const [file, before] of f.before)
			assert.deepEqual(await loginOutputBytes(file), before);
	});
}

for (const invalid of [
	"outside-target",
	"relative-target",
	"linked-directory",
	"public-directory",
	"generation-mismatch",
]) {
	test(`recovery rejects ${invalid} without following an undeclared journal`, async (t) => {
		const f = await promotionFixture(t);
		const fs = await import("node:fs/promises");
		const { randomUUID } = await import("node:crypto");
		const { hostname } = await import("node:os");
		const {
			recoverLoginOutputs,
			assertLoginOutputsCommitted,
			loginOutputBytes,
		} = await import("../deploy/ack/login-output-promotion.ts");
		const gate = `${f.config.identityFile}.promotion`;
		const generation = randomUUID();
		const prepared = `${gate}.${generation}.prepared`;
		const unrelated = join(f.directory, "unrelated-private-directory");
		await fs.mkdir(unrelated, { mode: 0o700 });
		await fs.writeFile(join(unrelated, "journal.json"), "unrelated-evidence", {
			mode: 0o600,
		});
		let target = prepared;
		if (invalid === "outside-target") target = unrelated;
		else if (invalid === "relative-target")
			target = "unrelated-private-directory";
		else if (invalid === "linked-directory")
			await fs.symlink(unrelated, prepared);
		else {
			await fs.mkdir(prepared, { mode: 0o700 });
			if (invalid === "public-directory") await fs.chmod(prepared, 0o755);
			await fs.writeFile(
				join(prepared, "journal.json"),
				JSON.stringify({
					schemaVersion: 1,
					generation: randomUUID(),
					hostname: hostname(),
					pid: 2147483647,
					entries: [],
				}),
				{ mode: 0o600 },
			);
		}
		await fs.symlink(target, gate);
		await assert.rejects(
			recoverLoginOutputs(f.config.identityFile, [...f.outputs.keys()]),
		);
		assert.equal(await fs.readlink(gate), target);
		assert.equal(
			await fs.readFile(join(unrelated, "journal.json"), "utf8"),
			"unrelated-evidence",
		);
		await assert.rejects(
			assertLoginOutputsCommitted(f.config.identityFile),
			/PROMOTION_INCOMPLETE/,
		);
		for (const [file, before] of f.before)
			assert.deepEqual(await loginOutputBytes(file), before);
	});
}

test("failed journal write removes only its unpublished preparation", async (t) => {
	const f = await promotionFixture(t);
	const fs = await import("node:fs/promises");
	const { promoteLoginOutputs, assertLoginOutputsCommitted, loginOutputBytes } =
		await import("../deploy/ack/login-output-promotion.ts");
	await assert.rejects(
		promoteLoginOutputs(f.config.identityFile, f.before, f.outputs, {
			rename: fs.rename,
			link: fs.link,
			open: async (...args) => {
				const handle = await fs.open(...args);
				return {
					writeFile: async (bytes) => {
						await handle.writeFile(bytes.slice(0, 3));
						throw new Error("INJECTED_JOURNAL_WRITE_FAILURE");
					},
					sync: () => handle.sync(),
					close: () => handle.close(),
				};
			},
		}),
		/INJECTED_JOURNAL_WRITE_FAILURE/,
	);
	assert(
		!(await fs.readdir(f.directory)).some((name) => name.endsWith(".prepared")),
	);
	await assertLoginOutputsCommitted(f.config.identityFile);
	for (const [file, before] of f.before)
		assert.deepEqual(await loginOutputBytes(file), before);
});

test("commit publication never overwrites an existing marker", async (t) => {
	const f = await promotionFixture(t);
	const fs = await import("node:fs/promises");
	const { promoteLoginOutputs, assertLoginOutputsCommitted } = await import(
		"../deploy/ack/login-output-promotion.ts"
	);
	let marker;
	await assert.rejects(
		promoteLoginOutputs(f.config.identityFile, f.before, f.outputs, {
			rename: fs.rename,
			link: async (from, to) => {
				if (String(to).endsWith("/committed")) {
					marker = to;
					await fs.writeFile(to, "other-marker", { flag: "wx", mode: 0o600 });
				}
				return fs.link(from, to);
			},
		}),
		{ code: "EEXIST" },
	);
	assert.equal(await fs.readFile(marker, "utf8"), "other-marker");
	await assert.rejects(
		assertLoginOutputsCommitted(f.config.identityFile),
		/PROMOTION_INCOMPLETE/,
	);
});

async function interruptedPromotion(t, stop = "committed") {
	const f = await promotionFixture(t);
	const module = new URL(
		"../deploy/ack/login-output-promotion.ts",
		import.meta.url,
	).href;
	const inputFile = await f.save(join(f.directory, "dead-writer-input.json"), {
		identityFile: f.config.identityFile,
		before: [...f.before].map(([file, bytes]) => [
			file,
			bytes?.toString("base64") ?? null,
		]),
		outputs: [...f.outputs],
	});
	const code = `
import * as fs from 'node:fs/promises';
import {promoteLoginOutputs} from ${JSON.stringify(module)};
const input=JSON.parse(await fs.readFile(${JSON.stringify(inputFile)},'utf8'));
await promoteLoginOutputs(input.identityFile,
 new Map(input.before.map(([p,b])=>[p,b===null?null:Buffer.from(b,'base64')])),new Map(input.outputs),{
 rename:fs.rename,link:async(from,to)=>{await fs.link(from,to);
 if(${JSON.stringify(stop)}==='committed'?String(to).endsWith('/committed'):to===input.identityFile)process.exit(74);}
});`;
	const child = spawnSync(
		process.execPath,
		["--experimental-strip-types", "--input-type=module", "-e", code],
		{ encoding: "utf8" },
	);
	assert.equal(child.status, 74, child.stderr);
	return { ...f, module };
}

for (const legacy of [false, true])
	test(`a stale recovery cannot retire the next writer gate (legacy=${legacy})`, {
		timeout: 20_000,
	}, async (t) => {
		const f = await interruptedPromotion(t);
		const fs = await import("node:fs/promises");
		const fsBase = (await import("node:fs")).default;
		const { syncBuiltinESMExports } = await import("node:module");
		const {
			recoverLoginOutputs,
			promoteLoginOutputs,
			assertLoginOutputsCommitted,
		} = await import(f.module);
		const gate = `${f.config.identityFile}.promotion`;
		if (legacy) {
			const prepared = await fs.readlink(gate);
			await fs.unlink(gate);
			await fs.rename(prepared, gate);
			await fs.rename(await initialJournal(gate), join(gate, "journal.json"));
		}
		const actualRename = fs.rename;
		const releases = [];
		let signalReady;
		const ready = new Promise((resolve) => {
			signalReady = resolve;
		});
		let releaseWriter;
		const continueWriter = new Promise((resolve) => {
			releaseWriter = resolve;
		});
		let signalWriter;
		const writerPaused = new Promise((resolve) => {
			signalWriter = resolve;
		});
		// Delay ownership/retirement at real filesystem operations, preserving their arguments.
		fsBase.promises.rename = async (from, to) => {
			if (
				releases.length < 2 &&
				(from === gate || String(from).split("/").at(-1).startsWith("journal."))
			) {
				await new Promise((resolve) => {
					releases.push(resolve);
					if (releases.length === 2) signalReady();
				});
			}
			return actualRename(from, to);
		};
		syncBuiltinESMExports();
		let writer;
		const recoveries = [1, 2].map(() =>
			recoverLoginOutputs(f.config.identityFile, [...f.outputs.keys()], {
				rename: (from, to) => fsBase.promises.rename(from, to),
				link: fs.link,
			}).then(
				() => true,
				() => false,
			),
		);
		try {
			await ready;
			releases[0]();
			assert.equal(await Promise.race(recoveries), true);
			const before = new Map(
				await Promise.all(
					[...f.outputs.keys()].map(async (file) => [
						file,
						await fs.readFile(file),
					]),
				),
			);
			writer = promoteLoginOutputs(
				f.config.identityFile,
				before,
				new Map(
					[...f.outputs.keys()].map((file) => [file, { generation: "next" }]),
				),
				{
					rename: actualRename,
					link: async (from, to) => {
						await fs.link(from, to);
						if (to === f.config.identityFile) {
							signalWriter();
							await continueWriter;
						}
					},
				},
			).then(
				() => true,
				() => false,
			);
			await writerPaused;
			releases[1]();
			assert.deepEqual((await Promise.all(recoveries)).sort(), [false, true]);
			assert.equal(
				JSON.parse(await fs.readFile(f.config.identityFile, "utf8")).generation,
				"next",
			);
			assert.equal(
				JSON.parse(await fs.readFile([...f.outputs.keys()][1], "utf8"))
					.generation,
				"new",
			);
			await assert.rejects(
				assertLoginOutputsCommitted(f.config.identityFile),
				/PROMOTION_INCOMPLETE/,
			);
			releaseWriter();
			assert.equal(await writer, true);
			await assertLoginOutputsCommitted(f.config.identityFile);
		} finally {
			fsBase.promises.rename = actualRename;
			syncBuiltinESMExports();
			for (const release of releases) release();
			releaseWriter();
			await Promise.all([...recoveries, writer]);
		}
	});

for (const legacy of [false, true]) {
	for (const committed of [false, true]) {
		test(`dead recovery claims transfer intact across repeated crashes (legacy=${legacy}, committed=${committed})`, async (t) => {
			const f = await interruptedPromotion(
				t,
				committed ? "committed" : "first-output",
			);
			const fs = await import("node:fs/promises");
			const {
				recoverLoginOutputs,
				assertLoginOutputsCommitted,
				loginOutputBytes,
			} = await import(f.module);
			const gate = `${f.config.identityFile}.promotion`;
			let directory = await fs.readlink(gate);
			if (legacy) {
				await fs.unlink(gate);
				await fs.rename(directory, gate);
				directory = gate;
				await fs.rename(await initialJournal(gate), join(gate, "journal.json"));
			}
			const originalPath = await initialJournal(directory);
			const originalJournal = await fs.readFile(originalPath);
			let previousClaim = originalPath.split("/").at(-1);
			for (let attempt = 0; attempt < 2; attempt++) {
				const code = `
import * as fs from 'node:fs/promises';
import {recoverLoginOutputs} from ${JSON.stringify(f.module)};
await recoverLoginOutputs(${JSON.stringify(f.config.identityFile)},${JSON.stringify([...f.outputs.keys()])},{
 link:fs.link,rename:async(from,to)=>{await fs.rename(from,to);if(String(to).includes('/recovery.'))process.exit(75);}
});`;
				const child = spawnSync(
					process.execPath,
					["--experimental-strip-types", "--input-type=module", "-e", code],
					{ encoding: "utf8" },
				);
				assert.equal(child.status, 75, child.stderr);
				const claims = (await fs.readdir(directory)).filter((name) =>
					name.startsWith("recovery."),
				);
				assert.equal(claims.length, 1);
				assert.notEqual(claims[0], previousClaim);
				assert.deepEqual(
					await fs.readFile(join(directory, claims[0])),
					originalJournal,
				);
				assert.equal(
					(await fs.lstat(join(directory, claims[0]))).mode & 0o777,
					0o600,
				);
				await assert.rejects(fs.lstat(join(directory, previousClaim)), {
					code: "ENOENT",
				});
				previousClaim = claims[0];
				await assert.rejects(
					assertLoginOutputsCommitted(f.config.identityFile),
					/PROMOTION_INCOMPLETE/,
				);
			}
			await recoverLoginOutputs(f.config.identityFile, [...f.outputs.keys()]);
			await assertLoginOutputsCommitted(f.config.identityFile);
			for (const [file, before] of f.before) {
				assert.deepEqual(
					await loginOutputBytes(file),
					committed
						? Buffer.from(`${JSON.stringify(f.outputs.get(file), null, 2)}\n`)
						: before,
				);
			}
		});
	}
}

test("a live recovery owns the only complete journal and rejects other recoverers", async (t) => {
	const f = await interruptedPromotion(t);
	const fs = await import("node:fs/promises");
	const { recoverLoginOutputs } = await import(f.module);
	let release;
	const resume = new Promise((resolve) => {
		release = resolve;
	});
	let acquired;
	const ready = new Promise((resolve) => {
		acquired = resolve;
	});
	const first = recoverLoginOutputs(
		f.config.identityFile,
		[...f.outputs.keys()],
		{
			link: fs.link,
			rename: async (from, to) => {
				await fs.rename(from, to);
				if (String(to).includes("/recovery.")) {
					acquired();
					await resume;
				}
			},
		},
	);
	await ready;
	try {
		await assert.rejects(
			recoverLoginOutputs(f.config.identityFile, [...f.outputs.keys()]),
			/WRITER_NOT_RETIRED/,
		);
	} finally {
		release();
		await first;
	}
});

for (const stop of ["restore-output", "before-retire", "after-retire"]) {
	test(`a crashed recoverer retains its claim until gate retirement (${stop})`, async (t) => {
		const f = await interruptedPromotion(t, "first-output");
		const fs = await import("node:fs/promises");
		const {
			recoverLoginOutputs,
			assertLoginOutputsCommitted,
			loginOutputBytes,
		} = await import(f.module);
		const gate = `${f.config.identityFile}.promotion`;
		const directory = await fs.readlink(gate);
		const code = `
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
const stop=${JSON.stringify(stop)}, gate=${JSON.stringify(gate)};
const rename=fs.rename;
fs.rename=async(from,to)=>{
 if(from===gate&&stop==='before-retire')process.exit(76);
 await rename(from,to);
 if(from===gate&&stop==='after-retire')process.exit(76);
};
syncBuiltinESMExports();
const {recoverLoginOutputs}=await import(${JSON.stringify(f.module)});
await recoverLoginOutputs(${JSON.stringify(f.config.identityFile)},${JSON.stringify([...f.outputs.keys()])},{
 rename:fs.rename,link:async(from,to)=>{await fs.link(from,to);if(stop==='restore-output'&&String(from).endsWith('.before'))process.exit(76);}
});`;
		const child = spawnSync(
			process.execPath,
			["--experimental-strip-types", "--input-type=module", "-e", code],
			{ encoding: "utf8" },
		);
		assert.equal(child.status, 76, child.stderr);
		const claims = (await fs.readdir(directory)).filter((name) =>
			name.startsWith("recovery."),
		);
		assert.equal(claims.length, 1);
		JSON.parse(await fs.readFile(join(directory, claims[0]), "utf8"));
		if (stop !== "after-retire") {
			await assert.rejects(
				assertLoginOutputsCommitted(f.config.identityFile),
				/PROMOTION_INCOMPLETE/,
			);
			await recoverLoginOutputs(f.config.identityFile, [...f.outputs.keys()]);
		}
		await assertLoginOutputsCommitted(f.config.identityFile);
		for (const [file, before] of f.before)
			assert.deepEqual(await loginOutputBytes(file), before);
	});
}

for (const invalid of [
	"live-pid",
	"invalid-pid",
	"duplicate",
	"symlink",
	"public-file",
	"unknown-name",
	"generation-name",
]) {
	test(`recovery rejects ${invalid} claims without changing gate or outputs`, async (t) => {
		const f = await interruptedPromotion(t);
		const fs = await import("node:fs/promises");
		const { randomUUID } = await import("node:crypto");
		const { recoverLoginOutputs } = await import(f.module);
		const gate = `${f.config.identityFile}.promotion`;
		const directory = await fs.readlink(gate);
		const original = await initialJournal(directory);
		const pid =
			invalid === "live-pid"
				? process.pid
				: invalid === "invalid-pid"
					? 0
					: 2147483647;
		const claim = join(
			directory,
			invalid === "unknown-name"
				? "unknown.json"
				: invalid === "generation-name"
					? `journal.${randomUUID()}.json`
					: `recovery.${pid}.${randomUUID()}.json`,
		);
		if (invalid === "duplicate") await fs.copyFile(original, claim);
		else if (invalid === "symlink") {
			const external = join(f.directory, "external-journal.json");
			await fs.rename(original, external);
			await fs.symlink(external, claim);
		} else {
			await fs.rename(original, claim);
			if (invalid === "public-file") await fs.chmod(claim, 0o644);
		}
		const inode = (await fs.lstat(gate)).ino;
		const before = await Promise.all(
			[...f.outputs.keys()].map((file) => fs.readFile(file)),
		);
		await assert.rejects(
			recoverLoginOutputs(f.config.identityFile, [...f.outputs.keys()]),
		);
		assert.equal((await fs.lstat(gate)).ino, inode);
		assert.deepEqual(
			await Promise.all([...f.outputs.keys()].map((file) => fs.readFile(file))),
			before,
		);
		assert(await fs.lstat(claim));
	});
}
