import { Eye, EyeOff, LoaderCircle } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type LoginActionProps = {
	endpoint: string;
	onLoggedIn: () => Promise<unknown>;
};

type LoginState = "idle" | "submitting" | "error";

export function isSafeLoginEndpoint(endpoint: string, currentOrigin: string) {
	const target = new URL(endpoint, currentOrigin);
	const loopbackHttp =
		target.protocol === "http:" &&
		["localhost", "127.0.0.1", "[::1]"].includes(target.hostname);
	return (
		(target.protocol === "https:" || loopbackHttp) &&
		target.origin === currentOrigin &&
		!target.username &&
		!target.password
	);
}

/**
 * Consume the Platform browser login contract. The endpoint is configured by
 * deployment, but the credential-bearing request must stay same-origin.
 */
export function LoginAction({ endpoint, onLoggedIn }: LoginActionProps) {
	const [login, setLogin] = useState("");
	const [password, setPassword] = useState("");
	const [state, setState] = useState<LoginState>("idle");
	const [errorStatus, setErrorStatus] = useState<number | null>(null);
	const [clientErrors, setClientErrors] = useState({
		login: false,
		password: false,
	});
	const [showPassword, setShowPassword] = useState(false);
	const loginRef = useRef<HTMLInputElement>(null);
	const passwordRef = useRef<HTMLInputElement>(null);

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const nextClientErrors = {
			login: !login.trim(),
			password: !password,
		};
		if (nextClientErrors.login || nextClientErrors.password) {
			setClientErrors(nextClientErrors);
			setErrorStatus(null);
			if (nextClientErrors.login) loginRef.current?.focus();
			else passwordRef.current?.focus();
			return;
		}
		setState("submitting");
		setClientErrors({ login: false, password: false });
		setErrorStatus(null);
		try {
			const target = new URL(endpoint, window.location.href);
			if (!isSafeLoginEndpoint(endpoint, window.location.origin))
				throw new Error(
					"Login must use HTTPS or loopback HTTP without userinfo",
				);
			const response = await fetch(target.href, {
				method: "POST",
				credentials: "include",
				redirect: "error",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ login, password }),
			});
			if (!response.ok) {
				setErrorStatus(response.status);
				throw new Error(`Login failed: ${response.status}`);
			}
			await onLoggedIn();
			setPassword("");
			setState("idle");
		} catch {
			setErrorStatus((value) => value ?? 0);
			setState("error");
			setPassword("");
		}
	}
	const loginError = clientErrors.login ? "请输入公司账号。" : undefined;
	const passwordError = clientErrors.password ? "请输入密码。" : undefined;
	const serverError =
		state === "error" && errorStatus !== null
			? errorStatus === 0 ||
				errorStatus === 429 ||
				errorStatus === 503 ||
				(errorStatus !== null && errorStatus >= 500)
				? "登录服务暂时不可用，请稍后重试。"
				: errorStatus === 403
					? "请从平台入口地址访问后重试。"
					: "账号或密码不正确，请检查后重试。"
			: undefined;

	return (
		<form
			className="login-form space-y-4"
			onSubmit={submit}
			noValidate
			aria-busy={state === "submitting" || undefined}
		>
			<div className="password-control space-y-2">
				<Label htmlFor="platform-login">账号</Label>
				<Input
					id="platform-login"
					name="login"
					placeholder="输入公司账号"
					autoCapitalize="none"
					spellCheck={false}
					autoComplete="username"
					maxLength={256}
					aria-invalid={clientErrors.login || state === "error" || undefined}
					aria-describedby={
						[
							loginError ? "platform-login-field-error" : undefined,
							serverError ? "platform-login-error" : undefined,
						]
							.filter(Boolean)
							.join(" ") || undefined
					}
					value={login}
					onChange={(event) => {
						setLogin(event.target.value);
						setClientErrors((current) => ({ ...current, login: false }));
					}}
					ref={loginRef}
					disabled={state === "submitting"}
				/>
				{loginError && (
					<p className="field-error" id="platform-login-field-error">
						{loginError}
					</p>
				)}
			</div>
			<div className="space-y-2">
				<Label htmlFor="platform-password">密码</Label>
				<Input
					id="platform-password"
					name="password"
					type={showPassword ? "text" : "password"}
					autoComplete="current-password"
					placeholder="输入密码"
					spellCheck={false}
					maxLength={4096}
					aria-invalid={clientErrors.password || state === "error" || undefined}
					aria-describedby={
						[
							passwordError ? "platform-password-field-error" : undefined,
							serverError ? "platform-login-error" : undefined,
						]
							.filter(Boolean)
							.join(" ") || undefined
					}
					value={password}
					className="pr-14"
					onChange={(event) => {
						setPassword(event.target.value);
						setClientErrors((current) => ({ ...current, password: false }));
					}}
					ref={passwordRef}
					disabled={state === "submitting"}
				/>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					className="login-password-toggle"
					aria-pressed={showPassword}
					aria-controls="platform-password"
					disabled={state === "submitting"}
					aria-label={showPassword ? "隐藏密码" : "显示密码"}
					onClick={() => setShowPassword((value) => !value)}
				>
					{showPassword ? (
						<EyeOff aria-hidden="true" />
					) : (
						<Eye aria-hidden="true" />
					)}
				</Button>
				{passwordError && (
					<p className="field-error" id="platform-password-field-error">
						{passwordError}
					</p>
				)}
			</div>
			<Button
				className="login-submit"
				type="submit"
				disabled={state === "submitting"}
			>
				{state === "submitting" && (
					<LoaderCircle className="animate-spin" aria-hidden="true" />
				)}
				{state === "submitting" ? "正在登录…" : "登录"}
			</Button>
			{serverError && (
				<Alert
					id="platform-login-error"
					role="alert"
					className="login-error"
					variant="destructive"
				>
					<AlertDescription>{serverError}</AlertDescription>
				</Alert>
			)}
		</form>
	);
}
