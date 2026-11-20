import { expect, it } from "vitest";
import { modelTransportErrorClass } from "./model-transport-diagnostic.js";

it("does not infer a transport class from private messages, stack or arbitrary names", () => {
	let reads = 0;
	expect(
		modelTransportErrorClass({
			get code() {
				return ++reads === 1 ? "ENOTFOUND" : "PRIVATE_CANARY";
			},
		}),
	).toBe("dns");
	expect(reads).toBe(1);

	expect(
		modelTransportErrorClass({
			name: "ECONNREFUSED",
			message: "ENOTFOUND",
			stack: "ETIMEDOUT",
		}),
	).toBe("UNKNOWN");
	const cycle: { cause?: unknown } = {};
	cycle.cause = cycle;
	expect(modelTransportErrorClass(cycle)).toBe("UNKNOWN");
	const hostile = Object.defineProperty({}, "code", {
		get() {
			throw new Error("PRIVATE_ERROR_CANARY");
		},
	});
	expect(modelTransportErrorClass(hostile)).toBe("UNKNOWN");
	expect(modelTransportErrorClass({ code: "__proto__" })).toBe("UNKNOWN");
});
