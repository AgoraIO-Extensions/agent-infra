import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { ConnectionApplicationService } from "@agent-infra/connection-core";
import { githubConnectionCatalog } from "@agent-infra/openconnector-adapter";
import postgres from "postgres";
import { expect, it } from "vitest";
import { seedApprovedConnectPermit } from "./approved-connect-fixture";
import { migrateConnectionDatabase } from "./migrations";
import { PostgresConnectionRepository } from "./repository";
import { assertIsolatedTestDatabaseUrl } from "./test-database";

const url = process.env.CONNECTION_TEST_DATABASE_URL;
assertIsolatedTestDatabaseUrl(url, process.env.DATABASE_URL);
if (process.env.CI && !url)
	throw new Error("CONNECTION_TEST_DATABASE_URL is required in CI");
(url ? it : it.skip)(
	"queries real calls with stable cursors, safe projections, RBAC and transactional query audit",
	async () => {
		if (!url) return;
		await migrateConnectionDatabase(
			url,
			resolve(import.meta.dirname, "../../../migrations/connection"),
		);
		const repo = new PostgresConnectionRepository(url, Buffer.alloc(32, 31));
		const sql = postgres(url, { max: 1 });
		const suffix = randomUUID();
		const admin = `audit-admin-${suffix}`;
		const user = `audit-user-${suffix}`;
		const consumer = `audit-consumer-${suffix}`;
		const instance = `audit-instance-${suffix}`;
		const service = new ConnectionApplicationService(repo, {} as never);
		try {
			await repo.publishGithubCatalog(githubConnectionCatalog);
			await sql`INSERT INTO connection_principals (id, display_name, email) VALUES (${admin}, '审计管理员', ${`admin-${suffix}@example.invalid`}), (${user}, '张三', ${`user-${suffix}@example.invalid`})`;
			await sql`INSERT INTO connection_principal_roles (principal_id, role, status, grant_source) VALUES (${admin}, 'CONNECTION_ADMIN', 'ACTIVE', 'BOOTSTRAP')`;
			await repo.publishConsumerDeclaration({
				actionVersionIds: githubConnectionCatalog.actions.map((a) => a.id),
				consumer: { id: consumer, name: "Audit consumer" },
				providerReleaseId: githubConnectionCatalog.providerReleaseId,
			});
			await sql`INSERT INTO connection_consumer_instances (id, consumer_id, kind, auth_subject, status, principal_id) VALUES (${instance}, ${consumer}, 'DEVICE', ${suffix}, 'ACTIVE', ${user})`;
			const { connectionId } = await repo.storeGithubOAuthCredential({
				accessRequestId: await seedApprovedConnectPermit(sql, {
					principalId: user,
					providerReleaseId: githubConnectionCatalog.providerReleaseId,
					scopes: [
						"delete_repo",
						"read:user",
						"repo",
						"user:email",
						"workflow",
					],
				}),
				accessToken: "AUDIT-TOKEN-CANARY",
				displayName: "Test account",
				externalAccount: suffix,
				principalId: user,
				grantedScopes: [
					"delete_repo",
					"read:user",
					"repo",
					"user:email",
					"workflow",
				],
			});
			const preview = await repo.createCurrentConsumerAuthorizationPreview({
				principalId: user,
				consumerId: consumer,
				connectionId,
			});
			await repo.confirmCurrentConsumerAuthorization({
				principalId: user,
				previewId: preview.previewId,
				confirmationToken: preview.confirmationToken,
				idempotencyKey: randomUUID(),
			});
			const invocation = await repo.resolveDirectIdentity({
				principalId: user,
				consumerId: consumer,
				instanceId: instance,
			});
			const { call } = await repo.createCall({
				action: "github.list_pull_requests",
				argsHash: "audit-hash",
				input: {
					repository: "AUDIT-BODY-CANARY",
					authorization: "AUDIT-TOKEN-CANARY",
				},
				invocation,
			});
			await repo.setCallResult({
				callId: call.callId,
				status: "SUCCEEDED",
				result: { total: 3, body: "AUDIT-BODY-CANARY" },
			});
			await sql`UPDATE connection_calls SET created_at = '2026-09-26T06:00:00.000123Z' WHERE id = ${call.callId}`;
			for (let index = 0; index < 51; index++)
				await sql`INSERT INTO connection_calls SELECT (jsonb_populate_record(NULL::connection_calls, to_jsonb(original) || jsonb_build_object('id', ${`audit-call-${index}-${suffix}`}::text))).* FROM connection_calls original WHERE id = ${call.callId}`;
			const filter = {
				from: "2026-09-26T00:00:00Z",
				to: "2026-09-27T00:00:00Z",
				query: `user-${suffix}@example.invalid`,
			};
			const first = await service.listAuditCalls(admin, filter);
			expect(first.items).toHaveLength(50);
			expect(first.nextCursor).toBeTruthy();
			const second = await service.listAuditCalls(admin, {
				...filter,
				cursor: first.nextCursor ?? "",
			});
			expect(second.items).toHaveLength(2);
			expect(second.nextCursor).toBeNull();
			expect(
				new Set([...first.items, ...second.items].map((item) => item.callId))
					.size,
			).toBe(52);
			expect(
				(await service.listAuditCalls(admin, { ...filter, query: "%" })).items,
			).toEqual([]);
			expect(
				(await service.listAuditCalls(admin, { ...filter, status: "FAILED" }))
					.items,
			).toEqual([]);
			expect(
				(
					await service.listAuditCalls(admin, {
						...filter,
						to: "2026-09-26T06:00:00Z",
					})
				).items,
			).toEqual([]);
			const detail = await service.getAuditCall(admin, call.callId);
			expect(detail.timeline.map((event) => event.event)).toEqual([
				"CALL_AUTHORIZED",
				"CALL_SUCCEEDED",
			]);
			expect(detail.output).toContainEqual({
				label: "结果数量",
				value: "3",
				state: "AVAILABLE",
			});
			expect(JSON.stringify([first, detail])).not.toContain("CANARY");
			await expect(service.listAuditCalls(user, filter)).rejects.toThrow();
			await expect(service.getAuditCall(user, call.callId)).rejects.toThrow();
			await expect(
				service.getAuditCall(admin, "missing-call"),
			).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
			const audits =
				await sql`SELECT event, detail FROM connection_audit_records WHERE principal_id = ${admin}`;
			expect(audits.some((a) => a.event === "AUDIT_CALLS_QUERIED")).toBe(true);
			expect(JSON.stringify(audits)).not.toMatch(/CANARY|user-.*@example/);
			const constraint = `audit_failure_${suffix.replaceAll("-", "")}`;
			await sql.unsafe(
				`ALTER TABLE connection_audit_records ADD CONSTRAINT ${constraint} CHECK (principal_id <> '${admin}' OR event NOT LIKE 'AUDIT_CALL%') NOT VALID`,
			);
			try {
				await expect(service.listAuditCalls(admin, filter)).rejects.toThrow();
				await expect(
					service.getAuditCall(admin, call.callId),
				).rejects.toThrow();
			} finally {
				await sql.unsafe(
					`ALTER TABLE connection_audit_records DROP CONSTRAINT ${constraint}`,
				);
			}
			await sql`UPDATE connection_principal_roles SET status = 'REVOKED', revoked_at = now(), revoked_by_principal_id = ${admin} WHERE principal_id = ${admin}`;
			await expect(service.getAuditCall(admin, call.callId)).rejects.toThrow();
		} finally {
			await sql.end();
			await repo.close();
		}
	},
	60_000,
);
