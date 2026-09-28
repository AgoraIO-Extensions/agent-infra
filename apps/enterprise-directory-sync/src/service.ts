import { timingSafeEqual } from "node:crypto";
import {
	createSnapshot,
	type createWeComSource,
	type DirectorySnapshot,
	type DirectoryStore,
	requireCurrentSnapshot,
	toDirectorySnapshotV1,
} from "@agent-infra/enterprise-directory";
import { Hono } from "hono";

export interface DirectoryServiceInput {
	store: DirectoryStore;
	source: ReturnType<typeof createWeComSource>;
	readToken: string;
	rootDepartmentId: number;
	now?: () => number;
}

export class DirectorySyncError extends Error {
	constructor(
		readonly reason:
			| "source_unavailable"
			| "invalid_snapshot"
			| "store_unavailable",
	) {
		super("Enterprise directory sync failed");
	}
}

function tokenMatches(provided: string | undefined, expected: string) {
	if (!provided?.startsWith("Bearer ") || !expected) return false;
	const actual = Buffer.from(provided.slice(7));
	const reference = Buffer.from(expected);
	return (
		actual.length === reference.length && timingSafeEqual(actual, reference)
	);
}

export function createDirectoryService(input: DirectoryServiceInput) {
	if (Buffer.byteLength(input.readToken) < 32) {
		throw new Error("Directory read credential is invalid");
	}
	const now = input.now ?? Date.now;
	const app = new Hono();
	app.get("/healthz", (context) => context.json({ status: "ready" }));
	app.get("/readyz", async (context) => {
		try {
			const snapshot = requireCurrentSnapshot(
				await input.store.latest(),
				now(),
			);
			return context.json({
				status: "ready",
				fetchedAt: snapshot.fetchedAt,
				validUntil: snapshot.validUntil,
			});
		} catch {
			return context.json({ status: "unavailable" }, 503);
		}
	});
	app.get("/internal/directory/snapshot", async (context) => {
		if (!tokenMatches(context.req.header("Authorization"), input.readToken)) {
			return context.json({ error: "unauthorized" }, 401);
		}
		try {
			const snapshot = requireCurrentSnapshot(
				await input.store.latest(),
				now(),
			);
			return context.json(toDirectorySnapshotV1(snapshot), 200, {
				"Cache-Control": "no-store",
			});
		} catch {
			return context.json({ error: "directory_unavailable" }, 503, {
				"Cache-Control": "no-store",
			});
		}
	});
	return {
		app,
		async syncOnce() {
			const startedAt = now();
			let complete: Awaited<ReturnType<typeof input.source.fetchComplete>>;
			try {
				complete = await input.source.fetchComplete();
			} catch {
				throw new DirectorySyncError("source_unavailable");
			}
			let snapshot: DirectorySnapshot;
			try {
				snapshot = createSnapshot({
					...complete,
					rootDepartmentId: input.rootDepartmentId,
					startedAt,
					completedAt: now(),
				});
			} catch {
				throw new DirectorySyncError("invalid_snapshot");
			}
			try {
				await input.store.publish(snapshot);
			} catch {
				throw new DirectorySyncError("store_unavailable");
			}
			return {
				revision: snapshot.revision,
				fetchedAt: snapshot.fetchedAt,
				validUntil: snapshot.validUntil,
			};
		},
	};
}
