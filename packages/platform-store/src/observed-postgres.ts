import rawPostgres from "postgres";
import {
	observePostgresClient,
	type StoreQueryObservabilityOptions,
} from "./query-observability.js";

let configured: StoreQueryObservabilityOptions = {};

/**
 * #4048：每个 Store 有独立连接池。未显式设置 `idle_timeout` 时空闲 30 秒回收连接，
 * 避免多个副本的空闲连接占满数据库；部署仍可用 postgres.js 原生的 PGIDLE_TIMEOUT 覆盖。
 */
export const platformPostgresIdleTimeoutSeconds = 30;

export function withPlatformPoolDefaults<
	T extends rawPostgres.Options<Record<string, rawPostgres.PostgresType>>,
>(options?: T, environment: NodeJS.ProcessEnv = process.env): T {
	const value = { ...options } as T;
	if (
		value.idle_timeout === undefined &&
		environment.PGIDLE_TIMEOUT === undefined
	)
		value.idle_timeout = platformPostgresIdleTimeoutSeconds;
	return value;
}

export function configureStoreQueryObservability(
	options: StoreQueryObservabilityOptions | undefined,
): void {
	configured = options ?? {};
}

function observedPostgres(
	...args: Parameters<typeof rawPostgres>
): ReturnType<typeof rawPostgres> {
	const [first, second] = args;
	const client =
		typeof first === "string"
			? rawPostgres(first, withPlatformPoolDefaults(second))
			: rawPostgres(withPlatformPoolDefaults(first));
	return observePostgresClient(client, configured);
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
