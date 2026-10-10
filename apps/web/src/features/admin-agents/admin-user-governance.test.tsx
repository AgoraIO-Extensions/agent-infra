import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminUserGovernance } from "./admin-user-governance.js";

const { setPlatformUserDisabledV2 } = vi.hoisted(() => ({
	setPlatformUserDisabledV2: vi.fn(),
}));
vi.mock("../../pilot/generated-v2/sdk.gen.js", () => ({
	setPlatformUserDisabledV2,
}));

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

function setupDirectory() {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () =>
			Response.json({
				items: [
					{
						kind: "user",
						canonicalId: "11111111-1111-4111-8111-111111111111",
						displayName: "Alice",
						email: "alice@example.test",
					},
				],
				kind: "user",
				query: "",
			}),
		),
	);
}

describe("Administrator employee access control", () => {
	it("selects a directory user and sends a server-authorized disable command", async () => {
		setupDirectory();
		setPlatformUserDisabledV2.mockResolvedValue({ response: { status: 204 } });
		render(<AdminUserGovernance />);
		fireEvent.focus(screen.getByRole("combobox", { name: "员工" }));
		await screen.findByRole("option", { name: /Alice/ });
		fireEvent.click(screen.getByRole("option", { name: /Alice/ }));
		fireEvent.click(screen.getByRole("button", { name: "禁用员工" }));
		await waitFor(() =>
			expect(setPlatformUserDisabledV2).toHaveBeenCalledWith({
				path: { userId: "11111111-1111-4111-8111-111111111111" },
				body: { schemaVersion: 1, disabled: true },
				responseStyle: "fields",
				throwOnError: false,
			}),
		);
		expect(await screen.findByText(/已提交禁用/)).toBeTruthy();
	});

	it("keeps both actions explicit and reports an unconfirmed response without details", async () => {
		setupDirectory();
		setPlatformUserDisabledV2.mockResolvedValue({ response: { status: 503 } });
		render(<AdminUserGovernance />);
		fireEvent.focus(screen.getByRole("combobox", { name: "员工" }));
		await screen.findByRole("option", { name: /Alice/ });
		fireEvent.click(screen.getByRole("option", { name: /Alice/ }));
		fireEvent.click(screen.getByRole("button", { name: "解除禁用" }));
		await screen.findByText(/操作未确认/);
		expect(screen.getByRole("button", { name: "禁用员工" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "解除禁用" })).toBeTruthy();
	});
});
