import { timingSafeEqual } from "node:crypto";
import {
	createDirectorySynchronizer,
	type DirectorySource,
	type DirectoryStore,
	requireCurrentSnapshot,
	toDirectorySnapshotV1,
	toDirectorySnapshotV2,
} from "@agent-infra/enterprise-directory";
import { Hono } from "hono";

export interface DirectoryServiceInput {
	store: DirectoryStore;
	source: DirectorySource;
	sourceId?: string;
	readToken: string;
	rootDepartmentId: number;
	now?: () => number;
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
	const synchronizer = createDirectorySynchronizer(input);
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
	for (const [path, encode] of [
		["/internal/directory/snapshot", toDirectorySnapshotV1],
		["/internal/directory/v2/snapshot", toDirectorySnapshotV2],
	] as const) {
		app.get(path, async (context) => {
			if (!tokenMatches(context.req.header("Authorization"), input.readToken)) {
				return context.json({ error: "unauthorized" }, 401);
			}
			try {
				const snapshot = requireCurrentSnapshot(
					await input.store.latest(),
					now(),
				);
				return context.json(encode(snapshot), 200, {
					"Cache-Control": "no-store",
				});
			} catch {
				return context.json({ error: "directory_unavailable" }, 503, {
					"Cache-Control": "no-store",
				});
			}
		});
	}
	return { app, syncOnce: synchronizer.syncOnce };
}
