import { describe, expect, expectTypeOf, it } from "vitest";

import {
	getCurrentSession,
	streamConversationEvents,
	submitMessage,
} from "../generated/sdk.gen.js";
import type { SubmitMessageData } from "../generated/types.gen.js";
import { listPlatformAuditV2 } from "../generated-v2/sdk.gen.js";
import type {
	CreateAgentApplicationV2Data,
	ListPlatformAuditV2Responses,
	PlatformAuditProjectionV2,
} from "../generated-v2/types.gen.js";

describe("Pilot generated browser client", () => {
	it("exposes management, command, and SSE operations from OpenAPI", () => {
		expect(getCurrentSession).toBeTypeOf("function");
		expect(submitMessage).toBeTypeOf("function");
		expect(streamConversationEvents).toBeTypeOf("function");
		expect(listPlatformAuditV2).toBeTypeOf("function");
		expectTypeOf<CreateAgentApplicationV2Data>().toMatchTypeOf<{
			body: unknown;
		}>();
		expectTypeOf<SubmitMessageData>().toMatchTypeOf<{ body: unknown }>();
		expectTypeOf<
			ListPlatformAuditV2Responses[200]["items"][number]
		>().toEqualTypeOf<PlatformAuditProjectionV2>();
		expectTypeOf<
			Extract<PlatformAuditProjectionV2["actor"], { kind: "system" }>
		>().toEqualTypeOf<{ actorId: string; kind: "system" }>();
	});
});
