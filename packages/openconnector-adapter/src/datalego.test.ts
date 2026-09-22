import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { DataLegoAdapter, datalegoConnectionCatalog } from "./datalego.ts";
import { datalegoExecutorDigest } from "./datalego-integrity.ts";

function session(accessToken = "personal-access-token") {
	return `x.${Buffer.from(JSON.stringify({ access_token: accessToken, user: { email: "user@agora.io" } })).toString("base64url")}.x`;
}

test("DataLego executor digest pins its reviewed source", () => {
	const digest = createHash("sha256")
		.update(readFileSync(new URL("./datalego.ts", import.meta.url)))
		.digest("hex");
	assert.equal(datalegoExecutorDigest, `sha256:${digest}`);
});

test("DataLego catalog keeps query effects explicit", () => {
	assert.deepEqual(
		datalegoConnectionCatalog.actions.map(({ id, effect }) => [id, effect]),
		[
			["datalego.get_current_user@v1", "READ"],
			["datalego.submit_query@v1", "WRITE"],
			["datalego.get_query_status@v1", "READ"],
			["datalego.cancel_query@v1", "WRITE"],
		],
	);
});

test("DataLego validates the personal HCI session without returning it", async () => {
	let request: { headers: Headers; url: string } | undefined;
	const adapter = new DataLegoAdapter(async (input, init) => {
		request = { headers: new Headers(init?.headers), url: String(input) };
		return Response.json({ email: "user@agora.io", name: "User" });
	});
	const token = session();
	const identity = await adapter.validateCredential(token);
	assert.equal(request?.url, "https://datalego.agoralab.co/api/userInfo");
	assert.equal(request?.headers.get("cookie"), `HCIAuthToken=${token}`);
	assert.equal(identity.externalAccount, "user@agora.io");
	assert.equal(
		JSON.stringify(identity).includes("personal-access-token"),
		false,
	);
});

test("DataLego refreshes an expired access token once and retries", async () => {
	const requests: Array<{ headers: Headers; method: string; url: string }> = [];
	const adapter = new DataLegoAdapter(async (input, init) => {
		const request = {
			headers: new Headers(init?.headers),
			method: init?.method ?? "GET",
			url: String(input),
		};
		requests.push(request);
		if (request.url === "https://grafana.bj2.agoralab.co/") {
			return new Response("", {
				headers: {
					"set-cookie": `HCIAuthToken=${session("refreshed-token")}; Path=/`,
				},
			});
		}
		if (requests.length === 1)
			return Response.json(
				{ message: "Invalid token: access token has expired" },
				{ status: 401 },
			);
		return Response.json({ id: "job-1", status: "success" });
	});
	const result = await adapter.execute({
		action: "datalego.get_query_status",
		credential: { accessToken: session() },
		input: { jobId: "job-1" },
	});
	assert.equal("status" in result && result.status, "success");
	assert.equal(requests.length, 3);
	assert.equal(
		requests[0]?.headers.get("accesstoken"),
		"personal-access-token",
	);
	assert.equal(requests[2]?.headers.get("accesstoken"), "refreshed-token");
});
