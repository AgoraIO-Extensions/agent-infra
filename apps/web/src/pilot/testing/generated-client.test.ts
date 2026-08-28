import { describe, expect, expectTypeOf, it } from "vitest";

import {
	getCurrentSession,
	streamConversationEvents,
	submitMessage,
} from "../generated/sdk.gen.js";
import type {
	CreateAgentApplicationData,
	SubmitMessageData,
} from "../generated/types.gen.js";

describe("Pilot generated browser client", () => {
	it("exposes management, command, and SSE operations from OpenAPI", () => {
		expect(getCurrentSession).toBeTypeOf("function");
		expect(submitMessage).toBeTypeOf("function");
		expect(streamConversationEvents).toBeTypeOf("function");
		expectTypeOf<CreateAgentApplicationData>().toMatchTypeOf<{
			body: unknown;
		}>();
		expectTypeOf<SubmitMessageData>().toMatchTypeOf<{ body: unknown }>();
	});
});
