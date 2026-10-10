import { PersonalRelayKeyReplaceRequestV1Schema } from "@agent-infra/contracts/pilot";
import { KeyRound, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { PersonalRelayKeyStateV1 } from "../../pilot/generated-v2/types.gen.js";
import {
	loadPersonalRelayKey,
	PersonalRelayKeyError,
	replacePersonalRelayKey,
	revokePersonalRelayKey,
} from "./personal-relay-key.js";

type PersonalRelayKeyDialogProps = {
	userId: string;
	onSessionExpired?: () => Promise<unknown> | unknown;
};

type PersonalRelayKeyFormProps = PersonalRelayKeyDialogProps & {
	open: boolean;
	surface?: "dialog" | "page";
};

type FormState = "idle" | "loading" | "ready" | "saving" | "error";

const failureMessages = {
	authentication: "登录状态已失效，请重新登录后重试。",
	authorization: "当前账号没有设置个人 Relay Key 的权限。",
	conflict: "个人 Key 状态已被其他请求更新，请重新读取后再操作。",
	unavailable: "个人 Key 服务暂时不可用，请稍后重试。",
	invalid: "个人 Key 请求未完成，请检查输入后重试。",
} as const;

function errorMessage(error: unknown) {
	return error instanceof PersonalRelayKeyError
		? failureMessages[error.kind]
		: failureMessages.unavailable;
}

function errorKind(error: unknown) {
	return error instanceof PersonalRelayKeyError ? error.kind : "unavailable";
}

export function PersonalRelayKeyEntry({
	userId,
	onSessionExpired,
}: PersonalRelayKeyDialogProps) {
	const [open, setOpen] = useState(false);
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger
				render={
					<Button
						variant="outline"
						size="sm"
						className="personal-relay-key-trigger shrink-0"
						aria-label="个人 Key 设置"
					/>
				}
			>
				<KeyRound aria-hidden="true" />
				个人 Key 设置
			</DialogTrigger>
			<DialogContent className="personal-relay-key-dialog">
				<PersonalRelayKeyForm
					open={open}
					userId={userId}
					onSessionExpired={onSessionExpired}
				/>
			</DialogContent>
		</Dialog>
	);
}

/** Full-page settings surface for the `/my-settings/relay-key` route. */
export function PersonalRelayKeyScreen({
	userId,
	onSessionExpired,
}: PersonalRelayKeyDialogProps) {
	return (
		<main className="platform-content management-content">
			<section
				aria-labelledby="personal-relay-key-page-title"
				className="mx-auto w-full max-w-2xl space-y-6"
			>
				<PersonalRelayKeyForm
					open
					userId={userId}
					onSessionExpired={onSessionExpired}
					surface="page"
				/>
			</section>
		</main>
	);
}

function PersonalRelayKeyForm({
	open,
	userId,
	onSessionExpired,
	surface = "dialog",
}: PersonalRelayKeyFormProps) {
	const [projection, setProjection] = useState<PersonalRelayKeyStateV1>();
	const [value, setValue] = useState("");
	const [fieldError, setFieldError] = useState("");
	const [failure, setFailure] = useState<unknown>();
	const [notice, setNotice] = useState("");
	const [state, setState] = useState<FormState>("idle");
	const [operation, setOperation] = useState<"replace" | "revoke">();
	const requestNumber = useRef(0);
	const inputRef = useRef<HTMLInputElement>(null);
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
		setNotice("");
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

	useEffect(() => {
		requestNumber.current += 1;
		setProjection(undefined);
		clearValue();
		setFieldError("");
		setFailure(undefined);
		setNotice("");
		setOperation(undefined);
		setState("idle");
		if (open && userId) void refresh();
		return () => {
			requestNumber.current += 1;
			if (inputRef.current) inputRef.current.value = "";
		};
	}, [clearValue, open, refresh, userId]);

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
		setNotice("");
		try {
			const next = await replacePersonalRelayKey(
				parsed.data.expectedVersion,
				parsed.data.keyValue,
			);
			if (request !== requestNumber.current) return;
			setProjection(next);
			setNotice("个人 Relay Key 已更新；从下一条任务生效。");
			setState("ready");
		} catch (error) {
			if (request !== requestNumber.current) return;
			if (["authentication", "authorization"].includes(errorKind(error)))
				setProjection(undefined);
			setFailure(error);
			setState("error");
		}
	};

	const remove = async () => {
		if (state !== "ready" || !projection?.isSet) return;
		clearValue();
		const request = ++requestNumber.current;
		setOperation("revoke");
		setState("saving");
		setFailure(undefined);
		setFieldError("");
		setNotice("");
		try {
			const next = await revokePersonalRelayKey(projection.keyVersion);
			if (request !== requestNumber.current) return;
			setProjection(next);
			setNotice("个人 Relay Key 已移除；从下一条任务生效。");
			setState("ready");
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
	const statusText =
		state === "loading"
			? "正在读取个人 Key 状态…"
			: state === "saving"
				? operation === "revoke"
					? "正在移除个人 Key…"
					: "正在保存个人 Key…"
				: hasFailure
					? errorMessage(failure)
					: notice;
	const actionButtons = (
		<>
			<Button
				variant="outline"
				type="button"
				disabled={state !== "ready" || !projection?.isSet}
				onClick={() => void remove()}
			>
				{state === "saving" && operation === "revoke" ? "移除中…" : "移除 Key"}
			</Button>
			<Button
				type="button"
				disabled={state !== "ready" || !projection}
				onClick={() => void submit()}
			>
				{state === "saving" && operation === "replace"
					? "保存中…"
					: projection?.isSet
						? "替换 Key"
						: "设置 Key"}
			</Button>
		</>
	);

	return (
		<>
			{surface === "page" ? (
				<header className="space-y-2">
					<h1
						id="personal-relay-key-page-title"
						className="font-semibold text-2xl tracking-tight"
					>
						个人 Relay Key
					</h1>
					<p className="text-muted-foreground text-sm">
						独立于 Agent Owner 配置。Key 只写入服务端，页面不会回显明文或摘要。
					</p>
				</header>
			) : (
				<DialogHeader>
					<DialogTitle>个人 Relay Key</DialogTitle>
					<DialogDescription>
						独立于 Agent Owner 配置。Key 只写入服务端，页面不会回显明文或摘要。
					</DialogDescription>
				</DialogHeader>
			)}
			<div className="space-y-4" data-testid="personal-relay-key-form">
				<div
					className="border border-border bg-muted/30 px-3 py-2 text-sm"
					data-testid="personal-key-status"
				>
					{projection?.isSet
						? `已配置 · 版本 ${projection.keyVersion}`
						: projection
							? "未配置"
							: "尚未读取"}
				</div>
				{statusText && (
					<p
						className={cn(
							"text-sm",
							hasFailure ? "text-destructive" : "text-muted-foreground",
						)}
						role={hasFailure ? "alert" : "status"}
					>
						{statusText}
					</p>
				)}
				{hasFailure && (
					<div className="flex flex-wrap gap-2">
						{kind === "authentication" && onSessionExpired ? (
							<Button
								variant="outline"
								size="sm"
								onClick={() => void onSessionExpired()}
							>
								重新检查登录
							</Button>
						) : null}
						{kind !== "authorization" && kind !== "authentication" && (
							<Button
								variant="outline"
								size="sm"
								onClick={() => void refresh()}
							>
								<RefreshCw aria-hidden="true" />
								重新读取状态
							</Button>
						)}
					</div>
				)}
				<div className="space-y-2">
					<Label htmlFor="personal-relay-key">
						{projection?.isSet ? "替换个人 Relay Key" : "设置个人 Relay Key"}
					</Label>
					<Input
						ref={inputRef}
						id="personal-relay-key"
						name="personal-relay-key"
						type="password"
						autoComplete="new-password"
						spellCheck={false}
						value={value}
						disabled={state !== "ready" || !projection}
						aria-invalid={fieldError ? "true" : undefined}
						aria-describedby="personal-relay-key-hint personal-relay-key-error"
						onChange={(event) => {
							setValue(event.target.value);
							setFieldError("");
						}}
					/>
					<p
						id="personal-relay-key-hint"
						className="text-muted-foreground text-xs"
					>
						提交或关闭后清空输入，不存入浏览器存储；不会回退到 Agent 默认 Key。
					</p>
					{fieldError && (
						<Alert
							id="personal-relay-key-error"
							variant="destructive"
							className="border-0 bg-transparent p-0 text-sm"
						>
							{fieldError}
						</Alert>
					)}
				</div>
			</div>
			{surface === "page" ? (
				<div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
					{actionButtons}
				</div>
			) : (
				<DialogFooter>{actionButtons}</DialogFooter>
			)}
		</>
	);
}
