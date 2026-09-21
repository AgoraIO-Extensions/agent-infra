import { describe, expect, it } from "vitest";

import { runtimeRequestSigningPayloadV3 } from "./host-v3.ts";

describe("Runtime V3 request signing payload", () => {
	it("uses the same UTF-16 key order for nested objects and array members", () => {
		const payload = runtimeRequestSigningPayloadV3({
			requestId: "request",
			grant: "excluded-token",
			z: { ä: 1, a: 2, _: 3, Z: 4, A: 5 },
			"😀": [
				{ z: 1, Z: 2 },
				{ Ω: 3, _: 4 },
			],
			ä: true,
			_: "underscore",
			Z: null,
			A: "uppercase",
		});
		expect(payload).toBe(
			'{"A":"uppercase","Z":null,"_":"underscore","requestId":"request","z":{"A":5,"Z":4,"_":3,"a":2,"ä":1},"ä":true,"😀":[{"Z":2,"z":1},{"_":4,"Ω":3}]}',
		);
		expect(
			runtimeRequestSigningPayloadV3({
				A: "uppercase",
				Z: null,
				_: "underscore",
				ä: true,
				"😀": [
					{ Z: 2, z: 1 },
					{ _: 4, Ω: 3 },
				],
				z: { A: 5, Z: 4, _: 3, a: 2, ä: 1 },
				grant: "another-excluded-token",
				requestId: "request",
			}),
		).toBe(payload);
	});

	it("binds the request ID while omitting only the envelope grant", () => {
		const request = {
			requestId: "request",
			grant: "excluded-token",
			input: { grant: "ordinary-nested-field", omitted: undefined },
		};
		const payload = runtimeRequestSigningPayloadV3(request);
		expect(payload).toBe(
			'{"input":{"grant":"ordinary-nested-field"},"requestId":"request"}',
		);
		expect(
			runtimeRequestSigningPayloadV3({ ...request, requestId: "retry" }),
		).not.toBe(payload);
	});
});
