import { describe, expect, it } from "vitest";

import { isPostgresError } from "./postgres-error.ts";

const hostileErrors: readonly [string, () => unknown][] = [
	[
		"code accessor",
		() =>
			Object.defineProperty(new Error("sensitive code accessor"), "code", {
				get() {
					throw new Error("sensitive code getter");
				},
			}),
	],
	[
		"cause accessor",
		() =>
			Object.defineProperty(new Error("sensitive cause accessor"), "cause", {
				get() {
					throw new Error("sensitive cause getter");
				},
			}),
	],
	[
		"has trap",
		() =>
			new Proxy(new Error("sensitive has trap"), {
				has() {
					throw new Error("sensitive has failure");
				},
			}),
	],
	[
		"code get trap",
		() =>
			new Proxy(
				Object.assign(new Error("sensitive code trap"), { code: "XX000" }),
				{
					get(target, property, receiver) {
						if (property === "code") throw new Error("sensitive code get");
						return Reflect.get(target, property, receiver);
					},
				},
			),
	],
	[
		"cause get trap",
		() =>
			new Proxy(
				Object.assign(new Error("sensitive cause trap"), { cause: undefined }),
				{
					get(target, property, receiver) {
						if (property === "cause") throw new Error("sensitive cause get");
						return Reflect.get(target, property, receiver);
					},
				},
			),
	],
	[
		"ownKeys trap",
		() =>
			new Proxy(new Error("sensitive ownKeys trap"), {
				ownKeys() {
					throw new Error("sensitive ownKeys failure");
				},
			}),
	],
	[
		"descriptor trap",
		() =>
			new Proxy(new Error("sensitive descriptor trap"), {
				getOwnPropertyDescriptor() {
					throw new Error("sensitive descriptor failure");
				},
			}),
	],
	[
		"getPrototypeOf trap",
		() =>
			new Proxy(new Error("sensitive prototype trap"), {
				getPrototypeOf() {
					throw new Error("sensitive prototype failure");
				},
			}),
	],
];

describe("PostgreSQL error classification", () => {
	it.each(hostileErrors)("returns false for a throwing %s", (_name, create) => {
		let result: boolean | undefined;
		expect(() => {
			result = isPostgresError(create(), "23505");
		}).not.toThrow();
		expect(result).toBe(false);
	});

	it("recognizes a bounded own-data cause chain", () => {
		expect(
			isPostgresError({ cause: { cause: { code: "23505" } } }, "23505"),
		).toBe(true);
	});
});
