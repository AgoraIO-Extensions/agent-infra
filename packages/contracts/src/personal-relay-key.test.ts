import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import { expect, it } from "vitest";
import {
	PersonalRelayKeyReplaceRequestV1Schema,
	PersonalRelayKeyRevokeRequestV1Schema,
	PersonalRelayKeyStateV1Schema,
} from "./pilot/personal-relay-key.ts";

it("keeps personal Relay Key Zod and generated request/state validation equivalent", async () => {
	const artifact = JSON.parse(
		await readFile(
			new URL(
				"../artifacts/openapi/pilot-browser.v2.openapi.json",
				import.meta.url,
			),
			"utf8",
		),
	);
	// Password is write-only presentation metadata; the pattern and bounds enforce its value.
	const ajv = new Ajv2020({ validateFormats: false });
	const replace = ajv.compile(
		artifact.components.schemas.PersonalRelayKeyReplaceRequestV1,
	);
	const revoke = ajv.compile(
		artifact.components.schemas.PersonalRelayKeyRevokeRequestV1,
	);
	const state = ajv.compile(
		artifact.components.schemas.PersonalRelayKeyStateV1,
	);
	for (const [keyValue, accepted] of [
		["!".repeat(16), true],
		["~".repeat(8192), true],
		["AZaz09!~_-+/=.\\xx", true],
		["a".repeat(15), false],
		["a".repeat(8193), false],
		["a".repeat(16).concat(" "), false],
		["a".repeat(16).concat("\n"), false],
		["a".repeat(16).concat("\x7f"), false],
		["a".repeat(16).concat("é"), false],
	] as const) {
		const command = { expectedVersion: null, keyValue };
		expect(
			PersonalRelayKeyReplaceRequestV1Schema.safeParse(command).success,
		).toBe(accepted);
		expect(replace(command)).toBe(accepted);
	}
	for (const [command, accepted] of [
		[{ expectedVersion: 1, keyValue: "a".repeat(16) }, true],
		[{ expectedVersion: 0, keyValue: "a".repeat(16) }, false],
		[
			{ expectedVersion: null, keyValue: "a".repeat(16), userId: "other" },
			false,
		],
	] as const) {
		expect(
			PersonalRelayKeyReplaceRequestV1Schema.safeParse(command).success,
		).toBe(accepted);
		expect(replace(command)).toBe(accepted);
	}
	for (const [command, accepted] of [
		[{ expectedVersion: 1 }, true],
		[{ expectedVersion: Number.MAX_SAFE_INTEGER }, true],
		[{ expectedVersion: 0 }, false],
		[{ expectedVersion: null }, false],
		[{ expectedVersion: Number.MAX_SAFE_INTEGER + 1 }, false],
		[{ expectedVersion: 1, userId: "other" }, false],
	] as const) {
		expect(
			PersonalRelayKeyRevokeRequestV1Schema.safeParse(command).success,
		).toBe(accepted);
		expect(revoke(command)).toBe(accepted);
	}
	for (const [response, accepted] of [
		[{ schemaVersion: 1, isSet: false, keyVersion: null }, true],
		[{ schemaVersion: 1, isSet: true, keyVersion: 1 }, true],
		[{ schemaVersion: 1, isSet: true, keyVersion: null }, false],
		[{ schemaVersion: 1, isSet: false, keyVersion: 1 }, false],
		[{ schemaVersion: 1, isSet: true, keyVersion: 0 }, false],
		[
			{
				schemaVersion: 1,
				isSet: true,
				keyVersion: Number.MAX_SAFE_INTEGER + 1,
			},
			false,
		],
		[
			{
				schemaVersion: 1,
				isSet: true,
				keyVersion: 1,
				keyValue: "PRIVATE_KEY_SENTINEL",
			},
			false,
		],
	] as const) {
		expect(PersonalRelayKeyStateV1Schema.safeParse(response).success).toBe(
			accepted,
		);
		expect(state(response)).toBe(accepted);
	}
});
