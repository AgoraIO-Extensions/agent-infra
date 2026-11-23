import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLinkIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
	Dialog,
	DialogBody,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
} from "@/components/ui/dialog";
import { Field, FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import {
	ConfigurationDialogHeader,
	WriteOnlyPasswordInput,
} from "./configuration-dialog-parts.js";
import { ConfigurationHeadSection } from "./configuration-section-head.js";
import {
	type AgentConnectionAssociationState,
	associateAgentConnection,
	type ConnectionAssociationFailure,
	ConnectionAssociationRequestError,
	disconnectAgentConnection,
	enableAgentConnectionRegistration,
	loadAgentConnectionAssociation,
} from "./connection-association.js";

type ChipTone = "green" | "amber" | "red" | "gray";

/** PRD §9.1 状态：关联不表示本人已授权或工具可调用。 */
export const connectionAssociationStatusLabels = {
	not_enabled: { label: "未启用", tone: "gray" },
	processing: { label: "关联处理中", tone: "amber" },
	associated: { label: "已关联", tone: "green" },
	failed: { label: "关联失败", tone: "red" },
	unverified: { label: "待核实", tone: "amber" },
	disabling: { label: "停用待处理", tone: "amber" },
	disabled: { label: "已停用", tone: "gray" },
} satisfies Record<
	AgentConnectionAssociationState["status"],
	{ label: string; tone: ChipTone }
>;

const failureText: Record<ConnectionAssociationFailure, string> = {
	credential_rejected:
		"Connection 未接受这个服务凭据，请确认 Agent ID 与服务凭据来自同一个 Consumer。",
	consumer_unavailable: "Connection 中的这个 Agent 当前未启用。",
	already_associated: "这个 Connection Agent 或服务凭据已关联其他 Agent。",
	conflict: "关联状态已变化，请刷新后重试。",
	automatic_unavailable: "当前部署未开启自动登记，请使用手工关联。",
	verification_unavailable:
		"暂时无法向 Connection 核实，未保存任何内容，请稍后重试。",
	not_found: "只有当前 Owner 可以管理 Connection 关联。",
	unavailable: "Connection 关联暂时不可用，请稍后重试。",
};

function reason(error: unknown): ConnectionAssociationFailure {
	return error instanceof ConnectionAssociationRequestError
		? error.reason
		: "unavailable";
}

const connectionAgentIdPattern = /^[a-z0-9][a-z0-9-]{2,79}$/;

/**
 * 手工关联弹窗：Agent ID 与服务凭据只在本次提交使用。凭据框非受控，不进 React state、
 * 查询缓存或浏览器存储；关闭或成功后清空。
 */
function AssociateDialog({
	open,
	replacing,
	onClose,
	onSubmit,
	finalFocus,
}: {
	open: boolean;
	replacing: boolean;
	onClose: () => void;
	onSubmit: (input: {
		connectionAgentId: string;
		serviceCredential: string;
	}) => Promise<void>;
	finalFocus: React.RefObject<HTMLElement | null>;
}) {
	const [pending, setPending] = useState(false);
	const [failure, setFailure] = useState<ConnectionAssociationFailure>();
	const [idError, setIdError] = useState<string>();
	const [credentialError, setCredentialError] = useState<string>();
	const idRef = useRef<HTMLInputElement>(null);
	const credentialRef = useRef<HTMLInputElement>(null);
	const ids = useId();
	useEffect(() => {
		if (!open) return;
		setPending(false);
		setFailure(undefined);
		setIdError(undefined);
		setCredentialError(undefined);
		return () => {
			if (credentialRef.current) credentialRef.current.value = "";
		};
	}, [open]);
	const submit = async () => {
		if (pending) return;
		const connectionAgentId = idRef.current?.value.trim() ?? "";
		const serviceCredential = credentialRef.current?.value ?? "";
		const badId = !connectionAgentIdPattern.test(connectionAgentId);
		const badCredential = !/^[\x21-\x7e]{16,4096}$/.test(serviceCredential);
		setIdError(
			badId
				? "请输入 Connection 中的 Agent ID（小写字母、数字或连字符）。"
				: undefined,
		);
		setCredentialError(
			badCredential
				? "请输入该 Agent 在 Connection 中显示的服务凭据。"
				: undefined,
		);
		if (badId) return idRef.current?.focus();
		if (badCredential) return credentialRef.current?.focus();
		setFailure(undefined);
		setPending(true);
		try {
			await onSubmit({ connectionAgentId, serviceCredential });
			if (credentialRef.current) credentialRef.current.value = "";
			setPending(false);
			onClose();
		} catch (error) {
			setPending(false);
			setFailure(reason(error));
			credentialRef.current?.focus();
		}
	};
	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next && !pending) onClose();
			}}
		>
			<DialogContent
				showCloseButton={false}
				initialFocus={idRef}
				finalFocus={finalFocus}
			>
				<form
					noValidate
					onSubmit={(event) => {
						event.preventDefault();
						event.stopPropagation();
						void submit();
					}}
				>
					<ConfigurationDialogHeader
						title={replacing ? "替换 Connection 服务凭据" : "关联 Connection"}
						closeDisabled={pending}
					/>
					<DialogBody>
						<DialogDescription>
							先在 Connection 为这个 Agent 创建
							Consumer，并选择「按使用者身份执行」。 平台会用服务凭据向
							Connection 核实一次，通过后才保存；保存后不能再查看。
						</DialogDescription>
						<Field className="mt-[15px]">
							<Label htmlFor={`${ids}-agent-id`}>Connection Agent ID</Label>
							<Input
								ref={idRef}
								id={`${ids}-agent-id`}
								name="connection-agent-id"
								autoComplete="off"
								spellCheck={false}
								readOnly={pending}
								aria-invalid={idError ? "true" : undefined}
								aria-describedby={idError ? `${ids}-agent-id-error` : undefined}
							/>
							{idError ? (
								<FieldError id={`${ids}-agent-id-error`}>{idError}</FieldError>
							) : null}
						</Field>
						<Field className="mt-[15px]">
							<Label htmlFor={`${ids}-credential`}>服务凭据</Label>
							<WriteOnlyPasswordInput
								ref={credentialRef}
								id={`${ids}-credential`}
								name="connection-service-credential"
								placeholder="仅本次提交使用"
								readOnly={pending}
								aria-invalid={credentialError ? "true" : undefined}
								aria-describedby={
									credentialError ? `${ids}-credential-error` : undefined
								}
								onInput={() => setCredentialError(undefined)}
							/>
							{credentialError ? (
								<FieldError id={`${ids}-credential-error`}>
									{credentialError}
								</FieldError>
							) : null}
						</Field>
						{failure ? (
							<Alert tone="danger" role="alert" className="mt-[15px]">
								<AlertDescription>{failureText[failure]}</AlertDescription>
							</Alert>
						) : null}
					</DialogBody>
					<DialogFooter>
						<DialogClose disabled={pending} render={<Button variant="ghost" />}>
							取消
						</DialogClose>
						<Button type="submit" disabled={pending} focusableWhenDisabled>
							{pending ? "正在核实…" : replacing ? "核实并替换" : "核实并关联"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/**
 * Agent 设置的 Connection 分区（PRD §9.1、Spec §13.5.7）：显示关联状态，Owner 可手工关联、
 * 替换服务凭据或解除关联，并打开 Connection 控制台。每个操作都是独立请求，不经过整页保存。
 */
export function ConfigurationConnectionSection({
	agentId,
	consoleUrl,
	disabled,
}: {
	agentId: string;
	/** Connection 控制台地址（服务端一次性系统接入配置）；没有时不显示链接。 */
	consoleUrl?: string;
	disabled: boolean;
}) {
	const toast = useToast();
	const queryClient = useQueryClient();
	const queryKey = ["agents", agentId, "connection-association"];
	const query = useQuery({
		queryKey,
		queryFn: () => loadAgentConnectionAssociation(agentId),
		retry: false,
	});
	const [dialogOpen, setDialogOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<ConnectionAssociationFailure>();
	const buttonRef = useRef<HTMLButtonElement>(null);
	const state = query.data;
	const manual = state?.source === "manual";
	const recovering =
		state?.source === "automatic" &&
		state.status === "unverified" &&
		state.automaticRegistrationAvailable;
	const update = (next: AgentConnectionAssociationState) =>
		queryClient.setQueryData(queryKey, next);

	const run = async (
		work: () => Promise<AgentConnectionAssociationState>,
		done: string,
	) => {
		setFailure(undefined);
		setBusy(true);
		try {
			update(await work());
			toast(done);
		} catch (error) {
			setFailure(reason(error));
		} finally {
			setBusy(false);
		}
	};

	const status = state
		? connectionAssociationStatusLabels[state.status]
		: undefined;
	return (
		<ConfigurationHeadSection
			data-od-id="owner-connection"
			title="Connection"
			description="Agent 通过 Connection 调用外部工具。关联后每位使用者仍需在 Connection 自行授权。"
			aside={
				status ? (
					<Badge tone={status.tone} data-testid="connection-association-status">
						{status.label}
					</Badge>
				) : null
			}
		>
			{query.isError ? (
				// 读取失败只在分区内说明，不作为页面级错误打断其他配置（RK2-06）。
				<p
					className="mt-[12px] text-[13px] text-muted-foreground"
					data-testid="connection-association-unavailable"
				>
					{failureText[reason(query.error)]}
				</p>
			) : null}
			{failure ? (
				<Alert tone="danger" role="alert" className="mt-[12px]">
					<AlertDescription>{failureText[failure]}</AlertDescription>
				</Alert>
			) : null}
			{state ? (
				<div className="mt-[12px] flex flex-wrap items-center gap-2">
					{state.status === "not_enabled" ? (
						<>
							<Button
								ref={buttonRef}
								type="button"
								variant="secondary"
								disabled={disabled || busy}
								onClick={() => setDialogOpen(true)}
							>
								手工关联
							</Button>
							{state.automaticRegistrationAvailable ? (
								<Button
									type="button"
									variant="ghost"
									disabled={disabled || busy}
									onClick={() =>
										void run(
											() => enableAgentConnectionRegistration(agentId),
											"已开始自动登记 Connection",
										)
									}
								>
									自动登记
								</Button>
							) : null}
						</>
					) : null}
					{recovering ? (
						<Button
							ref={buttonRef}
							type="button"
							variant="secondary"
							disabled={disabled || busy}
							onClick={() => setDialogOpen(true)}
						>
							补交原 Agent 服务凭据
						</Button>
					) : null}
					{manual && state.associationRevision !== null ? (
						<>
							<Button
								ref={buttonRef}
								type="button"
								variant="secondary"
								disabled={disabled || busy}
								onClick={() => setDialogOpen(true)}
							>
								替换服务凭据
							</Button>
							<ConfirmDialog
								title="解除 Connection 关联"
								description="解除后这个 Agent 不能再发起新的 Connection 安装与调用。Connection 中的 Consumer 不受影响，需要时请在 Connection 停用。"
								confirmLabel="解除关联"
								disabled={disabled || busy}
								onConfirm={() => {
									const revision = state.associationRevision;
									if (revision === null) return;
									void run(
										() => disconnectAgentConnection(agentId, revision),
										"已解除 Connection 关联",
									);
								}}
								trigger={
									<Button type="button" variant="ghost">
										解除关联
									</Button>
								}
							/>
						</>
					) : null}
					{consoleUrl ? (
						<a
							className="inline-flex items-center gap-1 text-sm underline-offset-4 hover:underline"
							href={consoleUrl}
							target="_blank"
							rel="noopener noreferrer"
						>
							打开 Connection 控制台
							<ExternalLinkIcon aria-hidden="true" className="size-[14px]" />
						</a>
					) : null}
				</div>
			) : null}
			{recovering ? (
				<p className="mt-[8px] text-[13px] text-muted-foreground">
					请在 Connection 原 Agent 中明确轮换服务凭据后补交；核实前保持待核实。
				</p>
			) : null}
			{state && state.status !== "not_enabled" ? (
				<p className="mt-[8px] text-[13px] text-muted-foreground">
					关联不代表本人已授权或工具可调用。
				</p>
			) : null}
			<AssociateDialog
				open={dialogOpen}
				replacing={manual}
				finalFocus={buttonRef}
				onClose={() => setDialogOpen(false)}
				onSubmit={async (input) => {
					const next = await associateAgentConnection(agentId, {
						...input,
						expectedRevision:
							manual || recovering
								? (state?.associationRevision ?? null)
								: null,
					});
					update(next);
					toast(
						recovering
							? "凭据已保存，等待核实原登记"
							: manual
								? "服务凭据已替换"
								: "Connection 已关联",
					);
				}}
			/>
		</ConfigurationHeadSection>
	);
}
