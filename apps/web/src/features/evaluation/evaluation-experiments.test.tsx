import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { client } from "../../pilot/generated-v2/client.gen.js";
import { EvaluationRun } from "./evaluation-experiments.js";

const datasetId = "10000000-0000-4000-8000-000000000001";
const versionId = "10000000-0000-4000-8000-000000000002";
const now = "2026-10-01T00:00:00Z";
const dataset = {
	schemaVersion: 1,
	items: [
		{
			datasetId,
			name: "Synthetic dataset",
			scope: "test",
			revision: 1,
			createdAt: now,
			metadataExpiresAt: now,
			grants: [],
			versions: [
				{
					datasetId,
					versionId,
					sourceVersionId: null,
					revision: 1,
					status: "available",
					createdAt: now,
					expiresAt: now,
					metadataExpiresAt: now,
					deleteBy: now,
					policyId: "policy",
					policyRevision: 1,
					materialApprovalId: "synthetic",
				},
			],
		},
	],
};
const choices = {
	datasetId,
	versionId,
	policyId: "policy",
	policyRevision: 1,
	maximumTasks: 10,
	variants: ["base", "candidate"].map((variantId) => ({
		variantId,
		agentId: "agent",
		configurationRevision: 1,
		modelOptionId: variantId,
		reasoningLevel: null,
		toolEnvironment: "test",
		billing: { purpose: "agent-default", subjectId: "agent" },
		name: variantId,
	})),
	scorers: [
		{
			scorerId: "human",
			version: "1",
			rubricId: "r",
			source: "human",
			scoringModel: null,
			minimum: 0,
			maximum: 1,
			passThreshold: 1,
		},
	],
};
beforeEach(() =>
	client.setConfig({
		baseUrl: "https://platform.test",
		fetch: (input, init) => globalThis.fetch(input, init),
	}),
);
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});
it("locks an uncertain experiment to its approved choices and replays exactly the original intent", async () => {
	const writes: { key: string | null; body: unknown }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const request = input instanceof Request ? input : new Request(input);
			const path = new URL(request.url).pathname;
			if (request.method === "POST") {
				writes.push({
					key: request.headers.get("Idempotency-Key"),
					body: await request.json(),
				});
				throw new Error("Synthetic lost result");
			}
			return Response.json(path.endsWith("/choices") ? choices : dataset);
		}),
	);
	render(<EvaluationRun onAnalyze={() => {}} />);
	await screen.findByRole("option", { name: /Synthetic dataset/ });
	fireEvent.change(screen.getByLabelText("评测版本"), {
		target: { value: `${datasetId}/${versionId}` },
	});
	await screen.findByLabelText("基线");
	fireEvent.change(screen.getByLabelText("基线"), {
		target: { value: "base" },
	});
	fireEvent.click(screen.getByRole("checkbox", { name: /candidate/ }));
	fireEvent.click(screen.getByRole("checkbox", { name: /human/ }));
	fireEvent.click(screen.getByRole("checkbox", { name: "配置" }));
	fireEvent.click(screen.getByRole("button", { name: "创建实验" }));
	await screen.findByText(/操作未确认/);
	expect(
		(screen.getByLabelText("评测版本") as HTMLSelectElement).disabled,
	).toBe(true);
	fireEvent.click(screen.getByRole("button", { name: "重试原操作" }));
	await screen.findByText(/操作未确认/);
	expect(writes).toHaveLength(2);
	expect(writes[1]).toEqual(writes[0]);
	expect(writes[0].key).toBeTruthy();
	expect(writes[0].body).toEqual({
		datasetId,
		versionId,
		variantIds: ["base", "candidate"],
		scorerRefs: [{ scorerId: "human", version: "1" }],
		comparisonTargets: ["model", "configuration"],
	});
});

it("keeps the accepted experiment mounted until an uncertain cancel is resolved", async () => {
	const experimentId = "10000000-0000-4000-8000-000000000003";
	const experiment = {
		experimentId,
		datasetId,
		versionId,
		principal: { kind: "user", id: "runner" },
		policyId: "policy",
		policyRevision: 1,
		sampleIds: ["sample"],
		variantIds: ["base", "candidate"],
		scorerRefs: [{ scorerId: "human", version: "1" }],
		status: "active",
		revision: 1,
		createdAt: now,
		metadataExpiresAt: now,
	};
	const cancels: { key: string | null; path: string; body: string }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const request = input instanceof Request ? input : new Request(input);
			const path = new URL(request.url).pathname;
			if (path.endsWith("/cancel")) {
				cancels.push({
					key: request.headers.get("Idempotency-Key"),
					path,
					body: await request.text(),
				});
				throw new Error("lost cancel response");
			}
			if (request.method === "POST") return Response.json(experiment);
			if (path.includes("/experiments/"))
				return Response.json({ experiment, items: [], nextCursor: null });
			return Response.json(path.endsWith("/choices") ? choices : dataset);
		}),
	);
	render(<EvaluationRun onAnalyze={() => {}} />);
	await screen.findByRole("option", { name: /Synthetic dataset/ });
	fireEvent.change(screen.getByLabelText("评测版本"), {
		target: { value: `${datasetId}/${versionId}` },
	});
	await screen.findByLabelText("基线");
	fireEvent.change(screen.getByLabelText("基线"), {
		target: { value: "base" },
	});
	fireEvent.click(screen.getByRole("checkbox", { name: /candidate/ }));
	fireEvent.click(screen.getByRole("checkbox", { name: /human/ }));
	fireEvent.click(screen.getByRole("button", { name: "创建实验" }));
	fireEvent.click(await screen.findByRole("button", { name: "取消实验" }));
	await screen.findByText(/操作未确认/);
	expect(
		(screen.getByRole("button", { name: "创建实验" }) as HTMLButtonElement)
			.disabled,
	).toBe(true);
	fireEvent.click(screen.getByRole("button", { name: "重试原操作" }));
	await screen.findByText(/操作未确认/);
	expect(cancels).toHaveLength(2);
	expect(cancels[1]).toEqual(cancels[0]);
	expect(cancels[0].key).toBeTruthy();
});
