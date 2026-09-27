import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import {
	ConnectionApplicationService,
	newCallDiagnostics,
	observeProviderFetch,
	withCallDiagnostics,
} from "@agent-infra/connection-core";
import { githubConnectionCatalog } from "@agent-infra/openconnector-adapter";
import postgres from "postgres";
import { expect, it } from "vitest";
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
			const diagnostic = newCallDiagnostics("EXECUTE");
			await withCallDiagnostics(diagnostic, () =>
				observeProviderFetch(
					"github",
					(async () =>
						new Response(null, {
							status: 200,
							headers: {
								"x-request-id": "123e4567-e89b-12d3-a456-426614174000",
							},
						})) as typeof fetch,
				)(
					"https://api.github.com/repos/SECRET-CANARY/SECRET-CANARY/pulls?token=SECRET-CANARY",
				),
			);
			await repo.setCallResult({
				diagnostics: diagnostic,
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
			expect(detail.diagnostics).toHaveLength(1);
			expect(detail.diagnostics[0]?.requests[0]).toMatchObject({
				pathTemplate: "/repos/{segment}/{segment}/pulls",
				status: 200,
			});
			const historical = await service.getAuditCall(
				admin,
				`audit-call-0-${suffix}`,
			);
			expect(historical.diagnostics).toEqual([]);
			const [storedDiagnostic] =
				await sql`SELECT diagnostic FROM connection_call_diagnostics WHERE call_id = ${call.callId}`;
			expect(JSON.stringify(storedDiagnostic)).not.toContain("CANARY");
			const diagnosticConstraint = `diagnostic_failure_${suffix.replaceAll("-", "")}`;
			await sql.unsafe(
				`ALTER TABLE connection_call_diagnostics ADD CONSTRAINT ${diagnosticConstraint} CHECK (call_id <> '${call.callId}') NOT VALID`,
			);
			try {
				await expect(
					repo.setCallResult({
						callId: call.callId,
						status: "FAILED",
						diagnostics: newCallDiagnostics("EXECUTE"),
					}),
				).rejects.toThrow();
				const [unchanged] =
					await sql`SELECT status FROM connection_calls WHERE id = ${call.callId}`;
				expect(unchanged?.status).toBe("SUCCEEDED");
			} finally {
				await sql.unsafe(
					`ALTER TABLE connection_call_diagnostics DROP CONSTRAINT ${diagnosticConstraint}`,
				);
			}
			const { call: pending } = await repo.createCall({
				action: "github.create_pull_request",
				argsHash: randomUUID(),
				idempotencyKey: randomUUID(),
				input: {},
				invocation,
			});
			await repo.startDispatch({
				action: "github.create_pull_request",
				callId: pending.callId,
				invocation,
			});
			await repo.setCallResult({
				callId: pending.callId,
				status: "UNCERTAIN",
				diagnostics: newCallDiagnostics("EXECUTE"),
			});
			const lease = await repo.claimReconciliationJob();
			expect(lease?.callId).toBe(pending.callId);
			const staleDiagnostic = newCallDiagnostics("RECONCILE");
			await repo.rescheduleReconciliationJob({
				callId: pending.callId,
				leaseId: "stale",
				reason: "test",
				diagnostics: staleDiagnostic,
			});
			expect(
				await sql`SELECT 1 FROM connection_call_diagnostics WHERE execution_id = ${staleDiagnostic.executionId}`,
			).toHaveLength(0);
			await repo.rescheduleReconciliationJob({
				callId: pending.callId,
				leaseId: lease?.leaseId ?? "",
				reason: "test",
				diagnostics: newCallDiagnostics("RECONCILE"),
			});
			await sql`UPDATE connection_reconciliation_jobs SET next_attempt_at = now() WHERE call_id = ${pending.callId}`;
			const retryLease = await repo.claimReconciliationJob();
			await repo.completeReconciliationJob({
				callId: pending.callId,
				leaseId: retryLease?.leaseId ?? "",
				result: {},
				diagnostics: newCallDiagnostics("RECONCILE"),
			});
			expect(
				(await service.getAuditCall(admin, pending.callId)).diagnostics,
			).toHaveLength(3);
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
			const server = createServer((_request, response) => {
				response.setHeader(
					"x-request-id",
					"123e4567-e89b-12d3-a456-426614174000",
				);
				response.setHeader("content-type", "application/json");
				response.end(JSON.stringify({ total: 1 }));
			});
			await new Promise<void>((resolve) =>
				server.listen(0, "127.0.0.1", resolve),
			);
			try {
				const actualFetch = observeProviderFetch("github", fetch);
				const executing = new ConnectionApplicationService(repo, {
					execute: async () => {
						const response = await actualFetch(
							`http://127.0.0.1:${(server.address() as AddressInfo).port}/repos/fixture/fixture/pulls?secret=CANARY`,
						);
						return response.json();
					},
				});
				const actual = await executing.executeDirectActionForIdentity(
					{ principalId: user, consumerId: consumer, instanceId: instance },
					"github.list_pull_requests",
					{ owner: "fixture", repo: "fixture" },
				);
				const persisted = await service.getAuditCall(admin, actual.callId);
				expect(persisted.diagnostics).toHaveLength(1);
				expect(
					persisted.diagnostics[0]?.requests[0]?.requestIds[0]?.value,
				).toBe("123e4567-e89b-12d3-a456-426614174000");
				expect(JSON.stringify(persisted)).not.toContain("CANARY");
			} finally {
				await new Promise<void>((resolve) => server.close(() => resolve()));
			}
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
