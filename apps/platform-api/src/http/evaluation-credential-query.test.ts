import { EvaluationDataErrorV1 } from "@agent-infra/platform-core";
import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { requireApiManagementMaterial } from "./agent-api-management-support.js";
import { registerEvaluationAnalysisRoutesV1 } from "./evaluation-analysis-routes.js";
import { registerEvaluationExperimentRoutesV1 } from "./evaluation-experiment-routes.js";

const material = `papi_${"A".repeat(43)}`;
const headers = { Authorization: `Bearer ${material}` };
const id = "11111111-1111-4111-8111-111111111111";
const cursor = "22222222-2222-4222-8222-222222222222";
const paths = [
	[
		`/api/v2/evaluation/history?limit=1&cursor=${cursor}`,
		"history",
		[1, cursor],
	],
	[
		`/api/v2/evaluation/choices?datasetId=${id}&versionId=${cursor}`,
		"choices",
		[id, cursor],
	],
	[
		`/api/v2/evaluation/worklist?purpose=review&limit=2&cursor=${cursor}`,
		"worklist",
		["review", 2, cursor],
	],
	[
		`/api/v2/evaluation/analysis/${id}/samples/${cursor}?limit=2&cursor=${id}&scoreId=${cursor}&reviewCursor=${id}`,
		"detail",
		[id, cursor, { limit: 2, cursor: id, scoreId: cursor, reviewCursor: id }],
	],
	[
		"/api/v2/agents/agent-one/feedback-summary?view=owner&from=2026-10-01T00:00:00.000Z&to=2026-10-02T00:00:00.000Z&modelId=fixture-model&configVersion=2",
		"summary",
		[
			"agent-one",
			"owner",
			{
				from: "2026-10-01T00:00:00.000Z",
				to: "2026-10-02T00:00:00.000Z",
				modelId: "fixture-model",
				configVersion: "2",
			},
		],
	],
	[
		`/api/v2/evaluation/experiments/${id}?limit=3&cursor=${cursor}`,
		"get",
		[id, 3, cursor],
	],
	[
		`/api/v2/evaluation/scores/${id}/reviews?limit=4&cursor=${cursor}`,
		"reviews",
		[id, 4, cursor],
	],
] as const;
function fixture() {
	const calls = Object.fromEntries(
		paths.map(([, name]) => [
			name,
			vi.fn().mockRejectedValue(new EvaluationDataErrorV1("denied")),
		]),
	) as Record<(typeof paths)[number][1], ReturnType<typeof vi.fn>>;
	const resolve = vi.fn().mockResolvedValue({
		schemaVersion: 1,
		userId: "self",
		displayName: "Self",
		accountStatus: "active",
		organizationIds: [],
		roles: ["employee"],
		authorizationRevision: "one",
	});
	const identity = {
		resolve,
		resolveUser: async () => null,
		hydrateUsers: async () => [],
	};
	const app = new Hono();
	registerEvaluationAnalysisRoutesV1(app, {
		identity,
		analysis: {
			history: calls.history,
			choices: calls.choices,
			detail: calls.detail,
		},
		feedback: { summary: calls.summary },
		scoring: { worklist: calls.worklist },
	} as unknown as NonNullable<
		Parameters<typeof registerEvaluationAnalysisRoutesV1>[1]
	>);
	registerEvaluationExperimentRoutesV1(app, {
		identity,
		experiments: { get: calls.get },
		scoring: { reviews: calls.reviews },
	} as unknown as NonNullable<
		Parameters<typeof registerEvaluationExperimentRoutesV1>[1]
	>);
	return { app, calls, resolve };
}
it.each(paths)(
	"passes contract query and bearer material to the authorized service: %s",
	async (path, name, args) => {
		const f = fixture();
		const response = await f.app.request(path, { headers });
		expect(response.status).toBe(404);
		expect(f.calls[name]).toHaveBeenCalledWith(
			expect.objectContaining({
				authentication: { kind: "credential", material },
			}),
			...args,
		);
		expect(f.resolve).not.toHaveBeenCalled();
	},
);
it("returns a real empty history response for bearer pagination", async () => {
	const f = fixture();
	f.calls.history.mockResolvedValue({ items: [], nextCursor: null });
	const response = await f.app.request("/api/v2/evaluation/history?limit=1", {
		headers,
	});
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ items: [], nextCursor: null });
});
it.each(paths)("keeps browser query behavior: %s", async (path, name, args) => {
	const f = fixture();
	expect(
		(await f.app.request(path, { headers: { Cookie: "session=fixture" } }))
			.status,
	).toBe(404);
	expect(f.calls[name]).toHaveBeenCalledWith(
		expect.objectContaining({
			authentication: { kind: "browser", userId: "self" },
		}),
		...args,
	);
});
it.each([
	"/api/v2/evaluation/history?limit=1&limit=2",
	"/api/v2/evaluation/history?limit=101",
	"/api/v2/evaluation/history?cursor=foreign",
	`/api/v2/evaluation/choices?datasetId=${id}&versionId=invalid`,
	"/api/v2/evaluation/worklist?purpose=admin",
	`/api/v2/evaluation/analysis/${id}/samples/${cursor}?reviewCursor=invalid`,
	`/api/v2/evaluation/experiments/${id}?limit=0`,
	`/api/v2/evaluation/scores/${id}/reviews?cursor=invalid`,
	`/api/v2/evaluation/scores/${id}/reviews?limit=1&limit=2`,
	`/api/v2/evaluation/analysis/${id}?limit=1`,
	"/api/v2/task-feedback/task-one?limit=1",
])("rejects invalid query before service access: %s", async (path) => {
	const f = fixture();
	expect((await f.app.request(path, { headers })).status).toBe(400);
	for (const call of Object.values(f.calls))
		expect(call).not.toHaveBeenCalled();
});
it.each(paths)(
	"rejects foreign query fields on every supported path: %s",
	async (path) => {
		const f = fixture();
		expect(
			(await f.app.request(`${path}&actorId=other`, { headers })).status,
		).toBe(400);
		for (const call of Object.values(f.calls))
			expect(call).not.toHaveBeenCalled();
	},
);
it.each([
	[{ Cookie: "session=fixture" }, 401],
	[{ Authorization: "Bearer invalid" }, 401],
	...[
		"x-user-id",
		"x-application-id",
		"x-principal",
		"x-principal-id",
		"x-role",
		"x-roles",
		"x-scope",
		"x-agent-id",
		"x-identity-context",
	].map((name) => [{ [name]: "other" }, 400] as const),
] as const)(
	"rejects mixed credentials or caller identity before service access: %j",
	async (extra, status) => {
		const f = fixture();
		expect(
			(
				await f.app.request("/api/v2/evaluation/history?limit=1", {
					headers: { ...headers, ...extra },
				})
			).status,
		).toBe(status);
		for (const call of Object.values(f.calls))
			expect(call).not.toHaveBeenCalled();
		expect(f.resolve).not.toHaveBeenCalled();
	},
);
it.each([
	"/api/v2/evaluation/experiments?limit=1",
	`/api/v2/evaluation/experiments/${id}/cancel?limit=1`,
	`/api/v2/evaluation/scores/${id}/reviews?limit=1`,
])("keeps mutation queries forbidden: %s", async (path) => {
	const f = fixture();
	expect(
		(await f.app.request(path, { method: "POST", headers, body: "{}" })).status,
	).toBe(400);
	for (const call of Object.values(f.calls))
		expect(call).not.toHaveBeenCalled();
});
it("keeps the management helper query-free for existing callers", () => {
	expect(
		requireApiManagementMaterial(
			new Request("https://fixture.invalid/api/v2/agents", { headers }),
			"trace",
		),
	).toBe(material);
	expect(() =>
		requireApiManagementMaterial(
			new Request("https://fixture.invalid/api/v2/agents?limit=1", { headers }),
			"trace",
		),
	).toThrow();
});
