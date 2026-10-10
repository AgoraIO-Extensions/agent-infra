import { describe, expect, it, vi } from "vitest";

import { createClient } from "../../pilot/generated-v2/client/index.js";
import {
	loadPersonalRelayKey,
	PersonalRelayKeyError,
	replacePersonalRelayKey,
	revokePersonalRelayKey,
} from "./personal-relay-key.js";

const configured = { schemaVersion: 1, isSet: true, keyVersion: 3 };
const absent = { schemaVersion: 1, isSet: false, keyVersion: null };
const secret = "synthetic-secret!";

function fakeClient(body: unknown = configured, status = 200) {
	const requests: Request[] = [];
	const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
		const request = input instanceof Request ? input : new Request(input, init);
		requests.push(request);
		return new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		});
	});
	return {
		client: createClient({ baseUrl: "https://platform.example.test", fetch }),
		requests,
		fetch,
	};
}

describe("personal Relay Key generated-client consumer", () => {
	it("uses only current-user GET/PUT/DELETE and preserves write-only request values", async () => {
		const { client, requests } = fakeClient();
		await expect(loadPersonalRelayKey(client)).resolves.toEqual(configured);
		await expect(
			replacePersonalRelayKey(null, secret, client),
		).resolves.toEqual(configured);
		await expect(revokePersonalRelayKey(3, client)).resolves.toEqual(
			configured,
		);
		expect(requests.map((request) => [request.method, request.url])).toEqual([
			["GET", "https://platform.example.test/api/v2/me/relay-key"],
			["PUT", "https://platform.example.test/api/v2/me/relay-key"],
			["DELETE", "https://platform.example.test/api/v2/me/relay-key"],
		]);
		expect(await requests[1]?.json()).toEqual({
			expectedVersion: null,
			keyValue: secret,
		});
		expect(await requests[2]?.json()).toEqual({
			expectedVersion: 3,
		});
	});

	it.each([16, 8192])(
		"accepts the %i character boundary without rewriting",
		async (length) => {
			const { client, requests } = fakeClient();
			const keyValue = `!${"K".repeat(length - 2)}~`;
			await replacePersonalRelayKey(2, keyValue, client);
			expect(await requests[0]?.json()).toMatchObject({ keyValue });
		},
	);

	it.each([
		"K".repeat(15),
		"K".repeat(8193),
		` ${secret}`,
		`${secret} `,
		`${secret}\t`,
		`${secret}\u0000`,
		`${secret}中文`,
	])("rejects invalid Key case %# before dispatch", async (keyValue) => {
		const { client, fetch } = fakeClient();
		await expect(
			replacePersonalRelayKey(2, keyValue, client),
		).rejects.toMatchObject({
			kind: "invalid",
			message: "Personal Relay Key request failed",
		});
		expect(fetch).not.toHaveBeenCalled();
	});

	it.each([0, -1, 1.5])(
		"rejects invalid CAS %s before PUT and DELETE",
		async (version) => {
			const { client, fetch } = fakeClient();
			await expect(
				replacePersonalRelayKey(version, secret, client),
			).rejects.toBeInstanceOf(PersonalRelayKeyError);
			await expect(
				revokePersonalRelayKey(version, client),
			).rejects.toBeInstanceOf(PersonalRelayKeyError);
			expect(fetch).not.toHaveBeenCalled();
		},
	);

	it("allows null only for setting and rejects null revocation", async () => {
		const { client, fetch } = fakeClient(absent);
		await expect(
			revokePersonalRelayKey(null as unknown as number, client),
		).rejects.toMatchObject({ kind: "invalid" });
		expect(fetch).not.toHaveBeenCalled();
		await expect(
			replacePersonalRelayKey(null, secret, client),
		).resolves.toEqual(absent);
	});

	it.each([
		{ schemaVersion: 1, isSet: false, keyVersion: 1 },
		{ schemaVersion: 1, isSet: true, keyVersion: null },
		{ schemaVersion: 1, isSet: true, keyVersion: 0 },
		{ ...configured, keyValue: secret },
	])("rejects invalid or secret-bearing 200 metadata case %#", async (body) => {
		const { client } = fakeClient(body);
		await expect(loadPersonalRelayKey(client)).rejects.toMatchObject({
			kind: "invalid",
			status: 200,
			retryable: false,
			message: "Personal Relay Key request failed",
		});
	});

	it.each(["replace", "revoke"] as const)(
		"also validates %s response metadata before accepting the write",
		async (operation) => {
			const { client } = fakeClient({ ...configured, keyValue: secret });
			const request =
				operation === "replace"
					? replacePersonalRelayKey(2, secret, client)
					: revokePersonalRelayKey(2, client);
			await expect(request).rejects.toMatchObject({
				kind: "invalid",
				status: 200,
				retryable: false,
				message: "Personal Relay Key request failed",
			});
		},
	);

	it.each([
		[401, "AUTHENTICATION_REQUIRED", "authentication", false],
		[403, "RESOURCE_UNAVAILABLE", "authorization", false],
		[409, "INVALID_REQUEST", "conflict", false],
		[503, "DEPENDENCY_UNAVAILABLE", "unavailable", true],
	] as const)(
		"preserves formal protocol failure for HTTP %s",
		async (status, code, kind, retryable) => {
			const { client } = fakeClient(
				{
					schemaVersion: 1,
					code,
					retryable,
					message: secret,
					traceId: "trace-personal-key",
				},
				status,
			);
			await expect(
				replacePersonalRelayKey(2, secret, client),
			).rejects.toMatchObject({
				kind,
				status,
				retryable,
				message: "Personal Relay Key request failed",
			});
		},
	);

	it.each([
		{
			schemaVersion: 1,
			code: "RESOURCE_CONFLICT",
			retryable: false,
			message: secret,
			traceId: "trace-personal-key",
		},
		{
			schemaVersion: 1,
			code: "INVALID_REQUEST",
			retryable: false,
			message: secret,
			traceId: "trace-personal-key",
			keyValue: secret,
		},
	])(
		"rejects nonformal or secret-bearing protocol failure case %#",
		async (body) => {
			const { client } = fakeClient(body, 409);
			await expect(loadPersonalRelayKey(client)).rejects.toMatchObject({
				kind: "invalid",
				retryable: false,
				message: "Personal Relay Key request failed",
			});
		},
	);

	it("sanitizes transport failures without copying raw response text into Error", async () => {
		const { client, fetch } = fakeClient();
		fetch.mockRejectedValue(new Error(`raw transport ${secret}`));
		await expect(loadPersonalRelayKey(client)).rejects.toMatchObject({
			kind: "unavailable",
			retryable: true,
			message: "Personal Relay Key request failed",
		});
	});
});
