import {
	ConnectionActionCallProjectionV1Schema,
	ConnectionCatalogV1Schema,
} from "@agent-infra/contracts/pilot";
import { describe, expect, it } from "vitest";

import {
	fakeConnectionCatalogV1,
	fakeProviderFailedCallV1,
	fakeResultPendingCallV1,
} from "./connection.js";

describe("Connection contract Fakes", () => {
	it("gives Platform the fixed read-only GitHub Pilot catalog", () => {
		const catalog = fakeConnectionCatalogV1();
		expect(ConnectionCatalogV1Schema.parse(catalog)).toEqual(catalog);
		expect(
			catalog.providers[0].actions.map((action) => action.actionId),
		).toEqual([
			"github.get_current_user",
			"github.list_my_repositories",
			"github.create_pull_request",
		]);
		expect(JSON.stringify(catalog)).not.toMatch(
			/token|secret|credential|connectionId|grantId/i,
		);
	});

	it("gives Web and runtime distinct known-failure and unknown projections", () => {
		const failed = fakeProviderFailedCallV1();
		const pending = fakeResultPendingCallV1();

		expect(ConnectionActionCallProjectionV1Schema.parse(failed)).toEqual(
			failed,
		);
		expect(ConnectionActionCallProjectionV1Schema.parse(pending)).toEqual(
			pending,
		);
		expect(failed.status).toBe("provider_failed");
		expect(pending.status).toBe("result_pending");
	});
});
