import { randomUUID } from "node:crypto";
import { link, readFile, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

export async function initializeWorkloadMarker(path) {
	try {
		if ((await readFile(path, "utf8")) !== "retained") {
			throw new Error("Invalid workload fixture marker");
		}
		return;
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, "retained", { flag: "wx", flush: true });
		await link(temporary, path).catch((error) => {
			if (error.code !== "EEXIST") throw error;
		});
	} finally {
		await unlink(temporary).catch((error) => {
			if (error.code !== "ENOENT") throw error;
		});
	}
	if ((await readFile(path, "utf8")) !== "retained") {
		throw new Error("Invalid workload fixture marker");
	}
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	await initializeWorkloadMarker("/workspace/marker");
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
}
