import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	classifyLoginFailure,
	isSafeLoginEndpoint,
	LoginAction,
	loginFailureMessages,
} from "./login-action";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

const credentialsMessage = "账号或密码不正确，请检查后重试。";

function account() {
	return screen.getByRole("textbox", { name: "公司账号" }) as HTMLInputElement;
}
function password() {
	return screen.getByLabelText("密码", { exact: true }) as HTMLInputElement;
}
function fill(login: string, secret: string) {
	fireEvent.change(account(), { target: { value: login } });
	fireEvent.change(password(), { target: { value: secret } });
}
function submit() {
	fireEvent.submit(screen.getByRole("button", { name: "登录" }));
}
/** 每个 aria-describedby 引用都必须指向页面中存在的元素（NI-16）。 */
function expectDescribedByResolves(input: HTMLElement) {
	for (const id of (input.getAttribute("aria-describedby") ?? "")
		.split(/\s+/)
		.filter(Boolean))
		expect(document.getElementById(id)).not.toBeNull();
}

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

		fill("alice", "correct horse");
		submit();

		await waitFor(() => expect(onLoggedIn).toHaveBeenCalledOnce());
		expect(fetchMock).toHaveBeenCalledWith("http://localhost:3000/auth/login", {
			method: "POST",
			credentials: "include",
			redirect: "error",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ login: "alice", password: "correct horse" }),
		});
		await waitFor(() => expect(password().value).toBe(""));
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("keeps the form retryable and does not report login on failure", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response(null, { status: 401 }));
		vi.stubGlobal("fetch", fetchMock);
		const onLoggedIn = vi.fn();
		render(<LoginAction endpoint="/auth/login" onLoggedIn={onLoggedIn} />);

		fill("alice", "wrong");
		submit();

		expect((await screen.findByRole("alert")).textContent).toBe(
			credentialsMessage,
		);
		expect(onLoggedIn).not.toHaveBeenCalled();
		expect(
			(screen.getByRole("button", { name: "登录" }) as HTMLButtonElement)
				.disabled,
		).toBe(false);
		// L-05：设计要求每次提交后清空密码，焦点回到密码框以便重输。
		expect(password().value).toBe("");
		await waitFor(() => expect(document.activeElement).toBe(password()));
		// 账号保留，便于只改密码重试。
		expect(account().value).toBe("alice");
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

		fill("alice", "secret");
		submit();

		expect((await screen.findByRole("alert")).textContent).toBe(
			"登录失败，请稍后重试。",
		);
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

		fill("alice", "secret");
		submit();

		expect((await screen.findByRole("alert")).textContent).toBe(
			"登录失败，请稍后重试。",
		);
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

		fill("alice", "secret");
		submit();

		expect((await screen.findByRole("alert")).textContent).toBe(
			"登录失败，请稍后重试。",
		);
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

		fill("alice", "secret");
		submit();

		// NI-30：会话未建立不是凭据错误。
		expect((await screen.findByRole("alert")).textContent).toBe(
			"登录服务暂时不可用，请稍后重试。",
		);
		// 设计要求每次提交后都清空密码。
		expect(password().value).toBe("");
	});
});

describe("classifyLoginFailure", () => {
	it.each([
		[401, "credentials"],
		[403, "entry-origin"],
		[500, "unavailable"],
		[502, "unavailable"],
		[503, "unavailable"],
		[429, "unavailable"],
		[400, "unknown"],
		[405, "unknown"],
		[418, "unknown"],
		[422, "unknown"],
	] as const)("maps HTTP %i to %s", (status, expected) => {
		expect(classifyLoginFailure({ kind: "status", status })).toBe(expected);
	});

	it("treats network errors and a missing session as unavailable, and unsafe endpoints as unknown", () => {
		expect(classifyLoginFailure({ kind: "network" })).toBe("unavailable");
		expect(classifyLoginFailure({ kind: "session-missing" })).toBe(
			"unavailable",
		);
		expect(classifyLoginFailure({ kind: "unsafe-endpoint" })).toBe("unknown");
	});

	it("uses the credential copy only for 401", () => {
		expect(
			Object.entries(loginFailureMessages)
				.filter(([, message]) => message === credentialsMessage)
				.map(([failure]) => failure),
		).toEqual(["credentials"]);
	});
});

describe("LoginAction field validation (L-04)", () => {
	it("reports both empty fields inline without sending a request", () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		render(<LoginAction endpoint="/auth/login" onLoggedIn={vi.fn()} />);
		const form = account().closest("form");
		expect(form?.noValidate).toBe(true);
		expect(account().required).toBe(false);
		expect(password().required).toBe(false);

		submit();

		expect(fetchMock).not.toHaveBeenCalled();
		expect(screen.getByText("请输入公司账号。")).toBeTruthy();
		expect(screen.getByText("请输入密码。")).toBeTruthy();
		for (const input of [account(), password()]) {
			expect(input.getAttribute("aria-invalid")).toBe("true");
			expectDescribedByResolves(input);
		}
		expect(
			document.getElementById(account().getAttribute("aria-describedby") ?? "")
				?.textContent,
		).toBe("请输入公司账号。");
		expect(
			document.getElementById(password().getAttribute("aria-describedby") ?? "")
				?.textContent,
		).toBe("请输入密码。");
		expect(document.activeElement).toBe(account());
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("focuses the password when only it is missing and treats a blank account as empty", () => {
		vi.stubGlobal("fetch", vi.fn());
		render(<LoginAction endpoint="/auth/login" onLoggedIn={vi.fn()} />);
		fireEvent.change(account(), { target: { value: "alice" } });
		submit();
		expect(document.activeElement).toBe(password());
		expect(screen.queryByText("请输入公司账号。")).toBeNull();
		expect(screen.getByText("请输入密码。")).toBeTruthy();

		fireEvent.change(account(), { target: { value: "   " } });
		fireEvent.change(password(), { target: { value: "secret" } });
		submit();
		expect(screen.getByText("请输入公司账号。")).toBeTruthy();
		expect(document.activeElement).toBe(account());
	});

	it("clears each field error as soon as that field receives input", () => {
		vi.stubGlobal("fetch", vi.fn());
		render(<LoginAction endpoint="/auth/login" onLoggedIn={vi.fn()} />);
		submit();
		fireEvent.change(account(), { target: { value: "alice" } });
		expect(screen.queryByText("请输入公司账号。")).toBeNull();
		expect(account().hasAttribute("aria-invalid")).toBe(false);
		expect(account().hasAttribute("aria-describedby")).toBe(false);
		expect(screen.getByText("请输入密码。")).toBeTruthy();
		fireEvent.change(password(), { target: { value: "s" } });
		expect(screen.queryByText("请输入密码。")).toBeNull();
		expect(password().hasAttribute("aria-invalid")).toBe(false);
		expect(password().hasAttribute("aria-describedby")).toBe(false);
	});
});

describe("LoginAction failure classification (L-05, R4-12)", () => {
	it.each([
		[401, credentialsMessage],
		[403, "请从平台入口地址访问后重试。"],
		[500, "登录服务暂时不可用，请稍后重试。"],
		[503, "登录服务暂时不可用，请稍后重试。"],
		[429, "登录服务暂时不可用，请稍后重试。"],
		[400, "登录失败，请稍后重试。"],
		[405, "登录失败，请稍后重试。"],
	])("shows one alert for HTTP %i", async (status, message) => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response(null, { status })),
		);
		render(<LoginAction endpoint="/auth/login" onLoggedIn={vi.fn()} />);
		fill("alice", "secret");
		submit();

		await screen.findByRole("alert");
		const alerts = screen.getAllByRole("alert");
		expect(alerts).toHaveLength(1);
		expect(alerts[0]?.textContent).toBe(message);
		// 不回显服务端状态码或输入值。
		expect(alerts[0]?.textContent).not.toContain(String(status));
		expect(document.body.textContent).not.toContain("secret");
		const credentials = status === 401;
		for (const input of [account(), password()]) {
			expect(input.getAttribute("aria-invalid")).toBe(
				credentials ? "true" : null,
			);
			expect(input.getAttribute("aria-describedby")).toBe(
				credentials ? alerts[0]?.id : null,
			);
			expectDescribedByResolves(input);
		}
		expect(password().value).toBe("");
		await waitFor(() => expect(document.activeElement).toBe(password()));
	});

	it.each([
		[
			"network error",
			() => vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
		],
		[
			"rate limit",
			() => vi.fn().mockResolvedValue(new Response(null, { status: 429 })),
		],
	])("does not blame credentials for a %s (NI-30)", async (_, fetchMock) => {
		vi.stubGlobal("fetch", fetchMock());
		render(<LoginAction endpoint="/auth/login" onLoggedIn={vi.fn()} />);
		fill("alice", "secret");
		submit();
		expect((await screen.findByRole("alert")).textContent).toBe(
			"登录服务暂时不可用，请稍后重试。",
		);
		expect(screen.queryByText(credentialsMessage)).toBeNull();
	});

	it("hides the form error and clears aria-invalid once the user types again", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response(null, { status: 401 })),
		);
		render(<LoginAction endpoint="/auth/login" onLoggedIn={vi.fn()} />);
		fill("alice", "wrong");
		submit();
		await screen.findByRole("alert");
		fireEvent.change(password(), { target: { value: "n" } });
		expect(screen.queryByRole("alert")).toBeNull();
		for (const input of [account(), password()]) {
			expect(input.hasAttribute("aria-invalid")).toBe(false);
			expect(input.hasAttribute("aria-describedby")).toBe(false);
		}
	});
});

describe("LoginAction submission state (L-06, NI-54)", () => {
	it("shows a spinner, marks the form busy and disables every control while submitting", async () => {
		let respond!: (response: Response) => void;
		vi.stubGlobal(
			"fetch",
			vi.fn(
				() =>
					new Promise<Response>((resolve) => {
						respond = resolve;
					}),
			),
		);
		render(<LoginAction endpoint="/auth/login" onLoggedIn={vi.fn()} />);
		fill("alice", "secret");
		fireEvent.click(screen.getByRole("button", { name: "显示密码" }));
		submit();

		const busy = await screen.findByRole("button", { name: "正在登录…" });
		expect(busy.querySelector('[data-slot="spinner"]')).toBeTruthy();
		expect(account().closest("form")?.getAttribute("aria-busy")).toBe("true");
		// #3242 K7-02：提交按钮在请求进行中是可聚焦的禁用（aria-disabled），不再是原生 disabled。
		expect(busy.getAttribute("aria-disabled")).toBe("true");
		expect((busy as HTMLButtonElement).disabled).toBe(false);
		expect(account().disabled).toBe(true);
		expect(password().disabled).toBe(true);
		expect(
			(screen.getByRole("button", { name: "隐藏密码" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);

		await act(async () => respond(new Response(null, { status: 503 })));
		await screen.findByRole("alert");
		// 提交结束后密码恢复隐藏。
		const toggle = screen.getByRole("button", { name: "显示密码" });
		expect(toggle.getAttribute("aria-pressed")).toBe("false");
		expect(password().type).toBe("password");
		expect(account().closest("form")?.hasAttribute("aria-busy")).toBe(false);
	});

	it("toggles password visibility with matching state attributes", () => {
		render(<LoginAction endpoint="/auth/login" onLoggedIn={vi.fn()} />);
		const toggle = screen.getByRole("button", { name: "显示密码" });
		expect(toggle.getAttribute("aria-controls")).toBe(password().id);
		expect(toggle.getAttribute("aria-pressed")).toBe("false");
		expect(password().type).toBe("password");
		fireEvent.click(toggle);
		expect(toggle.getAttribute("aria-pressed")).toBe("true");
		expect(toggle.getAttribute("aria-label")).toBe("隐藏密码");
		expect(password().type).toBe("text");
		fireEvent.click(toggle);
		expect(toggle.getAttribute("aria-label")).toBe("显示密码");
		expect(password().type).toBe("password");
	});

	it("uses the designed input attributes (L-02)", () => {
		render(<LoginAction endpoint="/auth/login" onLoggedIn={vi.fn()} />);
		expect(account().placeholder).toBe("输入公司账号");
		expect(account().getAttribute("autocapitalize")).toBe("none");
		expect(account().getAttribute("spellcheck")).toBe("false");
		expect(account().autocomplete).toBe("username");
		expect(account().maxLength).toBe(256);
		expect(password().placeholder).toBe("输入密码");
		expect(password().autocomplete).toBe("current-password");
		expect(password().maxLength).toBe(4096);
	});
});
