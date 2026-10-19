import { Link } from "@tanstack/react-router";
import { LogIn, RefreshCw } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { StateCard } from "@/components/ui/state-card";
import type { CollectionReadUnavailable } from "./collection-read-failure";
import { useBrowserSession } from "./use-browser-session";

/**
 * 公共状态卡的种类。kind 只决定默认文案与按钮，不带颜色（设计 #states 的 state-card）。
 * - login：会话失效，需要重新登录。
 * - unauthorized：无权访问；详情页把 403 与 404 合并为同一张卡，不暴露对象是否存在。
 * - unavailable：服务暂不可用，可重试。
 * - not-found：地址不存在（404 页）。
 * - invalid：服务返回的数据无法识别，没有可用操作。
 */
export type PageStateKind =
	| "login"
	| "unauthorized"
	| "unavailable"
	| "not-found"
	| "invalid";

export const pageStateDefaults: Record<
	PageStateKind,
	{ title: string; description: string }
> = {
	login: {
		title: "登录",
		description: "当前会话已过期，需要重新登录后再进入工作区。",
	},
	unauthorized: {
		title: "未授权",
		description: "你没有访问此 Agent 或平台审计的权限。",
	},
	unavailable: {
		title: "服务暂不可用",
		description: "暂时无法读取数据，请稍后重试。",
	},
	"not-found": {
		title: "无法打开此地址",
		description:
			"链接可能已失效或地址有误。可以回到工作台，或从 Agent 目录重新进入。",
	},
	invalid: {
		title: "数据无法读取",
		description: "服务返回的数据无法识别，请联系管理员。",
	},
};

// 读取失败是异步结果，进入页面后才出现，用 role="alert"；无权限与 404 是静态边界，不打断读屏。
const announcedKinds = new Set<PageStateKind>([
	"login",
	"unavailable",
	"invalid",
]);

/**
 * 重新读取服务端会话：会话已失效时由壳层切换到登录页，不整页刷新；会话仍有效时调用
 * onStillValid，由页面把失败的读取重做一次（W-03），否则页面会停在同一张卡上。
 */
function ReauthenticateAction({ onStillValid }: { onStillValid?: () => void }) {
	const session = useBrowserSession();
	// 只反映本次点击，不受挂载时的后台会话重读影响。
	const [checking, setChecking] = useState(false);
	return (
		<Button
			type="button"
			disabled={checking}
			onClick={async () => {
				setChecking(true);
				try {
					const result = await session.refetch();
					if (result.status === "success" && result.data?.kind === "ready")
						onStillValid?.();
				} finally {
					setChecking(false);
				}
			}}
		>
			<LogIn aria-hidden="true" data-icon="inline-start" />
			{checking ? "正在检查…" : "重新登录"}
		</Button>
	);
}

type PageStateCardProps = {
	kind: PageStateKind;
	title?: string;
	description?: string;
	/** 覆盖默认操作；传 null 表示不提供操作。 */
	action?: ReactNode;
	/** unavailable 的重试操作；未提供时不显示重试按钮。 */
	onRetry?: () => void;
	retrying?: boolean;
	retryLabel?: string;
	/** login 的「重新登录」确认会话仍有效后调用，用来重读失败的数据。 */
	onStillValid?: () => void;
	headingLevel?: 1 | 2 | 3;
	className?: string;
};

function defaultAction(
	kind: PageStateKind,
	{ onRetry, retrying, retryLabel, onStillValid }: PageStateCardProps,
): ReactNode {
	switch (kind) {
		case "login":
			return <ReauthenticateAction onStillValid={onStillValid} />;
		case "unauthorized":
			return (
				<Link className={buttonVariants({ variant: "outline" })} to="/">
					返回工作台
				</Link>
			);
		case "unavailable":
			return onRetry ? (
				<Button
					type="button"
					variant="outline"
					disabled={retrying}
					onClick={onRetry}
				>
					<RefreshCw aria-hidden="true" data-icon="inline-start" />
					{retrying ? "正在重新加载…" : (retryLabel ?? "重新加载")}
				</Button>
			) : null;
		case "not-found":
		case "invalid":
			return null;
	}
}

export function PageStateCard(props: PageStateCardProps) {
	const { kind, title, description, action, headingLevel, className } = props;
	const defaults = pageStateDefaults[kind];
	return (
		<StateCard
			data-kind={kind}
			role={announcedKinds.has(kind) ? "alert" : undefined}
			title={title ?? defaults.title}
			description={description ?? defaults.description}
			actions={action === undefined ? defaultAction(kind, props) : action}
			headingLevel={headingLevel}
			className={className}
		/>
	);
}

/**
 * 详情读取失败到状态卡的映射：401 → login；schema 不符 → invalid；可重试 → unavailable；
 * 其余不可重试结果（403、404、400 等）合并为同一张「无法访问」卡（PRD §7.3）。
 */
export function readFailureStateKind(
	failure: Pick<CollectionReadUnavailable, "retryable" | "reason">,
): PageStateKind {
	if (failure.reason === "authentication-required") return "login";
	if (failure.reason === "invalid-response") return "invalid";
	return failure.retryable ? "unavailable" : "unauthorized";
}

/** Agent 详情、申请详情与 Owner 配置共用的读取失败卡。 */
export function ReadFailureCard({
	failure,
	deniedDescription,
	unavailableDescription,
	back,
	onRetry,
	retrying,
	retryLabel,
	onStillValid,
}: {
	failure: Pick<CollectionReadUnavailable, "retryable" | "reason">;
	/** 无法访问（403、404 等）的说明，例如「Agent 不存在，或你没有访问权限。」。 */
	deniedDescription: string;
	/** 可重试失败的说明，例如「暂时无法读取 Agent，请稍后重试。」。 */
	unavailableDescription: string;
	/** 无法访问时返回上级的链接。 */
	back: ReactNode;
	onRetry?: () => void;
	retrying?: boolean;
	retryLabel?: string;
	/** 401「重新登录」后会话仍有效时重读详情（W-03）。 */
	onStillValid?: () => void;
}) {
	const kind = readFailureStateKind(failure);
	if (kind === "unauthorized")
		return (
			<PageStateCard
				kind="unauthorized"
				title="无法访问"
				description={deniedDescription}
				action={back}
			/>
		);
	if (kind === "unavailable")
		return (
			<PageStateCard
				kind="unavailable"
				description={unavailableDescription}
				onRetry={onRetry}
				retrying={retrying}
				retryLabel={retryLabel}
			/>
		);
	return <PageStateCard kind={kind} onStillValid={onStillValid} />;
}
