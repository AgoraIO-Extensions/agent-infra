import { describe, expect, it } from "vitest";
import {
	type AuditRawDetail,
	auditFilter,
	auditPage,
	projectAuditDetail,
} from "./audit";

const query = {
	from: "2026-09-01T00:00:00Z",
	to: "2026-09-27T00:00:00Z",
	query: "张三",
};
const raw: AuditRawDetail = {
	callId: "call-1",
	createdAt: "2026-09-26T00:00:00.000123Z",
	principalId: "person-1",
	person: "张三",
	email: "user@example.invalid",
	consumerId: "consumer-1",
	consumer: "Codex",
	instanceId: "instance-1",
	actorKey: null,
	connectionId: "connection-1",
	providerId: "jira",
	action: "jira.create_issue",
	actionVersionId: "jira.create_issue@v6",
	status: "SUCCEEDED",
	requestInput: {
		summary: "SECRET-CANARY",
		projectKey: "SECRET-CANARY",
		authorization: "SECRET-CANARY",
		unexpected: "SECRET-CANARY",
		body: { nested: "SECRET-CANARY" },
	},
	result: {
		key: "DEMO-123",
		id: "SECRET-CANARY",
		token: "SECRET-CANARY",
		description: "PRIVATE-BODY",
	},
	timeline: [],
};
describe("controlled audit queries", () => {
	it("rejects invalid, reversed and unbounded time ranges", () => {
		for (const input of [
			{ ...query, from: "invalid" },
			{ ...query, to: query.from },
			{ ...query, from: "2025-01-01T00:00:00Z" },
			{ ...query, query: "x".repeat(121) },
		])
			expect(() => auditFilter("admin", input)).toThrow("Invalid audit query");
	});
	it("binds keyset cursors to the administrator and exact filter, retaining microseconds", () => {
		const filter = auditFilter("admin", query);
		const page = auditPage(
			Array.from({ length: 51 }, (_, n) => ({ ...raw, callId: `call-${n}` })),
			filter.binding,
		);
		expect(page.items).toHaveLength(50);
		expect(JSON.stringify(page)).not.toMatch(
			/CANARY|requestInput|PRIVATE-BODY/,
		);
		expect(
			auditFilter("admin", { ...query, cursor: page.nextCursor ?? "" }).after,
		).toEqual({ callId: "call-49", createdAt: raw.createdAt });
		for (const [admin, input] of [
			["other", query],
			["admin", { ...query, query: "李四" }],
		] as const)
			expect(() =>
				auditFilter(admin, { ...input, cursor: page.nextCursor ?? "" }),
			).toThrow();
		expect(() =>
			auditFilter("admin", { ...query, cursor: "not-json" }),
		).toThrow();
	});
	it("never exposes arbitrary request/result text or keys", () => {
		const detail = projectAuditDetail(raw);
		expect(JSON.stringify(detail)).not.toMatch(
			/SECRET-CANARY|PRIVATE-BODY|requestInput|unexpected|authorization/,
		);
		expect(detail.output).toContainEqual({
			label: "工单编号",
			value: "DEMO-123",
			state: "AVAILABLE",
		});
		expect(detail.input).toContainEqual({
			label: "标题",
			value: "已脱敏",
			state: "REDACTED",
		});
		expect(
			projectAuditDetail({
				...raw,
				action: "unknown.execute",
				requestInput: { opaque: "SECRET-CANARY" },
				result: { opaque: "SECRET-CANARY" },
			}),
		).toMatchObject({
			input: [],
			output: [],
			inputState: "UNSUPPORTED",
			outputState: "UNSUPPORTED",
		});
		expect(projectAuditDetail({ ...raw, result: [raw.result] }).output).toEqual(
			[{ label: "结果条数", value: "1", state: "AVAILABLE" }],
		);
	});
	it("repairs the exact Bitbucket identity case and distinguishes summary states", () => {
		const identity = projectAuditDetail({
			...raw,
			action: "bitbucket.get_current_user",
			requestInput: {},
			inputSchema: { properties: {}, required: [] },
			result: {
				displayName: "郭贤哲",
				externalAccount: "2588",
				grantedScopes: ["bitbucket.server.pat"],
				providerId: "bitbucket",
			},
		});
		expect(identity.inputState).toBe("NO_PARAMETERS");
		expect(identity.outputState).toBe("REDACTED");
		expect(
			projectAuditDetail({
				...raw,
				action: "github.get_current_user",
				result: { data: { user: { login: "PRIVATE-BODY", id: 123 } } },
			}).output,
		).toEqual([
			{ label: "账号名称", value: "已脱敏", state: "REDACTED" },
			{ label: "对象编号", value: "已脱敏", state: "REDACTED" },
		]);
		expect(identity.output).toHaveLength(3);
		expect(identity.output.map((field) => field.label)).toEqual([
			"账号名称",
			"外部账号指纹",
			"授权范围数量",
		]);
		expect(JSON.stringify(identity.output)).not.toContain("郭贤哲");
		for (const provider of [
			"bitbucket",
			"github",
			"jira",
			"confluence",
			"jenkins",
			"jenkins-ci",
			"rehoboam",
			"manhattan",
			"datalego",
		]) {
			expect(
				projectAuditDetail({
					...raw,
					action: `${provider}.list`,
					result: { data: [{ body: "SECRET-CANARY" }] },
				}).output,
			).toEqual([{ label: "结果条数", value: "1", state: "AVAILABLE" }]);
		}
		expect(projectAuditDetail({ ...raw, result: null }).outputState).toBe(
			"NOT_RECORDED",
		);
		expect(projectAuditDetail({ ...raw, result: {} }).outputState).toBe(
			"EMPTY_OUTPUT",
		);
		expect(
			projectAuditDetail({
				...raw,
				requestInput: {},
				inputSchema: { properties: { limit: {} }, required: [] },
			}).inputState,
		).toBe("EMPTY_INPUT");
	});
});
