// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	login: vi.fn(async () => ({
		account: { displayName: "连接用户", email: "user@example.invalid" },
		isAdministrator: false,
	})),
	navigate: vi.fn(async () => undefined),
	returnTo: "/connection/connections?provider=confluence&intent=authorize",
}));

vi.mock("../api", () => ({
	ConnectionApiError: class ConnectionApiError extends Error {},
	connectionApi: { login: mocks.login },
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	useNavigate: () => mocks.navigate,
}));

import { LoginPage } from "../pages/login-page";

afterEach(() => {
	cleanup();
	mocks.returnTo =
		"/connection/connections?provider=confluence&intent=authorize";
	vi.clearAllMocks();
});

function renderLogin() {
	return render(
		<QueryClientProvider client={new QueryClient()}>
			<LoginPage returnTo={mocks.returnTo} />
		</QueryClientProvider>,
	);
}

async function login() {
	fireEvent.change(screen.getByLabelText("公司账号"), {
		target: { value: "connection-user" },
	});
	fireEvent.change(screen.getByLabelText("密码"), {
		target: { value: "password" },
	});
	fireEvent.submit(screen.getByRole("button", { name: "登录" }));
	await waitFor(() => expect(mocks.login).toHaveBeenCalledOnce());
}

describe("Connection 登录恢复", () => {
	it("登录后恢复受控的 Provider 授权深链", async () => {
		renderLogin();
		await login();

		expect(mocks.navigate).toHaveBeenCalledWith({
			search: { intent: "authorize", provider: "confluence" },
			to: "/connection/connections",
		});
	});

	it("拒绝外部 returnTo", async () => {
		mocks.returnTo = "https://evil.example/steal";
		renderLogin();
		await login();

		expect(mocks.navigate).toHaveBeenCalledWith({
			to: "/connection/connections",
		});
	});
});
