import { Eye, EyeOff } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { useSubmitFocus } from "@/hooks/use-submit-focus";

type LoginActionProps = {
	endpoint: string;
	onLoggedIn: () => Promise<unknown>;
};

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

/** 一次登录提交的结果；只记录类别和 HTTP 状态码，不保留服务端正文。 */
export type LoginOutcome =
	| { kind: "status"; status: number }
	| { kind: "network" }
	| { kind: "unsafe-endpoint" }
	| { kind: "session-missing" };

export type LoginFailure =
	| "credentials"
	| "entry-origin"
	| "unavailable"
	| "unknown";

/** 失败只给可读文案：不回显服务端错误、状态码、账号或密码。 */
export const loginFailureMessages: Record<LoginFailure, string> = {
	credentials: "账号或密码不正确，请检查后重试。",
	"entry-origin": "请从平台入口地址访问后重试。",
	unavailable: "登录服务暂时不可用，请稍后重试。",
	unknown: "登录失败，请稍后重试。",
};

/**
 * 只有 401 使用凭据文案；403 是入口地址（Origin）不符；5xx、429、网络错误与
 * 204 后会话仍未建立按服务不可用处理；400、405、其他状态与不安全端点给通用文案。
 */
export function classifyLoginFailure(outcome: LoginOutcome): LoginFailure {
	switch (outcome.kind) {
		case "network":
		case "session-missing":
			return "unavailable";
		case "unsafe-endpoint":
			return "unknown";
		case "status":
			if (outcome.status === 401) return "credentials";
			if (outcome.status === 403) return "entry-origin";
			if (outcome.status === 429 || outcome.status >= 500) return "unavailable";
			return "unknown";
	}
}

const loginInputId = "platform-login";
const passwordInputId = "platform-password";
const loginFieldErrorId = "platform-login-field-error";
const passwordFieldErrorId = "platform-password-field-error";
const formErrorId = "platform-login-error";

/**
 * Consume the Platform browser login contract. The endpoint is configured by
 * deployment, but the credential-bearing request must stay same-origin.
 * 身份只来自之后重读的服务端会话，这里不读取也不信任任何身份字段。
 */
export function LoginAction({ endpoint, onLoggedIn }: LoginActionProps) {
	const [login, setLogin] = useState("");
	const [password, setPassword] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [passwordVisible, setPasswordVisible] = useState(false);
	// 前端空值校验使用独立状态，不复用 HTTP 状态码（NI-16）。
	const [fieldErrors, setFieldErrors] = useState({
		login: false,
		password: false,
	});
	const [failure, setFailure] = useState<LoginFailure | null>(null);
	// 每次失败递增；提交结束、输入恢复可用后再把焦点移到密码框。
	const [failedAttempts, setFailedAttempts] = useState(0);
	const loginRef = useRef<HTMLInputElement>(null);
	const passwordRef = useRef<HTMLInputElement>(null);
	const formRef = useRef<HTMLFormElement>(null);
	const submitRef = useRef<HTMLButtonElement>(null);
	// 登录进行中「正在登录…」是可聚焦的禁用；在账号或密码框里按 Enter 提交时先把焦点交给它
	// （输入框随提交禁用），失败后再回到密码框（#3242 K7-02）。
	useSubmitFocus(submitting, formRef, submitRef);

	useEffect(() => {
		if (failedAttempts > 0) passwordRef.current?.focus();
	}, [failedAttempts]);

	async function attempt(): Promise<LoginOutcome | null> {
		let safe = false;
		try {
			safe = isSafeLoginEndpoint(endpoint, window.location.origin);
		} catch {
			safe = false;
		}
		if (!safe) return { kind: "unsafe-endpoint" };
		let response: Response;
		try {
			const target = new URL(endpoint, window.location.href);
			response = await fetch(target.href, {
				method: "POST",
				credentials: "include",
				redirect: "error",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ login, password }),
			});
		} catch {
			return { kind: "network" };
		}
		if (!response.ok) return { kind: "status", status: response.status };
		try {
			await onLoggedIn();
		} catch {
			return { kind: "session-missing" };
		}
		return null;
	}

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (submitting) return;
		setFailure(null);
		const missingLogin = !login.trim();
		const missingPassword = !password;
		setFieldErrors({ login: missingLogin, password: missingPassword });
		if (missingLogin || missingPassword) {
			(missingLogin ? loginRef : passwordRef).current?.focus();
			return;
		}
		setSubmitting(true);
		const outcome = await attempt();
		// 无论成功或失败都清空密码，并恢复为隐藏状态。
		setPassword("");
		setPasswordVisible(false);
		setSubmitting(false);
		if (outcome) {
			setFailure(classifyLoginFailure(outcome));
			setFailedAttempts((count) => count + 1);
		}
	}

	const credentialsRejected = failure === "credentials";
	const describedBy = (fieldError: boolean, fieldErrorId: string) =>
		fieldError ? fieldErrorId : credentialsRejected ? formErrorId : undefined;

	return (
		<form
			ref={formRef}
			className="login-form"
			noValidate
			aria-busy={submitting || undefined}
			onSubmit={submit}
		>
			<div className="login-field">
				<Label htmlFor={loginInputId}>公司账号</Label>
				<Input
					ref={loginRef}
					id={loginInputId}
					className="login-input"
					name="login"
					type="text"
					autoComplete="username"
					autoCapitalize="none"
					spellCheck={false}
					maxLength={256}
					placeholder="输入公司账号"
					aria-invalid={fieldErrors.login || credentialsRejected || undefined}
					aria-describedby={describedBy(fieldErrors.login, loginFieldErrorId)}
					value={login}
					onChange={(event) => {
						setLogin(event.target.value);
						setFieldErrors((errors) => ({ ...errors, login: false }));
						setFailure(null);
					}}
					disabled={submitting}
				/>
				{fieldErrors.login && (
					<p id={loginFieldErrorId} className="login-field-error">
						请输入公司账号。
					</p>
				)}
			</div>
			<div className="login-field">
				<Label htmlFor={passwordInputId}>密码</Label>
				<div className="login-password-control">
					<Input
						ref={passwordRef}
						id={passwordInputId}
						className="login-input"
						name="password"
						type={passwordVisible ? "text" : "password"}
						autoComplete="current-password"
						maxLength={4096}
						placeholder="输入密码"
						aria-invalid={
							fieldErrors.password || credentialsRejected || undefined
						}
						aria-describedby={describedBy(
							fieldErrors.password,
							passwordFieldErrorId,
						)}
						value={password}
						onChange={(event) => {
							setPassword(event.target.value);
							setFieldErrors((errors) => ({ ...errors, password: false }));
							setFailure(null);
						}}
						disabled={submitting}
					/>
					<Button
						type="button"
						variant="ghost"
						size="icon"
						className="login-password-toggle"
						aria-label={passwordVisible ? "隐藏密码" : "显示密码"}
						aria-pressed={passwordVisible}
						aria-controls={passwordInputId}
						disabled={submitting}
						onClick={() => setPasswordVisible((visible) => !visible)}
					>
						{passwordVisible ? (
							<EyeOff aria-hidden="true" />
						) : (
							<Eye aria-hidden="true" />
						)}
					</Button>
				</div>
				{fieldErrors.password && (
					<p id={passwordFieldErrorId} className="login-field-error">
						请输入密码。
					</p>
				)}
			</div>
			{failure && (
				// 每次提交只渲染这一个 role="alert"，不再嵌套其他 live region（NI-53）。
				<Alert
					id={formErrorId}
					tone="danger"
					icon={null}
					role="alert"
					className="login-form-error"
				>
					{loginFailureMessages[failure]}
				</Alert>
			)}
			<Button
				ref={submitRef}
				type="submit"
				className="login-submit"
				disabled={submitting}
				focusableWhenDisabled
			>
				{submitting && <Spinner className="login-submit-spinner" />}
				{submitting ? "正在登录…" : "登录"}
			</Button>
		</form>
	);
}
