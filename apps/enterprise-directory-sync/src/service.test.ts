import type {
	createWeComSource,
	DirectorySnapshot,
	DirectoryStore,
} from "@agent-infra/enterprise-directory";
import { createDirectoryClient } from "@agent-infra/enterprise-directory";
import { describe, expect, it } from "vitest";
import { createDirectoryService } from "./service.js";

const now = Date.UTC(2026, 8, 28);
const readToken = "r".repeat(32);

function fixture() {
	let published: DirectorySnapshot | null = null;
	let fail = false;
	let storeFail = false;
	let clock = now;
	let scanDelay = 0;
	const store: DirectoryStore = {
		async publish(snapshot) {
			if (storeFail) throw new Error("private database detail");
			published = snapshot;
		},
		async latest() {
			return published;
		},
		async close() {},
	};
	const source = {
		async fetchComplete() {
			if (fail) throw new Error("incomplete");
			clock += scanDelay;
			return {
				departments: [{ id: 1, name: "Company", parentId: 0 }],
				members: [
					{
						userId: "u1",
						email: "u1@example.test",
						active: true,
						departmentIds: [1],
					},
				],
			};
		},
	} as ReturnType<typeof createWeComSource>;
	const service = createDirectoryService({
		store,
		source,
		readToken,
		rootDepartmentId: 1,
		now: () => clock,
	});
	return {
		service,
		setFail(value: boolean) {
			fail = value;
		},
		setStoreFail(value: boolean) {
			storeFail = value;
		},
		setScanDelay(value: number) {
			scanDelay = value;
		},
		current() {
			return published;
		},
	};
}

describe("directory service", () => {
	it("publishes complete snapshot and protects internal reads", async () => {
		const { service } = fixture();
		expect(
			(await service.app.request("/internal/directory/snapshot")).status,
		).toBe(401);
		expect((await service.app.request("/readyz")).status).toBe(503);
		expect(
			(
				await service.app.request("/internal/directory/snapshot", {
					headers: { Authorization: "Bearer wrong" },
				})
			).status,
		).toBe(401);
		await service.syncOnce();
		expect((await service.app.request("/readyz")).status).toBe(200);
		expect(await (await service.app.request("/readyz")).json()).toEqual({
			status: "ready",
			fetchedAt: now,
			validUntil: now + 24 * 60 * 60_000,
		});
		const response = await service.app.request("/internal/directory/snapshot", {
			headers: { Authorization: `Bearer ${readToken}` },
		});
		expect(response.status).toBe(200);
		expect(((await response.json()) as { complete: boolean }).complete).toBe(
			true,
		);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
	});

	it("round trips the published wire response through the real client", async () => {
		const { service } = fixture();
		const fetchService: typeof fetch = async (input, init) =>
			service.app.request(String(input), init);
		const client = createDirectoryClient({
			endpoint: "https://directory.example.test/internal/directory/snapshot",
			token: readToken,
			fetch: fetchService,
		});
		await expect(client.loadCurrent(now)).rejects.toThrow();
		await service.syncOnce();
		const snapshot = await client.loadCurrent(now);
		expect(snapshot.complete).toBe(true);
		expect(snapshot.members[0]?.userId).toBe("u1");
		await expect(client.loadCurrent(snapshot.validUntil)).rejects.toThrow();
		const unauthorized = createDirectoryClient({
			endpoint: "https://directory.example.test/internal/directory/snapshot",
			token: "w".repeat(32),
			fetch: fetchService,
		});
		await expect(unauthorized.loadCurrent(now)).rejects.toThrow();
	});

	it("bounds validity by scan start and does not publish a day-long scan", async () => {
		const state = fixture();
		state.setScanDelay(60 * 60_000);
		await state.service.syncOnce();
		expect(state.current()?.fetchedAt).toBe(now + 60 * 60_000);
		expect(state.current()?.validUntil).toBe(now + 24 * 60 * 60_000);
		const previousRevision = state.current()?.revision;
		state.setScanDelay(24 * 60 * 60_000);
		await expect(state.service.syncOnce()).rejects.toMatchObject({
			reason: "invalid_snapshot",
		});
		expect(state.current()?.revision).toBe(previousRevision);
	});

	it("failed sync retains old revision, and expired old revision is refused", async () => {
		const { service, setFail, setStoreFail, current } = fixture();
		await service.syncOnce();
		const first = current()?.revision;
		setFail(true);
		await expect(service.syncOnce()).rejects.toMatchObject({
			reason: "source_unavailable",
		});
		setFail(false);
		setStoreFail(true);
		await expect(service.syncOnce()).rejects.toMatchObject({
			reason: "store_unavailable",
		});
		setStoreFail(false);
		expect(current()?.revision).toBe(first);
		const expired = createDirectoryService({
			store: {
				publish: async () => {},
				latest: async () => current(),
				close: async () => {},
			},
			source: {
				fetchComplete: async () => {
					throw new Error();
				},
			} as ReturnType<typeof createWeComSource>,
			readToken,
			rootDepartmentId: 1,
			now: () => now + 24 * 60 * 60_000,
		});
		expect(
			(
				await expired.app.request("/internal/directory/snapshot", {
					headers: { Authorization: `Bearer ${readToken}` },
				})
			).status,
		).toBe(503);
	});
});
