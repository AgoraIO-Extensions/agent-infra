import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";

interface ClickReceipt {
	runId: string;
	clickCount: number;
	valueSha256: string;
}

/** One process serves one acceptance run. Only the operator receives the click receipt. */
export function createPiBrowserTestSite(
	runId: string,
	record: (receipt: ClickReceipt) => void,
) {
	assert(
		/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(runId),
		"TEST_SITE_RUN_ID_INVALID",
	);
	const pagePath = `/runs/${runId}`;
	let clickCount = 0;
	const value = randomUUID();
	const valueSha256 = createHash("sha256").update(value).digest("hex");
	return createServer((request, response) => {
		response.setHeader("cache-control", "no-store");
		response.setHeader("referrer-policy", "no-referrer");
		if (request.url === pagePath && request.method === "GET") {
			response.setHeader("content-type", "text/html; charset=utf-8");
			response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Pi browser test</title>
<main><button type="button" id="show">Show test value</button><p id="value" role="status">Ready</p></main>
<script>document.getElementById("show").onclick = async function () {
  this.disabled = true;
  const response = await fetch(location.pathname + "/value");
  document.getElementById("value").textContent = response.ok ? await response.text() : "Value unavailable";
};</script></html>`);
			return;
		}
		if (request.url !== pagePath + "/value") {
			response.writeHead(404).end();
			return;
		}
		if (request.method !== "GET") {
			response.writeHead(405, { allow: "GET" }).end();
			return;
		}
		clickCount++;
		record({ runId, clickCount, valueSha256 });
		response
			.writeHead(200, {
				"content-type": "text/plain; charset=utf-8",
			})
			.end(value);
	});
}

if (import.meta.main) {
	const [runId, port = "8080"] = process.argv.slice(2);
	assert(runId, "Pass the UUID of this test run");
	createPiBrowserTestSite(runId, (row) =>
		process.stdout.write(JSON.stringify(row) + "\n"),
	).listen(Number(port));
}
