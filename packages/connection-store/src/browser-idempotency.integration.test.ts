import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { ConnectionError } from "@agent-infra/connection-core";
import postgres from "postgres";
import { describe, expect, it } from "vitest";

import { PostgresBrowserCommandIdempotency } from "./browser-idempotency";
import { migrateConnectionDatabase } from "./migrations";
import { assertIsolatedTestDatabaseUrl } from "./test-database";

const databaseUrl = process.env.CONNECTION_TEST_DATABASE_URL;
assertIsolatedTestDatabaseUrl(databaseUrl, process.env.DATABASE_URL);
if (process.env.CI && !databaseUrl) {
	throw new Error("CONNECTION_TEST_DATABASE_URL is required in CI");
}
const integrationTest = databaseUrl ? it : it.skip;

describe("PostgresBrowserCommandIdempotency", () => {
	integrationTest(
		"replays safe responses while secrets and uncertain commits remain fail closed",
		async () => {
			if (!databaseUrl) return;
			await migrateConnectionDatabase(
				databaseUrl,
				resolve(import.meta.dirname, "../../../migrations/connection"),
			);
			const sql = postgres(databaseUrl, { max: 1 });
			const store = new PostgresBrowserCommandIdempotency(
				databaseUrl,
				Buffer.alloc(32, 41),
			);
			const suffix = randomUUID();
			const input = {
				idempotencyKey: `browser-command-${suffix}`,
				operation: "connection.shared-scope.create",
				request: { name: "Codex 本机" },
				subject: `principal-${suffix}`,
			};
			let executions = 0;

			try {
				const first = await store.execute(input, async () => {
					executions += 1;
					return { resourceId: `scope-${suffix}` };
				});
				const replay = await store.execute(input, async () => {
					executions += 1;
					return { resourceId: "must-not-run" };
				});
				expect(replay).toEqual(first);
				expect(executions).toBe(1);

				const [stored] = await sql<
					{
						expires_at: string;
						idempotency_key_hash: string;
						request_hash: string;
						response_ciphertext: string;
					}[]
				>`
					SELECT expires_at::text, idempotency_key_hash, request_hash,
						response_ciphertext
					FROM connection_browser_command_idempotency
					WHERE operation = ${input.operation}
						AND response_ciphertext IS NOT NULL
					ORDER BY created_at DESC LIMIT 1
				`;
				expect(stored?.idempotency_key_hash).toMatch(/^[a-f0-9]{64}$/);
				expect(stored?.request_hash).toMatch(/^[a-f0-9]{64}$/);
				expect(stored?.response_ciphertext).not.toContain(suffix);
				expect(stored?.expires_at).toBe("infinity");

				await expect(
					store.execute(
						{ ...input, request: { name: "Claude 本机" } },
						async () => ({ resourceId: "must-not-run" }),
					),
				).rejects.toMatchObject({
					code: "IDEMPOTENCY_CONFLICT",
				});

				let release: (() => void) | undefined;
				let started: (() => void) | undefined;
				const commandStarted = new Promise<void>((resolveStarted) => {
					started = resolveStarted;
				});
				const commandReleased = new Promise<void>((resolveReleased) => {
					release = resolveReleased;
				});
				const overlapInput = {
					...input,
					idempotencyKey: `overlap-${suffix}`,
				};
				const inFlight = store.execute(overlapInput, async () => {
					started?.();
					await commandReleased;
					return { ok: true };
				});
				await commandStarted;
				await expect(
					store.execute(overlapInput, async () => ({ ok: false })),
				).rejects.toMatchObject({
					code: "RESULT_UNCERTAIN",
				});
				release?.();
				await expect(inFlight).resolves.toEqual({ ok: true });

				const secretInput = {
					...input,
					idempotencyKey: `secret-${suffix}`,
					operation: "connection.token.issue",
					replayable: false,
				};
				const secret = `conn_pat_${suffix}`;
				await expect(
					store.execute(secretInput, async () => ({ token: secret })),
				).resolves.toEqual({ token: secret });
				await expect(
					store.execute(secretInput, async () => ({ token: "must-not-run" })),
				).rejects.toMatchObject({ code: "RESULT_UNCERTAIN" });

				const uncertainInput = {
					...input,
					idempotencyKey: `commit-ack-${suffix}`,
					operation: "connection.shared-scope.rename",
				};
				let effects = 0;
				await expect(
					store.execute(uncertainInput, async () => {
						effects += 1;
						throw new Error("commit acknowledgement lost");
					}),
				).rejects.toMatchObject({ code: "RESULT_UNCERTAIN" });
				await expect(
					store.execute(uncertainInput, async () => {
						effects += 1;
						return { ok: true };
					}),
				).rejects.toMatchObject({ code: "RESULT_UNCERTAIN" });
				expect(effects).toBe(1);

				const rejectedInput = {
					...input,
					idempotencyKey: `rejected-${suffix}`,
				};
				await expect(
					store.execute(rejectedInput, async () => {
						throw new ConnectionError("INVALID_REQUEST", "rejected");
					}),
				).rejects.toMatchObject({ code: "INVALID_REQUEST" });
				await expect(
					store.execute(rejectedInput, async () => ({ ok: true })),
				).resolves.toEqual({ ok: true });
			} finally {
				await store.close();
				await sql.end();
			}
		},
		30_000,
	);
});
