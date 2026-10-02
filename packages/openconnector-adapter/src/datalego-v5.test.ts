import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { datalegoV4ConnectionCatalog } from "./datalego-v4.ts";
import {
	DataLegoV5Adapter,
	datalegoV5ConnectionCatalog,
} from "./datalego-v5.ts";
import { datalegoV5ExecutorDigest } from "./datalego-v5-integrity.ts";

const config = {
	clientId: "test-client",
	clientSecret: "test-secret",
	redirectUri: "https://connection.example/oauth/callback?provider=datalego",
};
const credential = { accessToken: "test-token" };

test("DataLego cancellation is a new immutable release with unchanged authorization", () => {
	assert.equal(
		datalegoV5ExecutorDigest,
		`sha256:${createHash("sha256")
			.update(readFileSync(new URL("./datalego-v5.ts", import.meta.url)))
			.digest("hex")}`,
	);
	assert.equal(
		datalegoV5ConnectionCatalog.providerReleaseId,
		"datalego-connection-v5",
	);
	assert.deepEqual(
		datalegoV5ConnectionCatalog.actions.map(({ id, ...action }) => action),
		datalegoV4ConnectionCatalog.actions.map(({ id, ...action }) => action),
	);
});

test("finished jobs explicitly report no cancellation and never send PUT", async () => {
	for (const status of ["success", "error", "cancel", "forbid"]) {
		const requests: string[] = [];
		const adapter = new DataLegoV5Adapter(async (url, init) => {
			requests.push(String(url));
			assert.equal(init?.method, "GET");
			return Response.json({ status, data: [["business-result"]] });
		}, config);
		assert.deepEqual(
			await adapter.execute({
				action: "datalego.cancel_query",
				credential,
				input: { jobId: "job-1" },
			}),
			{
				jobId: "job-1",
				status,
				cancellation: { applied: false, reason: "already_finished" },
			},
		);
		assert.deepEqual(requests, [
			"https://datalego.agoralab.co/api/v1/datainsight/jobs/job-1/status",
		]);
	}
});

test("live jobs send cancellation once; unknown states never submit", async () => {
	for (const status of [
		"pending",
		"waiting",
		"running",
		"unknown",
		undefined,
	]) {
		const methods: string[] = [];
		const adapter = new DataLegoV5Adapter(async (_url, init) => {
			methods.push(String(init?.method));
			return Response.json(
				init?.method === "GET" ? { status } : { status: "cancel" },
			);
		}, config);
		const result = adapter.execute({
			action: "datalego.cancel_query",
			credential,
			input: { jobId: "job-1" },
		});
		if (status === "unknown" || status === undefined) {
			await assert.rejects(result, {
				providerCode: "cancel_not_submitted",
				providerSubmissionOutcome: "rejected",
			});
			assert.deepEqual(methods, ["GET"]);
		} else {
			assert.deepEqual(await result, { status: "cancel" });
			assert.deepEqual(methods, ["GET", "PUT"]);
		}
	}
});

test("cancellation errors preserve status without claiming HTTP 400 proves no effect", async () => {
	for (const status of [400, 429, 500]) {
		let writes = 0;
		const adapter = new DataLegoV5Adapter(async (_url, init) => {
			if (init?.method === "GET") return Response.json({ status: "running" });
			writes++;
			return Response.json({ message: "private-upstream-content" }, { status });
		}, config);
		await assert.rejects(
			adapter.execute({
				action: "datalego.cancel_query",
				credential,
				input: { jobId: "job-1" },
			}),
			(error: Error) => {
				assert.equal(
					(error as Error & { providerStatus: number }).providerStatus,
					status,
				);
				assert.equal(
					(error as Error & { submissionUncertain: boolean })
						.submissionUncertain,
					true,
				);
				assert.equal(error.message.includes("private-upstream-content"), false);
				return true;
			},
		);
		assert.equal(writes, 1);
	}
});

test("lost cancellation response and malformed preflight never replay writes", async () => {
	for (const malformed of [true, false]) {
		let writes = 0;
		const adapter = new DataLegoV5Adapter(async (_url, init) => {
			if (init?.method === "GET")
				return malformed
					? new Response("not-json")
					: Response.json({ status: "running" });
			writes++;
			throw new DOMException("Timed out", "TimeoutError");
		}, config);
		await assert.rejects(
			adapter.execute({
				action: "datalego.cancel_query",
				credential,
				input: { jobId: "job-1" },
			}),
		);
		assert.equal(writes, malformed ? 0 : 1);
	}
});

test("successful empty cancellation response reports requested, not confirmed canceled", async () => {
	for (const status of [200, 204]) {
		const adapter = new DataLegoV5Adapter(
			async (_url, init) =>
				init?.method === "GET"
					? Response.json({ status: "running" })
					: new Response(null, { status }),
			config,
		);
		assert.deepEqual(
			await adapter.execute({
				action: "datalego.cancel_query",
				credential,
				input: { jobId: "job-1" },
			}),
			{ cancellation: { requested: true } },
		);
	}
});
