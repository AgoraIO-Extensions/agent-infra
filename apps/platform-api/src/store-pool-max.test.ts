import { describe, expect, it } from "vitest";
import { platformApiStorePoolMaxV1 } from "./index.js";

// #4048：API 进程每个 Store 连接池的上限默认为 2，部署可覆盖，非法值拒绝启动。
describe("platformApiStorePoolMaxV1", () => {
	it("defaults to two and accepts a deployment override", () => {
		expect(platformApiStorePoolMaxV1({})).toBe(2);
		expect(
			platformApiStorePoolMaxV1({ PLATFORM_API_STORE_POOL_MAX: "4" }),
		).toBe(4);
		expect(
			platformApiStorePoolMaxV1({ PLATFORM_API_STORE_POOL_MAX: "10" }),
		).toBe(10);
	});

	it.each(["0", "11", "1.5", "two", "", " 2"])(
		"rejects PLATFORM_API_STORE_POOL_MAX=%j",
		(value) => {
			expect(() =>
				platformApiStorePoolMaxV1({ PLATFORM_API_STORE_POOL_MAX: value }),
			).toThrow("PLATFORM_API_STORE_POOL_MAX must be an integer from 1 to 10");
		},
	);
});
