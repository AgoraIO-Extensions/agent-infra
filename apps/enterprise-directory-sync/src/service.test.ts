import type {
	createWeComSource,
	DirectorySnapshot,
	DirectoryStore,
} from "@agent-infra/enterprise-directory";
import { describe, expect, it } from "vitest";
import { createDirectoryService } from "./service.js";

const now = Date.UTC(2026, 8, 28);
const readToken = "r".repeat(32);

function fixture() {
	let published: DirectorySnapshot | null = null;
	let fail = false;
	let clock = now;
	let scanDelay = 0;
	const store: DirectoryStore = {
		async publish(snapshot) {
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
		const response = await service.app.request("/internal/directory/snapshot", {
			headers: { Authorization: `Bearer ${readToken}` },
		});
		expect(response.status).toBe(200);
		expect(((await response.json()) as { complete: boolean }).complete).toBe(
			true,
		);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
	});

	it("bounds validity by scan start and does not publish a day-long scan", async () => {
		const state = fixture();
		state.setScanDelay(60 * 60_000);
		await state.service.syncOnce();
		expect(state.current()?.fetchedAt).toBe(now + 60 * 60_000);
		expect(state.current()?.validUntil).toBe(now + 24 * 60 * 60_000);
		const previousRevision = state.current()?.revision;
		state.setScanDelay(24 * 60 * 60_000);
		await expect(state.service.syncOnce()).rejects.toThrow();
		expect(state.current()?.revision).toBe(previousRevision);
	});

	it("failed sync retains old revision, and expired old revision is refused", async () => {
		const { service, setFail, current } = fixture();
		await service.syncOnce();
		const first = current()?.revision;
		setFail(true);
		await expect(service.syncOnce()).rejects.toThrow();
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
