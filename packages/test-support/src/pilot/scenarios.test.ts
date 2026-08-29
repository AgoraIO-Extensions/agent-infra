import {
	AgentProjectionV1Schema,
	CommandAcceptedProjectionV1Schema,
	ExecutionDetailProjectionV1Schema,
	MessageProjectionV1Schema,
	PilotProtocolErrorV1Schema,
} from "@agent-infra/contracts/pilot";
import { describe, expect, it } from "vitest";

import { pilotFakeScenariosV1 } from "./index.js";

describe("Pilot schema-driven Fake scenarios", () => {
	it("covers every required product state with schema-valid responses", () => {
		expect(Object.keys(pilotFakeScenariosV1).sort()).toEqual(
			[
				"busy",
				"failed",
				"starting",
				"success",
				"unauthorized",
				"unavailable",
			].sort(),
		);
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
		expect(
			pilotFakeScenariosV1.failed.messages.map(
				(message) => MessageProjectionV1Schema.parse(message).error?.code,
			),
		).toEqual([
			"ORIGINAL_RESPONSE_NOT_STARTED",
			"ORIGINAL_RESPONSE_ALREADY_FINISHED",
			"AUTHORIZATION_REVOKED",
			"EXECUTION_FAILED",
		]);
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
});
