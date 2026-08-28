import { describe, expect, it } from "vitest";

import { pilotFakeScenariosV1 } from "../../../test-support/src/pilot/index.js";
import {
	AgentProjectionV1Schema,
	CommandAcceptedProjectionV1Schema,
	ExecutionDetailProjectionV1Schema,
} from "../../src/pilot/browser.js";
import { PilotProtocolErrorV1Schema } from "../../src/pilot/errors.js";
import { ConversationSseMessageV1Schema } from "../../src/pilot/sse.js";

describe("Pilot schema-driven Fake scenarios", () => {
	it("covers every required product state", () => {
		expect(Object.keys(pilotFakeScenariosV1).sort()).toEqual(
			[
				"busy",
				"failed",
				"replay",
				"staleAuthorization",
				"starting",
				"success",
				"unauthorized",
				"unavailable",
			].sort(),
		);
	});

	it("keeps every HTTP Fake response valid against its public response schema", () => {
		expect(
			CommandAcceptedProjectionV1Schema.parse(
				pilotFakeScenariosV1.success.response.body,
			),
		).toEqual(pilotFakeScenariosV1.success.response.body);
		expect(
			AgentProjectionV1Schema.parse(
				pilotFakeScenariosV1.starting.response.body,
			),
		).toEqual(pilotFakeScenariosV1.starting.response.body);
		expect(
			ExecutionDetailProjectionV1Schema.parse(
				pilotFakeScenariosV1.failed.response.body,
			),
		).toEqual(pilotFakeScenariosV1.failed.response.body);
		for (const scenario of [
			pilotFakeScenariosV1.unauthorized,
			pilotFakeScenariosV1.busy,
			pilotFakeScenariosV1.unavailable,
		]) {
			expect(PilotProtocolErrorV1Schema.parse(scenario.response.body)).toEqual(
				scenario.response.body,
			);
		}
	});

	it("keeps replay duplicates stable and stale authorization explicit", () => {
		for (const message of pilotFakeScenariosV1.replay.messages) {
			expect(ConversationSseMessageV1Schema.safeParse(message).success).toBe(
				true,
			);
		}
		expect(pilotFakeScenariosV1.replay.messages[0]).toEqual(
			pilotFakeScenariosV1.replay.messages[1],
		);
		expect(
			ConversationSseMessageV1Schema.parse(
				pilotFakeScenariosV1.staleAuthorization.messages[0],
			),
		).toMatchObject({
			type: "authorization.revoked",
			error: { retryable: false },
		});
	});
});
