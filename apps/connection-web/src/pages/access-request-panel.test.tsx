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
	within,
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

it("shows exact approved actions and labels a write-only bundle accurately", async () => {
	const read = {
		id: "github.get_issue@v1",
		name: "github.get_issue",
		description: "查看问题",
		effect: "READ" as const,
	};
	const write = {
		id: "github.create_issue@v1",
		name: "github.create_issue",
		description: "创建问题",
		effect: "WRITE" as const,
	};
	const options: AccessOptionsResponse = {
		options: [
			{
				providerId: "github",
				providerReleaseId: "release-1",
				capabilityProfileId: "read-profile",
				capabilityProfileName: "只读能力包",
				policyVersionId: "policy-read",
				presentationId: "presentation-read",
				effectCeiling: "READ",
				actions: [read],
				requiredScopes: [],
				durations: [{ kind: "FINITE", days: 90 }],
				disclaimers: [],
			},
			{
				providerId: "github",
				providerReleaseId: "release-1",
				capabilityProfileId: "write-profile",
				capabilityProfileName: "仅写能力包",
				policyVersionId: "policy-write",
				presentationId: "presentation-write",
				effectCeiling: "WRITE",
				actions: [write],
				requiredScopes: [],
				durations: [{ kind: "FINITE", days: 90 }],
				disclaimers: [],
			},
			{
				providerId: "github",
				providerReleaseId: "release-1",
				capabilityProfileId: "mixed-profile",
				capabilityProfileName: "混合能力包",
				policyVersionId: "policy-mixed",
				presentationId: "presentation-mixed",
				effectCeiling: "WRITE",
				actions: [read, write],
				requiredScopes: [],
				durations: [{ kind: "FINITE", days: 90 }],
				disclaimers: [],
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
				providerId="github"
				renewalTarget={null}
				requests={[]}
				requestsError={null}
				requestsPending={false}
				startProviderId="github"
				startSignal={1}
			/>
		</QueryClientProvider>,
	);
	expect(
		await screen.findByRole("button", { name: /只读能力包.*只读/ }),
	).toBeTruthy();
	expect(screen.getByRole("button", { name: /仅写能力包.*仅写/ })).toBeTruthy();
	expect(
		screen.getByRole("button", { name: /混合能力包.*读取与写入/ }),
	).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: /仅写能力包.*仅写/ }));
	const range = screen.getByRole("region", { name: "能力范围" });
	expect(within(range).getByText("github.create_issue")).toBeTruthy();
	expect(within(range).getByText("创建问题")).toBeTruthy();
	expect(within(range).getByText("写入")).toBeTruthy();
	expect(within(range).queryByText("github.get_issue")).toBeNull();
	fireEvent.change(screen.getByLabelText("用途"), {
		target: { value: "创建问题" },
	});
	fireEvent.click(screen.getByRole("button", { name: "提交申请" }));
	await waitFor(() =>
		expect(api.submitConnectionAccessRequest).toHaveBeenCalledOnce(),
	);
	expect(api.submitConnectionAccessRequest.mock.calls[0]?.[0]).toMatchObject({
		capabilityProfileId: "write-profile",
		policyVersionId: "policy-write",
	});
	client.clear();
});

it("blocks submission while a rolling deployment omits the action details", async () => {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
		},
	});
	client.setQueryData(["connection-access-options"], {
		options: [
			{
				providerId: "github",
				providerReleaseId: "release-1",
				capabilityProfileId: "profile-1",
				capabilityProfileName: "暂不可用",
				policyVersionId: "policy-1",
				presentationId: "presentation-1",
				effectCeiling: "WRITE",
				requiredScopes: [],
				durations: [{ kind: "FINITE", days: 90 }],
				disclaimers: [],
			},
		],
	});
	render(
		<QueryClientProvider client={client}>
			<AccessRequestPanel
				onSubmitted={vi.fn()}
				providerId="github"
				renewalTarget={null}
				requests={[]}
				requestsError={null}
				requestsPending={false}
				startProviderId="github"
				startSignal={1}
			/>
		</QueryClientProvider>,
	);
	fireEvent.click(await screen.findByRole("button", { name: /暂不可用/ }));
	expect(screen.getByRole("status", { name: "" }).textContent).toContain(
		"能力详情暂不可用",
	);
	fireEvent.change(screen.getByLabelText("用途"), {
		target: { value: "查看权限" },
	});
	expect(
		(screen.getByRole("button", { name: "提交申请" }) as HTMLButtonElement)
			.disabled,
	).toBe(true);
	client.clear();
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
				actions: [
					{
						id: "jira.get_issue@v1",
						name: "jira.get_issue",
						description: "查看问题",
						effect: "READ",
					},
				],
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
	const unconsumed = structuredClone(refreshed);
	const nextPresentation = unconsumed.options.find(
		(item) => item.policyVersionId === "policy-1",
	);
	if (!nextPresentation) throw new Error("Next presentation is missing");
	nextPresentation.presentationId = "presentation-3";
	api.getConnectionAccessOptions.mockResolvedValue(unconsumed);
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
	await waitFor(() =>
		expect(client.getQueryData(["connection-access-options"])).toEqual(
			unconsumed,
		),
	);
	fireEvent.click(await screen.findByRole("button", { name: /Jira Read/ }));
	fireEvent.change(screen.getByLabelText("用途"), {
		target: { value: "Fresh application" },
	});
	fireEvent.click(screen.getByRole("checkbox", { name: "Updated terms" }));
	fireEvent.click(screen.getByRole("button", { name: "提交申请" }));
	await waitFor(() =>
		expect(api.submitConnectionAccessRequest).toHaveBeenCalledTimes(2),
	);
	expect(api.submitConnectionAccessRequest.mock.calls[1]?.[0]).toMatchObject({
		presentationId: "presentation-3",
	});
	client.clear();
});
