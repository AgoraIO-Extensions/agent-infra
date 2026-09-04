import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
	AgentApplicationCreateRequestV1Writable,
	AgentApplicationUpdateRequestV1Writable,
} from "../../pilot/generated/types.gen.js";
import {
	createMyAgentApplication,
	updateMyAgentApplication,
} from "./my-agent-applications.js";
import { pendingApplication } from "./test-fixtures.js";
import { useAgentApplicationSubmission } from "./use-agent-application-submission.js";

vi.mock("./my-agent-applications.js", () => ({
	createMyAgentApplication: vi.fn(),
	updateMyAgentApplication: vi.fn(),
}));

const createBody = {
	schemaVersion: 1,
	name: pendingApplication.name,
	description: pendingApplication.description,
	source: pendingApplication.source,
	coOwnerIds: [],
	availability: [],
	actions: [],
	environment: [],
	secrets: [],
} satisfies AgentApplicationCreateRequestV1Writable;
const { secrets: _secrets, ...updateBody } = createBody;

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("useAgentApplicationSubmission", () => {
	it("creates a fresh idempotency key for each explicit create or update command", async () => {
		const queryClient = new QueryClient();
		vi.mocked(createMyAgentApplication).mockResolvedValue(pendingApplication);
		vi.mocked(updateMyAgentApplication).mockResolvedValue(pendingApplication);
		const wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		);
		const { result } = renderHook(() => useAgentApplicationSubmission(), {
			wrapper,
		});

		act(() => {
			expect(result.current.create(createBody)).toBeUndefined();
			expect(
				result.current.update(
					pendingApplication.applicationId,
					updateBody satisfies AgentApplicationUpdateRequestV1Writable,
				),
			).toBeUndefined();
		});
		await waitFor(() => {
			expect(createMyAgentApplication).toHaveBeenCalledOnce();
			expect(updateMyAgentApplication).toHaveBeenCalledOnce();
		});
		expect(createMyAgentApplication).toHaveBeenCalledWith(
			createBody,
			expect.any(String),
		);
		expect(updateMyAgentApplication).toHaveBeenCalledWith(
			pendingApplication.applicationId,
			updateBody,
			expect.any(String),
		);
		expect(vi.mocked(createMyAgentApplication).mock.calls[0]?.[1]).not.toBe(
			vi.mocked(updateMyAgentApplication).mock.calls[0]?.[2],
		);
		queryClient.clear();
	});
});
