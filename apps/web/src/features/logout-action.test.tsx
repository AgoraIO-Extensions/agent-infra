import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LogoutAction } from "./logout-action";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("LogoutAction", () => {
	it("posts same-origin logout with credentials and CSRF header", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response(null, { status: 204 }));
		vi.stubGlobal("fetch", fetchMock);
		const onLoggedOut = vi.fn().mockResolvedValue(undefined);
		render(<LogoutAction endpoint="/auth/logout" onLoggedOut={onLoggedOut} />);

		fireEvent.click(screen.getByRole("button", { name: "退出登录" }));

		await waitFor(() => expect(onLoggedOut).toHaveBeenCalledOnce());
		expect(fetchMock).toHaveBeenCalledWith(
			"http://localhost:3000/auth/logout",
			{
				method: "POST",
				credentials: "include",
				headers: { "X-Platform-CSRF": "1" },
			},
		);
	});

	it("shows a retryable failure and does not report logout", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response(null, { status: 403 })),
		);
		const onLoggedOut = vi.fn();
		render(<LogoutAction endpoint="/auth/logout" onLoggedOut={onLoggedOut} />);

		fireEvent.click(screen.getByRole("button", { name: "退出登录" }));

		await screen.findByRole("status");
		expect(onLoggedOut).not.toHaveBeenCalled();
		expect(
			(screen.getByRole("button", { name: "退出登录" }) as HTMLButtonElement)
				.disabled,
		).toBe(false);
	});

	it("rejects a cross-origin logout endpoint before sending a request", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const onLoggedOut = vi.fn();
		render(
			<LogoutAction
				endpoint="https://identity.example.test/auth/logout"
				onLoggedOut={onLoggedOut}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "退出登录" }));

		await screen.findByRole("status");
		expect(fetchMock).not.toHaveBeenCalled();
		expect(onLoggedOut).not.toHaveBeenCalled();
	});
});
