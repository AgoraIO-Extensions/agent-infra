import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createInvoiceServer } from "./fixtures/custom-agent-invoice/server.ts";

const invoice = {
	items: [
		{ quantity: 17, unitPrice: 23.5 },
		{ quantity: 9, unitPrice: 12.4 },
	],
	discountPercent: 8,
	taxPercent: 6,
};

async function listen(server) {
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
	await new Promise((resolve) => server.close(resolve));
}

test("invoice reference forwards the business input and persists the model result across restart", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "invoice-reference-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const token = randomBytes(24).toString("hex");
	const modelKey = randomBytes(24).toString("hex");
	const requests = [];
	const model = createServer(async (request, response) => {
		let body = "";
		for await (const part of request) body += part;
		requests.push({
			path: request.url,
			headers: request.headers,
			body: JSON.parse(body),
		});
		response.setHeader("Content-Type", "application/json");
		response.end(
			JSON.stringify({ content: [{ type: "text", text: "TOTAL=498.42" }] }),
		);
	});
	const modelBaseUrl = await listen(model);
	t.after(() => close(model));
	const configuration = {
		appToken: token,
		modelApiKey: modelKey,
		modelBaseUrl,
		modelId: "test-model",
		dataDirectory: directory,
		version: "v1",
	};
	let app = createInvoiceServer(configuration);
	t.after(() => close(app));
	const origin = await listen(app);
	const response = await fetch(`${origin}/api/invoices`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(invoice),
	});
	assert.equal(response.status, 201);
	const saved = await response.json();
	assert.match(saved.id, /^[0-9a-f-]{36}$/);
	assert.equal(saved.result, "TOTAL=498.42");
	assert.equal(saved.version, "v1");
	assert.equal(requests.length, 1);
	assert.equal(requests[0].path, "/v1/messages");
	assert.equal(requests[0].headers["x-api-key"], modelKey);
	assert.equal(requests[0].body.model, "test-model");
	assert.ok(
		requests[0].body.messages[0].content.includes(JSON.stringify(invoice)),
	);
	assert.ok(!requests[0].body.messages[0].content.includes(modelKey));
	await close(app);
	app = createInvoiceServer({ ...configuration, version: "v2" });
	const restarted = await listen(app);
	const read = await fetch(`${restarted}/api/invoices/${saved.id}`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	assert.equal(read.status, 200);
	assert.deepEqual(await read.json(), saved);
	assert.equal(requests.length, 1);
});

test("invoice reference denies unauthenticated and malformed input before contacting the model", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "invoice-denial-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	let modelCalls = 0;
	const model = createServer((_request, response) => {
		modelCalls++;
		response.end("unexpected");
	});
	const modelBaseUrl = await listen(model);
	t.after(() => close(model));
	const token = randomBytes(24).toString("hex");
	const app = createInvoiceServer({
		appToken: token,
		modelApiKey: randomBytes(24).toString("hex"),
		modelBaseUrl,
		modelId: "test-model",
		dataDirectory: directory,
		version: "v1",
	});
	const origin = await listen(app);
	t.after(() => close(app));
	const post = (body, headers = {}) =>
		fetch(`${origin}/api/invoices`, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...headers },
			body,
		});
	for (const [authorization, expected] of [
		[undefined, 401],
		["Bearer wrong-user", 403],
	]) {
		const response = await post(
			JSON.stringify(invoice),
			authorization
				? { Authorization: authorization }
				: { "X-User-Id": "forged" },
		);
		assert.equal(response.status, expected);
		assert.equal(await response.text(), "");
	}
	for (const body of [
		"broken",
		JSON.stringify({ ...invoice, endpoint: modelBaseUrl }),
		JSON.stringify({ ...invoice, items: [{ quantity: 1, unitPrice: -1 }] }),
		JSON.stringify({ ...invoice, taxPercent: 101 }),
	]) {
		const response = await post(body, { Authorization: `Bearer ${token}` });
		assert.equal(response.status, 400);
		assert.equal(await response.text(), "");
	}
	const oversized = await post(" ".repeat(16_385), {
		Authorization: `Bearer ${token}`,
	});
	assert.equal(oversized.status, 413);
	assert.equal(await oversized.text(), "");
	const traversal = await fetch(`${origin}/api/invoices/%2e%2e%2fprivate`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	assert.equal(traversal.status, 404);
	const health = await fetch(`${origin}/healthz`);
	assert.deepEqual(await health.json(), { status: "ready", version: "v1" });
	assert.equal(modelCalls, 0);
});

test("invoice reference bounds model responses and hides provider failures", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "invoice-provider-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const token = randomBytes(24).toString("hex");
	const modelKey = randomBytes(24).toString("hex");
	let mode = "failure";
	let redirectedCalls = 0;
	const redirect = createServer((_request, response) => {
		redirectedCalls++;
		response.end("unexpected");
	});
	const redirectOrigin = await listen(redirect);
	t.after(() => close(redirect));
	const model = createServer((request, response) => {
		request.resume();
		response.setHeader("Content-Type", "application/json");
		if (mode === "failure") {
			response.statusCode = 500;
			response.end(JSON.stringify({ error: modelKey }));
		} else if (mode === "redirect") {
			response.statusCode = 302;
			response.setHeader("Location", redirectOrigin);
			response.end();
		} else if (mode === "stored-envelope")
			response.end(
				JSON.stringify({
					content: [{ type: "text", text: "x".repeat(65490) }],
				}),
			);
		else
			response.end(
				JSON.stringify({
					content: [{ type: "text", text: modelKey.repeat(2000) }],
				}),
			);
	});
	const modelBaseUrl = await listen(model);
	t.after(() => close(model));
	const app = createInvoiceServer({
		appToken: token,
		modelApiKey: modelKey,
		modelBaseUrl,
		modelId: "test-model",
		dataDirectory: directory,
		version: "v1",
	});
	const origin = await listen(app);
	t.after(() => close(app));
	for (mode of ["failure", "redirect", "oversized", "stored-envelope"]) {
		const response = await fetch(`${origin}/api/invoices`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(invoice),
		});
		assert.equal(response.status, 502);
		assert.deepEqual(await response.json(), { code: "INVOICE_UNAVAILABLE" });
	}
	assert.equal(redirectedCalls, 0);
});
