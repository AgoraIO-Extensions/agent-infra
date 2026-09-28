import { describe, expect, it } from "vitest";
import { createDirectoryClient } from "./client.js";
import { createSnapshot } from "./snapshot.js";

const now = Date.UTC(2026, 8, 28);
const token = "r".repeat(32);
const snapshot = createSnapshot({
	startedAt: now,
	rootDepartmentId: 1,
	completedAt: now,
	departments: [{ id: 1, name: "Company", parentId: 0 }],
	members: [
		{
			userId: "u1",
			email: "u1@example.test",
			active: true,
			departmentIds: [1],
		},
	],
});

describe("authenticated directory client", () => {
	it("uses HTTPS without redirects and checks current schema", async () => {
		let authorization: string | undefined;
		const client = createDirectoryClient({
			endpoint: "https://directory.internal/internal/directory/snapshot",
			token,
			fetch: async (_input, init) => {
				authorization =
					new Headers(init?.headers).get("Authorization") ?? undefined;
				expect(init?.redirect).toBe("error");
				return Response.json(snapshot);
			},
		});
		expect((await client.loadCurrent(now)).revision).toBe(snapshot.revision);
		expect(authorization).toBe(`Bearer ${token}`);
	});

	it("rejects insecure endpoint, failed transport and stale data", async () => {
		expect(() =>
			createDirectoryClient({
				endpoint: "http://directory.internal/",
				token,
			}),
		).toThrow();
		expect(() =>
			createDirectoryClient({
				endpoint: "https://directory.internal/",
				token: "short",
			}),
		).toThrow();
		expect(() =>
			createDirectoryClient({
				endpoint: "https://directory.internal/",
				token: "",
			}),
		).toThrow();
		const failed = createDirectoryClient({
			endpoint: "https://directory.internal/internal/directory/snapshot",
			token,
			fetch: async () => Response.json(snapshot, { status: 503 }),
		});
		await expect(failed.loadCurrent(now)).rejects.toThrow();
		const expired = createDirectoryClient({
			endpoint: "https://directory.internal/internal/directory/snapshot",
			token,
			fetch: async () => Response.json(snapshot),
		});
		await expect(expired.loadCurrent(snapshot.validUntil)).rejects.toThrow();
	});
});
