import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApplicationMaterialGovernance } from "./application-material-governance.js";

const { read, grant, revoke } = vi.hoisted(() => ({
	read: vi.fn(),
	grant: vi.fn(),
	revoke: vi.fn(),
}));
vi.mock("../../pilot/generated-v2/sdk.gen.js", () => ({
	readApplicationMaterialV2: read,
	grantApplicationMaterialV2: grant,
	revokeApplicationMaterialV2: revoke,
}));

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

const metadata = {
	applicationId: "app-1",
	authorizationRevision: "rev-1",
	createdAt: "2026-10-01T00:00:00Z",
	principalId: "user-1",
	principalType: "user" as const,
	revokedAt: null,
};

function fill() {
	fireEvent.change(screen.getByLabelText("应用 ID"), {
		target: { value: "app-1" },
	});
	fireEvent.change(screen.getByLabelText("接收主体 ID"), {
		target: { value: "user-1" },
	});
}

describe("ApplicationMaterialGovernance", () => {
	it("reads metadata, grants and revokes without exposing material", async () => {
		read.mockResolvedValue({ response: { status: 200 }, data: { metadata } });
		grant.mockResolvedValue({
			response: { status: 201 },
			data: { metadata, replayed: false },
		});
		revoke.mockResolvedValue({
			response: { status: 200 },
			data: {
				metadata: { ...metadata, revokedAt: "2026-10-14T00:00:00Z" },
				replayed: false,
			},
		});
		render(<ApplicationMaterialGovernance />);
		fill();
		await screen.findByText("当前授权：有效");
		fireEvent.click(screen.getByRole("button", { name: "授权材料" }));
		await waitFor(() => expect(grant).toHaveBeenCalledOnce());
		fireEvent.click(screen.getByRole("button", { name: "撤销材料授权" }));
		await waitFor(() =>
			expect(revoke).toHaveBeenCalledWith({
				path: {
					applicationId: "app-1",
					principalType: "user",
					principalId: "user-1",
				},
				body: { expectedRevision: "rev-1", status: "revoked" },
				responseStyle: "fields",
				throwOnError: false,
			}),
		);
		expect(screen.queryByText(/credential|secret|token/i)).toBeNull();
	});

	it("keeps revoke unavailable when the metadata read is denied", async () => {
		read.mockResolvedValue({ response: { status: 403 } });
		render(<ApplicationMaterialGovernance />);
		fill();
		await screen.findByText("当前授权：暂时无法确认");
		expect(
			screen
				.getByRole("button", { name: "撤销材料授权" })
				.hasAttribute("disabled"),
		).toBe(true);
	});

	it("blocks grant and target changes while metadata or mutation is pending", async () => {
		let resolveRead: (value: unknown) => void = () => undefined;
		read.mockReturnValue(new Promise((resolve) => (resolveRead = resolve)));
		render(<ApplicationMaterialGovernance />);
		fill();
		expect(
			screen.getByRole("button", { name: "授权材料" }).hasAttribute("disabled"),
		).toBe(true);
		resolveRead({ response: { status: 200 }, data: { metadata } });
		await screen.findByText("当前授权：有效");
		let resolveGrant: (value: unknown) => void = () => undefined;
		grant.mockReturnValue(new Promise((resolve) => (resolveGrant = resolve)));
		fireEvent.click(screen.getByRole("button", { name: "授权材料" }));
		await waitFor(() => expect(grant).toHaveBeenCalledOnce());
		expect(screen.getByLabelText("应用 ID").hasAttribute("disabled")).toBe(
			true,
		);
		expect(screen.getByLabelText("接收主体 ID").hasAttribute("disabled")).toBe(
			true,
		);
		resolveGrant({
			response: { status: 201 },
			data: { metadata, replayed: false },
		});
	});
});
