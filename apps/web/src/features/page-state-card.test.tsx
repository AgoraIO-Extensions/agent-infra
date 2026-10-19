import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithAgentRouter } from "./agent-discovery/test-router.js";
import {
	PageStateCard,
	type PageStateKind,
	pageStateDefaults,
	ReadFailureCard,
	readFailureStateKind,
} from "./page-state-card.js";

const sessionLoader = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("./browser-session", async (importOriginal) => ({
	...(await importOriginal<typeof import("./browser-session")>()),
	loadBrowserSession: () => sessionLoader.load(),
}));
beforeEach(() => {
	sessionLoader.load.mockReset();
	sessionLoader.load.mockImplementation(() => new Promise(() => {}));
});

function card() {
	const element = document.querySelector('[data-slot="state-card"]');
	if (!(element instanceof HTMLElement)) throw new Error("state card missing");
	return element;
}
function actionNames() {
	return [...card().querySelectorAll("a, button")].map(
		(action) => action.textContent,
	);
}

describe("PageStateCard", () => {
	it.each([
		[
			"login",
			"登录",
			"当前会话已过期，需要重新登录后再进入工作区。",
			["重新登录"],
		],
		[
			"unauthorized",
			"未授权",
			"你没有访问此 Agent 或平台审计的权限。",
			["返回工作台"],
		],
		["unavailable", "服务暂不可用", "暂时无法读取数据，请稍后重试。", []],
		[
			"not-found",
			"无法打开此地址",
			"链接可能已失效或地址有误。可以回到工作台，或从 Agent 目录重新进入。",
			[],
		],
		["invalid", "数据无法读取", "服务返回的数据无法识别，请联系管理员。", []],
	] as const)(
		"renders the %s defaults",
		async (kind, title, description, actions) => {
			await renderWithAgentRouter(<PageStateCard kind={kind} />);
			expect(pageStateDefaults[kind as PageStateKind]).toEqual({
				title,
				description,
			});
			const element = card();
			expect(element.tagName).toBe("ARTICLE");
			expect(element.dataset.kind).toBe(kind);
			// 标题默认 h2，页面 h1 留在页头。
			expect(
				within(element).getByRole("heading", { level: 2, name: title }),
			).toBeTruthy();
			expect(
				element.querySelector('[data-slot="state-card-description"]')
					?.textContent,
			).toBe(description);
			expect(actionNames()).toEqual(actions);
			// 读取失败才播报；无权限与 404 是静态边界。
			expect(element.getAttribute("role")).toBe(
				kind === "unauthorized" || kind === "not-found" ? null : "alert",
			);
		},
	);

	it("links the unauthorized default back to the workbench", async () => {
		await renderWithAgentRouter(<PageStateCard kind="unauthorized" />);
		expect(
			screen.getByRole("link", { name: "返回工作台" }).getAttribute("href"),
		).toBe("/");
	});

	it("offers a retry for unavailable only when a handler exists", async () => {
		const onRetry = vi.fn();
		await renderWithAgentRouter(
			<PageStateCard
				kind="unavailable"
				onRetry={onRetry}
				retryLabel="重新加载 Agent"
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "重新加载 Agent" }));
		expect(onRetry).toHaveBeenCalledOnce();
	});

	it("disables the retry while it is running", async () => {
		await renderWithAgentRouter(
			<PageStateCard kind="unavailable" onRetry={vi.fn()} retrying />,
		);
		const retry = screen.getByRole("button", { name: "正在重新加载…" });
		expect((retry as HTMLButtonElement).disabled).toBe(true);
	});

	it("re-reads the server session for login instead of reloading the page", async () => {
		const reload = vi.fn();
		vi.stubGlobal("location", { ...window.location, reload });
		sessionLoader.load.mockImplementation(async () => ({
			kind: "ready",
			session: {
				schemaVersion: 1,
				user: { userId: "u-1", displayName: "u-1", roles: ["employee"] },
			},
		}));
		await renderWithAgentRouter(<PageStateCard kind="login" />);
		await waitFor(() => expect(sessionLoader.load).toHaveBeenCalled());
		const before = sessionLoader.load.mock.calls.length;
		fireEvent.click(screen.getByRole("button", { name: "重新登录" }));
		await waitFor(() =>
			expect(sessionLoader.load.mock.calls.length).toBeGreaterThan(before),
		);
		expect(reload).not.toHaveBeenCalled();
		vi.unstubAllGlobals();
	});

	it.each([
		["ready", 1],
		["expired", 0],
	] as const)(
		"calls onStillValid only when re-login finds a %s session (W-03)",
		async (kind, calls) => {
			const onStillValid = vi.fn();
			let current: "ready" | "expired" = "ready";
			sessionLoader.load.mockImplementation(async () =>
				current === "ready"
					? {
							kind: "ready",
							session: {
								schemaVersion: 1,
								user: {
									userId: "u-1",
									displayName: "u-1",
									roles: ["employee"],
								},
							},
						}
					: { kind: "unavailable", retryable: false },
			);
			await renderWithAgentRouter(
				<ReadFailureCard
					failure={{ retryable: false, reason: "authentication-required" }}
					deniedDescription="无法访问。"
					unavailableDescription="暂时无法读取。"
					back={null}
					onStillValid={onStillValid}
				/>,
			);
			await waitFor(() => expect(sessionLoader.load).toHaveBeenCalled());
			current = kind;
			fireEvent.click(screen.getByRole("button", { name: "重新登录" }));
			await waitFor(() =>
				expect(
					(
						screen.getByRole("button", {
							name: "重新登录",
						}) as HTMLButtonElement
					).disabled,
				).toBe(false),
			);
			expect(onStillValid).toHaveBeenCalledTimes(calls);
		},
	);

	it("allows overriding copy, action and heading level", async () => {
		await renderWithAgentRouter(
			<PageStateCard
				kind="unavailable"
				title="自定义标题"
				description="自定义说明"
				action={null}
				headingLevel={1}
			/>,
		);
		expect(
			screen.getByRole("heading", { level: 1, name: "自定义标题" }),
		).toBeTruthy();
		expect(card().textContent).toBe("自定义标题自定义说明");
	});
});

describe("readFailureStateKind", () => {
	it.each([
		[{ retryable: false, reason: "authentication-required" }, "login"],
		[{ retryable: false, reason: "invalid-response" }, "invalid"],
		[{ retryable: true }, "unavailable"],
		[{ retryable: false }, "unauthorized"],
		[{ retryable: false, reason: "denied" }, "unauthorized"],
		[{ retryable: false, reason: "not-found" }, "unauthorized"],
	] as const)("maps %o to %s", (failure, kind) => {
		expect(readFailureStateKind(failure)).toBe(kind);
	});
});

describe("ReadFailureCard", () => {
	it("shows the same text for denied and missing objects", async () => {
		const texts: string[] = [];
		for (const reason of ["denied", "not-found", undefined] as const) {
			const view = await renderWithAgentRouter(
				<ReadFailureCard
					failure={{ retryable: false, reason }}
					deniedDescription="Agent 不存在，或你没有访问权限。"
					unavailableDescription="暂时无法读取 Agent，请稍后重试。"
					back={<a href="/agents">返回 Agent 目录</a>}
				/>,
			);
			texts.push(card().textContent ?? "");
			view.unmount();
		}
		expect(new Set(texts).size).toBe(1);
		expect(texts[0]).toBe(
			"无法访问Agent 不存在，或你没有访问权限。返回 Agent 目录",
		);
	});

	it("uses the page-specific retry copy for retryable failures", async () => {
		const onRetry = vi.fn();
		await renderWithAgentRouter(
			<ReadFailureCard
				failure={{ retryable: true }}
				deniedDescription="申请不存在，或你没有访问权限。"
				unavailableDescription="暂时无法读取申请，请稍后重试。"
				back={null}
				onRetry={onRetry}
				retryLabel="重新加载申请"
			/>,
		);
		expect(card().textContent).toContain("暂时无法读取申请，请稍后重试。");
		fireEvent.click(screen.getByRole("button", { name: "重新加载申请" }));
		expect(onRetry).toHaveBeenCalledOnce();
	});
});
