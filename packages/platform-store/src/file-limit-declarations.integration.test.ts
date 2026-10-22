import {
	createFileLimitDeclarationReaderV1,
	type FileLimitDeclarationInputV1,
	resolveFileLimitsV1,
} from "@agent-infra/platform-core";
import postgres from "postgres";
import { expect, it } from "vitest";
import { PostgresFileLimitDeclarationStoreV1 } from "./file-limit-declarations.js";
import { migratePlatformDatabase } from "./migrate.js";
import { startPostgresTestDatabase } from "./postgres-test.js";

const now = new Date("2026-10-21T00:00:00Z");
const declaration = (
	overrides: Partial<FileLimitDeclarationInputV1> = {},
): FileLimitDeclarationInputV1 => ({
	expiresAt: "2026-11-21T00:00:00.000Z",
	mediaTypes: ["text/plain"],
	maxBytes: 1024,
	...overrides,
});

const digest = (value: number) => value.toString(16).padStart(64, "0");

it("persists declarations with revision CAS, idempotent replay and authoritative reads", async () => {
	const db = await startPostgresTestDatabase("file-limit-declarations");
	const sql = postgres(db.databaseUrl);
	await migratePlatformDatabase(db);
	await sql`insert into platform.agents (id, current_configuration_revision) values ('agent', 7)`;
	const store = new PostgresFileLimitDeclarationStoreV1(db.databaseUrl);
	let key = 0;
	const write = (
		subject: Parameters<typeof store.write>[0]["subject"],
		expectedRevision: number | null,
		values = declaration(),
	) =>
		store.write({
			subject,
			declaration: values,
			expectedRevision,
			idempotencyKey: `Command.Aa-0${++key}`,
			requestDigest: digest(key),
			actorId: "owner",
			now,
		});
	try {
		expect(await store.read({ scope: "deployment" })).toBeNull();
		expect(await store.readAgentConfigurationRevision("agent")).toBe(7);
		expect(await store.readAgentConfigurationRevision("missing")).toBeNull();

		const deployment = await write({ scope: "deployment" }, null, {
			expiresAt: "2026-11-21T00:00:00.000Z",
			mediaTypes: ["text/plain", "image/png"],
			maxBytes: 4096,
		});
		expect(deployment).toMatchObject({
			scope: "deployment",
			agentId: "",
			channelId: null,
			revision: 1,
			maxBytes: 4096,
			updatedBy: "owner",
		});
		const agent = await write({ scope: "agent", agentId: "agent" }, null);
		expect(agent).toMatchObject({
			scope: "agent",
			channelId: null,
			revision: 1,
		});
		const channel = await write(
			{ scope: "channel", agentId: "agent", channelId: "web" },
			null,
			declaration({ maxBytes: 2048 }),
		);
		expect(channel).toMatchObject({
			scope: "channel",
			agentId: "agent",
			channelId: "web",
			revision: 1,
		});

		// Replaying the exact same idempotency key and digest returns the persisted revision.
		const replayed = await store.write({
			subject: { scope: "agent", agentId: "agent" },
			declaration: declaration(),
			expectedRevision: null,
			idempotencyKey: "Command.Aa-02",
			requestDigest: digest(2),
			actorId: "owner",
			now,
		});
		expect(replayed).toEqual(agent);

		await expect(
			write({ scope: "agent", agentId: "agent" }, null),
		).rejects.toMatchObject({ code: "conflict" });
		await expect(
			write({ scope: "agent", agentId: "agent" }, 99),
		).rejects.toMatchObject({ code: "conflict" });
		const replaced = await write(
			{ scope: "agent", agentId: "agent" },
			1,
			declaration({ maxBytes: 512 }),
		);
		expect(replaced).toMatchObject({ revision: 2, maxBytes: 512 });

		const readLimits = createFileLimitDeclarationReaderV1({ store });
		const declared = await readLimits({
			agentId: "agent",
			channelId: "web",
			configurationRevision: 7,
			kind: "attachment",
		});
		expect(declared.configurationRevision).toBe(7);
		expect(resolveFileLimitsV1(declared.declarations, now)).toMatchObject({
			maxBytes: 512,
			mediaTypes: ["text/plain"],
		});
		// A stale caller snapshot is visible as a revision mismatch.
		expect(
			(
				await readLimits({
					agentId: "agent",
					channelId: "web",
					configurationRevision: 6,
					kind: "attachment",
				})
			).configurationRevision,
		).toBe(7);
		// Expiry is decided by resolution from the persisted timestamp.
		expect(
			resolveFileLimitsV1(
				declared.declarations,
				new Date("2026-12-01T00:00:00Z"),
			),
		).toBeNull();
		// Missing declaration scopes fail closed.
		const missing = await readLimits({
			agentId: "agent",
			channelId: "wecom_bot:missing",
			configurationRevision: 7,
			kind: "attachment",
		});
		expect(missing.declarations.channel).toBeNull();
		expect(resolveFileLimitsV1(missing.declarations, now)).toBeNull();
	} finally {
		await store.close();
		await sql.end();
		await db.stop();
	}
}, 120_000);
