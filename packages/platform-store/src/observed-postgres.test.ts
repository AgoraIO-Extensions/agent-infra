import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import observedPostgres, {
	platformPostgresIdleTimeoutSeconds,
	withPlatformPoolDefaults,
} from "./observed-postgres.js";

// #4048：每个 Store 有独立连接池；空闲连接必须按时回收，否则多个副本会占满数据库连接。
describe("Platform Store pool defaults", () => {
	// Creating a client does not connect; no database is needed.
	const url = "postgres://store:unused@127.0.0.1:1/platform";

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("closes idle connections after 30 seconds unless a pool sets its own timeout", async () => {
		const pool = observedPostgres(url, { max: 1 });
		const explicit = observedPostgres(url, { max: 1, idle_timeout: 5 });
		try {
			expect(pool.options.idle_timeout).toBe(
				platformPostgresIdleTimeoutSeconds,
			);
			expect(pool.options.max).toBe(1);
			expect(explicit.options.idle_timeout).toBe(5);
		} finally {
			await Promise.all([pool.end(), explicit.end()]);
		}
	});

	it("leaves the deployment's PGIDLE_TIMEOUT to postgres.js", async () => {
		vi.stubEnv("PGIDLE_TIMEOUT", "7");
		const pool = observedPostgres(url, { max: 1 });
		try {
			expect(pool.options.idle_timeout).toBe(7);
		} finally {
			await pool.end();
		}
		expect(withPlatformPoolDefaults({ max: 2 }, {})).toEqual({
			max: 2,
			idle_timeout: platformPostgresIdleTimeoutSeconds,
		});
	});

	it("applies the default to Store clients created from raw postgres", () => {
		const directory = fileURLToPath(new URL(".", import.meta.url));
		const offenders = readdirSync(directory)
			.filter(
				(name) =>
					name.endsWith(".ts") &&
					!name.includes(".test.") &&
					!name.includes("test-support") &&
					name !== "observed-postgres.ts" &&
					name !== "postgres-test.ts",
			)
			.filter((name) => {
				const source = readFileSync(`${directory}${name}`, "utf8");
				if (
					!/^import (?:postgres|\{ default as postgres \}) from "postgres";$/m.test(
						source,
					)
				)
					return false;
				const clients = source.match(/\bpostgres\(/g)?.length ?? 0;
				const defaulted =
					source.match(/withPlatformPoolDefaults\(/g)?.length ?? 0;
				return clients > defaulted;
			});
		expect(offenders).toEqual([]);
	});
});
