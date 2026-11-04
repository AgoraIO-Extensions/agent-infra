import { once } from "node:events";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import { createS3ObjectStorageV1 } from "./s3.js";

it("signs an immutable version for a header-free GET and bounds its lifetime", async () => {
	const requests: { method: string; version: string | null }[] = [];
	const version = "opaque/version+id=";
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://localhost");
		requests.push({
			method: request.method ?? "",
			version: url.searchParams.get("versionId"),
		});
		response.writeHead(200, {
			"content-length": "5",
			"content-type": "text/plain",
			etag: '"test-etag"',
			"x-amz-version-id": version,
		});
		response.end(request.method === "HEAD" ? undefined : "hello");
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error();
	const storage = createS3ObjectStorageV1({
		endpoint: `http://127.0.0.1:${address.port}`,
		region: "us-east-1",
		credentials: { accessKeyId: "synthetic", secretAccessKey: "synthetic" },
		bucket: "snapshots",
		prefix: "workspace-snapshots/",
		maxObjectBytes: 1024,
		timeoutMs: 2000,
	});
	try {
		const objectRef = "00000000-0000-4000-8000-000000000001";
		const url = new URL(
			await storage.createReadUrl({
				objectRef,
				version,
				expiresInSeconds: 300,
			}),
		);
		expect(url.pathname).toBe(`/snapshots/workspace-snapshots/${objectRef}`);
		expect(url.searchParams.get("versionId")).toBe(version);
		expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
		expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
		expect(requests).toEqual([
			{ method: "HEAD", version },
			{ method: "GET", version },
		]);
		for (const invalid of [0, 901, 1.5])
			await expect(
				storage.createReadUrl({
					objectRef,
					version,
					expiresInSeconds: invalid,
				}),
			).rejects.toMatchObject({ code: "invalid" });
		await expect(
			storage.createReadUrl({
				objectRef,
				version: "null",
				expiresInSeconds: 300,
			}),
		).rejects.toMatchObject({ code: "invalid" });
		expect(requests).toHaveLength(2);
	} finally {
		storage.close();
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
});
