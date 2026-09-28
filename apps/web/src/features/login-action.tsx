import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type LoginActionProps = {
	endpoint: string;
	onLoggedIn: () => Promise<unknown>;
};

type LoginState = "idle" | "submitting" | "error";

/**
 * Consume the Platform browser login contract. The endpoint is configured by
 * deployment, but the credential-bearing request must stay same-origin.
 */
export function LoginAction({ endpoint, onLoggedIn }: LoginActionProps) {
	const [login, setLogin] = useState("");
	const [password, setPassword] = useState("");
	const [state, setState] = useState<LoginState>("idle");

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setState("submitting");
		try {
			const target = new URL(endpoint, window.location.href);
			if (
				!["http:", "https:"].includes(target.protocol) ||
				target.origin !== window.location.origin ||
				target.username ||
				target.password
			)
				throw new Error(
					"Login must use a same-origin HTTP(S) endpoint without userinfo",
				);
			const response = await fetch(target.href, {
				method: "POST",
				credentials: "include",
				redirect: "error",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ login, password }),
			});
			if (!response.ok) throw new Error(`Login failed: ${response.status}`);
			await onLoggedIn();
			setPassword("");
			setState("idle");
		} catch {
			setState("error");
		}
	}

	return (
		<form className="max-w-sm space-y-4" onSubmit={submit}>
			<div className="space-y-2">
				<Label htmlFor="platform-login">账号</Label>
				<Input
					id="platform-login"
					name="login"
					autoComplete="username"
					maxLength={256}
					aria-invalid={state === "error" || undefined}
					aria-describedby={
						state === "error" ? "platform-login-error" : undefined
					}
					value={login}
					onChange={(event) => setLogin(event.target.value)}
					required
					disabled={state === "submitting"}
				/>
			</div>
			<div className="space-y-2">
				<Label htmlFor="platform-password">密码</Label>
				<Input
					id="platform-password"
					name="password"
					type="password"
					autoComplete="current-password"
					maxLength={4096}
					aria-invalid={state === "error" || undefined}
					aria-describedby={
						state === "error" ? "platform-login-error" : undefined
					}
					value={password}
					onChange={(event) => setPassword(event.target.value)}
					required
					disabled={state === "submitting"}
				/>
			</div>
			<Button type="submit" disabled={state === "submitting"}>
				{state === "submitting" ? "正在登录…" : "登录"}
			</Button>
			{state === "error" && (
				<p
					id="platform-login-error"
					className="text-destructive text-sm"
					role="status"
				>
					登录失败，请检查账号或稍后重试。
				</p>
			)}
		</form>
	);
}
