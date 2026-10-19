import { Ban, RefreshCw, RotateCcw, Square } from "lucide-react";
import {
	type ReactNode,
	type RefObject,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import type { AgentProjectionV2 } from "../../pilot/generated-v2/types.gen.js";
import type { AgentLifecycleCommand } from "../agent-administration/agent-administration.js";
import {
	commandLabels,
	commandProgressLabels,
	confirmationCopy,
	visibleLifecycleCommands,
} from "../agent-administration/agent-lifecycle-commands.js";
import { useAgentLifecycleCommand } from "../agent-administration/use-agent-lifecycle-command.js";
import type { BrowserSessionState } from "../browser-session.js";

type LifecycleSessionState = BrowserSessionState | { kind: "loading" };

/** 发起命令的区域：结果与失败只在发起的区域显示（NI-88）。 */
type LifecycleArea = "footer" | "danger" | "admin";

type RequestError = Error & { readonly retryable?: boolean };

// 受理后的提示只说明「已提交」，不从受理响应推断状态；结束态以 Agent 详情回读为准（NW-16）。
const acceptedMessages = {
	restart: "Agent 正在重启…",
	stop: "已提交停止请求",
	disable: "已提交停用请求",
	retry_creation: "已提交重试创建请求",
} satisfies Record<AgentLifecycleCommand, string>;

const failureMessage = (error: RequestError) =>
	error.retryable === false
		? "权限或 Agent 状态已变化，请刷新页面。"
		: "操作未能提交，请稍后重试。";

/** 页面 h1（tabIndex=-1）：区域卸载后焦点的落点，避免焦点落到 body。 */
export const configurationHeadingId = "agent-configuration-heading";

function focusPageHeading() {
	// 等待被卸载的区域真正离开 DOM 后再检查焦点。
	window.setTimeout(() => {
		const active = document.activeElement;
		if (active && active !== document.body) return;
		document.getElementById(configurationHeadingId)?.focus();
	});
}

/** 区域卸载时若焦点在区域内，把焦点交给页面 h1（AC-10）。 */
function useFocusFallbackOnUnmount(root: RefObject<HTMLElement | null>) {
	useLayoutEffect(() => {
		const element = root.current;
		return () => {
			if (element?.contains(document.activeElement)) focusPageHeading();
		};
	}, [root]);
}

/**
 * Owner 配置页的生命周期状态：整页只创建一个生命周期 mutation，页脚、危险区与管理员区
 * 共用进行中状态，任一命令进行中时全部生命周期按钮禁用（NI-88）。
 * 由配置 workflow 按 Agent 重新挂载，切换 Agent 后不会沿用上一个 Agent 的状态。
 */
export function useConfigurationLifecycle(
	agent: AgentProjectionV2,
	session: LifecycleSessionState,
) {
	const toast = useToast();
	const lifecycle = useAgentLifecycleCommand(agent.agentId);
	const [running, setRunning] = useState<{
		readonly area: LifecycleArea;
		readonly command: AgentLifecycleCommand;
	}>();
	const [failure, setFailure] = useState<{
		readonly area: LifecycleArea;
		readonly message: string;
	}>();
	const [awaiting, setAwaiting] = useState<{
		readonly accepted: boolean;
		readonly command: AgentLifecycleCommand;
		readonly transitioned: boolean;
	}>();
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	// 受理之后按详情回读给结束态提示；重启要先看到 starting / updating 再看到 ready。
	useEffect(() => {
		if (!awaiting) return;
		const { managementStatus, serviceAvailability } = agent;
		if (awaiting.command === "restart") {
			const transitioning =
				managementStatus === "available" &&
				(serviceAvailability === "starting" ||
					serviceAvailability === "updating");
			if (transitioning && !awaiting.transitioned) {
				setAwaiting({ ...awaiting, transitioned: true });
				return;
			}
			if (
				awaiting.accepted &&
				awaiting.transitioned &&
				managementStatus === "available" &&
				serviceAvailability === "ready"
			) {
				toast("重启完成，Agent 已就绪");
				setAwaiting(undefined);
			}
			return;
		}
		if (!awaiting.accepted) return;
		if (awaiting.command === "stop" && managementStatus === "stopped") {
			toast("Agent 已停止，历史会话转为只读");
			setAwaiting(undefined);
		} else if (
			awaiting.command === "disable" &&
			managementStatus === "disabled"
		) {
			toast("Agent 已停用");
			setAwaiting(undefined);
		} else if (awaiting.command === "retry_creation") {
			setAwaiting(undefined);
		}
	}, [agent, awaiting, toast]);

	const isOwner =
		session.kind === "ready" &&
		agent.configuration.owners.some(
			(owner) => owner.userId === session.session.user.userId,
		);
	const isAdministrator =
		session.kind === "ready" &&
		session.session.user.roles.includes("system_admin");
	// 可见规则与 main 相同（服务端仍对每条命令鉴权），这里只决定命令出现在哪个区域。
	const commands = visibleLifecycleCommands(agent, session);
	const footerCommands = commands.filter(
		(command) =>
			command === "restart" || (command === "retry_creation" && isOwner),
	);
	const dangerCommands = commands.filter((command) => command === "stop");
	const administratorCommands = commands.filter(
		(command) =>
			command === "disable" ||
			(command === "retry_creation" && !isOwner && isAdministrator),
	);
	const pending = running !== undefined || lifecycle.isPending;

	const run = (area: LifecycleArea, command: AgentLifecycleCommand) => {
		if (pending) return;
		setRunning({ area, command });
		setFailure(undefined);
		setAwaiting({ accepted: false, command, transitioned: false });
		lifecycle.mutateAsync(command).then(
			() => {
				if (!mounted.current) return;
				setRunning(undefined);
				toast(acceptedMessages[command]);
				setAwaiting((current) =>
					current?.command === command
						? { ...current, accepted: true }
						: current,
				);
			},
			(error: unknown) => {
				if (!mounted.current) return;
				setRunning(undefined);
				setAwaiting(undefined);
				setFailure({
					area,
					message: failureMessage(
						error instanceof Error ? error : new Error(String(error)),
					),
				});
			},
		);
	};

	return {
		agent,
		activeCommand: running?.command,
		administratorCommands,
		dangerCommands,
		failureIn: (area: LifecycleArea) =>
			failure?.area === area ? failure.message : undefined,
		footerCommands,
		pending,
		run,
	};
}

export type ConfigurationLifecycle = ReturnType<
	typeof useConfigurationLifecycle
>;

const commandIcons = {
	stop: Square,
	restart: RefreshCw,
	retry_creation: RotateCcw,
	disable: Ban,
} satisfies Record<AgentLifecycleCommand, typeof Square>;

function LifecycleCommandButton({
	area,
	command,
	finalFocus,
	lifecycle,
}: {
	area: LifecycleArea;
	command: AgentLifecycleCommand;
	/** 确认后焦点的去处；未提供时回到触发按钮。 */
	finalFocus?: RefObject<HTMLElement | null>;
	lifecycle: ConfigurationLifecycle;
}) {
	const confirmed = useRef(false);
	const copy = confirmationCopy[command];
	const Icon = commandIcons[command];
	// 只有 Owner 的「停止」是实心危险按钮；管理员「停用」用 outline + Ban 图标区分（N-01）。
	const triggerVariant = command === "stop" ? "destructive" : "outline";
	const label =
		lifecycle.activeCommand === command
			? commandProgressLabels[command]
			: commandLabels[command];
	return (
		<ConfirmDialog
			disabled={lifecycle.pending}
			trigger={
				<Button variant={triggerVariant}>
					<Icon aria-hidden="true" data-icon="inline-start" />
					{label}
				</Button>
			}
			title={copy.title(lifecycle.agent.name)}
			subject={{ name: lifecycle.agent.name }}
			description={copy.description}
			confirmLabel={copy.confirm}
			tone={command === "stop" || command === "disable" ? "danger" : "default"}
			onOpenChange={(open) => {
				if (open) confirmed.current = false;
			}}
			finalFocus={
				finalFocus
					? () => (confirmed.current ? finalFocus.current : true)
					: undefined
			}
			onConfirm={() => {
				confirmed.current = true;
				lifecycle.run(area, command);
			}}
		/>
	);
}

function LifecycleFailure({ message }: { message?: string }) {
	return message ? (
		<Alert tone="danger" role="alert">
			<AlertDescription>{message}</AlertDescription>
		</Alert>
	) : null;
}

/** 页脚保存按钮之后的「重启 Agent」/「重试创建」（O-11）。 */
export function ConfigurationFooterLifecycleActions({
	lifecycle,
}: {
	lifecycle: ConfigurationLifecycle;
}) {
	return (
		<>
			{lifecycle.footerCommands.map((command) => (
				<LifecycleCommandButton
					area="footer"
					command={command}
					key={command}
					lifecycle={lifecycle}
				/>
			))}
		</>
	);
}

/** 页脚操作的失败提示，只在由页脚发起的命令失败时出现。 */
export function ConfigurationFooterLifecycleFailure({
	lifecycle,
}: {
	lifecycle: ConfigurationLifecycle;
}) {
	return <LifecycleFailure message={lifecycle.failureIn("footer")} />;
}

function LifecyclePanel({
	actions,
	area,
	children,
	className,
	description,
	lifecycle,
	title,
}: {
	actions: readonly AgentLifecycleCommand[];
	area: LifecycleArea;
	children?: ReactNode;
	className: string;
	description: string;
	lifecycle: ConfigurationLifecycle;
	title: string;
}) {
	const root = useRef<HTMLElement>(null);
	const heading = useRef<HTMLHeadingElement>(null);
	useFocusFallbackOnUnmount(root);
	const headingId = `configuration-${area}-heading`;
	return (
		<section ref={root} aria-labelledby={headingId} className={className}>
			<h2 id={headingId} ref={heading} tabIndex={-1}>
				{title}
			</h2>
			<p>{description}</p>
			{children}
			<LifecycleFailure message={lifecycle.failureIn(area)} />
			<div className="card-actions">
				{actions.map((command) => (
					<LifecycleCommandButton
						area={area}
						command={command}
						finalFocus={heading}
						key={command}
						lifecycle={lifecycle}
					/>
				))}
			</div>
		</section>
	);
}

/** 表单卡之后的独立危险区：Owner 在 Agent 可用时停止 Agent（O-11、N-01）。 */
export function ConfigurationStopDangerZone({
	lifecycle,
}: {
	lifecycle: ConfigurationLifecycle;
}) {
	if (lifecycle.dangerCommands.length === 0) return null;
	return (
		<LifecyclePanel
			actions={lifecycle.dangerCommands}
			area="danger"
			className="lifecycle-danger-zone configuration-danger-zone"
			description="停止会释放运行资源，但保留配置、渠道绑定、平台会话历史与用户数据。停止后历史只读。"
			lifecycle={lifecycle}
			title="停止 Agent"
		/>
	);
}

/**
 * 只对系统管理员显示的操作（停用、纯管理员的重试创建）：中性卡片 + outline 按钮，
 * 不与 Owner 的危险区同款；没有可用操作时不渲染（N-01、NI-96）。
 */
export function ConfigurationAdministratorActions({
	lifecycle,
}: {
	lifecycle: ConfigurationLifecycle;
}) {
	if (lifecycle.administratorCommands.length === 0) return null;
	return (
		<LifecyclePanel
			actions={lifecycle.administratorCommands}
			area="admin"
			className="configuration-admin-actions"
			description="以下操作仅对系统管理员显示。"
			lifecycle={lifecycle}
			title="管理员操作"
		/>
	);
}
