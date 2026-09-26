// @vitest-environment jsdom

import type {
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
	listApprovalPolicyCatalog: vi.fn(
		async (): Promise<ApprovalPolicyCatalog> => ({
			profiles: [],
			policies: [],
			disclaimers: [],
			providers: [],
		}),
	),
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

it("publishes a material policy only with an explicit reapproval deadline", async () => {
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
	fireEvent.click(await screen.findByRole("button", { name: "张三" }));
	fireEvent.change(screen.getByLabelText("代理审批人"), {
		target: { value: "李四" },
	});
	fireEvent.click(await screen.findByRole("button", { name: "李四" }));
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
			},
		],
		disclaimers: [
			{
				id: "disclaimer-material-1",
				kind: "GLOBAL",
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
