import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAdminAgents } from "../admin-agents/admin-agents.js";
import { loadAgentDiscovery } from "../agent-discovery/agent-discovery.js";
import {
	type AuditAgentOption,
	AuditAgentPicker,
	loadAuditAgentOptions,
} from "./audit-agent-picker.js";
import type { AuditScope } from "./audit-query.js";

vi.mock("../application-shell.js", () => ({
	useApplicationSession: () => ({ identityKey: "identity-a" }),
}));
vi.mock("../agent-discovery/agent-discovery.js", () => ({
	loadAgentDiscovery: vi.fn(),
}));
vi.mock("../admin-agents/admin-agents.js", () => ({
	loadAdminAgents: vi.fn(),
}));

const agent = (agentId: string, name: string) => ({ agentId, name });

beforeEach(() => {
	vi.mocked(loadAgentDiscovery).mockResolvedValue({
		kind: "ready",
		agents: [
			agent("agent-writer-0001", "写作助手"),
			agent("agent-coder-0001", "编程助手"),
		],
	} as never);
	vi.mocked(loadAdminAgents).mockResolvedValue({
		kind: "ready",
		agents: [agent("agent-admin-0001", "平台巡检")],
	} as never);
});
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

function Harness({
	scope,
	onChange,
}: {
	scope: AuditScope;
	onChange: (value: AuditAgentOption | null) => void;
}) {
	const [value, setValue] = useState<AuditAgentOption | null>(null);
	return (
		<AuditAgentPicker
			id="audit-agent"
			label="Agent"
			scope={scope}
			value={value}
			onChange={(next) => {
				setValue(next);
				onChange(next);
			}}
		/>
	);
}

function renderPicker(scope: AuditScope = "own") {
	const onChange = vi.fn();
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={client}>
			<Harness scope={scope} onChange={onChange} />
		</QueryClientProvider>,
	);
	return { onChange, input: screen.getByRole("combobox", { name: "Agent" }) };
}

describe("AuditAgentPicker", () => {
	it("reads candidates only after opening and selects an Agent by name, submitting its ID", async () => {
		const { onChange, input } = renderPicker();
		expect(loadAgentDiscovery).not.toHaveBeenCalled();
		fireEvent.focus(input);
		await screen.findByRole("option", { name: /编程助手/ });
		expect(loadAgentDiscovery).toHaveBeenCalledWith(
			undefined,
			"visible",
			expect.any(AbortSignal),
		);
		expect(loadAdminAgents).not.toHaveBeenCalled();
		// 候选按名称排序。
		expect(
			screen.getAllByRole("option").map((option) => option.textContent),
		).toEqual([
			expect.stringContaining("编程助手"),
			expect.stringContaining("写作助手"),
		]);
		fireEvent.change(input, { target: { value: "写作" } });
		expect(screen.getAllByRole("option")).toHaveLength(1);
		expect(input.getAttribute("aria-activedescendant")).toBe(
			"audit-agent-agent-writer-0001",
		);
		fireEvent.keyDown(input, { key: "Enter" });
		expect(onChange).toHaveBeenLastCalledWith({
			agentId: "agent-writer-0001",
			name: "写作助手",
		});
		expect(screen.queryByRole("listbox")).toBeNull();
		expect(input.getAttribute("aria-expanded")).toBe("false");
		// 已选 Agent 以名称 chip 显示，可移除。
		fireEvent.click(screen.getByRole("button", { name: "移除 写作助手" }));
		expect(onChange).toHaveBeenLastCalledWith(null);
	});

	it("searches by Agent ID too and closes on Escape without selecting", async () => {
		const { onChange, input } = renderPicker();
		fireEvent.click(input);
		await screen.findAllByRole("option");
		fireEvent.change(input, { target: { value: "coder" } });
		expect(screen.getByRole("option").textContent).toContain("编程助手");
		fireEvent.keyDown(input, { key: "Escape" });
		expect(screen.queryByRole("listbox")).toBeNull();
		expect(onChange).not.toHaveBeenCalled();
	});

	it("uses the administrator Agent list for platform audit", async () => {
		const { input } = renderPicker("administrator");
		fireEvent.focus(input);
		await screen.findByRole("option", { name: /平台巡检/ });
		expect(loadAdminAgents).toHaveBeenCalledOnce();
		expect(loadAgentDiscovery).not.toHaveBeenCalled();
	});

	it("reports an unreadable or empty Agent list without offering stale choices", async () => {
		vi.mocked(loadAgentDiscovery).mockResolvedValueOnce({
			kind: "unavailable",
			retryable: false,
		} as never);
		const { input } = renderPicker();
		fireEvent.focus(input);
		expect(await screen.findByText("Agent 列表暂时无法读取")).toBeInstanceOf(
			HTMLElement,
		);
		expect(screen.queryByRole("option")).toBeNull();
		fireEvent.keyDown(input, { key: "Enter" });
		await act(async () => {});
		fireEvent.change(input, { target: { value: "不存在" } });
		expect(screen.queryByRole("option")).toBeNull();
	});

	it("tells the user to narrow a long list", async () => {
		vi.mocked(loadAgentDiscovery).mockResolvedValueOnce({
			kind: "ready",
			agents: Array.from({ length: 60 }, (_, index) =>
				agent(`agent-${String(index).padStart(3, "0")}`, `助手 ${index}`),
			),
		} as never);
		const { input } = renderPicker();
		fireEvent.focus(input);
		await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(50));
		expect(
			screen.getByText("仅列出前 50 项，继续输入名称缩小范围。"),
		).toBeInstanceOf(HTMLElement);
	});
});

describe("loadAuditAgentOptions", () => {
	it("rejects a denied administrator list instead of returning an empty choice", async () => {
		vi.mocked(loadAdminAgents).mockResolvedValueOnce({
			kind: "denied",
		} as never);
		await expect(
			loadAuditAgentOptions("administrator", new AbortController().signal),
		).rejects.toThrow();
	});
});
