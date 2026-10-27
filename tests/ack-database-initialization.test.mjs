import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { databaseInitialization } from "../deploy/ack/database-initialization.ts";

const inputs = {
	installationId: "11111111-1111-4111-8111-111111111111",
	namespace: "test",
	adminRole: "bootstrap_admin",
	platformUrl:
		"postgres://platform_user:platform-canary-password@agent-infra-postgres/platform_db",
	directoryMigrationUrl:
		"postgres://directory_owner:migration-canary-password@agent-infra-postgres/directory_db",
	directoryUrl:
		"postgres://directory_runtime:runtime-canary-password@agent-infra-postgres/directory_db",
};

test("database SQL contains only SCRAM verifiers and is deterministic for one installation", () => {
	const first = databaseInitialization(inputs);
	assert.deepEqual(databaseInitialization(inputs), first);
	for (const secret of [
		"platform-canary-password",
		"migration-canary-password",
		"runtime-canary-password",
	])
		assert(
			!first.sql.includes(secret) && !first.verificationSql.includes(secret),
		);
	assert.equal((first.sql.match(/CREATE ROLE/g) ?? []).length, 3);
	assert.equal((first.sql.match(/CREATE DATABASE/g) ?? []).length, 2);
	assert(first.sql.includes("SCRAM-SHA-256"));
	assert.throws(() =>
		databaseInitialization({ ...inputs, adminRole: "platform_user" }),
	);
	assert.throws(() =>
		databaseInitialization({ ...inputs, directoryUrl: inputs.platformUrl }),
	);
	assert.throws(() =>
		databaseInitialization({
			...inputs,
			platformUrl: inputs.platformUrl.replace(
				"agent-infra-postgres",
				"foreign.example",
			),
		}),
	);
});

// Explicit opt-in: isolated native PostgreSQL process, never a shared service or ACK.
// biome-ignore lint/suspicious/noUndeclaredEnvVars: Direct node --test fixture outside Turbo.
const pgBin = process.env.ACK_NATIVE_PG_BIN;
test("native PostgreSQL accepts generated SCRAM passwords and enforces database/role separation", {
	skip: !pgBin,
	timeout: 30_000,
}, async () => {
	const directory = await mkdtemp(join(tmpdir(), "ack-pg-native-"));
	const data = join(directory, "data");
	const run = (tool, args, input, env = {}) =>
		spawnSync(join(pgBin, tool), args, {
			encoding: "utf8",
			input,
			env: { ...process.env, ...env },
			timeout: 15_000,
		});
	const listener = createServer();
	listener.listen(0, "127.0.0.1");
	await once(listener, "listening");
	const port = listener.address().port;
	await new Promise((resolve) => listener.close(resolve));
	let started = false;
	try {
		assert.equal(
			run("initdb", [
				"-D",
				data,
				"-U",
				inputs.adminRole,
				"--auth-local=trust",
				"--auth-host=scram-sha-256",
				"--no-locale",
				"--encoding=UTF8",
			]).status,
			0,
			"isolated initdb failed",
		);
		assert.equal(
			run("pg_ctl", [
				"-D",
				data,
				"-l",
				join(directory, "server.log"),
				"-o",
				`-h 127.0.0.1 -p ${port} -k ${directory}`,
				"-w",
				"start",
			]).status,
			0,
			"isolated postgres start failed",
		);
		started = true;
		const admin = (sql) =>
			run(
				"psql",
				[
					"-X",
					"-h",
					directory,
					"-p",
					String(port),
					"-U",
					inputs.adminRole,
					"-d",
					"postgres",
					"-v",
					"ON_ERROR_STOP=1",
					"-At",
					"-f",
					"-",
				],
				sql,
			);
		const generated = databaseInitialization(inputs);
		assert.equal(admin(generated.sql).status, 0, "bootstrap DDL failed");
		assert.equal(admin(generated.verificationSql).stdout.trim(), "t");
		const asRole = (role, password, database, sql) =>
			run(
				"psql",
				[
					"-X",
					"-h",
					"127.0.0.1",
					"-p",
					String(port),
					"-U",
					role,
					"-d",
					database,
					"-v",
					"ON_ERROR_STOP=1",
					"-At",
					"-f",
					"-",
				],
				sql,
				{ PGPASSWORD: password },
			);
		for (const [role, password, database] of [
			["platform_user", "platform-canary-password", "platform_db"],
			["directory_owner", "migration-canary-password", "directory_db"],
			["directory_runtime", "runtime-canary-password", "directory_db"],
		])
			assert.equal(
				asRole(role, password, database, "SELECT current_user;").stdout.trim(),
				role,
			);
		assert.notEqual(
			asRole(
				"directory_runtime",
				"runtime-canary-password",
				"platform_db",
				"SELECT 1;",
			).status,
			0,
		);
		assert.notEqual(
			asRole(
				"platform_user",
				"platform-canary-password",
				"directory_db",
				"SELECT 1;",
			).status,
			0,
		);
		assert.notEqual(
			asRole(
				"directory_runtime",
				"wrong-canary-password",
				"directory_db",
				"SELECT 1;",
			).status,
			0,
		);
		assert.notEqual(
			asRole(
				"directory_runtime",
				"runtime-canary-password",
				"directory_db",
				"CREATE TABLE unauthorized(id int);",
			).status,
			0,
		);
		assert.equal(
			asRole(
				"directory_owner",
				"migration-canary-password",
				"directory_db",
				"CREATE SCHEMA enterprise_directory; CREATE TABLE enterprise_directory.test(id int); GRANT USAGE ON SCHEMA enterprise_directory TO directory_runtime; GRANT SELECT,INSERT ON enterprise_directory.test TO directory_runtime;",
			).status,
			0,
		);
		assert.equal(
			asRole(
				"directory_runtime",
				"runtime-canary-password",
				"directory_db",
				"INSERT INTO enterprise_directory.test VALUES(1); SELECT count(*) FROM enterprise_directory.test;",
			).status,
			0,
		);
		assert.equal(admin(generated.verificationSql).stdout.trim(), "t");
	} finally {
		let stopped = !started;
		if (started)
			stopped =
				run("pg_ctl", ["-D", data, "-m", "fast", "-w", "stop"]).status === 0;
		if (stopped) await rm(directory, { recursive: true });
		assert(stopped, "isolated postgres cleanup failed");
	}
});
