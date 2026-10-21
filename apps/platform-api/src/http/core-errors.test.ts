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

	it.each([
		[
			"Application creation",
			new ApplicationFoundationError("platform_identity_entry_unavailable"),
		],
		[
			"Application revision",
			new ApplicationRevisionError("platform_identity_entry_unavailable"),
		],
		[
			"Agent configuration",
			new AgentConfigurationError("platform_identity_entry_unavailable"),
		],
	])(
		"maps a %s without a platform identity entry to a terminal 409 (#3034)",
		(_label, error) => {
			const mapped = mapCoreError(error, traceId);
			expect(mapped).toMatchObject({
				status: 409,
				body: {
					schemaVersion: 1,
					code: "ACTION_UNAVAILABLE",
					retryable: false,
					traceId,
				},
			});
			// 不暴露内部错误码或部署细节。
			expect(JSON.stringify(mapped.body)).not.toMatch(
				/platform_identity_entry_unavailable|customAgentGateway|annotation/i,
			);
		},
	);

	it("keeps an ordinary admission rejection distinct from the missing platform identity entry", () => {
		expect(
			mapCoreError(new AgentConfigurationError("not_admitted"), traceId).body
				.code,
		).not.toBe("ACTION_UNAVAILABLE");
	});
});
