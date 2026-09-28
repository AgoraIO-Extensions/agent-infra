// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
	AccessPolicyDraftResponse,
	ApprovalDelegationsResponse,
	ApprovalPolicyCatalog,
	OutboxFailuresResponse,
} from "@agent-infra/connection-contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
	getApprovalPolicyStages: vi.fn(async () => ({ stages: [] })),
	getConnectionAccessPolicyDraft: vi.fn(
		async (): Promise<AccessPolicyDraftResponse> => ({
			policyId: "policy-1",
			revision: "4",
			candidates: [],
			draft: {
				allowPermanent: true,
				capabilityProfileId: "profile-1",
				providerReleaseId: "jira-release-1",
				connectTtlSeconds: 7200,
				requestTtlSeconds: 14400,
				renewalLeadSeconds: 3600,
				priority: 123,
				defaultDurationDays: 30,
				disclaimerVersionIds: [],
				durations: [{ kind: "FINITE", days: 30 }, { kind: "PERMANENT" }],
				stages: [
					{
						name: "待配置审批人",
						quorumType: "ANY",
						timeoutSeconds: 86400,
						approverCandidateIds: [],
					},
				],
			},
		}),
	),
	updateConnectionAccessPolicy: vi.fn(async (_input: unknown) => ({
		policyVersionId: "policy-1",
	})),
	listApprovalPolicyCatalog: vi.fn(
		async (): Promise<ApprovalPolicyCatalog> => ({
			profiles: [],
			policies: [],
			disclaimers: [],
			providers: [],
		}),
	),
	getApprovalCapabilityProfile: vi.fn(async (id: string) => ({
		profile: {
			id,
			providerReleaseId: "jira-release-1",
			name: "Jira Read",
			effectCeiling: "READ" as const,
			revision: "1",
			status: "PUBLISHED",
			actions: [
				{
					id: "jira.read@v1",
					name: "jira.read",
					description: "Read",
					effect: "READ" as const,
					status: "PUBLISHED",
				},
			],
		},
	})),
	createApprovalCapabilityProfile: vi.fn(async (_body: unknown) => ({
		capabilityProfileId: "profile-created",
	})),
	updateApprovalCapabilityProfileDraft: vi.fn(async (_input: unknown) => ({
		capabilityProfileId: "draft-1",
	})),
	publishApprovalCapabilityProfile: vi.fn(async (_id: string) => undefined),
	createApprovalDisclaimer: vi.fn(async (_body: unknown) => ({
		disclaimerVersionId: "disclaimer-created",
	})),
	updateApprovalDisclaimerDraft: vi.fn(async (_input: unknown) => ({
		disclaimerVersionId: "disclaimer-1",
	})),
	publishApprovalDisclaimer: vi.fn(async (_id: string) => undefined),
	listApprovalRoutingBlocked: vi.fn(async () => ({ requests: [] })),
	listOutboxFailures: vi.fn(
		async (): Promise<OutboxFailuresResponse> => ({ events: [] }),
	),
	retryOutboxFailure: vi.fn(async (_id: string, _attempts: number) => ({
		eventId: "event-1",
	})),
	listApprovalDelegations: vi.fn(
		async (): Promise<ApprovalDelegationsResponse> => ({ delegations: [] }),
	),
	searchApprovalEmployees: vi.fn(async (query: string) => ({
		candidates: [
			{
				candidateId: `candidate-${query}`,
				displayName: query,
				email: null,
				alias: null,
			},
		],
	})),
	createApprovalDelegation: vi.fn(async (_body: unknown) => ({
		delegationId: "delegation-1",
	})),
	revokeApprovalDelegation: vi.fn(async (_id: string, _revision: string) => ({
		delegationId: "delegation-1",
	})),
	listAdminAccessAuthorizations: vi.fn(async () => ({
		authorizations: [
			{
				id: "access-1",
				connectionId: "connection-1",
				providerId: "jira",
				ownerDisplayName: "张三",
				state: "ACTIVE",
				revision: "7",
				validUntil: "2030-01-01T00:00:00.000Z",
			},
		],
	})),
	revokeAdminAccessAuthorization: vi.fn(async (_input: unknown) => ({
		authorizationId: "access-1",
	})),
	createReapprovalCampaign: vi.fn(async (_body: unknown) => ({
		campaignId: "campaign-1",
		affectedConnections: 1,
	})),
	publishConnectionAccessPolicy: vi.fn(async (_input: unknown) => undefined),
	revokeConnectionAccessPolicy: vi.fn(async (_input: unknown) => ({
		policyVersionId: "policy-1",
		canceledRequests: 2,
		suspendedConnections: 1,
	})),
}));

vi.mock("../api", () => ({ connectionApi: api }));
vi.mock("../shell", () => ({
	ConsoleShell: ({ children }: { children: ReactNode }) => <>{children}</>,
	PageError: () => <div role="alert">请求失败</div>,
}));

import { ApprovalPoliciesPage } from "./approval-policies-page";

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	vi.restoreAllMocks();
});

it("creates an exact capability draft from the independent catalog without publishing it", async () => {
	const actions = [
		{
			id: "read-user",
			name: "github.get_current_user",
			effect: "READ" as const,
		},
		{
			id: "read-branches",
			name: "github.list_branches",
			effect: "READ" as const,
		},
		{
			id: "write-repo",
			name: "github.create_repository",
			effect: "WRITE" as const,
		},
		{
			id: "write-branch",
			name: "github.delete_branch",
			effect: "WRITE" as const,
		},
	];
	api.listApprovalPolicyCatalog.mockResolvedValueOnce({
		profiles: [],
		policies: [],
		disclaimers: [],
		providers: [
			{ provider: "github", providerReleaseId: "github-release", actions },
			{
				provider: "jira",
				providerReleaseId: "jira-release",
				actions: [
					{ id: "jira-write", name: "jira.create_issue", effect: "WRITE" },
				],
			},
		],
	});
	const { container } = render(
		<QueryClientProvider
			client={
				new QueryClient({ defaultOptions: { queries: { retry: false } } })
			}
		>
			<ApprovalPoliciesPage />
		</QueryClientProvider>,
	);
	fireEvent.click(screen.getByRole("tab", { name: "目录管理" }));
	fireEvent.click(screen.getByRole("button", { name: "新建能力包" }));
	expect(
		(screen.getByRole("button", { name: "全选" }) as HTMLButtonElement)
			.disabled,
	).toBe(true);
	await screen.findByRole("option", { name: /github · github-release/ });
	fireEvent.change(screen.getByRole("combobox", { name: "Provider" }), {
		target: { value: "github-release" },
	});
	expect(screen.getByText("已选 0 / 4")).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "仅只读" }));
	expect(screen.getByText("已选 2 / 4")).toBeTruthy();
	expect(
		(
			screen.getByRole("checkbox", {
				name: /github.get_current_user/,
			}) as HTMLInputElement
		).checked,
	).toBe(true);
	fireEvent.change(screen.getByRole("searchbox", { name: "搜索能力" }), {
		target: { value: "create" },
	});
	expect(
		container.querySelectorAll('.approval-action-list input[type="checkbox"]'),
	).toHaveLength(1);
	fireEvent.click(screen.getByRole("button", { name: "全选" }));
	expect(screen.getByText("已选 4 / 4")).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "清空" }));
	expect(screen.getByText("已选 0 / 4")).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "仅只写" }));
	expect(screen.getByText("已选 2 / 4")).toBeTruthy();
	fireEvent.change(screen.getByRole("searchbox", { name: "搜索能力" }), {
		target: { value: "" },
	});
	fireEvent.click(
		screen.getByRole("checkbox", { name: /github.get_current_user/ }),
	);
	expect(screen.getByText("已选 3 / 4")).toBeTruthy();
	fireEvent.change(screen.getByRole("combobox", { name: "Provider" }), {
		target: { value: "jira-release" },
	});
	expect(screen.getByText("已选 0 / 1")).toBeTruthy();
	expect(
		screen.getByRole("searchbox", { name: "搜索能力" }).getAttribute("value"),
	).toBe("");
	expect(
		(screen.getByRole("button", { name: "仅只读" }) as HTMLButtonElement)
			.disabled,
	).toBe(true);
	fireEvent.change(screen.getByRole("combobox", { name: "Provider" }), {
		target: { value: "github-release" },
	});
	expect(screen.getByText("已选 0 / 4")).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "仅只写" }));
	fireEvent.click(
		screen.getByRole("checkbox", { name: /github.get_current_user/ }),
	);
	fireEvent.change(screen.getByRole("textbox", { name: "名称" }), {
		target: { value: "GitHub Mixed" },
	});
	fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
	await waitFor(() =>
		expect(api.createApprovalCapabilityProfile).toHaveBeenCalledOnce(),
	);
	expect(api.createApprovalCapabilityProfile.mock.calls[0]?.[0]).toEqual({
		providerReleaseId: "github-release",
		name: "GitHub Mixed",
		actionVersionIds: ["write-repo", "write-branch", "read-user"],
	});
	expect(api.publishApprovalCapabilityProfile).not.toHaveBeenCalled();
});

it("shows exact published actions and required disclaimer content in a policy", async () => {
	api.listApprovalPolicyCatalog.mockResolvedValueOnce({
		profiles: [
			{
				id: "profile-1",
				providerReleaseId: "github-release",
				name: "GitHub read",
				effectCeiling: "READ",
				revision: "1",
				status: "PUBLISHED",
			},
		],
		policies: [],
		providers: [
			{ provider: "github", providerReleaseId: "github-release", actions: [] },
		],
		disclaimers: [
			{
				id: "global-1",
				kind: "GLOBAL",
				revision: "1",
				providerId: null,
				locale: "zh-CN",
				content: "正式全局条款",
				materialChange: false,
				status: "PUBLISHED",
			},
			{
				id: "github-1",
				kind: "PROVIDER",
				revision: "1",
				providerId: "github",
				locale: "zh-CN",
				content: "GitHub 附加正文",
				materialChange: false,
				status: "PUBLISHED",
			},
		],
	});
	api.getApprovalCapabilityProfile.mockResolvedValueOnce({
		profile: {
			id: "profile-1",
			providerReleaseId: "github-release",
			name: "GitHub read",
			effectCeiling: "READ",
			revision: "1",
			status: "PUBLISHED",
			actions: [
				{
					id: "read-1",
					name: "github.get_issue",
					description: "Read an issue",
					effect: "READ",
					status: "PUBLISHED",
				},
			],
		},
	});
	render(
		<QueryClientProvider
			client={
				new QueryClient({ defaultOptions: { queries: { retry: false } } })
			}
		>
			<ApprovalPoliciesPage />
		</QueryClientProvider>,
	);
	fireEvent.click(screen.getByRole("tab", { name: "能力与条款" }));
	await screen.findByRole("option", { name: /github · github-release/ });
	fireEvent.change(screen.getByRole("combobox", { name: "Provider" }), {
		target: { value: "github-release" },
	});
	fireEvent.change(screen.getByRole("combobox", { name: "能力包" }), {
		target: { value: "profile-1" },
	});
	expect(await screen.findByText("Read an issue")).toBeTruthy();
	expect(screen.getByText("github.get_issue")).toBeTruthy();
	const global = screen.getByRole("checkbox", {
		name: /全局基础条款/,
	}) as HTMLInputElement;
	expect(global.checked).toBe(true);
	expect(global.disabled).toBe(true);
	expect(screen.getByText("正式全局条款")).toBeTruthy();
	fireEvent.click(screen.getByRole("checkbox", { name: /github 附加条款/ }));
	expect(screen.getByText("GitHub 附加正文")).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "在目录中复制或管理" }));
	expect(
		screen
			.getByRole("region", { name: "目录管理" })
			.querySelector(".approval-directory-list > button.active")?.textContent,
	).toContain("GitHub read");
});

it("does not invent a global disclaimer for an existing policy", async () => {
	api.listApprovalPolicyCatalog.mockResolvedValueOnce({
		profiles: [
			{
				id: "profile-1",
				providerReleaseId: "github-release",
				name: "GitHub read",
				effectCeiling: "READ",
				revision: "2",
				status: "PUBLISHED",
			},
		],
		policies: [
			{
				id: "policy-1",
				providerReleaseId: "github-release",
				capabilityProfileId: "profile-1",
				materialChange: false,
				status: "PUBLISHED",
				revision: "2",
				disclaimerVersionIds: [],
			},
		],
		providers: [
			{ provider: "github", providerReleaseId: "github-release", actions: [] },
		],
		disclaimers: [
			{
				id: "global-1",
				kind: "GLOBAL",
				providerId: null,
				locale: "zh-CN",
				content: "未绑定条款",
				materialChange: false,
				revision: "1",
				status: "PUBLISHED",
			},
		],
	});
	render(
		<QueryClientProvider
			client={
				new QueryClient({ defaultOptions: { queries: { retry: false } } })
			}
		>
			<ApprovalPoliciesPage />
		</QueryClientProvider>,
	);
	fireEvent.click(screen.getByRole("tab", { name: "能力与条款" }));
	expect(await screen.findByText("当前策略未绑定全局基础条款。")).toBeTruthy();
	expect(screen.queryByText("未绑定条款")).toBeNull();
});

it("copies a published profile into a draft and publishes only on an explicit command", async () => {
	api.listApprovalPolicyCatalog.mockResolvedValueOnce({
		profiles: [
			{
				id: "profile-1",
				providerReleaseId: "github-release",
				name: "GitHub read",
				effectCeiling: "READ",
				revision: "1",
				status: "PUBLISHED",
			},
		],
		policies: [],
		disclaimers: [],
		providers: [
			{
				provider: "github",
				providerReleaseId: "github-release",
				actions: [
					{ id: "read-1", name: "github.get_issue", effect: "READ" },
					{ id: "write-1", name: "github.create_issue", effect: "WRITE" },
				],
			},
		],
	});
	api.getApprovalCapabilityProfile.mockResolvedValueOnce({
		profile: {
			id: "profile-1",
			providerReleaseId: "github-release",
			name: "GitHub read",
			effectCeiling: "READ",
			revision: "1",
			status: "PUBLISHED",
			actions: [
				{
					id: "read-1",
					name: "github.get_issue",
					description: "Read an issue",
					effect: "READ",
					status: "PUBLISHED",
				},
			],
		},
	});
	render(
		<QueryClientProvider
			client={
				new QueryClient({ defaultOptions: { queries: { retry: false } } })
			}
		>
			<ApprovalPoliciesPage />
		</QueryClientProvider>,
	);
	fireEvent.click(screen.getByRole("tab", { name: "目录管理" }));
	await screen.findByText("Read an issue");
	fireEvent.click(screen.getByRole("button", { name: "复制为新能力包" }));
	expect(
		(screen.getByRole("textbox", { name: "名称" }) as HTMLInputElement).value,
	).toBe("GitHub read 新版");
	fireEvent.change(screen.getByRole("textbox", { name: "名称" }), {
		target: { value: "GitHub read" },
	});
	expect(screen.getByRole("alert").textContent).toContain(
		"同名发布会替换现有能力包",
	);
	expect(
		(screen.getByRole("button", { name: "保存草稿" }) as HTMLButtonElement)
			.disabled,
	).toBe(true);
	fireEvent.change(screen.getByRole("textbox", { name: "名称" }), {
		target: { value: "GitHub read 新版" },
	});
	expect(
		(
			screen.getByRole("checkbox", {
				name: /github.get_issue/,
			}) as HTMLInputElement
		).checked,
	).toBe(true);
	fireEvent.click(
		screen.getByRole("checkbox", { name: /github.create_issue/ }),
	);
	fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
	await waitFor(() =>
		expect(api.createApprovalCapabilityProfile).toHaveBeenCalledOnce(),
	);
	expect(api.createApprovalCapabilityProfile.mock.calls[0]?.[0]).toEqual({
		providerReleaseId: "github-release",
		name: "GitHub read 新版",
		actionVersionIds: ["read-1", "write-1"],
	});
	expect(api.publishApprovalCapabilityProfile).not.toHaveBeenCalled();
});

it("publishes an existing capability draft from the directory", async () => {
	api.listApprovalPolicyCatalog.mockResolvedValueOnce({
		profiles: [
			{
				id: "draft-1",
				providerReleaseId: "github-release",
				name: "GitHub draft",
				effectCeiling: "READ",
				revision: "1",
				status: "DRAFT",
			},
		],
		policies: [],
		disclaimers: [],
		providers: [
			{ provider: "github", providerReleaseId: "github-release", actions: [] },
		],
	});
	api.getApprovalCapabilityProfile.mockResolvedValueOnce({
		profile: {
			id: "draft-1",
			providerReleaseId: "github-release",
			name: "GitHub draft",
			effectCeiling: "READ",
			revision: "1",
			status: "DRAFT",
			actions: [
				{
					id: "read-1",
					name: "github.get_issue",
					description: "Read an issue",
					effect: "READ",
					status: "PUBLISHED",
				},
			],
		},
	});
	render(
		<QueryClientProvider
			client={
				new QueryClient({ defaultOptions: { queries: { retry: false } } })
			}
		>
			<ApprovalPoliciesPage />
		</QueryClientProvider>,
	);
	fireEvent.click(screen.getByRole("tab", { name: "目录管理" }));
	await screen.findByText("Read an issue");
	fireEvent.click(screen.getByRole("button", { name: "发布能力包" }));
	await waitFor(() =>
		expect(api.publishApprovalCapabilityProfile).toHaveBeenCalledOnce(),
	);
	expect(api.publishApprovalCapabilityProfile.mock.calls[0]?.[0]).toBe(
		"draft-1",
	);
});

it("updates a capability draft with its current revision", async () => {
	api.listApprovalPolicyCatalog.mockResolvedValueOnce({
		profiles: [
			{
				id: "draft-1",
				providerReleaseId: "github-release",
				name: "GitHub draft",
				effectCeiling: "READ",
				revision: "1",
				status: "DRAFT",
			},
		],
		policies: [],
		disclaimers: [],
		providers: [
			{
				provider: "github",
				providerReleaseId: "github-release",
				actions: [{ id: "read-1", name: "github.get_issue", effect: "READ" }],
			},
		],
	});
	api.getApprovalCapabilityProfile.mockResolvedValueOnce({
		profile: {
			id: "draft-1",
			providerReleaseId: "github-release",
			name: "GitHub draft",
			effectCeiling: "READ",
			revision: "1",
			status: "DRAFT",
			actions: [
				{
					id: "read-1",
					name: "github.get_issue",
					description: "Read an issue",
					effect: "READ",
					status: "PUBLISHED",
				},
			],
		},
	});
	render(
		<QueryClientProvider
			client={
				new QueryClient({ defaultOptions: { queries: { retry: false } } })
			}
		>
			<ApprovalPoliciesPage />
		</QueryClientProvider>,
	);
	fireEvent.click(screen.getByRole("tab", { name: "目录管理" }));
	await screen.findByText("Read an issue");
	fireEvent.click(screen.getByRole("button", { name: "修改草稿" }));
	fireEvent.change(screen.getByRole("textbox", { name: "名称" }), {
		target: { value: "GitHub draft revised" },
	});
	fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
	await waitFor(() =>
		expect(api.updateApprovalCapabilityProfileDraft).toHaveBeenCalledOnce(),
	);
	expect(api.updateApprovalCapabilityProfileDraft.mock.calls[0]?.[0]).toEqual({
		profileId: "draft-1",
		revision: "1",
		body: {
			name: "GitHub draft revised",
			providerReleaseId: "github-release",
			actionVersionIds: ["read-1"],
		},
	});
	expect(api.publishApprovalCapabilityProfile).not.toHaveBeenCalled();
});

it("updates a disclaimer draft without publishing it", async () => {
	api.listApprovalPolicyCatalog.mockResolvedValueOnce({
		profiles: [],
		policies: [],
		providers: [
			{ provider: "github", providerReleaseId: "github-release", actions: [] },
		],
		disclaimers: [
			{
				id: "disclaimer-1",
				kind: "PROVIDER",
				providerId: "github",
				locale: "zh-CN",
				content: "原条款",
				revision: "1",
				materialChange: false,
				status: "DRAFT",
			},
		],
	});
	render(
		<QueryClientProvider
			client={
				new QueryClient({ defaultOptions: { queries: { retry: false } } })
			}
		>
			<ApprovalPoliciesPage />
		</QueryClientProvider>,
	);
	fireEvent.click(screen.getByRole("tab", { name: "目录管理" }));
	fireEvent.click(screen.getByRole("tab", { name: "免责声明" }));
	fireEvent.click(await screen.findByRole("button", { name: "修改草稿" }));
	fireEvent.change(screen.getByRole("textbox", { name: "条款正文" }), {
		target: { value: "修订条款" },
	});
	fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
	await waitFor(() =>
		expect(api.updateApprovalDisclaimerDraft).toHaveBeenCalledOnce(),
	);
	expect(api.updateApprovalDisclaimerDraft.mock.calls[0]?.[0]).toEqual({
		disclaimerId: "disclaimer-1",
		revision: "1",
		body: {
			kind: "PROVIDER",
			providerId: "github",
			locale: "zh-CN",
			content: "修订条款",
			materialChange: false,
		},
	});
	expect(api.publishApprovalDisclaimer).not.toHaveBeenCalled();
});

it("keeps the action checklist compact despite global input styles", () => {
	const style = document.createElement("style");
	style.textContent = readFileSync(
		resolve(import.meta.dirname, "approval-policies-page.css"),
		"utf8",
	);
	const checklist = document.createElement("div");
	checklist.className = "approval-catalog-editor";
	checklist.innerHTML =
		'<div class="approval-action-list"><label><input type="checkbox"><span>github.get_current_user</span><small>READ</small></label></div>';
	document.head.append(style);
	document.body.append(checklist);
	try {
		const checkbox = checklist.querySelector("input");
		const row = checklist.querySelector("label");
		if (!checkbox || !row) throw new Error("Capability checklist is missing");
		expect(getComputedStyle(checkbox).width).toBe("16px");
		expect(getComputedStyle(checkbox).minHeight).toBe("16px");
		expect(getComputedStyle(row).display).toBe("grid");
		expect(getComputedStyle(row).gridTemplateColumns).toBe(
			"16px minmax(0, 1fr) auto",
		);
	} finally {
		style.remove();
		checklist.remove();
	}
});

it("shows only current-provider disclaimers and clears hidden selections", async () => {
	api.listApprovalPolicyCatalog.mockResolvedValueOnce({
		profiles: [],
		policies: [],
		providers: [
			{ provider: "github", providerReleaseId: "github-release", actions: [] },
			{ provider: "jira", providerReleaseId: "jira-release", actions: [] },
		],
		disclaimers: [
			{
				id: "global",
				kind: "GLOBAL",
				revision: "1",
				providerId: null,
				locale: "zh-CN",
				content: "基础条款",
				materialChange: false,
				status: "PUBLISHED",
			},
			{
				id: "github",
				kind: "PROVIDER",
				revision: "1",
				providerId: "github",
				locale: "zh-CN",
				content: "GitHub 条款",
				materialChange: false,
				status: "PUBLISHED",
			},
			{
				id: "jira",
				kind: "PROVIDER",
				revision: "1",
				providerId: "jira",
				locale: "zh-CN",
				content: "Jira 条款",
				materialChange: false,
				status: "PUBLISHED",
			},
		],
	});
	render(
		<QueryClientProvider
			client={
				new QueryClient({ defaultOptions: { queries: { retry: false } } })
			}
		>
			<ApprovalPoliciesPage />
		</QueryClientProvider>,
	);
	fireEvent.click(screen.getByRole("tab", { name: "能力与条款" }));
	const global = (await screen.findByRole("checkbox", {
		name: /全局基础条款 · zh-CN/,
	})) as HTMLInputElement;
	expect(global.checked).toBe(true);
	expect(global.disabled).toBe(true);
	expect(
		screen.queryByRole("checkbox", { name: /附加条款 · zh-CN/ }),
	).toBeNull();
	fireEvent.change(screen.getByRole("combobox", { name: "Provider" }), {
		target: { value: "github-release" },
	});
	const github = screen.getByRole("checkbox", {
		name: "github 附加条款 · zh-CN",
	}) as HTMLInputElement;
	fireEvent.click(github);
	fireEvent.change(screen.getByRole("combobox", { name: "Provider" }), {
		target: { value: "jira-release" },
	});
	expect(
		screen.queryByRole("checkbox", { name: "github 附加条款 · zh-CN" }),
	).toBeNull();
	expect(
		screen.getByRole("checkbox", { name: "jira 附加条款 · zh-CN" }),
	).toBeTruthy();
	expect(global.checked).toBe(true);
	fireEvent.change(screen.getByRole("combobox", { name: "Provider" }), {
		target: { value: "github-release" },
	});
	expect(
		(
			screen.getByRole("checkbox", {
				name: "github 附加条款 · zh-CN",
			}) as HTMLInputElement
		).checked,
	).toBe(false);
	fireEvent.change(screen.getByRole("combobox", { name: "Provider" }), {
		target: { value: "" },
	});
	expect(
		screen.queryByRole("checkbox", { name: /附加条款 · zh-CN/ }),
	).toBeNull();
	expect(global.checked).toBe(true);
});

it("keeps disclaimer and permanent-duration controls compact and clickable", async () => {
	api.listApprovalPolicyCatalog.mockResolvedValueOnce({
		profiles: [],
		policies: [],
		providers: [],
		disclaimers: [
			{
				id: "disclaimer-1",
				kind: "GLOBAL",
				revision: "1",
				locale: "zh-CN",
				content: "测试条款",
				materialChange: false,
				providerId: null,
				status: "PUBLISHED",
			},
		],
	});
	const style = document.createElement("style");
	style.textContent = readFileSync(
		resolve(import.meta.dirname, "approval-policies-page.css"),
		"utf8",
	);
	document.head.append(style);
	try {
		render(
			<QueryClientProvider
				client={
					new QueryClient({ defaultOptions: { queries: { retry: false } } })
				}
			>
				<ApprovalPoliciesPage />
			</QueryClientProvider>,
		);
		fireEvent.click(screen.getByRole("tab", { name: "能力与条款" }));
		const disclaimer = (await screen.findByRole("checkbox", {
			name: /全局基础条款 · zh-CN/,
		})) as HTMLInputElement;
		const permanent = screen.getByRole("checkbox", {
			name: "允许永久有效",
		}) as HTMLInputElement;
		for (const checkbox of [disclaimer, permanent]) {
			expect(getComputedStyle(checkbox).width).toBe("16px");
			expect(getComputedStyle(checkbox).minHeight).toBe("16px");
		}
		fireEvent.click(screen.getByText("允许永久有效"));
		expect(disclaimer.checked).toBe(true);
		expect(disclaimer.disabled).toBe(true);
		expect(permanent.checked).toBe(true);
		fireEvent.click(screen.getByRole("tab", { name: "目录管理" }));
		fireEvent.click(screen.getByRole("tab", { name: "免责声明" }));
		fireEvent.click(screen.getByRole("button", { name: "新建免责声明" }));
		const material = screen.getByRole("checkbox", {
			name: "重大内容变化",
		}) as HTMLInputElement;
		fireEvent.click(material);
		expect(material.checked).toBe(true);
	} finally {
		style.remove();
	}
});

it("does not clip employee candidates at the approval panel boundary", async () => {
	const style = document.createElement("style");
	style.textContent = readFileSync(
		resolve(import.meta.dirname, "approval-policies-page.css"),
		"utf8",
	);
	document.head.append(style);
	try {
		const { container } = render(
			<QueryClientProvider
				client={
					new QueryClient({ defaultOptions: { queries: { retry: false } } })
				}
			>
				<ApprovalPoliciesPage />
			</QueryClientProvider>,
		);
		fireEvent.change(screen.getByRole("combobox", { name: "审批人" }), {
			target: { value: "guo" },
		});
		await screen.findByRole("option", { name: "guo" });
		const panel = container.querySelector(".approval-layout");
		const dropdown = container.querySelector(".employee-picker-dropdown");
		if (!panel || !dropdown)
			throw new Error("Employee dropdown must be inside the approval editor");
		expect(panel.contains(dropdown)).toBe(true);
		expect(getComputedStyle(panel).overflow).toBe("visible");
		expect(getComputedStyle(dropdown).overflowY).toBe("auto");
		expect(getComputedStyle(dropdown).maxHeight).toBe("260px");
	} finally {
		style.remove();
	}
});

it.each([
	{ defaultDays: 30, setDefault: false },
	{ defaultDays: undefined, setDefault: false },
	{ defaultDays: undefined, setDefault: true },
])(
	"preserves or completes an incomplete draft default: %j",
	async ({ defaultDays, setDefault }) => {
		const loaded = await api.getConnectionAccessPolicyDraft();
		loaded.draft.defaultDurationDays = defaultDays;
		loaded.draft.allowPermanent = defaultDays !== undefined;
		loaded.draft.durations = [{ kind: "FINITE", days: 30 }];
		api.getConnectionAccessPolicyDraft.mockResolvedValueOnce(loaded);
		api.listApprovalPolicyCatalog.mockResolvedValueOnce({
			profiles: [
				{
					id: "profile-1",
					name: "Jira Read",
					providerReleaseId: "jira-release-1",
					effectCeiling: "READ",
					revision: "1",
					status: "PUBLISHED",
				},
			],
			providers: [
				{ provider: "jira", providerReleaseId: "jira-release-1", actions: [] },
			],
			disclaimers: [],
			policies: [
				{
					id: "policy-1",
					capabilityProfileId: "profile-1",
					providerReleaseId: "jira-release-1",
					revision: "4",
					status: "DRAFT",
					materialChange: false,
					disclaimerVersionIds: [],
				},
			],
		});
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		render(
			<QueryClientProvider client={client}>
				<ApprovalPoliciesPage />
			</QueryClientProvider>,
		);
		fireEvent.click(await screen.findByRole("button", { name: "编辑草稿" }));
		const name = await screen.findByLabelText("阶段名称");
		expect((name as HTMLInputElement).value).toBe("待配置审批人");
		fireEvent.change(name, { target: { value: "安全审批" } });
		if (defaultDays === undefined) {
			fireEvent.click(screen.getByRole("tab", { name: "能力与条款" }));
			const duration = screen.getByLabelText(
				"允许时长（天）",
			) as HTMLInputElement;
			expect(duration.value).toBe("");
			if (setDefault) fireEvent.change(duration, { target: { value: "90" } });
		}
		expect(screen.queryByRole("button", { name: "发布策略" })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
		await waitFor(() =>
			expect(api.updateConnectionAccessPolicy).toHaveBeenCalledOnce(),
		);
		expect(api.updateConnectionAccessPolicy.mock.calls[0]?.[0]).toMatchObject({
			policyId: "policy-1",
			revision: "4",
			body: {
				priority: 123,
				connectTtlSeconds: 7200,
				requestTtlSeconds: 14400,
				renewalLeadSeconds: 3600,
				defaultDurationDays: setDefault ? 90 : defaultDays,
				allowPermanent: defaultDays !== undefined,
				disclaimerVersionIds: [],
				stages: [{ name: "安全审批", approverCandidateIds: [] }],
			},
		});
		const saved = api.updateConnectionAccessPolicy.mock.calls[0]?.[0] as {
			body: { durations: unknown[] };
		};
		expect(saved.body.durations).toEqual([
			{ kind: "FINITE", days: setDefault ? 90 : 30 },
			...(defaultDays !== undefined ? [{ kind: "PERMANENT" }] : []),
		]);
	},
);

it("publishes a material policy only with an explicit reapproval deadline", async () => {
	api.listApprovalPolicyCatalog.mockResolvedValueOnce({
		profiles: [],
		disclaimers: [
			{
				id: "global-1",
				kind: "GLOBAL",
				providerId: null,
				locale: "zh-CN",
				content: "基础条款",
				materialChange: false,
				revision: "1",
				status: "PUBLISHED",
			},
		],
		providers: [],
		policies: [
			{
				id: "policy-1",
				providerReleaseId: "jira-release-1",
				capabilityProfileId: "profile-1",
				materialChange: false,
				status: "DRAFT",
				revision: "1",
				disclaimerVersionIds: ["global-1"],
			},
		],
	});
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={client}>
			<ApprovalPoliciesPage />
		</QueryClientProvider>,
	);
	fireEvent.click(await screen.findByRole("button", { name: "发布策略" }));
	fireEvent.click(
		screen.getByRole("checkbox", { name: "重大变更，既有资格限期重审" }),
	);
	fireEvent.change(screen.getByLabelText("重审截止时间"), {
		target: { value: "2030-01-01T00:00" },
	});
	fireEvent.change(screen.getByLabelText("变更原因"), {
		target: { value: "数据用途变化" },
	});
	fireEvent.click(screen.getByRole("button", { name: "确认发布" }));
	await waitFor(() =>
		expect(api.publishConnectionAccessPolicy).toHaveBeenCalledOnce(),
	);
	expect(api.publishConnectionAccessPolicy.mock.calls[0]?.[0]).toMatchObject({
		policyId: "policy-1",
		body: { materialChange: true, reason: "数据用途变化" },
	});
});

it("keeps a draft without a global disclaimer unpublished", async () => {
	api.listApprovalPolicyCatalog.mockResolvedValueOnce({
		profiles: [],
		disclaimers: [],
		providers: [],
		policies: [
			{
				id: "policy-1",
				providerReleaseId: "jira-release-1",
				capabilityProfileId: "profile-1",
				materialChange: false,
				status: "DRAFT",
				revision: "1",
				disclaimerVersionIds: [],
			},
		],
	});
	render(
		<QueryClientProvider
			client={
				new QueryClient({ defaultOptions: { queries: { retry: false } } })
			}
		>
			<ApprovalPoliciesPage />
		</QueryClientProvider>,
	);
	expect(
		(
			(await screen.findByRole("button", {
				name: "发布策略",
			})) as HTMLButtonElement
		).disabled,
	).toBe(true);
});

it("revokes the current policy with its revision and reason", async () => {
	api.listApprovalPolicyCatalog.mockResolvedValueOnce({
		profiles: [],
		disclaimers: [],
		providers: [],
		policies: [
			{
				id: "policy-1",
				providerReleaseId: "jira-release-1",
				capabilityProfileId: "profile-1",
				materialChange: false,
				status: "PUBLISHED",
				revision: "7",
				disclaimerVersionIds: [],
			},
		],
	});
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={client}>
			<ApprovalPoliciesPage />
		</QueryClientProvider>,
	);
	fireEvent.click(await screen.findByRole("button", { name: "撤销策略" }));
	fireEvent.change(screen.getByLabelText("撤销原因"), {
		target: { value: "紧急安全事件" },
	});
	fireEvent.click(screen.getByRole("button", { name: "确认撤销" }));
	await waitFor(() =>
		expect(api.revokeConnectionAccessPolicy).toHaveBeenCalledOnce(),
	);
	expect(api.revokeConnectionAccessPolicy.mock.calls[0]?.[0]).toEqual({
		policyId: "policy-1",
		body: { expectedRevision: "7", reason: "紧急安全事件" },
	});
});

it("selects employee candidates and creates a bounded delegation", async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={client}>
			<ApprovalPoliciesPage />
		</QueryClientProvider>,
	);
	fireEvent.change(screen.getByLabelText("原审批人"), {
		target: { value: "张三" },
	});
	fireEvent.click(await screen.findByRole("option", { name: "张三" }));
	fireEvent.change(screen.getByLabelText("代理审批人"), {
		target: { value: "李四" },
	});
	fireEvent.click(await screen.findByRole("option", { name: "李四" }));
	fireEvent.change(screen.getByLabelText("开始时间"), {
		target: { value: "2030-01-01T00:00" },
	});
	fireEvent.change(screen.getByLabelText("结束时间"), {
		target: { value: "2030-01-02T00:00" },
	});
	fireEvent.click(screen.getByRole("button", { name: "添加代理" }));
	await waitFor(() =>
		expect(api.createApprovalDelegation).toHaveBeenCalledOnce(),
	);
	expect(api.createApprovalDelegation.mock.calls[0]?.[0]).toMatchObject({
		principalCandidateId: "candidate-张三",
		delegateCandidateId: "candidate-李四",
	});
});

it("revokes the selected delegation using its current revision", async () => {
	api.listApprovalDelegations.mockResolvedValueOnce({
		delegations: [
			{
				id: "delegation-1",
				principalId: "approver-1",
				principalName: "张三",
				delegatePrincipalId: "delegate-1",
				delegateName: "李四",
				startsAt: "2030-01-01T00:00:00Z",
				endsAt: "2030-01-02T00:00:00Z",
				revision: "7",
				status: "ACTIVE",
			},
		],
	});
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={client}>
			<ApprovalPoliciesPage />
		</QueryClientProvider>,
	);
	fireEvent.click(await screen.findByRole("button", { name: "撤销" }));
	await waitFor(() =>
		expect(api.revokeApprovalDelegation).toHaveBeenCalledWith(
			"delegation-1",
			"7",
		),
	);
});

it("requeues only the selected failed projection event", async () => {
	api.listOutboxFailures.mockResolvedValueOnce({
		events: [
			{
				id: "event-1",
				topic: "connection.access-request.created",
				attemptCount: 10,
				createdAt: "2026-09-25T00:00:00Z",
			},
		],
	});
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={client}>
			<ApprovalPoliciesPage />
		</QueryClientProvider>,
	);
	fireEvent.click(await screen.findByRole("button", { name: "重投递" }));
	await waitFor(() =>
		expect(api.retryOutboxFailure).toHaveBeenCalledWith("event-1", 10),
	);
});

it("requires confirmation and sends the current revision when revoking access", async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	vi.spyOn(window, "confirm").mockReturnValue(true);
	render(
		<QueryClientProvider client={client}>
			<ApprovalPoliciesPage />
		</QueryClientProvider>,
	);
	fireEvent.click(
		await screen.findByRole("button", { name: "撤销 张三 的 jira 资格" }),
	);
	await waitFor(() =>
		expect(api.revokeAdminAccessAuthorization).toHaveBeenCalledOnce(),
	);
	expect(api.revokeAdminAccessAuthorization.mock.calls[0]?.[0]).toEqual({
		authorizationId: "access-1",
		body: { expectedRevision: "7" },
	});
});

it("publishes a material disclaimer reapproval campaign with a chosen deadline", async () => {
	api.listApprovalPolicyCatalog.mockResolvedValueOnce({
		profiles: [
			{
				id: "profile-1",
				providerReleaseId: "jira-release-1",
				name: "研发读写",
				effectCeiling: "WRITE",
				revision: "1",
				status: "PUBLISHED",
			},
		],
		policies: [
			{
				id: "policy-1",
				providerReleaseId: "jira-release-1",
				capabilityProfileId: "profile-1",
				materialChange: false,
				status: "PUBLISHED",
				revision: "2",
				disclaimerVersionIds: [],
			},
		],
		disclaimers: [
			{
				id: "disclaimer-material-1",
				kind: "GLOBAL",
				revision: "1",
				locale: "zh-CN",
				content: "正式条款",
				status: "PUBLISHED",
				materialChange: true,
				providerId: null,
			},
		],
		providers: [
			{ provider: "jira", providerReleaseId: "jira-release-1", actions: [] },
		],
	});
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	vi.spyOn(window, "confirm").mockReturnValue(true);
	render(
		<QueryClientProvider client={client}>
			<ApprovalPoliciesPage />
		</QueryClientProvider>,
	);
	fireEvent.click(await screen.findByRole("button", { name: "发起重审" }));
	fireEvent.change(screen.getByLabelText("目标能力包"), {
		target: { value: "profile-1" },
	});
	fireEvent.change(screen.getByLabelText("已发布版本"), {
		target: { value: "disclaimer-material-1" },
	});
	fireEvent.change(screen.getByLabelText("重审截止时间"), {
		target: { value: "2030-01-01T00:00" },
	});
	fireEvent.change(screen.getByLabelText("原因"), {
		target: { value: "重大数据用途变更" },
	});
	const submit = screen.getAllByRole("button", { name: "发起重审" }).at(-1);
	if (!submit) throw new Error("Campaign submit button is missing");
	fireEvent.click(submit);
	await waitFor(() =>
		expect(api.createReapprovalCampaign).toHaveBeenCalledOnce(),
	);
	expect(api.createReapprovalCampaign.mock.calls[0]?.[0]).toMatchObject({
		capabilityProfileId: "profile-1",
		providerReleaseId: "jira-release-1",
		triggerKind: "DISCLAIMER",
		triggerVersionId: "disclaimer-material-1",
		reason: "重大数据用途变更",
	});
});
