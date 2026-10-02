import type postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import {
	readCurrentTaskApiUseGrantV1,
	readCurrentTaskApplicationV1,
	TaskCurrentAuthorityUnavailableErrorV1,
} from "./application-task-authorization.js";

const principal = { kind: "application" as const, id: "same-id" };
const grant = {
	grantType: "use" as const,
	principal,
	agentId: "agent",
	authorizationRevision: "use-1",
	revoked: false,
};
const application = {
	schemaVersion: 1,
	applicationId: principal.id,
	status: "active",
	authorizationRevision: "application-1",
	useGrant: grant,
};

function transaction(rows: unknown[], isolation = "read committed") {
	const queries: { sql: string; values: unknown[] }[] = [];
	const query = vi.fn(
		async (strings: TemplateStringsArray, ...values: unknown[]) => {
			const sql = strings.join("?");
			queries.push({ sql, values });
			return sql.includes("show transaction_isolation")
				? [{ transaction_isolation: isolation }]
				: rows;
		},
	);
	return { sql: query as unknown as postgres.TransactionSql, query, queries };
}

describe("caller-owned application/current-use authority reads", () => {
	it("projects actual application and only its exact explicit Agent use grant without credentials", async () => {
		const tx = transaction([{ application }]);
		expect(
			await readCurrentTaskApplicationV1(tx.sql, {
				applicationId: principal.id,
				agentId: "agent",
			}),
		).toEqual(application);
		expect(tx.queries).toHaveLength(2);
		const query = tx.queries[1];
		expect(query?.values).toEqual(["agent", principal.id]);
		expect(query?.sql).toContain("platform.platform_applications");
		expect(query?.sql).toContain("use_grant.principal_type = 'application'");
		expect(query?.sql).toContain("use_grant.grant_type = 'use'");
		expect(query?.sql).not.toMatch(
			/credential|responsible_user|agent_owner|begin|commit/i,
		);
	});
	it.each([
		["no application", []],
		["no use grant", [{ application: { ...application, useGrant: null } }]],
		[
			"disabled application",
			[{ application: { ...application, status: "disabled" } }],
		],
		[
			"revoked grant",
			[
				{
					application: {
						...application,
						useGrant: { ...grant, revoked: true },
					},
				},
			],
		],
	] as const)(
		"preserves %s instead of inventing active authorization",
		async (_name, rows) => {
			const tx = transaction([...rows]);
			const result = await readCurrentTaskApplicationV1(tx.sql, {
				applicationId: principal.id,
				agentId: "agent",
			});
			expect(result).toEqual(rows.length ? rows[0]?.application : null);
		},
	);
	it.each([
		{ ...application, status: "unknown" },
		{ ...application, useGrant: { ...grant, grantType: "manage" } },
		{ ...application, applicationId: "another-app", useGrant: null },
		{ ...application, useGrant: { ...grant, agentId: "another-agent" } },
		{
			...application,
			useGrant: { ...grant, principal: { kind: "user", id: principal.id } },
		},
		{ ...application, credentialHash: "must-not-project" },
	])(
		"fails unavailable on malformed or foreign persisted facts",
		async (value) => {
			await expect(
				readCurrentTaskApplicationV1(
					transaction([{ application: value }]).sql,
					{ applicationId: principal.id, agentId: "agent" },
				),
			).rejects.toBeInstanceOf(TaskCurrentAuthorityUnavailableErrorV1);
		},
	);
	it("keeps same-ID user and application grant namespaces distinct", async () => {
		for (const kind of ["user", "application"] as const) {
			const current = { ...grant, principal: { kind, id: principal.id } };
			const tx = transaction([{ use_grant: current }]);
			expect(
				await readCurrentTaskApiUseGrantV1(tx.sql, {
					principal: current.principal,
					agentId: "agent",
				}),
			).toEqual(current);
			expect(tx.queries[1]?.values).toEqual([kind, principal.id, "agent"]);
			expect(tx.queries[1]?.sql).toContain("grant_type = 'use'");
			await expect(
				readCurrentTaskApiUseGrantV1(
					transaction([{ use_grant: current }]).sql,
					{
						principal: {
							kind: kind === "user" ? "application" : "user",
							id: principal.id,
						},
						agentId: "agent",
					},
				),
			).rejects.toBeInstanceOf(TaskCurrentAuthorityUnavailableErrorV1);
		}
	});
	it("rejects an old repeatable-read snapshot before returning current authority", async () => {
		const tx = transaction([{ application }], "repeatable read");
		await expect(
			readCurrentTaskApplicationV1(tx.sql, {
				applicationId: principal.id,
				agentId: "agent",
			}),
		).rejects.toBeInstanceOf(TaskCurrentAuthorityUnavailableErrorV1);
		expect(tx.queries).toHaveLength(1);
	});
	it("normalizes query failure without exposing row contents or creating resources", async () => {
		const tx = transaction([]);
		tx.query.mockRejectedValue(new Error("raw dependency detail"));
		await expect(
			readCurrentTaskApplicationV1(tx.sql, {
				applicationId: principal.id,
				agentId: "agent",
			}),
		).rejects.toThrow("Task current authority is unavailable");
	});
});
