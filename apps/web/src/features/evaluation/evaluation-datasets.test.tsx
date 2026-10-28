import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { client } from "../../pilot/generated-v2/client.gen.js";
import { EvaluationDatasets } from "./evaluation-datasets.js";

const id = "11111111-1111-4111-8111-111111111111";
const version = "22222222-2222-4222-8222-222222222222";
const now = "2026-10-28T00:00:00.000Z";
const page = {
	schemaVersion: 1,
	items: [
		{
			datasetId: id,
			scope: "team",
			name: "Dataset",
			revision: 1,
			createdAt: now,
			metadataExpiresAt: now,
			grants: [],
			versions: [
				{
					datasetId: id,
					versionId: version,
					sourceVersionId: null,
					revision: 3,
					status: "available",
					createdAt: now,
					expiresAt: now,
					metadataExpiresAt: now,
					deleteBy: now,
					policyId: "test",
					policyRevision: 1,
					materialApprovalId: "synthetic-fixture",
				},
			],
		},
	],
};
const content = {
	schemaVersion: 1,
	provenance: { approvalId: "synthetic-fixture" },
	samples: [
		{
			id: "a",
			input: "SENSITIVE-SAMPLE",
			context: null,
			taskType: "answer",
			expectedResult: null,
		},
	],
	rubric: [{ id: "r", description: "Expected output" }],
};
beforeEach(() => {
	client.setConfig({
		baseUrl: "https://platform.test",
		fetch: (input, init) => globalThis.fetch(input, init),
	});
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});
it("does not restore a late content response after a new authorization read", async () => {
	let done: (response: Response) => void = () => {};
	let lists = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const request = input instanceof Request ? input : new Request(input);
			if (new URL(request.url).pathname.endsWith("/content"))
				return new Promise<Response>((resolve) => {
					done = resolve;
				});
			lists++;
			return Response.json(
				lists === 1 ? page : { schemaVersion: 1, items: [] },
			);
		}),
	);
	render(<EvaluationDatasets />);
	fireEvent.click(await screen.findByRole("button", { name: "读取内容" }));
	fireEvent.click(screen.getByRole("button", { name: "刷新评测集" }));
	await screen.findByText("当前没有可见评测集。");
	await act(async () => {
		done(Response.json(content));
	});
	expect(screen.queryByText(/SENSITIVE-SAMPLE/)).toBeNull();
});
it("retains the original idempotency key and payload after refresh until explicit replay succeeds", async () => {
	let writes = 0;
	const keys: Array<string | null> = [];
	const bodies: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const request = input instanceof Request ? input : new Request(input);
			if (request.method === "POST") {
				writes++;
				keys.push(request.headers.get("Idempotency-Key"));
				bodies.push(await request.text());
				if (writes === 1) throw new Error("connection lost");
				return Response.json(page.items[0]);
			}
			return Response.json({ schemaVersion: 1, items: [] });
		}),
	);
	render(<EvaluationDatasets />);
	await screen.findByText("当前没有可见评测集。");
	fireEvent.change(screen.getByLabelText("评测集名称"), {
		target: { value: "Dataset" },
	});
	fireEvent.change(screen.getByLabelText("部署批准的范围"), {
		target: { value: "team" },
	});
	fireEvent.click(screen.getByRole("button", { name: "创建空评测集" }));
	await screen.findByText(/操作未确认/);
	expect(writes).toBe(1);
	expect(
		(screen.getByRole("button", { name: "创建空评测集" }) as HTMLButtonElement)
			.disabled,
	).toBe(true);
	fireEvent.click(screen.getByRole("button", { name: "刷新评测集" }));
	await screen.findByText("当前没有可见评测集。");
	expect(
		(screen.getByRole("button", { name: "创建空评测集" }) as HTMLButtonElement)
			.disabled,
	).toBe(true);
	expect(writes).toBe(1);
	fireEvent.change(screen.getByLabelText("评测集名称"), {
		target: { value: "Different" },
	});
	fireEvent.click(screen.getByRole("button", { name: "重放原操作" }));
	await waitFor(() => expect(writes).toBe(2));
	expect(keys[0]).toBeTruthy();
	expect(keys[1]).toBe(keys[0]);
	expect(bodies[1]).toBe(bodies[0]);
	await waitFor(() =>
		expect(
			(
				screen.getByRole("button", {
					name: "创建空评测集",
				}) as HTMLButtonElement
			).disabled,
		).toBe(false),
	);
});
it("requires confirmation before deleting a version", async () => {
	let deletes = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const r = input instanceof Request ? input : new Request(input);
			if (r.method === "DELETE") {
				deletes++;
				return Response.json(page.items[0]?.versions[0]);
			}
			return Response.json(page);
		}),
	);
	render(<EvaluationDatasets />);
	fireEvent.click(await screen.findByRole("button", { name: "删除内容" }));
	expect(deletes).toBe(0);
	fireEvent.click(await screen.findByRole("button", { name: "确认删除" }));
	await waitFor(() => expect(deletes).toBe(1));
});
