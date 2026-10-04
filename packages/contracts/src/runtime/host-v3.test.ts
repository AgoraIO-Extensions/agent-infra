import { describe, expect, it } from "vitest";

import {
	RuntimeOriginalBindingResponseV3Schema,
	runtimeRequestSigningPayloadV3,
} from "./host-v3.ts";

describe("Runtime V3 original binding response", () => {
	const response = {
		schemaVersion: 3,
		executionId: "execution-1",
		outcome: "binding_found",
		hostSessionRef: "host-1",
	};
	it("accepts only the original binding receipt without a status projection", () => {
		expect(RuntimeOriginalBindingResponseV3Schema.parse(response)).toEqual(
			response,
		);
	});
	it.each([
		{ status: "running" },
		{ extra: true },
		{ schemaVersion: 4 },
		{ executionId: "" },
		{ hostSessionRef: null },
		{ hostSessionRef: "" },
		{ outcome: "not_found" },
	])("rejects invalid response fields %j", (fields) => {
		expect(
			RuntimeOriginalBindingResponseV3Schema.safeParse({
				...response,
				...fields,
			}).success,
		).toBe(false);
	});
});

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
