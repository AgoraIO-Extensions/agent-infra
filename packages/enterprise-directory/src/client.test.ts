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

	describe("concurrent loads (#2740)", () => {
		const endpoint = "https://directory.internal/internal/directory/snapshot";

		function deferredFetch() {
			const calls: Array<(response: Response) => void> = [];
			const fetcher = async () =>
				new Promise<Response>((resolve) => {
					calls.push(resolve);
				});
			return { calls, fetch: fetcher as unknown as typeof fetch };
		}

		it("shares one snapshot request among concurrent callers", async () => {
			const remote = deferredFetch();
			const client = createDirectoryClient({
				endpoint,
				token,
				fetch: remote.fetch,
			});
			// 重启期间同一时刻有几十个身份解析；之前每个都各发一次请求，各自新建连接、各做一次 DNS 解析。
			const loads = Array.from({ length: 20 }, () => client.loadCurrent(now));
			await Promise.resolve();
			expect(remote.calls).toHaveLength(1);
			remote.calls[0]?.(Response.json(snapshot));
			const results = await Promise.all(loads);
			expect(results.map((result) => result.revision)).toEqual(
				Array(20).fill(snapshot.revision),
			);
			// 调用方之间不共享可变对象。
			expect(results[0]).not.toBe(results[1]);
		});

		it("still checks validity with each caller's own time", async () => {
			const remote = deferredFetch();
			const client = createDirectoryClient({
				endpoint,
				token,
				fetch: remote.fetch,
			});
			const current = client.loadCurrent(now);
			const expired = client.loadCurrent(snapshot.validUntil);
			expect(remote.calls).toHaveLength(1);
			remote.calls[0]?.(Response.json(snapshot));
			await expect(current).resolves.toMatchObject({
				revision: snapshot.revision,
			});
			await expect(expired).rejects.toThrow();
		});

		it("fails every joined caller and starts a fresh request afterwards", async () => {
			const remote = deferredFetch();
			const client = createDirectoryClient({
				endpoint,
				token,
				fetch: remote.fetch,
			});
			const first = client.loadCurrent(now);
			const second = client.loadCurrent(now);
			remote.calls[0]?.(Response.json(snapshot, { status: 503 }));
			await expect(first).rejects.toThrow();
			await expect(second).rejects.toThrow();
			// 失败不被缓存：之后的调用重新请求。
			const later = client.loadCurrent(now);
			await Promise.resolve();
			expect(remote.calls).toHaveLength(2);
			remote.calls[1]?.(Response.json(snapshot));
			await expect(later).resolves.toMatchObject({
				revision: snapshot.revision,
			});
		});

		it("never reuses a completed request for a later call", async () => {
			let requests = 0;
			const client = createDirectoryClient({
				endpoint,
				token,
				fetch: async () => {
					requests++;
					return Response.json(snapshot);
				},
			});
			await client.loadCurrent(now);
			await client.loadCurrent(now);
			expect(requests).toBe(2);
		});
	});
});
