import {
	AgentProjectionV2Schema,
	BrowserSessionProjectionV1Schema,
} from "@agent-infra/contracts/pilot";
import { pilotFakeScenariosV2 } from "@agent-infra/test-support/pilot";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render as renderView,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentConfigurationScreen } from "./agent-configuration/agent-configuration-screen.js";
import { AgentDetailScreen } from "./agent-discovery/agent-detail-screen.js";
import { renderWithAgentRouter } from "./agent-discovery/test-router.js";
import { DirectoryRecords } from "./directory-fields.js";

function render(element: ReactElement) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	});
	const result = renderView(
		<QueryClientProvider client={client}>{element}</QueryClientProvider>,
	);
	return {
		...result,
		rerender(element: ReactElement) {
			result.rerender(
				<QueryClientProvider client={client}>{element}</QueryClientProvider>,
			);
		},
	};
}

const agent = AgentProjectionV2Schema.parse({
	...pilotFakeScenariosV2.starting.response.body,
	configuration: {
		...pilotFakeScenariosV2.starting.response.body.configuration,
		availability: [
			{ kind: "user", userId: "user-2" },
			{ kind: "organization", organizationId: "org-1" },
		],
	},
});
const session = BrowserSessionProjectionV1Schema.parse({
	schemaVersion: 1,
	user: { userId: "user-owner-1", displayName: "Owner", roles: ["employee"] },
});
const items = [
	{
		kind: "user",
		canonicalId: "user-owner-1",
		displayName: "Current Owner",
		email: "owner@example.test",
	},
	{
		kind: "user",
		canonicalId: "user-2",
		displayName: "Directory User",
		email: "user@example.test",
	},
	{
		kind: "user",
		canonicalId: "user-3",
		displayName: "New Owner",
		email: "new@example.test",
	},
	{
		kind: "organization",
		canonicalId: "org-1",
		displayName: "Platform",
		organizationPath: "Engineering / Platform",
	},
];
function directoryFixture() {
	const fetch = vi.fn(async (input: string | URL | Request) => {
		const url = new URL(String(input), "http://localhost");
		if (!url.pathname.endsWith("/directory/search"))
			return Response.json({ status: "not_configured" });
		const ids = url.searchParams.get("ids")?.split(",");
		const query = url.searchParams.get("q")?.toLowerCase() ?? "";
		return Response.json({
			items: items.filter(
				(item) =>
					item.kind === url.searchParams.get("kind") &&
					(!ids || ids.includes(item.canonicalId)) &&
					JSON.stringify(item).toLowerCase().includes(query),
			),
		});
	});
	vi.stubGlobal("fetch", fetch);
	return fetch;
}
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("Agent detail and Owner configuration directory fields", () => {
	it("resolves detail availability by canonical IDs without displaying them", async () => {
		const fetch = directoryFixture();
		await renderWithAgentRouter(
			<AgentDetailScreen state={{ kind: "ready", agent }} />,
		);
		expect(await screen.findByText("Directory User")).toBeTruthy();
		expect(await screen.findByText("Engineering / Platform")).toBeTruthy();
		expect(screen.getByText("user@example.test")).toBeTruthy();
		expect(document.body.textContent).not.toContain("user-2");
		expect(document.body.textContent).not.toContain("org-1");
		expect(
			fetch.mock.calls.some(([url]) => String(url).includes("ids=user-2")),
		).toBe(true);
		expect(
			fetch.mock.calls.some(([url]) => String(url).includes("ids=org-1")),
		).toBe(true);
	});
	it("shows directory failure and missing records without falling back to IDs", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null, { status: 503 })),
		);
		await renderWithAgentRouter(
			<AgentDetailScreen state={{ kind: "ready", agent }} />,
		);
		await waitFor(() =>
			expect(screen.getAllByText("目录暂时无法读取")).toHaveLength(2),
		);
		expect(document.body.textContent).not.toContain("user-2");
		cleanup();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ items: [] })),
		);
		await renderWithAgentRouter(
			<AgentDetailScreen state={{ kind: "ready", agent }} />,
		);
		await waitFor(() =>
			expect(screen.getAllByText("目录记录不可用")).toHaveLength(2),
		);
		expect(document.body.textContent).not.toContain("org-1");
	});
	it("prefills configuration chips and saves selected canonical IDs", async () => {
		directoryFixture();
		const onSave = vi.fn();
		render(
			<AgentConfigurationScreen
				agent={agent}
				onSave={onSave}
				onUpgradeImage={vi.fn()}
				session={{ kind: "ready", session }}
				submitting={false}
			/>,
		);
		expect(await screen.findByText("Current Owner")).toBeTruthy();
		expect(await screen.findByText("Directory User")).toBeTruthy();
		expect(await screen.findByText("Platform")).toBeTruthy();
		const input = screen.getByRole("combobox", { name: "共同 Owner 用户" });
		fireEvent.change(input, { target: { value: "New" } });
		fireEvent.click(await screen.findByRole("option", { name: /New Owner/ }));
		fireEvent.click(
			screen.getByRole("button", { name: "移除 Directory User" }),
		);
		fireEvent.click(screen.getByRole("button", { name: "校验并保存" }));
		expect(onSave).toHaveBeenCalledWith(
			expect.objectContaining({
				coOwnerIds: ["user-owner-1", "user-3"],
				availability: [{ kind: "organization", organizationId: "org-1" }],
			}),
		);
		expect(screen.queryByLabelText("Owner 用户 ID")).toBeNull();
	});
	it("retains unresolved selections on directory failure and prevents an empty Owner submission", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null, { status: 503 })),
		);
		const onSave = vi.fn();
		render(
			<AgentConfigurationScreen
				agent={agent}
				onSave={onSave}
				onUpgradeImage={vi.fn()}
				session={{ kind: "ready", session }}
				submitting={false}
			/>,
		);
		await waitFor(() =>
			expect(screen.getAllByText("目录记录不可用")).toHaveLength(3),
		);
		fireEvent.click(screen.getByRole("button", { name: "校验并保存" }));
		expect(onSave).toHaveBeenCalledWith(
			expect.objectContaining({
				coOwnerIds: ["user-owner-1"],
				availability: agent.configuration.availability,
			}),
		);
		onSave.mockClear();
		const ownerField = screen
			.getByRole("combobox", { name: "共同 Owner 用户" })
			.closest(".directory-field");
		if (!(ownerField instanceof HTMLElement))
			throw new Error("Missing Owner field");
		fireEvent.click(
			within(ownerField).getByRole("button", { name: "移除 目录记录不可用" }),
		);
		fireEvent.click(screen.getByRole("button", { name: "校验并保存" }));
		expect(onSave).not.toHaveBeenCalled();
		expect(screen.getByText("请选择至少一名有效 Owner。")).toBeTruthy();
	});
});

it("does not reuse readable records when a new scope fails", async () => {
	const fetch = directoryFixture();
	const { rerender } = render(
		<DirectoryRecords kind="user" ids={["user-2"]} />,
	);
	expect(await screen.findByText("Directory User")).toBeTruthy();
	fetch.mockImplementation(async () => new Response(null, { status: 403 }));
	rerender(<DirectoryRecords kind="user" ids={["user-3"]} />);
	expect(screen.queryByText("Directory User")).toBeNull();
	expect(await screen.findByText("目录暂时无法读取")).toBeTruthy();
});

it("resolves all selected records beyond the 50-result search limit", async () => {
	const ids = Array.from({ length: 51 }, (_, index) => `selected-${index}`);
	const fetch = vi.fn(async (input: string | URL | Request) => {
		const url = new URL(String(input), "http://localhost");
		const batch = url.searchParams.get("ids")?.split(",") ?? [];
		expect(batch.length).toBeLessThanOrEqual(50);
		return Response.json({
			items: batch.map((id) => ({
				kind: "user",
				canonicalId: id,
				displayName: `Name ${id}`,
			})),
		});
	});
	vi.stubGlobal("fetch", fetch);
	render(<DirectoryRecords kind="user" ids={ids} />);
	expect(await screen.findByText("Name selected-50")).toBeTruthy();
	expect(screen.getAllByRole("listitem")).toHaveLength(51);
	expect(fetch).toHaveBeenCalledTimes(2);
});

it.each(["pending", "disabled"])(
	"keeps configuration directory controls disabled while %s",
	async (state) => {
		directoryFixture();
		render(
			<AgentConfigurationScreen
				agent={{
					...agent,
					managementStatus:
						state === "disabled" ? "disabled" : agent.managementStatus,
				}}
				onSave={vi.fn()}
				onUpgradeImage={vi.fn()}
				session={{ kind: "ready", session }}
				submitting={state === "pending"}
			/>,
		);
		await screen.findByText("Current Owner");
		for (const input of screen.getAllByRole("combobox"))
			expect(input.hasAttribute("disabled")).toBe(true);
		expect(
			screen
				.getByRole("button", { name: "移除 Current Owner" })
				.hasAttribute("disabled"),
		).toBe(true);
	},
);

it("does not read the directory for non-Owner configuration", () => {
	const fetch = directoryFixture();
	render(
		<AgentConfigurationScreen
			agent={agent}
			onSave={vi.fn()}
			onUpgradeImage={vi.fn()}
			session={{
				kind: "ready",
				session: {
					...session,
					user: { ...session.user, userId: "other-user" },
				},
			}}
			submitting={false}
		/>,
	);
	expect(screen.getByRole("heading", { name: "配置不可用" })).toBeTruthy();
	expect(fetch).not.toHaveBeenCalled();
});
