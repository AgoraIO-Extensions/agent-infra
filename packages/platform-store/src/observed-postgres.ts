import rawPostgres from "postgres";
import {
	observePostgresClient,
	type StoreQueryObservabilityOptions,
} from "./query-observability.js";

let configured: StoreQueryObservabilityOptions = {};
let poolMaxCap: number | undefined;

/**
 * #4048：每个 Store 有独立连接池。未显式设置 `idle_timeout` 时空闲 30 秒回收连接，
 * 避免多个副本的空闲连接占满数据库；部署仍可用 postgres.js 原生的 PGIDLE_TIMEOUT 覆盖。
 */
export const platformPostgresIdleTimeoutSeconds = 30;

/**
 * #4048：进程级的每池连接上限。API 有约 50 个 Store 池，一个请求经过多个池，两个副本
 * 叠加后会用尽数据库连接；启动时在创建任何 Store 之前调用。`undefined` 表示不设上限。
 */
export function configureStorePoolMax(value: number | undefined): void {
	if (
		value !== undefined &&
		(!Number.isSafeInteger(value) || value < 1 || value > 100)
	)
		throw new RangeError("Store pool max must be an integer from 1 to 100");
	poolMaxCap = value;
}

export function withPlatformPoolDefaults<
	T extends rawPostgres.Options<Record<string, rawPostgres.PostgresType>>,
>(options?: T, environment: NodeJS.ProcessEnv = process.env): T {
	const value = { ...options } as T;
	if (
		value.idle_timeout === undefined &&
		environment.PGIDLE_TIMEOUT === undefined
	)
		value.idle_timeout = platformPostgresIdleTimeoutSeconds;
	// postgres.js 未设置 max 时默认 10。
	if (poolMaxCap !== undefined)
		value.max = Math.min(value.max ?? 10, poolMaxCap);
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
