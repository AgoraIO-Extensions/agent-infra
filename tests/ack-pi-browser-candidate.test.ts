import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { piBrowserCandidateManifest } from "../deploy/ack/pi-browser-candidate.ts";
import { createPiBrowserTestSite } from "./local-real-e2e/pi-browser-test-site.ts";

const source = "a".repeat(40);
const manifestLabel = "io.agora.agent.runtime.manifest";
const manifest = {
	schemaVersion: 1,
	interactionMode: "platform-adapter",
	protocol: "acp",
	service: { port: 3003 },
	health: { path: "/healthz" },
	capabilities: {
		modelSelection: true,
		attachments: true,
		resultFiles: true,
		connection: false,
		supplementaryInstruction: false,
	},
};
const labels = {
	"org.opencontainers.image.revision": source,
	"io.agora.agent.standard-template": "pi",
	[manifestLabel]: JSON.stringify(manifest),
};

test("Pi candidate extends the pinned image's manifest with just one controlled test origin", () => {
	const origin = "https://fixture.example.test/";
	const candidate = piBrowserCandidateManifest(labels, source, origin);
	const { browser, ...capabilities } = candidate.capabilities;
	assert.deepEqual({ ...candidate, capabilities }, manifest);
	assert.deepEqual(browser.operations, ["navigate", "observe", "interact"]);
	assert.deepEqual(browser.policy.allowedOrigins, [origin]);
	assert.deepEqual(
		piBrowserCandidateManifest(
			labels,
			source,
			"http://fixture.example.test:8080",
		).capabilities.browser.policy.allowedOrigins,
		["http://fixture.example.test:8080/"],
	);
	assert.equal(browser.policy.maxDownloads, 0);
	assert.equal(browser.policy.allowUserHandoff, false);
	assert.throws(() =>
		piBrowserCandidateManifest(labels, "b".repeat(40), origin),
	);
	assert.throws(() =>
		piBrowserCandidateManifest(
			{ ...labels, "io.agora.agent.standard-template": "codex" },
			source,
			origin,
		),
	);
	assert.throws(() =>
		piBrowserCandidateManifest(labels, source, origin + "some-path"),
	);
});

test("the test site issues a value once and independently records its hash and any repeat clicks", async () => {
	const runId = randomUUID();
	const records: { runId: string; clickCount: number; valueSha256: string }[] =
		[];
	const site = createPiBrowserTestSite(runId, (record) => records.push(record));
	site.listen(0, "127.0.0.1");
	await once(site, "listening");
	try {
		const address = site.address();
		assert.ok(address && typeof address !== "string");
		const base = `http://127.0.0.1:${address.port}/runs/${runId}`;
		const page = await fetch(base);
		assert.match(await page.text(), /button type="button"/);
		assert.equal(records.length, 0);
		assert.equal(
			(await fetch(base + "/value", { method: "POST" })).status,
			405,
		);
		const first = await fetch(base + "/value");
		assert.equal(first.status, 200);
		const value = await first.text();
		assert.match(value, /^[0-9a-f-]{36}$/);
		const valueSha256 = createHash("sha256").update(value).digest("hex");
		assert.deepEqual(records[0], { runId, clickCount: 1, valueSha256 });
		const reread = await fetch(base + "/value");
		assert.equal(reread.status, 200);
		assert.equal(await reread.text(), value);
		assert.deepEqual(records[1], { runId, clickCount: 2, valueSha256 });
		assert.equal((await fetch(base.replace(runId, randomUUID()))).status, 404);
	} finally {
		site.close();
		await once(site, "close");
	}
});
