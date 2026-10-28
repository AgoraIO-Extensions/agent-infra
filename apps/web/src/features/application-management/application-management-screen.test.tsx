import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render as renderView,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client as generatedClient } from "../../pilot/generated-v2/client.gen.js";
import type { ApplicationMetadataV1 } from "../../pilot/generated-v2/types.gen.js";
import {
	directoryRequestUrl,
	directorySearchResponse,
} from "../directory-test-fixtures.js";
import type { ApplicationCredentialResponse } from "./application-management.js";
import type { ApplicationManagementViewState } from "./application-management-screen.js";
import { ApplicationManagementScreen } from "./application-management-screen.js";

// 页面按需读取目录显示名：测试与生产一样提供 QueryClient，并以固定目录记录响应。
const directoryRecords = [
	{
		kind: "user",
		canonicalId: "user-1",
		displayName: "负责人一",
		email: "owner.one@example.test",
	},
	{
		kind: "organization",
		canonicalId: "org-release",
		displayName: "发布工程",
		organizationPath: "研发 / 发布工程",
	},
];
beforeEach(() => {
	// 生成 Client 默认使用相对地址；jsdom 下的 Request 需要绝对地址。
	generatedClient.setConfig({ baseUrl: "https://platform.test" });
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request) => {
			const url = directoryRequestUrl(input);
			if (url.pathname.endsWith("/credentials"))
				return Response.json({ items: [], nextCursor: null });
			const ids = url.searchParams.get("ids")?.split(",") ?? [];
			return Response.json(
				directorySearchResponse(
					url,
					directoryRecords.filter(
						(item) =>
							item.kind === url.searchParams.get("kind") &&
							ids.includes(item.canonicalId),
					),
				),
			);
		}),
	);
});
afterEach(() => vi.unstubAllGlobals());
function render(ui: ReactElement) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	});
	return renderView(ui, {
		wrapper: ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={client}>{children}</QueryClientProvider>
		),
	});
}

const metadata: ApplicationMetadataV1 = {
	applicationId: "application-1",
	authorizationRevision: "revision-1",
	createdAt: "2026-10-10T00:00:00Z",
	name: "Build service",
	responsibleUserId: "user-1",
	status: "active",
	updatedAt: "2026-10-10T00:00:00Z",
};

const response: ApplicationCredentialResponse = {
	metadata: {
		applicationId: metadata.applicationId,
		credentialId: "application-credential-1",
		createdAt: "2026-10-10T00:00:00Z",
		expiresAt: "2027-01-01T00:00:23.135Z",
		lastUsedAt: null,
		revokedAt: null,
		scopes: ["agent:read", "agent:use"],
	},
	delivery: {
		attemptId: "delivery-attempt-1",
		grantRevision: "material-grant-1",
		recipient: {
			principalType: "application",
			principalId: "recipient-service",
		},
		status: "accepted",
	},
	replayed: false,
};

function submitCredential() {
	fireEvent.change(screen.getByLabelText("接收主体 ID"), {
		target: { value: "recipient-1" },
	});
	fireEvent.click(screen.getByRole("button", { name: "签发应用凭证" }));
}

const changedScopes: {
	label: string;
	state: ApplicationManagementViewState;
}[] = [
	{
		label: "another application",
		state: {
			kind: "ready",
			application: { ...metadata, applicationId: "application-2" },
		},
	},
	{
		label: "new authorization revision",
		state: {
			kind: "ready",
			application: { ...metadata, authorizationRevision: "revision-2" },
		},
	},
	{
		label: "disabled application",
		state: { kind: "ready", application: { ...metadata, status: "disabled" } },
	},
	{ label: "read denial", state: { kind: "denied" } },
	{
		label: "missing application",
		state: { kind: "unavailable", reason: "not-found", retryable: false },
	},
	{
		label: "unavailable application",
		state: { kind: "unavailable", retryable: true },
	},
	{ label: "loading", state: { kind: "loading" } },
	{ label: "registration", state: { kind: "empty" } },
];

describe("ApplicationManagementScreen", () => {
	afterEach(cleanup);

	it("is an h2 section of the API credentials page with distinct field names (R-02, N-12)", () => {
		const headingRef = { current: null as HTMLHeadingElement | null };
		render(
			<ApplicationManagementScreen
				state={{ kind: "ready", application: metadata }}
				onOpenApplication={vi.fn()}
				onIssueCredential={vi.fn()}
				headingRef={headingRef}
			/>,
		);
		// API 凭证页只有一个 h1；应用管理是分区 h2，应用名是其下的 h3。
		expect(screen.queryAllByRole("heading", { level: 1 })).toHaveLength(0);
		const heading = screen.getByRole("heading", { level: 2, name: "应用管理" });
		expect(headingRef.current).toBe(heading);
		expect(heading.getAttribute("tabindex")).toBe("-1");
		expect(
			screen.getByRole("heading", { level: 3, name: "Build service" }),
		).toBeTruthy();
		expect(document.body.textContent).not.toContain("安全设置");
		// 与个人凭证签发表单同页：同名分组和过期时间带上对象名。
		expect(
			screen.getByRole("group", { name: "权限范围：应用凭证" }),
		).toBeTruthy();
		expect(screen.getByLabelText("过期时间（可选）：应用凭证")).toBeTruthy();
		// E3-16：权限复选框名称为「{权限}：{应用名}」，与签发个人凭证区的同名复选框区分；
		// 可见标签与点击标签切换不变。
		const group = screen.getByRole("group", { name: "权限范围：应用凭证" });
		expect(within(group).getAllByRole("checkbox")).toHaveLength(4);
		for (const label of [
			"读取 Agent",
			"使用 Agent",
			"管理 Agent",
			"创建 Agent",
		]) {
			const checkbox = within(group).getByRole("checkbox", {
				name: `${label}：Build service`,
			});
			const before = checkbox.getAttribute("aria-checked");
			fireEvent.click(within(group).getByText(label, { selector: "label" }));
			expect(checkbox.getAttribute("aria-checked")).not.toBe(before);
		}
	});

	it("registers an application using the current-session owner", async () => {
		const onRegister = vi.fn().mockResolvedValue(metadata);
		render(
			<ApplicationManagementScreen
				state={{ kind: "empty" }}
				onRegister={onRegister}
			/>,
		);

		fireEvent.change(screen.getByLabelText("应用名称"), {
			target: { value: "  Build service  " },
		});
		fireEvent.click(screen.getByRole("button", { name: "注册应用" }));
		await waitFor(() =>
			expect(onRegister).toHaveBeenCalledWith("Build service"),
		);
	});

	it("confirms disabling the application before calling onDisable", async () => {
		const onDisable = vi
			.fn<(applicationId: string) => Promise<ApplicationMetadataV1>>()
			.mockResolvedValue({ ...metadata, status: "disabled" });
		const view = render(
			<ApplicationManagementScreen
				state={{ kind: "ready", application: metadata }}
				onDisable={onDisable}
			/>,
		);
		const trigger = screen.getByRole("button", {
			name: "停用应用：Build service",
		});
		expect(trigger.className).not.toContain("bg-destructive");
		fireEvent.click(trigger);
		let dialog = await screen.findByRole("dialog", {
			name: "停用这个应用？",
		});
		expect(within(dialog).getByText("Build service")).toBeTruthy();
		expect(within(dialog).getByText(/拒绝该应用的新任务/)).toBeTruthy();
		expect(onDisable).not.toHaveBeenCalled();
		fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(onDisable).not.toHaveBeenCalled();
		// #3292 N9-3-06：取消与 Escape 关闭后焦点回到触发按钮（同撤销凭证、禁用员工），不到应用名标题。
		await waitFor(() => expect(document.activeElement).toBe(trigger));
		fireEvent.click(trigger);
		dialog = await screen.findByRole("dialog");
		fireEvent.keyDown(dialog, { key: "Escape" });
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(onDisable).not.toHaveBeenCalled();
		await waitFor(() => expect(document.activeElement).toBe(trigger));
		fireEvent.click(trigger);
		dialog = await screen.findByRole("dialog");
		fireEvent.click(within(dialog).getByRole("button", { name: "停用应用" }));
		expect(onDisable).toHaveBeenCalledExactlyOnceWith("application-1");
		// 需求变化（#3292 N9-3-06）：原断言确认后焦点立即到应用名标题（finalFocus=标题）；现确认后先回到
		// 触发按钮，停用中它是可聚焦的禁用（aria-disabled、无原生 disabled），停用成功、详情按新状态
		// 重新挂载后再到应用名标题。
		await waitFor(() => expect(document.activeElement).toBe(trigger));
		view.rerender(
			<ApplicationManagementScreen
				state={{ kind: "ready", application: metadata }}
				onDisable={onDisable}
				isDisabling
			/>,
		);
		const pending = screen.getByRole("button", {
			name: "正在停用…：Build service",
		}) as HTMLButtonElement;
		expect(pending).toBe(trigger);
		expect(pending.getAttribute("aria-disabled")).toBe("true");
		expect(pending.disabled).toBe(false);
		expect(document.activeElement).toBe(pending);
		view.rerender(
			<ApplicationManagementScreen
				state={{
					kind: "ready",
					application: { ...metadata, status: "disabled" },
				}}
				onDisable={onDisable}
			/>,
		);
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByRole("heading", { name: "Build service" }),
			),
		);
	});

	it("does not offer credential material when the application is disabled", () => {
		render(
			<ApplicationManagementScreen
				state={{
					kind: "ready",
					application: { ...metadata, status: "disabled" },
				}}
			/>,
		);

		expect(screen.getByText("应用已停用")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "签发应用凭证" })).toBeNull();
	});

	it("opens a trimmed existing ID without registering or assuming access", () => {
		const onOpenApplication = vi.fn();
		const onRegister = vi.fn();
		render(
			<ApplicationManagementScreen
				state={{ kind: "empty" }}
				onOpenApplication={onOpenApplication}
				onRegister={onRegister}
			/>,
		);
		const button = screen.getByRole("button", { name: "打开应用" });
		expect((button as HTMLButtonElement).disabled).toBe(true);
		fireEvent.change(screen.getByLabelText("既有应用 ID"), {
			target: { value: "  application-1  " },
		});
		fireEvent.click(button);
		expect(onOpenApplication).toHaveBeenCalledWith("application-1");
		expect(onRegister).not.toHaveBeenCalled();
		expect(screen.queryByText("Build service")).toBeNull();
	});

	it.each(["not-found", "denied"] as const)(
		"shows %s without presenting registration as success",
		(reason) => {
			render(
				<ApplicationManagementScreen
					state={{ kind: "unavailable", reason, retryable: false }}
					onOpenApplication={vi.fn()}
					onRegister={vi.fn()}
				/>,
			);
			expect(screen.getByRole("alert").textContent).toContain(
				reason === "denied" ? "当前账号无权" : "找不到这个应用",
			);
			expect(screen.queryByRole("button", { name: "注册应用" })).toBeNull();
		},
	);

	it("offers a section-named 重新登录 for a 401 application read (N9-3-04)", () => {
		const onRelogin = vi.fn();
		render(
			<ApplicationManagementScreen
				state={{
					kind: "unavailable",
					reason: "authentication-required",
					retryable: false,
				}}
				onRelogin={onRelogin}
			/>,
		);
		const alert = screen.getByRole("alert");
		expect(alert.textContent).toBe(
			"登录状态已失效，请重新登录后再试。重新登录",
		);
		// 与上方个人凭证列表的「重新登录」可能同时出现，名称带分区名，可见文字不变。
		const relogin = within(alert).getByRole("button", {
			name: "重新登录：应用管理",
		});
		expect(relogin.textContent).toBe("重新登录");
		fireEvent.click(relogin);
		expect(onRelogin).toHaveBeenCalledOnce();
	});

	it("offers a section-named 重新加载 for a retryable application read (N10-3-01)", () => {
		const onRetry = vi.fn();
		render(
			<ApplicationManagementScreen
				state={{ kind: "unavailable", retryable: true }}
				onRetry={onRetry}
			/>,
		);
		const alert = screen.getByRole("alert");
		expect(alert.textContent).toBe("暂时无法读取应用，请稍后重试。重新加载");
		// 与上方个人凭证列表的「重新加载」可能同时出现（两处同时 503），名称带分区名，可见文字不变。
		const reload = within(alert).getByRole("button", {
			name: "重新加载：应用管理",
		});
		expect(reload.textContent).toBe("重新加载");
		fireEvent.click(reload);
		expect(onRetry).toHaveBeenCalledOnce();
	});

	it("retains safe response metadata and prepares an explicit rotation of its returned ID", async () => {
		const rotated: ApplicationCredentialResponse = {
			...response,
			metadata: { ...response.metadata, credentialId: "rotated-credential-2" },
			delivery: {
				...response.delivery,
				attemptId: "rotation-attempt-2",
				status: "delivery_pending",
			},
		};
		const onIssueCredential = vi
			.fn()
			.mockResolvedValueOnce({
				...response,
				credential: "synthetic-material-must-not-render",
			})
			.mockResolvedValueOnce(rotated);
		render(
			<ApplicationManagementScreen
				state={{ kind: "ready", application: metadata }}
				onIssueCredential={onIssueCredential}
			/>,
		);
		submitCredential();
		await screen.findByText(response.metadata.credentialId);
		for (const value of [
			response.delivery.recipient.principalId,
			response.delivery.attemptId,
			response.delivery.grantRevision,
			"尚未使用",
			"未撤销",
			"读取 Agent、使用 Agent",
		])
			expect(screen.getByText(value)).toBeTruthy();
		expect(screen.queryByText("synthetic-material-must-not-render")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "使用此凭证 ID 轮换" }));
		expect(
			(screen.getByLabelText("要轮换的凭证 ID") as HTMLInputElement).value,
		).toBe(response.metadata.credentialId);
		expect(onIssueCredential).toHaveBeenCalledTimes(1);
		fireEvent.click(screen.getByRole("button", { name: "轮换应用凭证" }));
		await screen.findByText(rotated.metadata.credentialId);
		expect(onIssueCredential.mock.calls[1]?.[0]).toEqual({
			applicationId: metadata.applicationId,
			body: {
				operation: "rotate",
				credentialId: response.metadata.credentialId,
				recipient: response.delivery.recipient,
				scopes: response.metadata.scopes,
				expiresAt: response.metadata.expiresAt,
			},
		});
		expect(screen.queryByText(response.metadata.credentialId)).toBeNull();
	});

	it.each([
		["delivery_pending", "等待投递"],
		["delivery_in_flight", "投递中"],
		["accepted", "投递通道已接收"],
		["failed", "投递失败"],
		["unknown", "投递结果未知"],
	] as const)(
		"shows actual %s status without retrying the operation",
		async (status, label) => {
			const onIssueCredential = vi.fn().mockResolvedValue({
				...response,
				replayed: true,
				delivery: { ...response.delivery, status },
			});
			render(
				<ApplicationManagementScreen
					state={{ kind: "ready", application: metadata }}
					onIssueCredential={onIssueCredential}
				/>,
			);
			submitCredential();
			await screen.findByText(label);
			expect(screen.getByText(/当前展示原请求的回执/).textContent).toContain(
				"原请求的回执，未再次签发",
			);
			if (status === "unknown")
				expect(screen.getByText(/无法确认材料是否已投递/)).toBeTruthy();
			expect(screen.queryByRole("button", { name: /重发|重试/ })).toBeNull();
			expect(onIssueCredential).toHaveBeenCalledTimes(1);
		},
	);

	it.each(changedScopes)(
		"clears a previous result for $label",
		async ({ state }) => {
			const onIssueCredential = vi.fn().mockResolvedValue(response);
			const view = render(
				<ApplicationManagementScreen
					state={{ kind: "ready", application: metadata }}
					onIssueCredential={onIssueCredential}
				/>,
			);
			submitCredential();
			await screen.findByText(response.metadata.credentialId);
			view.rerender(
				<ApplicationManagementScreen
					state={state}
					onIssueCredential={onIssueCredential}
				/>,
			);
			expect(
				screen.queryByRole("heading", { name: "应用凭证结果" }),
			).toBeNull();
			view.rerender(
				<ApplicationManagementScreen
					state={{ kind: "ready", application: metadata }}
					onIssueCredential={onIssueCredential}
				/>,
			);
			expect(screen.queryByText(response.metadata.credentialId)).toBeNull();
			expect(
				(screen.getByLabelText("接收主体 ID") as HTMLInputElement).value,
			).toBe("");
		},
	);

	it.each(changedScopes)(
		"ignores late success after $label",
		async ({ state }) => {
			let resolve: (value: ApplicationCredentialResponse) => void = () => {};
			const onIssueCredential = vi.fn(
				() =>
					new Promise<ApplicationCredentialResponse>((done) => {
						resolve = done;
					}),
			);
			const view = render(
				<ApplicationManagementScreen
					state={{ kind: "ready", application: metadata }}
					onIssueCredential={onIssueCredential}
				/>,
			);
			submitCredential();
			view.rerender(
				<ApplicationManagementScreen
					state={state}
					onIssueCredential={onIssueCredential}
				/>,
			);
			view.rerender(
				<ApplicationManagementScreen
					state={{ kind: "ready", application: metadata }}
					onIssueCredential={onIssueCredential}
				/>,
			);
			await act(async () => {
				resolve(response);
			});
			expect(screen.queryByText(response.metadata.credentialId)).toBeNull();
			expect(
				screen.queryByRole("heading", { name: "应用凭证结果" }),
			).toBeNull();
		},
	);

	it("does not retain results through unmount or accept another application's receipt", async () => {
		let resolve: (value: ApplicationCredentialResponse) => void = () => {};
		const onIssueCredential = vi
			.fn()
			.mockImplementationOnce(
				() =>
					new Promise<ApplicationCredentialResponse>((done) => {
						resolve = done;
					}),
			)
			.mockResolvedValueOnce({
				...response,
				metadata: { ...response.metadata, applicationId: "wrong-application" },
			});
		const view = render(
			<ApplicationManagementScreen
				state={{ kind: "ready", application: metadata }}
				onIssueCredential={onIssueCredential}
			/>,
		);
		submitCredential();
		view.unmount();
		render(
			<ApplicationManagementScreen
				state={{ kind: "ready", application: metadata }}
				onIssueCredential={onIssueCredential}
			/>,
		);
		await act(async () => {
			resolve(response);
		});
		expect(screen.queryByText(response.metadata.credentialId)).toBeNull();
		submitCredential();
		await waitFor(() =>
			expect(
				(
					screen.getByRole("button", {
						name: "签发应用凭证",
					}) as HTMLButtonElement
				).disabled,
			).toBe(false),
		);
		expect(screen.queryByRole("heading", { name: "应用凭证结果" })).toBeNull();
	});

	it("clears the former result on rejected rotation and prevents duplicate submissions", async () => {
		const onIssueCredential = vi
			.fn()
			.mockResolvedValueOnce(response)
			.mockRejectedValueOnce(new Error("denied"));
		render(
			<ApplicationManagementScreen
				state={{ kind: "ready", application: metadata }}
				onIssueCredential={onIssueCredential}
			/>,
		);
		submitCredential();
		fireEvent.click(screen.getByRole("button", { name: "正在提交…" }));
		await screen.findByText(response.metadata.credentialId);
		expect(onIssueCredential).toHaveBeenCalledTimes(1);
		fireEvent.click(screen.getByRole("button", { name: "使用此凭证 ID 轮换" }));
		fireEvent.click(screen.getByRole("button", { name: "轮换应用凭证" }));
		await waitFor(() => expect(onIssueCredential).toHaveBeenCalledTimes(2));
		expect(screen.queryByText(response.metadata.credentialId)).toBeNull();
	});
});
