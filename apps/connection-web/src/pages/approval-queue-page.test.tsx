// @vitest-environment jsdom
import type { ApprovalQueueItem } from "@agent-infra/connection-contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
	listConnectionApprovalQueue: vi.fn(),
	decideConnectionAccessRequest: vi.fn(async (_input: unknown) => ({})),
}));
vi.mock("../api", () => ({ connectionApi: api }));
vi.mock("../shell", () => ({
	ConsoleShell: ({ children }: { children: ReactNode }) => <>{children}</>,
	PageError: () => <div role="alert">Failed</div>,
}));

import { ApprovalQueuePage } from "./approval-queue-page";

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

function request(id: string): ApprovalQueueItem {
	return {
		id,
		applicantDisplayName: id,
		approverPrincipalId: "reviewer-1",
		currentRequestStageId: `stage-${id}`,
		providerId: "jira",
		providerReleaseId: "jira-v1",
		capabilityProfileName: "Read",
		purpose: `Purpose ${id}`,
		renewal: false,
		duration: { kind: "FINITE", days: 90 },
		state: "IN_REVIEW",
		currentStageOrdinal: 1,
		revision: "1",
		createdAt: "2026-09-01T00:00:00Z",
		expiresAt: "2030-01-01T00:00:00Z",
		connectExpiresAt: null,
		stages: [
			{
				ordinal: 1,
				name: "Review",
				state: "PENDING",
				revision: "1",
				routingRevision: "1",
				openedAt: null,
				completedAt: null,
				decisions: [],
			},
		],
	};
}

it.each(["removed", "seat", "revision", "selection"])(
	"does not reuse confirmation after %s changes",
	async (change) => {
		const first = request("Alice");
		const second = request("Bob");
		const client = new QueryClient({
			defaultOptions: {
				queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
			},
		});
		client.setQueryData(["connection-approval-queue"], {
			requests: [first, second],
		});
		api.listConnectionApprovalQueue.mockResolvedValue({ requests: [] });
		render(
			<QueryClientProvider client={client}>
				<ApprovalQueuePage />
			</QueryClientProvider>,
		);
		fireEvent.click(screen.getByRole("button", { name: "通过" }));
		fireEvent.change(screen.getByLabelText("审批意见"), {
			target: { value: "Alice only" },
		});
		expect(screen.getByRole("button", { name: "确认通过" })).toBeTruthy();
		const replacement =
			change === "seat"
				? { ...first, approverPrincipalId: "reviewer-2" }
				: change === "revision"
					? { ...first, revision: "2" }
					: second;
		if (change === "selection")
			fireEvent.click(screen.getByRole("button", { name: /Bob/ }));
		else
			act(() => {
				client.setQueryData(["connection-approval-queue"], {
					requests: [replacement],
				});
			});
		await waitFor(() =>
			expect(screen.queryByRole("button", { name: "确认通过" })).toBeNull(),
		);
		expect(api.decideConnectionAccessRequest).not.toHaveBeenCalled();
		fireEvent.click(
			screen.getByRole("button", {
				name: new RegExp(replacement.applicantDisplayName),
			}),
		);
		fireEvent.click(screen.getByRole("button", { name: "通过" }));
		expect(
			(screen.getByLabelText("审批意见") as HTMLTextAreaElement).value,
		).toBe("");
		fireEvent.click(screen.getByRole("button", { name: "确认通过" }));
		await waitFor(() =>
			expect(api.decideConnectionAccessRequest).toHaveBeenCalledOnce(),
		);
		expect(api.decideConnectionAccessRequest.mock.calls[0]?.[0]).toMatchObject({
			requestId: replacement.id,
			body: {
				approverPrincipalId: replacement.approverPrincipalId,
				expectedRequestRevision: replacement.revision,
				decision: "APPROVE",
			},
		});
		client.clear();
	},
);
