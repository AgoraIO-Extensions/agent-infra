import {
	AgentConfigurationError,
	ApplicationFoundationError,
	ApplicationRevisionError,
} from "@agent-infra/platform-core";
import { describe, expect, it } from "vitest";

import { mapCoreError } from "./core-errors.js";

const traceId = "trace-core-errors";

describe("core error mapping", () => {
	it.each([
		[
			"Application creation",
			new ApplicationFoundationError("resource_cap_exceeded"),
		],
		[
			"Application revision",
			new ApplicationRevisionError("resource_cap_exceeded"),
		],
		[
			"Agent configuration",
			new AgentConfigurationError("resource_cap_exceeded"),
		],
	])("maps a %s resource cap rejection to a terminal 409", (_label, error) => {
		expect(mapCoreError(error, traceId)).toMatchObject({
			status: 409,
			body: {
				code: "MULTI_SERVICE_RESOURCE_CAP_EXCEEDED",
				retryable: false,
				traceId,
			},
		});
	});

	it("keeps an ordinary admission rejection distinct from the resource cap", () => {
		expect(
			mapCoreError(new AgentConfigurationError("not_admitted"), traceId).body
				.code,
		).not.toBe("MULTI_SERVICE_RESOURCE_CAP_EXCEEDED");
		expect(
			mapCoreError(new ApplicationFoundationError("not_admitted"), traceId).body
				.code,
		).not.toBe("MULTI_SERVICE_RESOURCE_CAP_EXCEEDED");
	});
});
