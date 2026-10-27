import assert from "node:assert/strict";
import { createHash, createHmac, pbkdf2Sync } from "node:crypto";

type Account = { role: string; database: string; password: string };
const identifier = /^[a-z_][a-z0-9_]{0,62}$/u;
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const name = (value: string) => {
	assert(identifier.test(value));
	return `"${value}"`;
};

function account(text: string, hosts: string[]): Account {
	const url = new URL(text.trim());
	assert(["postgres:", "postgresql:"].includes(url.protocol));
	assert(
		[...url.searchParams.keys()].every((key) => key === "sslmode") &&
			url.searchParams.getAll("sslmode").length <= 1,
	);
	assert(
		hosts.includes(url.hostname) &&
			(!url.port || url.port === "5432") &&
			!url.hash,
	);
	const role = decodeURIComponent(url.username);
	const database = decodeURIComponent(url.pathname.slice(1));
	const password = decodeURIComponent(url.password);
	assert(identifier.test(role) && identifier.test(database));
	assert(
		!role.startsWith("pg_") &&
			!["postgres", "template0", "template1"].includes(database),
	);
	// ASCII credentials avoid changing SASLprep semantics when computing the PostgreSQL verifier.
	assert(/^[\x21-\x7e]{16,256}$/u.test(password));
	return { role, database, password };
}

function verifier(password: string, installationId: string, role: string) {
	// The fixed per-installation salt makes re-running input preparation byte-for-byte deterministic.
	const salt = createHash("sha256")
		.update(`ack-db-v1:${installationId}:${role}`)
		.digest()
		.subarray(0, 16);
	const salted = pbkdf2Sync(password, salt, 4096, 32, "sha256");
	const clientKey = createHmac("sha256", salted).update("Client Key").digest();
	const storedKey = createHash("sha256").update(clientKey).digest("base64");
	const serverKey = createHmac("sha256", salted)
		.update("Server Key")
		.digest("base64");
	return `SCRAM-SHA-256$4096:${salt.toString("base64")}$${storedKey}:${serverKey}`;
}

export function databaseInitialization(input: {
	installationId: string;
	namespace: string;
	adminRole: string;
	platformUrl: string;
	directoryMigrationUrl: string;
	directoryUrl: string;
}) {
	assert(/^[a-f0-9-]{36}$/u.test(input.installationId));
	assert(
		/^[a-z0-9-]+$/u.test(input.namespace) && identifier.test(input.adminRole),
	);
	const hosts = [
		"agent-infra-postgres",
		`agent-infra-postgres.${input.namespace}`,
		`agent-infra-postgres.${input.namespace}.svc`,
		`agent-infra-postgres.${input.namespace}.svc.cluster.local`,
	];
	const platform = account(input.platformUrl, hosts);
	const migration = account(input.directoryMigrationUrl, hosts);
	const directory = account(input.directoryUrl, hosts);
	const accounts = [platform, migration, directory];
	assert(
		new Set([input.adminRole, ...accounts.map((item) => item.role)]).size === 4,
	);
	assert(
		platform.database !== migration.database &&
			migration.database === directory.database,
	);
	const marker = `agent-infra-bootstrap:${input.installationId}`;
	const checks: string[] = [];
	const statements = ["\\set ON_ERROR_STOP on"];
	for (const item of accounts) {
		const stored = verifier(item.password, input.installationId, item.role);
		statements.push(
			`CREATE ROLE ${name(item.role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD ${quote(stored)};`,
		);
		statements.push(`COMMENT ON ROLE ${name(item.role)} IS ${quote(marker)};`);
		checks.push(
			`EXISTS (SELECT 1 FROM pg_authid WHERE rolname=${quote(item.role)} AND rolcanlogin AND rolvaliduntil IS NULL AND rolconnlimit=-1 AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolinherit AND NOT rolreplication AND NOT rolbypassrls AND rolpassword=${quote(stored)} AND shobj_description(oid,'pg_authid')=${quote(marker)})`,
		);
	}
	for (const owner of [platform, migration]) {
		statements.push(
			`CREATE DATABASE ${name(owner.database)} OWNER ${name(owner.role)};`,
		);
		statements.push(
			`COMMENT ON DATABASE ${name(owner.database)} IS ${quote(marker)};`,
		);
		statements.push(
			`REVOKE ALL ON DATABASE ${name(owner.database)} FROM PUBLIC;`,
		);
		statements.push(`\\connect ${name(owner.database)}`);
		statements.push("REVOKE CREATE ON SCHEMA public FROM PUBLIC;");
		checks.push(
			`EXISTS (SELECT 1 FROM pg_database WHERE datname=${quote(owner.database)} AND datallowconn AND NOT datistemplate AND pg_get_userbyid(datdba)=${quote(owner.role)} AND shobj_description(oid,'pg_database')=${quote(marker)})`,
		);
	}
	statements.push(
		`GRANT CONNECT ON DATABASE ${name(directory.database)} TO ${name(directory.role)};`,
	);
	const roles = accounts.map((item) => quote(item.role)).join(",");
	checks.push(
		`NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member IN (SELECT oid FROM pg_roles WHERE rolname IN (${roles})))`,
	);
	for (const [role, database] of [
		[directory.role, platform.database],
		[migration.role, platform.database],
		[platform.role, directory.database],
	])
		checks.push(
			`NOT has_database_privilege(${quote(role)},${quote(database)},'CONNECT')`,
		);
	checks.push(
		`has_database_privilege(${quote(directory.role)},${quote(directory.database)},'CONNECT')`,
	);
	checks.push(
		`NOT has_database_privilege(${quote(directory.role)},${quote(directory.database)},'CREATE')`,
	);
	return {
		sql: `${statements.join("\n")}\n`,
		verificationSql: `SELECT ${checks.join(" AND ")};\n`,
		runtimeRole: directory.role,
	};
}

export function initializationFromResources(
	documents: Record<string, any>[],
	objects: Record<string, any>[],
	namespace: string,
	installationId: string,
) {
	const one = (kind: string, name: string) => {
		const found = documents.filter(
			(item) => item.kind === kind && item.metadata?.name === name,
		);
		assert(found.length === 1);
		return found[0];
	};
	const environment = (object: Record<string, any>, field: string) => {
		const items = object.spec.template.spec.containers[0].env.filter(
			(item: any) => item.name === field,
		);
		assert(items.length === 1);
		return items[0];
	};
	const secretText = (reference: { name: string; key: string }) => {
		const secret = objects.find(
			(item) => item.kind === "Secret" && item.metadata.name === reference.name,
		);
		assert(secret?.data?.[reference.key]);
		return new TextDecoder("utf-8", { fatal: true })
			.decode(Buffer.from(secret.data[reference.key], "base64"))
			.trim();
	};
	const postgres = one("StatefulSet", "agent-infra-postgres");
	const adminRole = environment(postgres, "POSTGRES_USER").value;
	assert(environment(postgres, "POSTGRES_DB").value === "postgres");
	const adminPassword = secretText(
		environment(postgres, "POSTGRES_PASSWORD").valueFrom.secretKeyRef,
	);
	assert(/^[\x21-\x7e]{16,256}$/u.test(adminPassword));
	const initialization = postgres.spec.template.spec.volumes?.find(
		(volume: any) => volume.name === "initialization",
	);
	assert(initialization?.secret?.secretName);
	const migration = one("Job", "agent-infra-directory-migration");
	const result = databaseInitialization({
		namespace,
		installationId,
		adminRole,
		platformUrl: secretText(
			environment(
				one("Job", "agent-infra-platform-migration"),
				"PLATFORM_DATABASE_URL",
			).valueFrom.secretKeyRef,
		),
		directoryMigrationUrl: secretText(
			environment(migration, "DIRECTORY_MIGRATION_DATABASE_URL").valueFrom
				.secretKeyRef,
		),
		directoryUrl: secretText(
			environment(
				one("Deployment", "agent-infra-directory"),
				"DIRECTORY_DATABASE_URL",
			).valueFrom.secretKeyRef,
		),
	});
	assert(
		environment(migration, "DIRECTORY_RUNTIME_DATABASE_ROLE").value ===
			result.runtimeRole,
	);
	return { ...result, adminRole, secretName: initialization.secret.secretName };
}
