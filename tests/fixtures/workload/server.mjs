import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";

await writeFile("/workspace/marker", "retained", { flag: "wx" }).catch(
	(error) => {
		if (error.code !== "EEXIST") throw error;
	},
);
createServer(async (request, response) => {
	// biome-ignore lint/suspicious/noUndeclaredEnvVars: The Kind harness injects this container-only value.
	const version = process.env.VERSION;
	const secretPresent =
		// biome-ignore lint/suspicious/noUndeclaredEnvVars: The Kind harness injects this container-only value.
		process.env.FIXTURE_VALUE === "synthetic-workload-proof";
	response.statusCode = request.url === "/invalid-health" ? 503 : 200;
	response.end(
		JSON.stringify({
			version,
			marker: await readFile("/workspace/marker", "utf8"),
			secretPresent,
		}),
	);
}).listen(8080, "0.0.0.0");
