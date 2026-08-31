import { describe } from "vitest";

import { agentManagementV1Conformance } from "./agent-management.conformance.ts";
import { FakeAgentManagementV1 } from "./fake-agent-management.ts";

describe("Fake Agent management Interface", () => {
	agentManagementV1Conformance(async (options) =>
		Promise.resolve(new FakeAgentManagementV1(options)),
	);
});
