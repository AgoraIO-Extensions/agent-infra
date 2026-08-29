import { describe, expect, expectTypeOf, it } from "vitest";

import { getCurrentSession, submitMessage } from "../generated/sdk.gen.js";
import type {
	CreateAgentApplicationData,
	SubmitMessageData,
} from "../generated/types.gen.js";

describe("Pilot generated browser client", () => {
	it("exposes management and command operations from OpenAPI", () => {
		expect(getCurrentSession).toBeTypeOf("function");
		expect(submitMessage).toBeTypeOf("function");
		expectTypeOf<CreateAgentApplicationData>().toMatchTypeOf<{
			body: unknown;
		}>();
		expectTypeOf<SubmitMessageData>().toMatchTypeOf<{ body: unknown }>();
	});
});
