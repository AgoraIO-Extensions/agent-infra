// @vitest-environment jsdom

import type { AccessOptionsResponse } from "@agent-infra/connection-contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
	getConnectionAccessOptions: vi.fn(),
	cancelConnectionAccessRequest: vi.fn(),
	submitConnectionAccessRequest: vi.fn(async (_body: unknown) => ({
		requestId: "request-1",
	})),
}));
vi.mock("../api", () => ({ connectionApi: api }));
vi.mock("../shell", () => ({
	PageError: () => <div role="alert">Request failed</div>,
}));

import { AccessRequestPanel } from "./access-request-panel";

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

it("requires consent to each current disclaimer after the option bundle refreshes", async () => {
	const options: AccessOptionsResponse = {
		options: [
			{
				providerId: "jira",
				providerReleaseId: "jira-v1",
				capabilityProfileId: "profile-1",
				capabilityProfileName: "Jira Read",
				policyVersionId: "policy-1",
				presentationId: "presentation-1",
				effectCeiling: "READ",
				requiredScopes: [],
				durations: [{ kind: "FINITE", days: 90 }],
				disclaimers: [
					{
						id: "disclaimer-1",
						content: "Original terms",
						contentSha256: "a".repeat(64),
						locale: "en",
					},
				],
			},
		],
	};
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
		},
	});
	client.setQueryData(["connection-access-options"], options);
	render(
		<QueryClientProvider client={client}>
			<AccessRequestPanel
				onSubmitted={vi.fn()}
				providerId="jira"
				renewalTarget={null}
				requests={[]}
				requestsError={null}
				requestsPending={false}
				startProviderId="jira"
				startSignal={1}
			/>
		</QueryClientProvider>,
	);
	fireEvent.click(await screen.findByRole("button", { name: /Jira Read/ }));
	fireEvent.change(screen.getByLabelText("用途"), {
		target: { value: "Issue tracking" },
	});
	fireEvent.click(screen.getByRole("checkbox", { name: "Original terms" }));
	expect(
		(screen.getByRole("button", { name: "提交申请" }) as HTMLButtonElement)
			.disabled,
	).toBe(false);
	const refreshed = structuredClone(options);
	const next = refreshed.options[0];
	const original = options.options[0];
	if (!next || !original) throw new Error("Option fixture is missing");
	next.presentationId = "presentation-2";
	next.disclaimers = [
		{
			id: "disclaimer-2",
			content: "Updated terms",
			contentSha256: "b".repeat(64),
			locale: "en",
		},
	];
	refreshed.options.unshift({
		...original,
		policyVersionId: "different-policy",
		capabilityProfileId: "different-profile",
		capabilityProfileName: "Different capability",
	});
	act(() => {
		client.setQueryData(["connection-access-options"], refreshed);
	});
	expect(
		(
			(await screen.findByRole("checkbox", {
				name: "Updated terms",
			})) as HTMLInputElement
		).checked,
	).toBe(false);
	expect(
		(screen.getByRole("button", { name: "提交申请" }) as HTMLButtonElement)
			.disabled,
	).toBe(true);
	fireEvent.click(screen.getByRole("button", { name: "提交申请" }));
	expect(api.submitConnectionAccessRequest).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("checkbox", { name: "Updated terms" }));
	fireEvent.click(screen.getByRole("button", { name: "提交申请" }));
	await waitFor(() =>
		expect(api.submitConnectionAccessRequest).toHaveBeenCalledOnce(),
	);
	expect(api.submitConnectionAccessRequest.mock.calls[0]?.[0]).toMatchObject({
		policyVersionId: "policy-1",
		capabilityProfileId: "profile-1",
		presentationId: "presentation-2",
		disclaimerConfirmations: [
			{
				disclaimerVersionId: "disclaimer-2",
				contentSha256: "b".repeat(64),
				locale: "en",
			},
		],
	});
	client.clear();
});
