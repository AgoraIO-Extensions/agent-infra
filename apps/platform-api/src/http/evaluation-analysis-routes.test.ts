import {
	EvaluationDataErrorV1,
	EvaluationQueryLimitErrorV1,
} from "@agent-infra/platform-core";
import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import {
	type EvaluationAnalysisRoutesV1,
	registerEvaluationAnalysisRoutesV1,
} from "./evaluation-analysis-routes.js";

const identity = {
	resolve: async () => ({
		schemaVersion: 1,
		userId: "self",
		displayName: "Self",
		accountStatus: "active",
		organizationIds: [],
		roles: ["employee"],
		authorizationRevision: "one",
	}),
	resolveUser: async () => null,
	hydrateUsers: async () => [],
};
it("keeps unconfigured, denied, dependency, empty and oversized query responses distinct", async () => {
	const absent = new Hono();
	registerEvaluationAnalysisRoutesV1(absent);
	expect((await absent.request("/api/v2/evaluation/history")).status).toBe(503);
	const history = vi.fn();
	const app = new Hono();
	registerEvaluationAnalysisRoutesV1(app, {
		identity,
		analysis: { history },
		feedback: {},
		scoring: {},
	} as unknown as EvaluationAnalysisRoutesV1);
	for (const [error, status, code] of [
		[new EvaluationQueryLimitErrorV1(), 400, "EVALUATION_QUERY_TOO_LARGE"],
		[new EvaluationDataErrorV1("denied"), 404, "RESOURCE_UNAVAILABLE"],
		[new EvaluationDataErrorV1("unavailable"), 503, "DEPENDENCY_UNAVAILABLE"],
	] as const) {
		history.mockRejectedValueOnce(error);
		const result = await app.request("/api/v2/evaluation/history");
		expect(result.status).toBe(status);
		expect(await result.json()).toMatchObject({ code });
	}
	history.mockResolvedValueOnce({ items: [], nextCursor: null });
	const empty = await app.request("/api/v2/evaluation/history");
	expect(empty.status).toBe(200);
	expect(await empty.json()).toEqual({ items: [], nextCursor: null });
});
it("rejects duplicate/foreign query keys, spoofed subjects and extra path grammar before any content read", async () => {
	const history = vi.fn();
	const app = new Hono();
	registerEvaluationAnalysisRoutesV1(app, {
		identity,
		analysis: { history },
		feedback: {},
		scoring: {},
	} as unknown as EvaluationAnalysisRoutesV1);
	for (const path of [
		"/api/v2/evaluation/history?limit=1&limit=2",
		"/api/v2/evaluation/history?actorId=other",
		"/api/v2/evaluation/history?cursor=foreign",
	])
		expect((await app.request(path)).status).toBe(400);
	expect(
		(
			await app.request("/api/v2/evaluation/history", {
				headers: { "x-principal-id": "other" },
			})
		).status,
	).toBe(400);
	expect((await app.request("/api/v2/evaluation/history/extra")).status).toBe(
		404,
	);
	expect(history).not.toHaveBeenCalled();
});
