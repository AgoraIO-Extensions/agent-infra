import rawPostgres from "postgres";
import {
	observePostgresClient,
	type StoreQueryObservabilityOptions,
} from "./query-observability.js";

let configured: StoreQueryObservabilityOptions = {};

export function configureStoreQueryObservability(
	options: StoreQueryObservabilityOptions | undefined,
): void {
	configured = options ?? {};
}

function observedPostgres(
	...args: Parameters<typeof rawPostgres>
): ReturnType<typeof rawPostgres> {
	return observePostgresClient(rawPostgres(...args), configured);
}

namespace observedPostgres {
	// biome-ignore lint/complexity/noBannedTypes: mirror the upstream postgres generic default
	export type Sql<T extends Record<string, unknown> = {}> = rawPostgres.Sql<T>;
	// biome-ignore lint/complexity/noBannedTypes: mirror the upstream postgres generic default
	export type TransactionSql<T extends Record<string, unknown> = {}> =
		rawPostgres.TransactionSql<T>;
	// biome-ignore lint/complexity/noBannedTypes: mirror the upstream postgres generic default
	export type ReservedSql<T extends Record<string, unknown> = {}> =
		rawPostgres.ReservedSql<T>;
	// biome-ignore lint/suspicious/noExplicitAny: mirror upstream postgres tuple generic
	export type PendingQuery<T extends readonly any[] = readonly any[]> =
		rawPostgres.PendingQuery<T>;
	// biome-ignore lint/suspicious/noExplicitAny: mirror upstream postgres tuple generic
	export type RowList<T extends readonly any[] = readonly any[]> =
		rawPostgres.RowList<T>;
	export type JSONValue = rawPostgres.JSONValue;
	// biome-ignore lint/complexity/noBannedTypes: mirror the upstream postgres generic default
	export type ISql<T extends Record<string, unknown> = {}> =
		rawPostgres.ISql<T>;
	export const PostgresError = rawPostgres.PostgresError;
}

Object.assign(observedPostgres, rawPostgres);

export default observedPostgres;
