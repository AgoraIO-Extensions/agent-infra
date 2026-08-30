import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import postgres from "postgres";

const execFile = promisify(execFileCallback);
const postgresImage =
	"postgres@sha256:20edbde7749f822887a1a022ad526fde0a47d6b2be9a8364433605cf65099416";
const username = "platform_test";
const password = "platform_test_password";
const database = "platform_test";

export interface PostgresTestDatabase {
	databaseUrl: string;
	stop(): Promise<void>;
}

export async function startPostgresTestDatabase(
	name: string,
): Promise<PostgresTestDatabase> {
	const containerName = `agent-infra-${name}-${randomUUID()}`;
	const stop = async () => {
		await execFile("docker", ["rm", "--force", containerName]).catch(() => {});
	};
	try {
		await execFile("docker", [
			"run",
			"--detach",
			"--rm",
			"--name",
			containerName,
			"--env",
			`POSTGRES_USER=${username}`,
			"--env",
			`POSTGRES_PASSWORD=${password}`,
			"--env",
			`POSTGRES_DB=${database}`,
			"--publish",
			"127.0.0.1::5432",
			postgresImage,
		]);
		const { stdout } = await execFile("docker", [
			"port",
			containerName,
			"5432/tcp",
		]);
		const port = stdout.trim().match(/:(\d+)$/)?.[1];
		if (!port)
			throw new Error("PostgreSQL test container did not publish a port");
		const databaseUrl = `postgres://${username}:${password}@127.0.0.1:${port}/${database}`;

		for (let attempt = 0; attempt < 80; attempt += 1) {
			const client = postgres(databaseUrl, { connect_timeout: 1, max: 1 });
			try {
				await client`select 1`;
				await client.end();
				return { databaseUrl, stop };
			} catch {
				await client.end({ timeout: 0 });
				await new Promise((resolve) => setTimeout(resolve, 250));
			}
		}
		throw new Error("PostgreSQL test container did not become ready");
	} catch (error) {
		await stop();
		throw error;
	}
}
