// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { EmployeePicker } from "./employee-picker";

const search = vi.hoisted(() => vi.fn());
vi.mock("../api", () => ({
	connectionApi: { searchApprovalEmployees: search },
}));
afterEach(() => {
	cleanup();
	vi.resetAllMocks();
});
const alice = {
	candidateId: "candidate-1",
	displayName: "Alice",
	email: "alice@example.com",
	alias: null,
};
function setup() {
	const onSelect = vi.fn();
	render(
		<QueryClientProvider
			client={
				new QueryClient({ defaultOptions: { queries: { retry: false } } })
			}
		>
			<EmployeePicker label="审批人" onSelect={onSelect} />
		</QueryClientProvider>,
	);
	return { input: screen.getByRole("combobox"), onSelect };
}

it("debounces searches and selects from the dropdown by keyboard", async () => {
	search.mockResolvedValue({ candidates: [alice] });
	const { input, onSelect } = setup();
	fireEvent.change(input, { target: { value: "al" } });
	fireEvent.change(input, { target: { value: "alice" } });
	expect(screen.getByRole("status").textContent).toContain("正在搜索");
	await screen.findByRole("option");
	expect(search).toHaveBeenCalledTimes(1);
	expect(search).toHaveBeenCalledWith("alice");
	fireEvent.keyDown(input, { key: "ArrowDown" });
	fireEvent.keyDown(input, { key: "Enter" });
	expect(onSelect).toHaveBeenCalledWith(alice);
	expect(screen.queryByRole("option")).toBeNull();
});

it("shows an actionable error and an explicit empty state after retry", async () => {
	search
		.mockRejectedValueOnce(new Error("unavailable"))
		.mockResolvedValue({ candidates: [] });
	const { input } = setup();
	fireEvent.change(input, { target: { value: "alice" } });
	expect((await screen.findByRole("alert")).textContent).toContain(
		"员工目录暂不可用",
	);
	fireEvent.click(screen.getByRole("button", { name: "重试" }));
	await waitFor(() =>
		expect(screen.getByRole("status").textContent).toContain("未找到"),
	);
});

it("never offers a late result for a previous query", async () => {
	let resolveFirst!: (value: unknown) => void;
	search
		.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveFirst = resolve;
				}),
		)
		.mockResolvedValue({ candidates: [] });
	const { input } = setup();
	fireEvent.change(input, { target: { value: "alice" } });
	await waitFor(() => expect(search).toHaveBeenCalledOnce());
	fireEvent.change(input, { target: { value: "bob" } });
	resolveFirst({ candidates: [alice] });
	await waitFor(() => expect(search).toHaveBeenCalledTimes(2));
	expect(screen.queryByRole("option")).toBeNull();
});
