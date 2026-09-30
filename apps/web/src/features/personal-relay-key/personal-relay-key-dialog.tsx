import { KeyRound, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

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
				className={cn("shrink-0", "personal-relay-key-trigger")}
				aria-label="个人 Key 设置"
			>
				<KeyRound aria-hidden="true" />
				个人 Key 设置
			</DialogTrigger>
			<DialogContent>
				<PersonalRelayKeyForm
					open={open}
					userId={userId}
					onSessionExpired={onSessionExpired}
				/>
			</DialogContent>
		</Dialog>
	);
}

function PersonalRelayKeyForm({
	open,
	userId,
	onSessionExpired,
}: PersonalRelayKeyDialogProps & { open: boolean }) {
	const [projection, setProjection] = useState<PersonalRelayKeyStateV1>();
	const [value, setValue] = useState("");
	const [fieldError, setFieldError] = useState("");
	const [failure, setFailure] = useState<unknown>();
	const [notice, setNotice] = useState("");
	const [state, setState] = useState<FormState>("idle");
	const [operation, setOperation] = useState<"replace" | "revoke">();
	const requestNumber = useRef(0);
	const previousUserId = useRef(userId);
	const inputRef = useRef<HTMLInputElement>(null);

	const refresh = useCallback(async () => {
		const request = ++requestNumber.current;
		setState("loading");
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
	}, []);

	useEffect(() => {
		if (previousUserId.current !== userId) previousUserId.current = userId;
		requestNumber.current += 1;
		setProjection(undefined);
		setValue("");
		setFieldError("");
		setFailure(undefined);
		setNotice("");
		setOperation(undefined);
		setState("idle");
		if (!open) return;
		void refresh();
	}, [open, refresh, userId]);

	const submit = async () => {
		if (state === "saving" || !projection) return;
		const nextValue = value.trim();
		if (!nextValue) {
			setFieldError("请输入个人 Relay Key。");
			inputRef.current?.focus();
			return;
		}
		const request = ++requestNumber.current;
		setOperation("replace");
		setState("saving");
		setFailure(undefined);
		setFieldError("");
		setNotice("");
		try {
			const next = await replacePersonalRelayKey(
				projection.keyVersion,
				nextValue,
			);
			if (request !== requestNumber.current) return;
			setProjection(next);
			setValue("");
			setNotice("个人 Relay Key 已更新；从下一条任务生效。");
			setState("ready");
		} catch (error) {
			if (request !== requestNumber.current) return;
			setFailure(error);
			setState("error");
		}
	};

	const remove = async () => {
		if (state === "saving" || !projection?.isSet) return;
		const request = ++requestNumber.current;
		setOperation("revoke");
		setState("saving");
		setFailure(undefined);
		setNotice("");
		try {
			const next = await revokePersonalRelayKey(projection.keyVersion);
			if (request !== requestNumber.current) return;
			setProjection(next);
			setValue("");
			setNotice("个人 Relay Key 已移除；从下一条任务生效。");
			setState("ready");
		} catch (error) {
			if (request !== requestNumber.current) return;
			setFailure(error);
			setState("error");
		}
	};

	const kind = errorKind(failure);
	const hasFailure = failure !== undefined;
	const busy = state === "loading" || state === "saving";
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

	return (
		<>
			<DialogHeader>
				<DialogTitle>个人 Relay Key</DialogTitle>
				<DialogDescription>
					独立于 Agent Owner 配置。Key 只写入服务端，页面不会回显明文或摘要。
				</DialogDescription>
			</DialogHeader>
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
						{kind !== "authorization" && (
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
					<label htmlFor="personal-relay-key" className="font-medium text-sm">
						{projection?.isSet ? "替换个人 Relay Key" : "设置个人 Relay Key"}
					</label>
					<Input
						ref={inputRef}
						id="personal-relay-key"
						name="personal-relay-key"
						type="password"
						autoComplete="new-password"
						spellCheck={false}
						value={value}
						disabled={busy || (state === "error" && kind === "authorization")}
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
						<p
							id="personal-relay-key-error"
							className="text-destructive text-sm"
							role="alert"
						>
							{fieldError}
						</p>
					)}
				</div>
			</div>
			<DialogFooter>
				<Button
					variant="outline"
					type="button"
					disabled={busy || !projection?.isSet}
					onClick={() => void remove()}
				>
					{state === "saving" && operation === "revoke"
						? "移除中…"
						: "移除 Key"}
				</Button>
				<Button
					type="button"
					disabled={busy || !projection}
					onClick={() => void submit()}
				>
					{state === "saving" && operation === "replace"
						? "保存中…"
						: projection?.isSet
							? "替换 Key"
							: "设置 Key"}
				</Button>
			</DialogFooter>
		</>
	);
}
