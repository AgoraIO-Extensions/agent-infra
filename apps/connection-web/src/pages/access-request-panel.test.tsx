// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
	AccessOptionsResponse,
	AccessRequestsResponse,
} from "@agent-infra/connection-contracts";
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

function pendingUpgradeRequest(): AccessRequestsResponse["requests"][number] {
	return {
		id: "request-old",
		providerId: "datalego",
		providerReleaseId: "datalego-v3",
		capabilityProfileName: "旧能力包",
		state: "APPROVED_PENDING_CONNECTION",
		renewal: false,
		connectExpiresAt: "2099-10-08T00:00:00Z",
		expiresAt: "2099-10-08T00:00:00Z",
		createdAt: "2026-10-01T00:00:00Z",
		currentStageOrdinal: null,
		revision: "1",
		purpose: "调查发布失败",
		duration: { kind: "FINITE", days: 30 },
		stages: [],
		connectReadiness: {
			status: "REAPPLY_REQUIRED",
			targetProviderReleaseId: "datalego-v4",
		},
	};
}

function currentUpgradeOption(): AccessOptionsResponse["options"][number] {
	return {
		providerId: "datalego",
		providerReleaseId: "datalego-v4",
		capabilityProfileId: "profile-v4",
		capabilityProfileName: "新版只读能力包",
		effectCeiling: "READ",
		policyVersionId: "policy-v4",
		presentationId: "presentation-v4",
		actions: [
			{
				id: "datalego.get_current_user@v4",
				name: "datalego.get_current_user",
				description: "读取身份",
				effect: "READ",
			},
		],
		requiredScopes: ["read"],
		durations: [
			{ kind: "FINITE", days: 7 },
			{ kind: "FINITE", days: 30 },
		],
		disclaimers: [
			{
				id: "disclaimer-v4",
				content: "我已阅读新版范围",
				contentSha256: "a".repeat(64),
				locale: "zh-CN",
			},
		],
	};
}

function renderPendingUpgrade(
	request: AccessRequestsResponse["requests"][number],
	choices: AccessOptionsResponse["options"],
) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
		},
	});
	client.setQueryData(["connection-access-options"], { options: choices });
	render(
		<QueryClientProvider client={client}>
			<AccessRequestPanel
				onSubmitted={vi.fn()}
				providerId={request.providerId}
				renewalTarget={null}
				requests={[request]}
				requestsError={null}
				requestsPending={false}
				startProviderId=""
				startSignal={0}
			/>
		</QueryClientProvider>,
	);
	return client;
}

it("valid historical approval waits for administrator when no current option exists", () => {
	const request = pendingUpgradeRequest();
	const oldOption = {
		...currentUpgradeOption(),
		providerReleaseId: "datalego-v3",
	};
	const client = renderPendingUpgrade(request, [oldOption]);
	expect(screen.getByText(/新版暂未开放申请/)).toBeTruthy();
	expect(screen.getByText("待连接")).toBeTruthy();
	expect(screen.queryByRole("link", { name: "连接账号" })).toBeNull();
	expect(screen.queryByRole("button", { name: "按新版重新申请" })).toBeNull();
	expect(api.cancelConnectionAccessRequest).not.toHaveBeenCalled();
	expect(request.state).toBe("APPROVED_PENDING_CONNECTION");
	client.clear();
});

it("administrator publishing current options restores reapply without invalidating approval", async () => {
	const request = pendingUpgradeRequest();
	const client = renderPendingUpgrade(request, []);
	expect(screen.getByText(/新版暂未开放申请/)).toBeTruthy();
	await act(async () => {
		client.setQueryData(["connection-access-options"], {
			options: [currentUpgradeOption()],
		});
	});
	expect(
		await screen.findByRole("button", { name: "按新版重新申请" }),
	).toBeTruthy();
	expect(request.state).toBe("APPROVED_PENDING_CONNECTION");
	expect(api.cancelConnectionAccessRequest).not.toHaveBeenCalled();
	client.clear();
});

it("reapply keeps purpose and matching duration but requires current scope and disclaimer confirmation", async () => {
	const client = renderPendingUpgrade(pendingUpgradeRequest(), [
		currentUpgradeOption(),
	]);
	fireEvent.click(screen.getByRole("button", { name: "按新版重新申请" }));
	expect(api.submitConnectionAccessRequest).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: /新版只读能力包/ }));
	expect((screen.getByLabelText("用途") as HTMLTextAreaElement).value).toBe(
		"调查发布失败",
	);
	expect((screen.getByLabelText("申请时长") as HTMLSelectElement).value).toBe(
		"1",
	);
	expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(
		false,
	);
	expect(
		(screen.getByRole("button", { name: "提交申请" }) as HTMLButtonElement)
			.disabled,
	).toBe(true);
	fireEvent.click(screen.getByRole("checkbox"));
	fireEvent.click(screen.getByRole("button", { name: "提交申请" }));
	await waitFor(() =>
		expect(api.submitConnectionAccessRequest).toHaveBeenCalledOnce(),
	);
	expect(api.submitConnectionAccessRequest.mock.calls[0]?.[0]).toMatchObject({
		providerReleaseId: "datalego-v4",
		purpose: "调查发布失败",
		duration: { kind: "FINITE", days: 30 },
		disclaimerConfirmations: [{ disclaimerVersionId: "disclaimer-v4" }],
	});
	expect(api.cancelConnectionAccessRequest).not.toHaveBeenCalled();
	client.clear();
});

it("reapply does not substitute a duration that the applicant never selected", () => {
	const option = {
		...currentUpgradeOption(),
		durations: [{ kind: "FINITE" as const, days: 7 }],
	};
	const client = renderPendingUpgrade(pendingUpgradeRequest(), [option]);
	fireEvent.click(screen.getByRole("button", { name: "按新版重新申请" }));
	fireEvent.click(screen.getByRole("button", { name: /新版只读能力包/ }));
	expect((screen.getByLabelText("申请时长") as HTMLSelectElement).value).toBe(
		"-1",
	);
	fireEvent.click(screen.getByRole("checkbox"));
	expect(
		(screen.getByRole("button", { name: "提交申请" }) as HTMLButtonElement)
			.disabled,
	).toBe(true);
	client.clear();
});

it("a compatible request continues to connect under the original approval", () => {
	const request = pendingUpgradeRequest();
	request.connectReadiness = {
		status: "READY",
		targetProviderReleaseId: "datalego-v4",
	};
	const client = renderPendingUpgrade(request, []);
	expect(
		screen.getByRole("link", { name: "连接账号" }).getAttribute("href"),
	).toContain("accessRequestId=request-old");
	expect(screen.getByText("可连接")).toBeTruthy();
	expect(screen.queryByRole("button", { name: "按新版重新申请" })).toBeNull();
	client.clear();
});

it.each([false, true])(
	"old policy is hidden for new connections but retained for renewal (%s)",
	(renewal) => {
		const option = {
			...currentUpgradeOption(),
			providerReleaseId: "datalego-v3",
			availableForNewConnections: false,
		};
		const client = new QueryClient({
			defaultOptions: {
				queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
			},
		});
		client.setQueryData(["connection-access-options"], { options: [option] });
		render(
			<QueryClientProvider client={client}>
				<AccessRequestPanel
					onSubmitted={vi.fn()}
					providerId="datalego"
					renewalTarget={
						renewal
							? {
									id: "existing-access",
									capabilityProfileId: option.capabilityProfileId,
									providerReleaseId: option.providerReleaseId,
								}
							: null
					}
					requests={[]}
					requestsError={null}
					requestsPending={false}
					startProviderId="datalego"
					startSignal={1}
				/>
			</QueryClientProvider>,
		);
		if (renewal)
			expect(
				screen.getByRole("button", { name: /新版只读能力包/ }),
			).toBeTruthy();
		else expect(screen.getByText("当前没有可申请的连接能力。")).toBeTruthy();
		client.clear();
	},
);

it.each(["CONSUMED", "IN_REVIEW", "APPROVED_PENDING_CONNECTION"] as const)(
	"only collapses completed progress (%s), retaining details and actions",
	async (state) => {
		const client = new QueryClient();
		client.setQueryData(["connection-access-options"], { options: [] });
		const requests: AccessRequestsResponse["requests"] = [
			{
				id: "request-compact",
				providerId: "bitbucket",
				providerReleaseId: "bitbucket-v8",
				capabilityProfileName: "bitbucket full",
				connectExpiresAt: "2099-10-08T00:00:00Z",
				revision: "1",
				state,
				renewal: false,
				purpose: "协作",
				createdAt: "2026-09-30T00:00:00Z",
				expiresAt: "2099-10-08T00:00:00Z",
				duration: { kind: "PERMANENT" },
				currentStageOrdinal: 1,
				stages: [
					{
						ordinal: 1,
						name: "主管审批",
						state: "APPROVED",
						revision: "1",
						routingRevision: "1",
						openedAt: "2026-09-30T00:00:00Z",
						completedAt: "2026-09-30T00:01:00Z",
						decisions: [],
					},
				],
			},
		];
		const { container } = render(
			<QueryClientProvider client={client}>
				<AccessRequestPanel
					onSubmitted={vi.fn()}
					providerId="bitbucket"
					renewalTarget={null}
					requests={requests}
					requestsError={null}
					requestsPending={false}
					startProviderId=""
					startSignal={0}
				/>
			</QueryClientProvider>,
		);
		const details = container.querySelector("details");
		const summary = container.querySelector("summary");
		expect(details?.open).toBe(state !== "CONSUMED");
		expect(summary?.hidden).toBe(state !== "CONSUMED");
		if (state === "CONSUMED") {
			if (!summary) throw new Error("Progress summary missing");
			expect(summary.textContent).toContain("bitbucket full");
			expect(summary.textContent).toContain("永久");
			fireEvent.click(summary);
			expect(details?.open).toBe(true);
			expect(screen.getByText("主管审批")).toBeTruthy();
			fireEvent.click(summary);
			expect(details?.open).toBe(false);
			fireEvent.click(screen.getByRole("button", { name: /重新申请/ }));
			await waitFor(() =>
				expect(screen.getByText("当前没有可申请的连接能力。")).toBeTruthy(),
			);
		} else {
			expect(
				screen.getByRole(state === "IN_REVIEW" ? "button" : "link", {
					name: state === "IN_REVIEW" ? "取消申请" : "连接账号",
				}),
			).toBeTruthy();
		}
		client.clear();
	},
);

it("keeps disclaimer consent beside its text despite global input sizing", () => {
	const style = document.createElement("style");
	style.textContent = `input { width: 100%; min-height: 39px; }\n${readFileSync(
		resolve(import.meta.dirname, "approval-policies-page.css"),
		"utf8",
	)}`;
	const row = document.createElement("label");
	row.className = "approval-disclaimer-confirm";
	row.innerHTML =
		'<input type="checkbox"><span>我确认仅为已说明的工作目的申请 Connection。</span>';
	document.head.append(style);
	document.body.append(row);
	try {
		const checkbox = row.querySelector("input");
		if (!checkbox) throw new Error("Disclaimer checkbox is missing");
		expect(getComputedStyle(row).display).toBe("flex");
		expect(getComputedStyle(checkbox).width).toBe("16px");
		expect(getComputedStyle(checkbox).flex).toBe("0 0 16px");
		expect(getComputedStyle(checkbox).minHeight).toBe("0");
	} finally {
		style.remove();
		row.remove();
	}
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
