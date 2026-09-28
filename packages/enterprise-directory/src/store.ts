import postgres from "postgres";
import { type DirectorySnapshot, validateSnapshot } from "./snapshot.js";

export interface DirectoryStore {
	publish(snapshot: DirectorySnapshot): Promise<void>;
	latest(): Promise<unknown | null>;
	close(): Promise<void>;
}

export function createPostgresDirectoryStore(
	databaseUrl: string,
): DirectoryStore {
	const sql = postgres(databaseUrl, { max: 4 });
	return {
		async publish(value) {
			const snapshot = validateSnapshot(value);
			await sql`
				insert into enterprise_directory.snapshots
					(revision, fetched_at, valid_until, contents)
				values (
					${snapshot.revision},
					${new Date(snapshot.fetchedAt)},
					${new Date(snapshot.validUntil)},
					${sql.json(snapshot)}
				)
			`;
		},
		async latest() {
			const rows = await sql`
				select contents from enterprise_directory.snapshots
				order by fetched_at desc, revision desc
				limit 1
			`;
			return rows[0]?.contents ?? null;
		},
		close: () => sql.end(),
	};
}
