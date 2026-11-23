import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createSub2ApiAdapter } from "./sub2api.ts";

const configFile = process.argv[2];
if (!configFile)
	throw Error("Supply the mounted Relay Adapter configuration file");
const handle = createSub2ApiAdapter(
	JSON.parse(await readFile(configFile, "utf8")),
);
const server = createServer(async (req, res) => {
	try {
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const chunk of req) {
			size += chunk.length;
			if (size > 4096) {
				res.writeHead(413).end();
				return;
			}
			chunks.push(chunk);
		}
		const method = req.method ?? "GET";
		if (method !== "GET" && method !== "POST") {
			res.writeHead(405).end();
			return;
		}
		const result = await handle(
			new Request(new URL(req.url ?? "/", "http://localhost"), {
				method,
				headers: {
					...(req.headers.authorization
						? { authorization: req.headers.authorization }
						: {}),
				},
				...(method === "POST"
					? { body: Buffer.concat(chunks).toString("utf8") }
					: {}),
			}),
		);
		res
			.writeHead(result.status, Object.fromEntries(result.headers))
			.end(Buffer.from(await result.arrayBuffer()));
	} catch {
		res.writeHead(400).end();
	}
});
server.requestTimeout = 8000;
server.listen(Number(process.env.PORT ?? 8090), "127.0.0.1");
