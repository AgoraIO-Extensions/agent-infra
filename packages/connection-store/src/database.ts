import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema.js";

export type ConnectionDatabase = ReturnType<
	typeof createConnectionDatabase
>["db"];

export interface ConnectionDatabaseHandle {
	db: ReturnType<typeof drizzle<typeof schema>>;
	close: () => Promise<void>;
}

export function createConnectionDatabase(
	databaseUrl: string,
): ConnectionDatabaseHandle {
	const client = postgres(databaseUrl);
	return {
		db: drizzle(client, { schema }),
		close: () => client.end(),
	};
}
