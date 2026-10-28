import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
} from "../deploy/ack/bootstrap-login.ts";

const source = "a".repeat(40);
const ids = [
	"11111111-1111-4111-8111-111111111111",
	"22222222-2222-4222-8222-222222222222",
];

async function fixture(t, scenario = "success") {
	const directory = await mkdtemp(join(tmpdir(), "ack-bootstrap-login-"));
	const calls = [];
	const reads = [0, 0];
	const server = createServer(async (request, response) => {
		calls.push(request.url);
		const origin = `http://127.0.0.1:${server.address().port}`;
		if (request.url === "/auth/login") {
			let bytes = "";
			for await (const chunk of request) bytes += chunk;
			const body = JSON.parse(bytes);
			const index = ["fixture-owner", "fixture-other"].indexOf(body.login);
			assert(index >= 0);
			assert.equal(
				body.password,
				scenario === "whitespace-password"
					? `  fixture-password-${index}  `
					: `fixture-password-${index}`,
			);
			assert.equal(request.headers.origin, origin);
			assert.equal(
				request.headers.cookie,
				undefined,
				"must use fresh login contexts",
			);
			if (scenario === "redirect") {
				response.writeHead(307, { Location: `${origin}/unexpected` });
				response.end();
				return;
			}
			if (scenario === "second-login-failed" && index === 1) {
				response.writeHead(401);
				response.end();
				return;
			}
			const cookie = `__Host-platform-session=${String.fromCharCode(65 + index).repeat(43)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600`;
			response.writeHead(
				204,
				scenario === "missing-cookie" ? {} : { "Set-Cookie": cookie },
			);
			response.end();
			return;
		}
		if (request.url === "/api/v1/session") {
			const index = request.headers.cookie?.includes("B".repeat(43)) ? 1 : 0;
			reads[index] += 1;
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
			loginFile: await save(
				join(directory, `${name}.login`),
				`fixture-${name}`,
			),
			passwordFile: await save(
				join(directory, `${name}.password`),
				scenario === "whitespace-password"
					? `  fixture-password-${index}  \r\n`
					: `fixture-password-${index}`,
			),
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

test("fresh login derives distinct canonical identities, updates blueprints and exposes only hashes", async (t) => {
	const f = await fixture(t);
	const result = await bootstrapLogin(f.file, source);
	assert.equal(result.loginVerified, true);
	assert.equal(result.subjectCount, 2);
	assert.equal(result.blueprintCount, 1);
	for (const value of [
		...ids,
		"fixture-owner",
		"fixture-password-0",
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

test("the deployment origin must match before any credentials are submitted", async (t) => {
	const f = await fixture(t);
	await assert.rejects(
		bootstrapLogin(f.file, source, "https://different.example.test"),
		/LOGIN_ORIGIN_MISMATCH/,
	);
	assert.equal(f.calls.length, 0);
});

test("password spaces survive while one terminal file newline is removed", async (t) => {
	const f = await fixture(t, "whitespace-password");
	assert.equal((await bootstrapLogin(f.file, source)).loginVerified, true);
});

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
	"credential-output-alias",
	"public-password",
	"public-output",
	"insecure-origin",
	"duplicate-login",
]) {
	test(`login preflight rejects ${scenario} before network calls`, async (t) => {
		const f = await fixture(t);
		if (scenario === "unknown-blueprint") {
			const b = JSON.parse(await readFile(f.blueprintFile));
			b.other.stateFile = join(f.directory, "unbound-state");
			await f.save(f.blueprintFile, b);
		}
		if (scenario === "credential-output-alias")
			f.config.identityFile = f.config.subjects[0].passwordFile;
		if (scenario === "public-password")
			await chmod(f.config.subjects[0].passwordFile, 0o644);
		if (scenario === "public-output") await chmod(f.config.identityFile, 0o644);
		if (scenario === "insecure-origin")
			f.config.origin = "http://outside.example.test";
		if (scenario === "duplicate-login")
			f.config.subjects[1].loginFile = f.config.subjects[0].loginFile;
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

test("CLI redacts invalid credential files", async (t) => {
	const f = await fixture(t);
	await chmod(f.config.subjects[0].passwordFile, 0o644);
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

test("incomplete promotion blocks a fresh login before network I/O", async (t) => {
	const f = await fixture(t);
	const { mkdir } = await import("node:fs/promises");
	await mkdir(`${f.config.identityFile}.promotion`, { mode: 0o700 });
	await assert.rejects(bootstrapLogin(f.file, source), /PROMOTION_INCOMPLETE/);
	assert.equal(f.calls.length, 0);
});

for (const stop of ["first-publish", "rollback-failure", "corrupted-backup"]) {
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
					`${f.config.identityFile}.promotion/journal.json`,
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
