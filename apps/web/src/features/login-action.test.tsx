import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isSafeLoginEndpoint, LoginAction } from "./login-action";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("LoginAction", () => {
	it("requires HTTPS except for same-origin loopback HTTP", () => {
		expect(
			isSafeLoginEndpoint(
				"http://example.test/auth/login",
				"http://example.test",
			),
		).toBe(false);
		expect(
			isSafeLoginEndpoint(
				"http://localhost:3000/auth/login",
				"http://localhost:3000",
			),
		).toBe(true);
		expect(
			isSafeLoginEndpoint(
				"http://127.0.0.1:3511/auth/login",
				"http://127.0.0.1:3511",
			),
		).toBe(true);
		expect(
			isSafeLoginEndpoint(
				"https://example.test/auth/login",
				"https://example.test",
			),
		).toBe(true);
	});

	it("posts the Platform JSON login contract with browser credentials", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response(null, { status: 204 }));
		vi.stubGlobal("fetch", fetchMock);
		const onLoggedIn = vi.fn().mockResolvedValue(undefined);
		render(<LoginAction endpoint="/auth/login" onLoggedIn={onLoggedIn} />);

		fireEvent.change(screen.getByLabelText("账号"), {
			target: { value: "alice" },
		});
		fireEvent.change(screen.getByLabelText("密码"), {
			target: { value: "correct horse" },
		});
		fireEvent.submit(screen.getByRole("button", { name: "登录" }));

		await waitFor(() => expect(onLoggedIn).toHaveBeenCalledOnce());
		expect(fetchMock).toHaveBeenCalledWith("http://localhost:3000/auth/login", {
			method: "POST",
			credentials: "include",
			redirect: "error",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ login: "alice", password: "correct horse" }),
		});
		expect((screen.getByLabelText("密码") as HTMLInputElement).value).toBe("");
	});

	it("reports both empty fields and focuses the account field", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		render(<LoginAction endpoint="/auth/login" onLoggedIn={vi.fn()} />);

		fireEvent.submit(screen.getByRole("button", { name: "登录" }));

		await screen.findByText("请输入公司账号。");
		expect(screen.getByText("请输入密码。")).toBeTruthy();
		const loginInput = screen.getByLabelText("账号") as HTMLInputElement;
		const passwordInput = screen.getByLabelText("密码") as HTMLInputElement;
		expect(document.activeElement).toBe(loginInput);
		expect(loginInput.getAttribute("aria-invalid")).toBe("true");
		expect(passwordInput.getAttribute("aria-invalid")).toBe("true");
		expect(loginInput.getAttribute("aria-describedby")).toBe(
			"platform-login-field-error",
		);
		expect(passwordInput.getAttribute("aria-describedby")).toBe(
			"platform-password-field-error",
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("focuses the password field when only the password is missing", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		render(<LoginAction endpoint="/auth/login" onLoggedIn={vi.fn()} />);

		fireEvent.change(screen.getByLabelText("账号"), {
			target: { value: "alice" },
		});
		fireEvent.submit(screen.getByRole("button", { name: "登录" }));

		await screen.findByText("请输入密码。");
		const loginInput = screen.getByLabelText("账号") as HTMLInputElement;
		const passwordInput = screen.getByLabelText("密码") as HTMLInputElement;
		expect(document.activeElement).toBe(passwordInput);
		expect(loginInput.getAttribute("aria-invalid")).toBeNull();
		expect(passwordInput.getAttribute("aria-invalid")).toBe("true");
		expect(loginInput.getAttribute("aria-describedby")).toBeNull();
		expect(passwordInput.getAttribute("aria-describedby")).toBe(
			"platform-password-field-error",
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("keeps the form retryable and does not report login on failure", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response(null, { status: 401 }));
		vi.stubGlobal("fetch", fetchMock);
		const onLoggedIn = vi.fn();
		render(<LoginAction endpoint="/auth/login" onLoggedIn={onLoggedIn} />);

		fireEvent.change(screen.getByLabelText("账号"), {
			target: { value: "alice" },
		});
		fireEvent.change(screen.getByLabelText("密码"), {
			target: { value: "wrong" },
		});
		fireEvent.submit(screen.getByRole("button", { name: "登录" }));

		await screen.findByRole("alert");
		expect(onLoggedIn).not.toHaveBeenCalled();
		expect(
			(screen.getByRole("button", { name: "登录" }) as HTMLButtonElement)
				.disabled,
		).toBe(false);
		expect((screen.getByLabelText("密码") as HTMLInputElement).value).toBe("");
	});

	it("distinguishes an invalid platform entry from bad credentials", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response(null, { status: 403 })),
		);
		render(<LoginAction endpoint="/auth/login" onLoggedIn={vi.fn()} />);
		fireEvent.change(screen.getByLabelText("账号"), {
			target: { value: "alice" },
		});
		fireEvent.change(screen.getByLabelText("密码"), {
			target: { value: "wrong" },
		});
		fireEvent.submit(screen.getByRole("button", { name: "登录" }));

		expect((await screen.findByRole("alert")).textContent).toContain(
			"请从平台入口地址访问后重试。",
		);
	});

	it("rejects a cross-origin endpoint before sending credentials", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const onLoggedIn = vi.fn();
		render(
			<LoginAction
				endpoint="https://identity.example.test/auth/login"
				onLoggedIn={onLoggedIn}
			/>,
		);

		fireEvent.change(screen.getByLabelText("账号"), {
			target: { value: "alice" },
		});
		fireEvent.change(screen.getByLabelText("密码"), {
			target: { value: "secret" },
		});
		fireEvent.submit(screen.getByRole("button", { name: "登录" }));

		await screen.findByRole("alert");
		expect(fetchMock).not.toHaveBeenCalled();
		expect(onLoggedIn).not.toHaveBeenCalled();
	});

	it("rejects a non-HTTP endpoint before sending credentials", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const onLoggedIn = vi.fn();
		render(
			<LoginAction
				endpoint="blob:http://localhost:3000/credential-target"
				onLoggedIn={onLoggedIn}
			/>,
		);

		fireEvent.change(screen.getByLabelText("账号"), {
			target: { value: "alice" },
		});
		fireEvent.change(screen.getByLabelText("密码"), {
			target: { value: "secret" },
		});
		fireEvent.submit(screen.getByRole("button", { name: "登录" }));

		await screen.findByRole("alert");
		expect(fetchMock).not.toHaveBeenCalled();
		expect(onLoggedIn).not.toHaveBeenCalled();
	});

	it("rejects endpoint userinfo before sending credentials", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const onLoggedIn = vi.fn();
		render(
			<LoginAction
				endpoint="http://attacker:secret@localhost:3000/auth/login"
				onLoggedIn={onLoggedIn}
			/>,
		);

		fireEvent.change(screen.getByLabelText("账号"), {
			target: { value: "alice" },
		});
		fireEvent.change(screen.getByLabelText("密码"), {
			target: { value: "secret" },
		});
		fireEvent.submit(screen.getByRole("button", { name: "登录" }));

		await screen.findByRole("alert");
		expect(fetchMock).not.toHaveBeenCalled();
		expect(onLoggedIn).not.toHaveBeenCalled();
	});

	it("does not report a session when the post succeeds but refresh stays anonymous", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
		);
		const onLoggedIn = vi
			.fn()
			.mockRejectedValue(new Error("session unavailable"));
		render(<LoginAction endpoint="/auth/login" onLoggedIn={onLoggedIn} />);

		fireEvent.change(screen.getByLabelText("账号"), {
			target: { value: "alice" },
		});
		fireEvent.change(screen.getByLabelText("密码"), {
			target: { value: "secret" },
		});
		fireEvent.submit(screen.getByRole("button", { name: "登录" }));

		await screen.findByRole("alert");
		expect((screen.getByLabelText("密码") as HTMLInputElement).value).toBe("");
	});
});
