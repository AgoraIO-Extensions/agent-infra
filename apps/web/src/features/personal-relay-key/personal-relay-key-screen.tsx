import { PersonalRelayKeyReplaceRequestV1Schema } from "@agent-infra/contracts/pilot";
import { RefreshCw, Shield } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadingLine } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import type { PersonalRelayKeyStateV1 } from "../../pilot/generated-v2/types.gen.js";
import {
	loadPersonalRelayKey,
	PersonalRelayKeyError,
	replacePersonalRelayKey,
	revokePersonalRelayKey,
} from "./personal-relay-key.js";

type PersonalRelayKeyScreenProps = {
	userId: string;
	onSessionExpired?: () => Promise<unknown> | unknown;
};

type FormState = "idle" | "loading" | "ready" | "saving" | "error";

const failureMessages = {
	authentication: "登录状态已失效，请重新登录后重试。",
	authorization: "当前账号没有设置个人 Relay Key 的权限。",
	conflict: "个人 Key 状态已被其他请求更新，请重新读取后再操作。",
	unavailable: "个人 Key 服务暂时不可用，请稍后重试。",
	invalid: "个人 Key 请求未完成，请检查输入后重试。",
} as const;

// 设计 #personal-keys 的四张说明卡（静态文案）。
const situations = [
	["缺少 Key", "提交消息前提示在这里完成接入。"],
	["Key 失效", "保留已受理任务，新的消息需要替换有效 Key。"],
	["额度不足", "显示失败原因，不自动切换到 Agent Key。"],
	["模型无权限", "提示检查个人 Key 或选择允许的模型。"],
] as const;

function errorMessage(error: unknown) {
	return error instanceof PersonalRelayKeyError
		? failureMessages[error.kind]
		: failureMessages.unavailable;
}

function errorKind(error: unknown) {
	return error instanceof PersonalRelayKeyError ? error.kind : "unavailable";
}

/** `/my-settings/relay-key` 页面：读取、设置、替换与撤销个人 Relay Key。 */
export function PersonalRelayKeyScreen({
	userId,
	onSessionExpired,
}: PersonalRelayKeyScreenProps) {
	const toast = useToast();
	const [projection, setProjection] = useState<PersonalRelayKeyStateV1>();
	const [value, setValue] = useState("");
	const [fieldError, setFieldError] = useState("");
	const [failure, setFailure] = useState<unknown>();
	const [state, setState] = useState<FormState>("idle");
	const [operation, setOperation] = useState<"replace" | "revoke">();
	const [focusTarget, setFocusTarget] = useState<"input" | "save">();
	const requestNumber = useRef(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const saveRef = useRef<HTMLButtonElement>(null);
	const clearValue = useCallback(() => {
		setValue("");
		if (inputRef.current) inputRef.current.value = "";
	}, []);

	const refresh = useCallback(async () => {
		const request = ++requestNumber.current;
		setState("loading");
		setProjection(undefined);
		clearValue();
		setFieldError("");
		setFailure(undefined);
		try {
			const next = await loadPersonalRelayKey();
			if (request !== requestNumber.current) return;
			setProjection(next);
			setState("ready");
		} catch (error) {
			if (request !== requestNumber.current) return;
			setFailure(error);
			setState("error");
		}
	}, [clearValue]);

	// 身份变化或离开页面时作废进行中的请求并清空输入，迟到的响应不再写回。
	useEffect(() => {
		requestNumber.current += 1;
		setProjection(undefined);
		clearValue();
		setFieldError("");
		setFailure(undefined);
		setOperation(undefined);
		setState("idle");
		if (userId) void refresh();
		return () => {
			requestNumber.current += 1;
			if (inputRef.current) inputRef.current.value = "";
		};
	}, [clearValue, refresh, userId]);

	// 按钮在请求期间禁用会丢失焦点，完成后按设计放回输入框或主按钮。
	useEffect(() => {
		if (state !== "ready" || !focusTarget) return;
		(focusTarget === "input" ? inputRef : saveRef).current?.focus();
		setFocusTarget(undefined);
	}, [focusTarget, state]);

	const submit = async () => {
		if (state !== "ready" || !projection) return;
		const parsed = PersonalRelayKeyReplaceRequestV1Schema.safeParse({
			expectedVersion: projection.keyVersion,
			keyValue: value,
		});
		if (!parsed.success) {
			setFieldError(
				"请输入 16–8192 位 ASCII 可见字符，不含空格的个人 Relay Key。",
			);
			inputRef.current?.focus();
			return;
		}
		clearValue();
		const request = ++requestNumber.current;
		setOperation("replace");
		setState("saving");
		setFailure(undefined);
		setFieldError("");
		try {
			const next = await replacePersonalRelayKey(
				parsed.data.expectedVersion,
				parsed.data.keyValue,
			);
			if (request !== requestNumber.current) return;
			setProjection(next);
			setState("ready");
			setFocusTarget("save");
			toast("个人 Relay Key 已保存，页面不会显示值");
		} catch (error) {
			if (request !== requestNumber.current) return;
			if (["authentication", "authorization"].includes(errorKind(error)))
				setProjection(undefined);
			setFailure(error);
			setState("error");
		}
	};

	const revoke = async () => {
		if (state !== "ready" || !projection?.isSet) return;
		clearValue();
		const request = ++requestNumber.current;
		setOperation("revoke");
		setState("saving");
		setFailure(undefined);
		setFieldError("");
		try {
			const next = await revokePersonalRelayKey(projection.keyVersion);
			if (request !== requestNumber.current) return;
			setProjection(next);
			setState("ready");
			setFocusTarget("input");
			toast("个人 Relay Key 已撤销");
		} catch (error) {
			if (request !== requestNumber.current) return;
			if (["authentication", "authorization"].includes(errorKind(error)))
				setProjection(undefined);
			setFailure(error);
			setState("error");
		}
	};

	const kind = errorKind(failure);
	const hasFailure = failure !== undefined;
	const canRecheckLogin =
		kind === "authentication" && Boolean(onSessionExpired);
	// 身份或授权失效时重读无意义，只给可恢复的失败提供「重新读取状态」。
	const canReread = kind !== "authorization" && kind !== "authentication";
	const isSet = projection?.isSet === true;
	const keyVersion = projection?.keyVersion;
	const busyText =
		state === "loading"
			? "正在读取个人 Key 状态…"
			: state === "saving"
				? operation === "revoke"
					? "正在撤销个人 Key…"
					: "正在保存个人 Key…"
				: "";

	return (
		<main className="platform-content management-content">
			<section aria-labelledby="personal-relay-key-page-title">
				<header className="page-heading">
					<div>
						<p className="page-eyebrow">我的管理 / 个人凭证</p>
						<h1 id="personal-relay-key-page-title">个人 Relay Key</h1>
						<p>用于 Web 对话和企微渠道。凭证值只在提交时使用，页面不会回显。</p>
					</div>
					{/* 读取完成前不显示状态，避免把「尚未读取」当成「未设置」。 */}
					{projection ? (
						<Badge
							tone={isSet ? "green" : "amber"}
							data-testid="personal-key-status"
						>
							{isSet ? "已设置" : "未设置"}
						</Badge>
					) : null}
				</header>

				{/* 静态说明，不设 role。 */}
				<Alert tone="info" icon={<Shield aria-hidden="true" />}>
					<AlertTitle>费用和权限跟随个人 Key</AlertTitle>
					<AlertDescription>
						平台不会改用 Agent 默认 Key 代替个人调用。
					</AlertDescription>
				</Alert>

				<section
					className="settings-surface"
					aria-labelledby="personal-relay-key-section-title"
					data-testid="personal-relay-key-form"
				>
					<div className="section-heading">
						<div>
							<h2 id="personal-relay-key-section-title">
								{isSet ? "替换个人 Key" : "接入个人 Key"}
							</h2>
							<p>
								{isSet
									? `当前状态：已设置 · version ${keyVersion}`
									: "提交后只显示设置状态，后续可替换或撤销。"}
							</p>
						</div>
						{projection ? (
							<Badge tone={isSet ? "gray" : "amber"}>
								{isSet ? `version ${keyVersion}` : "待设置"}
							</Badge>
						) : null}
					</div>

					{busyText ? (
						<LoadingLine className="settings-status">{busyText}</LoadingLine>
					) : null}
					{hasFailure ? (
						// 失败在分区内就地提示，不只靠 Toast。
						<Alert tone="danger" role="alert" className="settings-status">
							<AlertDescription>{errorMessage(failure)}</AlertDescription>
							{canRecheckLogin || canReread ? (
								<div className="settings-actions">
									{canRecheckLogin && onSessionExpired ? (
										<Button
											variant="outline"
											type="button"
											onClick={() => void onSessionExpired()}
										>
											重新检查登录
										</Button>
									) : null}
									{canReread ? (
										<Button
											variant="outline"
											type="button"
											onClick={() => void refresh()}
										>
											<RefreshCw aria-hidden="true" />
											重新读取状态
										</Button>
									) : null}
								</div>
							) : null}
						</Alert>
					) : null}

					<div className="settings-form-grid">
						<Field>
							<Label htmlFor="personal-relay-key">Relay Key</Label>
							<Input
								ref={inputRef}
								id="personal-relay-key"
								name="personal-relay-key"
								type="password"
								autoComplete="new-password"
								spellCheck={false}
								placeholder="仅本次提交使用"
								value={value}
								disabled={state !== "ready" || !projection}
								aria-invalid={fieldError ? "true" : undefined}
								aria-describedby={
									fieldError ? "personal-relay-key-error" : undefined
								}
								onChange={(event) => {
									setValue(event.target.value);
									setFieldError("");
								}}
							/>
							{fieldError ? (
								<Alert
									id="personal-relay-key-error"
									tone="danger"
									role="alert"
									icon={null}
									className="settings-field-error"
								>
									{fieldError}
								</Alert>
							) : null}
						</Field>
					</div>
					<div className="settings-actions">
						<Button
							ref={saveRef}
							type="button"
							disabled={state !== "ready" || !projection}
							onClick={() => void submit()}
						>
							{state === "saving" && operation === "replace"
								? "保存中…"
								: isSet
									? "替换 Key"
									: "保存 Key"}
						</Button>
						{/* 只在已设置时出现；设计与 PRD 均为点击即撤销。 */}
						{isSet ? (
							<Button
								variant="destructive"
								type="button"
								disabled={state !== "ready"}
								onClick={() => void revoke()}
							>
								{state === "saving" && operation === "revoke"
									? "撤销中…"
									: "撤销 Key"}
							</Button>
						) : null}
					</div>
				</section>

				<div className="roadmap-grid">
					{situations.map(([title, description]) => (
						<article className="roadmap-card" key={title}>
							<h3>{title}</h3>
							<p>{description}</p>
						</article>
					))}
				</div>
			</section>
		</main>
	);
}
