import {
	AgentProjectionV2Schema,
	BrowserSessionProjectionV1Schema,
} from "@agent-infra/contracts/pilot";
import { pilotFakeScenariosV2 } from "@agent-infra/test-support/pilot";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/components/ui/toast";
import type { SkillHubVersionMetadataV1 } from "../../pilot/generated-v2/types.gen.js";
import { minimalSkillGrant } from "./agent-skill-binding.js";
import { AgentSkillBindingScreen } from "./agent-skill-binding-screen.js";
import { digest, skillBinding } from "./agent-skill-binding-test-fixtures.js";

const agent = AgentProjectionV2Schema.parse(
	pilotFakeScenariosV2.starting.response.body,
);
const session = (userId: string, roles: ("employee" | "system_admin")[]) =>
	BrowserSessionProjectionV1Schema.parse({
		schemaVersion: 1,
		user: { userId, displayName: userId, roles },
	});
const owner = session("user-owner-1", ["employee"]);

function version(
	name: string,
	versionNumber: string,
	id = `${name}-v${versionNumber}`,
): SkillHubVersionMetadataV1 {
	return {
		schemaVersion: 1,
		skillId: `${name}-skill`,
		skillVersionId: id,
		name,
		version: versionNumber,
		provider: "my_library",
		visibility: "PRIVATE",
		state: "published",
		packageDigest: digest("a"),
		manifestDigest: digest("b"),
		signatureDigest: digest("c"),
	};
}

function requestError(status: number, retryable: boolean) {
	return Object.assign(new Error("Agent Skill 状态暂时无法读取。"), {
		status,
		retryable,
	});
}

type Props = ComponentProps<typeof AgentSkillBindingScreen>;

function renderScreen(overrides: Partial<Props> = {}) {
	const readBindings = vi.fn(async () => ({
		schemaVersion: 1 as const,
		agentId: agent.agentId,
		agentVersion: "agent-version-1",
		configurationRevision: 3,
		bindings: [skillBinding("synced")],
	}));
	const bindVersion = vi.fn(async () => ({
		schemaVersion: 1 as const,
		agentId: agent.agentId,
		agentVersion: "agent-version-1",
		configurationRevision: 4,
		changedFields: ["skills"] as ["skills"],
		replayed: false,
	}));
	const loadDirectory = vi.fn(async () => ({
		kind: "ready" as const,
		versions: [
			version("workspace-summary", "1.0.0", "workspace-summary-v1"),
			version("workspace-summary", "1.1.0", "workspace-summary-v2"),
			version("code-review", "1.0.0", "code-review-v1"),
		],
	}));
	const props: Props = {
		agent,
		agentVersion: "agent-version-1",
		session: { kind: "ready", session: owner },
		readBindings,
		bindVersion,
		loadDirectory,
		...overrides,
	};
	const queryClient = new QueryClient();
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queryClient}>
			<ToastProvider>{children}</ToastProvider>
		</QueryClientProvider>
	);
	const view = render(<AgentSkillBindingScreen {...props} />, { wrapper });
	return {
		...view,
		props,
		readBindings: props.readBindings as typeof readBindings,
		bindVersion: props.bindVersion as typeof bindVersion,
	};
}

const toastText = () =>
	document.querySelector('[data-slot="toast"]')?.textContent ?? "";

afterEach(cleanup);

describe("AgentSkillBindingScreen (O-02)", () => {
	it("shows the design heading and never asks for a hand-typed Agent version", () => {
		const { readBindings } = renderScreen({ agentVersion: null });
		expect(
			screen
				.getByRole("link", { name: "返回 Owner 配置" })
				.getAttribute("href"),
		).toBe("/agents/agent-pilot-1/configuration");
		expect(screen.getByText("Owner 配置 / Skill")).toBeTruthy();
		expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
			"Agent 的 Skill",
		);
		expect(
			screen.getByText(
				"Release assistant · 固定 Skill 版本，完成同步后才能在对话中使用。",
			),
		).toBeTruthy();
		expect(
			screen.getByRole("link", { name: "浏览 Skill Hub" }).getAttribute("href"),
		).toBe("/skills");
		// 契约还没有当前 Agent Version：只说明，不发绑定请求，也没有手填字段。
		expect(screen.getByText("暂时无法读取当前 Agent 版本")).toBeTruthy();
		expect(readBindings).not.toHaveBeenCalled();
		for (const label of [
			"Agent ID",
			"Agent 版本",
			"配置 revision",
			"Grant JSON",
		])
			expect(screen.queryByLabelText(label)).toBeNull();
		expect(screen.queryAllByRole("textbox")).toEqual([]);
	});

	it.each([
		[
			"a pure administrator",
			session("user-admin-1", ["employee", "system_admin"]),
		],
		["an employee", session("user-employee-1", ["employee"])],
	])(
		"tells %s there is no permission without reading bindings",
		(_label, other) => {
			const { readBindings, bindVersion } = renderScreen({
				session: { kind: "ready", session: other },
			});
			expect(screen.getByText("没有权限")).toBeTruthy();
			expect(
				screen
					.getByRole("link", { name: "返回 Agent 详情" })
					.getAttribute("href"),
			).toBe("/agents/agent-pilot-1");
			expect(screen.queryByRole("button", { name: "绑定固定版本" })).toBeNull();
			expect(readBindings).not.toHaveBeenCalled();
			expect(bindVersion).not.toHaveBeenCalled();
		},
	);

	it("shows loading, empty and read failures", async () => {
		let resolveRead: (value: unknown) => void = () => undefined;
		const pending = renderScreen({
			readBindings: vi.fn(
				() =>
					new Promise((resolve) => {
						resolveRead = resolve;
					}),
			) as never,
		});
		const status = screen
			.getAllByRole("status")
			.find((element) => element.getAttribute("data-slot") === "loading-line");
		expect(status?.querySelector('[data-slot="spinner"]')).not.toBeNull();
		resolveRead({
			schemaVersion: 1,
			agentId: agent.agentId,
			agentVersion: "agent-version-1",
			configurationRevision: 3,
			bindings: [],
		});
		expect(await screen.findByText("还未绑定 Skill")).toBeTruthy();
		expect(
			screen.getByText("先加入自己的库，再绑定到当前 Agent 版本。"),
		).toBeTruthy();
		pending.unmount();

		const retry = vi
			.fn()
			.mockRejectedValueOnce(requestError(503, true))
			.mockResolvedValue({
				schemaVersion: 1,
				agentId: agent.agentId,
				agentVersion: "agent-version-1",
				configurationRevision: 3,
				bindings: [],
			});
		const failing = renderScreen({ readBindings: retry });
		fireEvent.click(await screen.findByRole("button", { name: "重新读取" }));
		await waitFor(() => expect(retry).toHaveBeenCalledTimes(2));
		expect(await screen.findByText("还未绑定 Skill")).toBeTruthy();
		failing.unmount();

		renderScreen({
			readBindings: vi.fn().mockRejectedValue(requestError(404, false)),
		});
		expect(await screen.findByText("无法读取 Skill 绑定")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "重新读取" })).toBeNull();
	});

	it("maps each binding to a card with four stages and no internal values", async () => {
		renderScreen({
			agent: AgentProjectionV2Schema.parse({
				...agent,
				capabilities: {
					...agent.capabilities,
					skills: [
						{
							schemaVersion: 1,
							name: "ready-skill",
							version: "1.0.0",
							packageDigest: digest("a"),
							manifestSha256: digest("b"),
							readOnly: true,
						},
					],
				},
			}),
			readBindings: vi.fn(async () => ({
				schemaVersion: 1 as const,
				agentId: agent.agentId,
				agentVersion: "agent-version-1",
				configurationRevision: 3,
				bindings: [
					skillBinding("pending_sync", { name: "pending-skill" }),
					skillBinding("synced", { name: "ready-skill" }),
					skillBinding("synced", { name: "assembling-skill" }),
					skillBinding("failed", { name: "failed-skill" }),
					skillBinding("revoked", { name: "revoked-skill" }),
				],
			})),
		});
		const cards = await screen.findAllByRole("article");
		expect(
			cards.map((card) => [
				within(card).getByRole("heading", { level: 2 }).textContent,
				card.querySelector('[data-slot="badge"], .rounded-\\[999px\\]')
					?.textContent,
				within(card).queryAllByRole("listitem").length,
			]),
		).toEqual([
			["pending-skill v1.0.0", "等待确认", 4],
			["ready-skill v1.0.0", "对话可用", 4],
			["assembling-skill v1.0.0", "等待确认", 4],
			["failed-skill v1.0.0", "同步失败", 4],
			["revoked-skill v1.0.0", "版本已撤销", 0],
		]);
		const assembling = cards[2] as HTMLElement;
		expect(
			within(assembling)
				.getAllByRole("listitem")
				.map((item) => item.textContent),
		).toEqual([
			"固定版本绑定：完成",
			"内容同步：完成",
			"装配确认：完成",
			"对话可用：进行中",
		]);
		expect(
			within(assembling)
				.getAllByRole("listitem")
				.map((item) => item.getAttribute("aria-current")),
		).toEqual([null, null, null, "step"]);
		expect(cards[3]?.textContent).toContain(
			"内容同步失败，这个版本不会在对话中提供。",
		);
		expect(cards[4]?.textContent).toContain(
			"新的调用已被阻止，已保存的执行记录保持原版本。",
		);
		// 只有对话可用的绑定能去对话中选择；撤销的版本不能更换。
		expect(
			screen
				.getByRole("link", { name: "在对话中选择：ready-skill" })
				.getAttribute("href"),
		).toBe("/chat/agent-pilot-1");
		expect(
			screen.queryAllByRole("link", { name: /^在对话中选择/ }),
		).toHaveLength(1);
		expect(
			screen
				.getByRole("link", { name: "版本详情：failed-skill" })
				.getAttribute("href"),
		).toBe("/skills/failed-skill-v1");
		const names = screen
			.getAllByRole("link", { name: /^版本详情/ })
			.map((link) => link.getAttribute("aria-label"));
		expect(new Set(names).size).toBe(names.length);
		const text = document.body.textContent ?? "";
		for (const raw of [
			"pending_sync",
			"synced",
			"Applied",
			".agents/skills",
			"internal sync detail",
			digest("a"),
		])
			expect(text).not.toContain(raw);
	});

	it("confirms a binding and submits the complete collection once", async () => {
		const { bindVersion } = renderScreen();
		await screen.findByRole("article");
		fireEvent.change(screen.getByLabelText("固定版本"), {
			target: { value: "code-review-v1" },
		});
		fireEvent.click(screen.getByRole("button", { name: "绑定固定版本" }));
		const dialog = await screen.findByRole("dialog", {
			name: "确认绑定固定版本",
		});
		expect(dialog.textContent).toContain("code-review · v1.0.0");
		expect(dialog.textContent).toContain("同步完成且装配确认");
		expect(bindVersion).not.toHaveBeenCalled();
		const confirm = within(dialog).getByRole("button", { name: "确认绑定" });
		fireEvent.click(confirm);
		fireEvent.click(confirm);
		await waitFor(() => expect(bindVersion).toHaveBeenCalledOnce());
		expect(bindVersion).toHaveBeenCalledWith(
			"agent-pilot-1",
			"agent-version-1",
			{
				schemaVersion: 1,
				expectedConfigurationRevision: 3,
				bindings: [
					{
						skillVersionId: "workspace-summary-v1",
						grant: minimalSkillGrant(),
					},
					{ skillVersionId: "code-review-v1", grant: minimalSkillGrant() },
				],
			},
			expect.any(String),
		);
		await waitFor(() => expect(toastText()).toBe("已提交绑定，等待同步"));
	});

	it("does not resubmit an already bound version", async () => {
		const { bindVersion } = renderScreen();
		await screen.findByRole("article");
		fireEvent.change(screen.getByLabelText("固定版本"), {
			target: { value: "workspace-summary-v1" },
		});
		fireEvent.click(screen.getByRole("button", { name: "绑定固定版本" }));
		await waitFor(() => expect(toastText()).toBe("这个固定版本已经绑定"));
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(bindVersion).not.toHaveBeenCalled();
	});

	it("rereads after a conflict and reuses the key only for the same input", async () => {
		const bindVersion = vi
			.fn()
			.mockRejectedValueOnce(requestError(409, false))
			.mockRejectedValueOnce(requestError(503, true))
			.mockRejectedValueOnce(requestError(503, true))
			.mockResolvedValue({});
		const { readBindings } = renderScreen({ bindVersion });
		await screen.findByRole("article");
		const bind = async (value: string) => {
			fireEvent.change(screen.getByLabelText("固定版本"), {
				target: { value },
			});
			fireEvent.click(screen.getByRole("button", { name: "绑定固定版本" }));
			fireEvent.click(
				within(
					await screen.findByRole("dialog", { name: "确认绑定固定版本" }),
				).getByRole("button", { name: "确认绑定" }),
			);
			await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		};
		await bind("code-review-v1");
		expect(
			await screen.findByText(
				"绑定已被其他修改更新，已重新读取，请确认后再试。",
			),
		).toBeTruthy();
		await waitFor(() => expect(readBindings).toHaveBeenCalledTimes(2));
		// 选择保留。
		expect(screen.getByLabelText<HTMLSelectElement>("固定版本").value).toBe(
			"code-review-v1",
		);
		await bind("code-review-v1");
		await screen.findByText("绑定未完成，请重试。");
		await bind("code-review-v1");
		await waitFor(() => expect(bindVersion).toHaveBeenCalledTimes(3));
		const keys = bindVersion.mock.calls.map((call) => call[3]);
		expect(keys[2]).toBe(keys[1]);
		await bind("workspace-summary-v2");
		await waitFor(() => expect(bindVersion).toHaveBeenCalledTimes(4));
		expect(bindVersion.mock.calls[3]?.[3]).not.toBe(keys[2]);
	});

	it("changes a fixed version through a confirmation that only replaces that binding", async () => {
		const { bindVersion } = renderScreen();
		fireEvent.click(
			await screen.findByRole("button", {
				name: "更换固定版本：workspace-summary",
			}),
		);
		const dialog = await screen.findByRole("dialog", { name: "更换固定版本" });
		expect(dialog.textContent).toContain("workspace-summary · v1.0.0 → v1.1.0");
		expect(dialog.textContent).toContain(
			"现有执行保留原版本。新的调用要等同步和装配确认完成。",
		);
		fireEvent.click(
			within(dialog).getByRole("button", { name: "确认版本变更" }),
		);
		await waitFor(() => expect(bindVersion).toHaveBeenCalledOnce());
		expect((bindVersion.mock.calls as unknown as unknown[][])[0]?.[2]).toEqual({
			schemaVersion: 1,
			expectedConfigurationRevision: 3,
			bindings: [
				{ skillVersionId: "workspace-summary-v2", grant: minimalSkillGrant() },
			],
		});
	});

	it("is read-only for a disabled Agent", async () => {
		renderScreen({
			agent: {
				...agent,
				managementStatus: "disabled",
				serviceAvailability: null,
			},
		});
		await screen.findByRole("article");
		expect(screen.queryByRole("button", { name: "绑定固定版本" })).toBeNull();
		expect(screen.queryByRole("button", { name: /^更换固定版本/ })).toBeNull();
	});

	it("polls while syncing and toasts once when the Skill becomes usable", async () => {
		const ready = AgentProjectionV2Schema.parse({
			...agent,
			capabilities: {
				...agent.capabilities,
				skills: [
					{
						schemaVersion: 1,
						name: "workspace-summary",
						version: "1.0.0",
						packageDigest: digest("a"),
						manifestSha256: digest("b"),
						readOnly: true,
					},
				],
			},
		});
		const response = (state: "pending_sync" | "synced") => ({
			schemaVersion: 1 as const,
			agentId: agent.agentId,
			agentVersion: "agent-version-1",
			configurationRevision: 3,
			bindings: [skillBinding(state)],
		});
		const readBindings = vi
			.fn()
			.mockResolvedValueOnce(response("pending_sync"))
			.mockResolvedValue(response("synced"));
		const onRefreshAgent = vi.fn();
		const { rerender, props } = renderScreen({ readBindings, onRefreshAgent });
		await screen.findByText("内容同步");
		await waitFor(() => expect(readBindings).toHaveBeenCalledTimes(2), {
			timeout: 4000,
		});
		expect(onRefreshAgent).toHaveBeenCalled();
		expect(toastText()).toBe("");
		rerender(<AgentSkillBindingScreen {...props} agent={ready} />);
		await waitFor(() =>
			expect(toastText()).toBe("同步与装配已确认，Skill 可在对话中选择"),
		);
		const calls = readBindings.mock.calls.length;
		await new Promise((resolve) => setTimeout(resolve, 2300));
		expect(readBindings.mock.calls.length).toBe(calls);
	}, 10_000);
});
