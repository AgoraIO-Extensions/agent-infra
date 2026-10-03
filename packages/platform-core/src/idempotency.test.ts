import { describe, expect, it, vi } from "vitest";
import { FakePlatformIdempotencyDatabaseV1 } from "./fake-idempotency.ts";
import { platformIdempotencyPortV1Conformance } from "./idempotency.conformance.ts";
import { platformIdempotencyV1 } from "./idempotency.ts";

function forwardingProxy<T extends object>(value: T, onTrap: () => void): T {
	return new Proxy(value, {
		getPrototypeOf(target) {
			onTrap();
			return Reflect.getPrototypeOf(target);
		},
		ownKeys(target) {
			onTrap();
			return Reflect.ownKeys(target);
		},
		getOwnPropertyDescriptor(target, key) {
			onTrap();
			return Reflect.getOwnPropertyDescriptor(target, key);
		},
	});
}

describe("Platform idempotency domain", () => {
	it("creates a bounded canonical request digest independent of object key order", () => {
		const first = platformIdempotencyV1.canonicalRequestDigest({
			model: { name: "gpt", reasoning: "medium" },
			revision: 2,
		});
		const equivalent = platformIdempotencyV1.canonicalRequestDigest({
			revision: 2,
			model: { reasoning: "medium", name: "gpt" },
		});

		expect(first).toBe(
			"cb98ab4afba53affc423e04e8e664ceff90ade16df64aa997d5d38d3f1b5771d",
		);
		expect(equivalent).toBe(first);
		expect(() =>
			platformIdempotencyV1.canonicalRequestDigest({
				value: "x".repeat(64 * 1024),
			}),
		).toThrow(
			expect.objectContaining({
				name: "PlatformIdempotencyError",
				code: "invalid_input",
			}),
		);
		expect(() =>
			platformIdempotencyV1.canonicalRequestDigest({
				values: Array.from({ length: 8_192 }, () => "12345678"),
			}),
		).toThrow(expect.objectContaining({ code: "invalid_input" }));
		let objectTrapCalls = 0;
		const proxiedObject = forwardingProxy({ value: 1 }, () => {
			objectTrapCalls += 1;
		});
		expect(() =>
			platformIdempotencyV1.canonicalRequestDigest({ nested: proxiedObject }),
		).toThrow(expect.objectContaining({ code: "invalid_input" }));
		expect(objectTrapCalls).toBe(0);
	});

	it("accepts only the current Platform operation, resources, and result shape", () => {
		const scope = {
			schemaVersion: 1 as const,
			operation: "platform.agent-application.submit.v1" as const,
			resourceType: "agent_application" as const,
			resourceId: "application_01",
			actorId: "user_01",
		};
		const result = {
			schemaVersion: 1 as const,
			outcome: "accepted" as const,
			references: [
				{
					resourceType: "agent_application" as const,
					resourceId: "application_01",
					revision: null,
				},
				{
					resourceType: "agent" as const,
					resourceId: "agent_01",
					revision: 1,
				},
			],
		};

		expect(platformIdempotencyV1.parseScope(scope)).toEqual(scope);
		expect(platformIdempotencyV1.parseResult(result)).toEqual(result);
		let scopeTrapCalls = 0;
		const proxiedScope = forwardingProxy(scope, () => {
			scopeTrapCalls += 1;
		});
		expect(() => platformIdempotencyV1.parseScope(proxiedScope)).toThrow(
			expect.objectContaining({ code: "invalid_input" }),
		);
		expect(scopeTrapCalls).toBe(0);

		for (const invalidScope of [
			{ ...scope, operation: "platform.update-agent" },
			{ ...scope, operation: "platform.agent.lifecycle.restart.v1" },
			{ ...scope, operation: "runtime.submit" },
			{ ...scope, operation: "connection.invoke" },
			{ ...scope, resourceType: "conversation" },
			{ ...scope, resourceType: "connection" },
			{ ...scope, callerActorId: "attacker" },
		]) {
			expect(() => platformIdempotencyV1.parseScope(invalidScope)).toThrow(
				expect.objectContaining({ code: "invalid_input" }),
			);
		}

		for (const invalidResult of [
			{ ...result, accessToken: "credential-value" },
			{ ...result, providerResponse: { remoteId: "remote_01" } },
			{ ...result, sqlError: { query: "select secret" } },
			{ ...result, schemaVersion: 2 },
			{ ...result, references: [] },
			{
				...result,
				references: [
					{ resourceType: "conversation", resourceId: "c_01", revision: null },
				],
			},
		]) {
			expect(() => platformIdempotencyV1.parseResult(invalidResult)).toThrow(
				expect.objectContaining({ code: "invalid_input" }),
			);
		}
	});

	it("snapshots only bounded dense canonical arrays without invoking them", () => {
		const zeroDigest = platformIdempotencyV1.canonicalRequestDigest({
			values: [0],
		});
		const oneDigest = platformIdempotencyV1.canonicalRequestDigest({
			values: [1],
		});
		expect(zeroDigest).not.toBe(oneDigest);

		const customPrototype = [0];
		const prototype = Object.create(Array.prototype);
		Object.defineProperty(prototype, "map", {
			value: () => ["1"],
		});
		Object.setPrototypeOf(customPrototype, prototype);
		expect(() =>
			platformIdempotencyV1.canonicalRequestDigest({
				values: customPrototype,
			}),
		).toThrow(expect.objectContaining({ code: "invalid_input" }));

		let getterCalls = 0;
		const accessorElement = [0];
		Object.defineProperty(accessorElement, "0", {
			enumerable: true,
			configurable: true,
			get() {
				getterCalls += 1;
				return 1;
			},
		});
		expect(() =>
			platformIdempotencyV1.canonicalRequestDigest({
				values: accessorElement,
			}),
		).toThrow(expect.objectContaining({ code: "invalid_input" }));
		expect(getterCalls).toBe(0);

		const hole: unknown[] = [];
		hole.length = 1;
		const extraProperty = [0] as number[] & { providerPayload?: unknown };
		extraProperty.providerPayload = { remoteId: "remote_01" };
		const symbolProperty = [0] as number[] & Record<symbol, unknown>;
		symbolProperty[Symbol("provider")] = "remote_01";
		const ownKeysTrap = new Proxy([0], {
			ownKeys() {
				throw new Error("untrusted ownKeys trap");
			},
		});
		const descriptorTrap = new Proxy([0], {
			getOwnPropertyDescriptor() {
				throw new Error("untrusted descriptor trap");
			},
		});
		let forwardingTrapCalls = 0;
		const proxiedArray = forwardingProxy([0], () => {
			forwardingTrapCalls += 1;
		});
		const oversized = Array.from({ length: 16_385 }, () => 0);
		const descriptorsSpy = vi.spyOn(Object, "getOwnPropertyDescriptors");
		try {
			for (const invalid of [
				hole,
				extraProperty,
				symbolProperty,
				ownKeysTrap,
				descriptorTrap,
				proxiedArray,
				oversized,
			]) {
				expect(() =>
					platformIdempotencyV1.canonicalRequestDigest({
						values: invalid as never,
					}),
				).toThrow(expect.objectContaining({ code: "invalid_input" }));
			}
			expect(
				descriptorsSpy.mock.calls.some(([value]) => value === oversized),
			).toBe(false);
		} finally {
			descriptorsSpy.mockRestore();
		}
		expect(forwardingTrapCalls).toBe(0);

		expect(
			platformIdempotencyV1.canonicalRequestDigest({
				tag: "nested",
				values: [
					[1, 2],
					[3, [4]],
				],
			}),
		).toBe(
			platformIdempotencyV1.canonicalRequestDigest({
				values: [
					[1, 2],
					[3, [4]],
				],
				tag: "nested",
			}),
		);
	});

	it("snapshots result references without invoking array or element accessors", () => {
		const reference = {
			resourceType: "agent" as const,
			resourceId: "agent_array",
			revision: 1,
		};
		const result = (references: unknown) => ({
			schemaVersion: 1,
			outcome: "accepted",
			references,
		});
		const revokedReferences = Proxy.revocable([reference], {});
		revokedReferences.revoke();
		expect(() =>
			platformIdempotencyV1.parseResult(result(revokedReferences.proxy)),
		).toThrow(expect.objectContaining({ code: "invalid_input" }));
		let referenceTrapCalls = 0;
		const proxiedReference = forwardingProxy(reference, () => {
			referenceTrapCalls += 1;
		});
		expect(() =>
			platformIdempotencyV1.parseResult(result([proxiedReference])),
		).toThrow(expect.objectContaining({ code: "invalid_input" }));
		expect(referenceTrapCalls).toBe(0);

		const customPrototype = [reference];
		Object.setPrototypeOf(customPrototype, Object.create(Array.prototype));
		expect(() =>
			platformIdempotencyV1.parseResult(result(customPrototype)),
		).toThrow(expect.objectContaining({ code: "invalid_input" }));

		let getterCalls = 0;
		const accessorElement = [reference];
		Object.defineProperty(accessorElement, "0", {
			enumerable: true,
			configurable: true,
			get() {
				getterCalls += 1;
				return reference;
			},
		});
		expect(() =>
			platformIdempotencyV1.parseResult(result(accessorElement)),
		).toThrow(expect.objectContaining({ code: "invalid_input" }));
		expect(getterCalls).toBe(0);

		const providerArray = [reference] as (typeof reference)[] & {
			providerPayload?: unknown;
		};
		providerArray.providerPayload = { remoteId: "remote_01" };
		const providerElement = [{ ...reference, providerPayload: "remote_01" }];
		let forwardingTrapCalls = 0;
		const proxiedReferencesArray = forwardingProxy([reference], () => {
			forwardingTrapCalls += 1;
		});
		for (const invalid of [
			providerArray,
			providerElement,
			proxiedReferencesArray,
		]) {
			expect(() => platformIdempotencyV1.parseResult(result(invalid))).toThrow(
				expect.objectContaining({ code: "invalid_input" }),
			);
		}
		expect(forwardingTrapCalls).toBe(0);

		expect(platformIdempotencyV1.parseResult(result([reference]))).toEqual(
			result([reference]),
		);
	});
});

describe("Fake Platform idempotency Port", () => {
	platformIdempotencyPortV1Conformance(async () => {
		const database = new FakePlatformIdempotencyDatabaseV1();
		return {
			open: (scope) => database.open(scope),
			close: () => Promise.resolve(),
		};
	});
});
