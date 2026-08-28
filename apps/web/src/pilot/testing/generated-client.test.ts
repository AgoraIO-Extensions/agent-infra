import { describe, expect, it } from "vitest";

import {
	getCurrentSession,
	streamConversationEvents,
	submitMessage,
} from "../generated/sdk.gen.js";

describe("Pilot generated browser client", () => {
	it("exposes management, command, and SSE operations from OpenAPI", () => {
		expect(getCurrentSession).toBeTypeOf("function");
		expect(submitMessage).toBeTypeOf("function");
		expect(streamConversationEvents).toBeTypeOf("function");
	});
});
