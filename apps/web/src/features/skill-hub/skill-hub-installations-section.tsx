import { Link } from "@tanstack/react-router";
import { Package } from "lucide-react";
import { useId, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Timestamp } from "@/components/ui/timestamp";
import { useToast } from "@/components/ui/toast";
import { withObjectName } from "@/lib/accessible-name";
import type { SkillHubInstallationListItemV1 } from "../../pilot/generated-v2/types.gen.js";
import type { SkillHubInstallationsState } from "./skill-hub.js";
import { uninstallSkillHubInstallation } from "./skill-hub-management.js";
import {
	SkillHubScopePill,
	SkillHubStateChip,
} from "./skill-hub-scope-pill.js";
import {
	SkillHubEmpty,
	SkillHubLoading,
	SkillHubReadFailure,
} from "./skill-hub-screen.js";

type RequestFailure = { status?: number; retryable?: boolean };

function removalFailureMessage(error: unknown) {
	const { status, retryable } =
		error && typeof error === "object" ? (error as RequestFailure) : {};
	if (status === 401) return "登录状态已失效，请重新登录后再试。";
	if (status === 403) return "当前账号不能把这个版本移出我的库。";
	if (status === 404 || status === 409)
		return "我的库状态已变化，列表已重新读取。";
	if (status === 503 || retryable) return "暂时无法移出我的库，请稍后重试。";
	return "移出我的库失败，请稍后重试。";
}

/**
 * 「我的安装」（#2953）：只显示服务端按会话主体返回的本人安装。移出成功后先隐藏该行，
 * 再回读列表；回读到新列表后以服务端结果为准。
 */
export function MyInstallationsSection({
	installations,
	onRetry,
	retrying = false,
	onChanged,
	uninstall = uninstallSkillHubInstallation,
}: {
	installations: SkillHubInstallationsState | { kind: "loading" };
	onRetry?: () => void;
	retrying?: boolean;
	/** 移出或发现状态变化后回读列表。 */
	onChanged?: () => void;
	uninstall?: (
		installationId: string,
		idempotencyKey: string,
	) => Promise<unknown>;
}) {
	const id = useId();
	const toast = useToast();
	const heading = useRef<HTMLHeadingElement>(null);
	const keys = useRef(new Map<string, string>());
	const [removing, setRemoving] = useState<string>();
	const [failure, setFailure] = useState<{
		installationId: string;
		text: string;
	}>();
	const items =
		installations.kind === "ready" ? installations.installations : undefined;
	const [removed, setRemoved] = useState<{
		basedOn: SkillHubInstallationListItemV1[];
		ids: ReadonlySet<string>;
	}>();
	// 乐观隐藏只作用于发起移出时的那份列表。
	const hidden =
		removed && items && removed.basedOn === items ? removed.ids : undefined;
	const visible = items?.filter((item) => !hidden?.has(item.installationId));

	// 同一安装的移出失败后重试复用同一幂等键，成功后丢弃。
	function keyFor(installationId: string) {
		const existing = keys.current.get(installationId);
		if (existing) return existing;
		const key = crypto.randomUUID();
		keys.current.set(installationId, key);
		return key;
	}

	async function remove(item: SkillHubInstallationListItemV1) {
		if (removing || !items) return;
		setRemoving(item.installationId);
		setFailure(undefined);
		try {
			await uninstall(item.installationId, keyFor(item.installationId));
			keys.current.delete(item.installationId);
			setRemoved({
				basedOn: items,
				ids: new Set([...(hidden ?? []), item.installationId]),
			});
			toast("已移出我的库");
			heading.current?.focus();
			onChanged?.();
		} catch (error) {
			setFailure({
				installationId: item.installationId,
				text: removalFailureMessage(error),
			});
			const { status } =
				error && typeof error === "object" ? (error as RequestFailure) : {};
			// 安装已不存在或状态已变化时回读，以服务端列表为准。
			if (status === 404 || status === 409) onChanged?.();
		} finally {
			setRemoving(undefined);
		}
	}

	return (
		<section
			className="skill-section-block"
			aria-labelledby={`${id}-installations`}
		>
			<div className="section-heading">
				<div>
					<h2 id={`${id}-installations`} ref={heading} tabIndex={-1}>
						我的安装
					</h2>
					<p>加入我的库的固定版本，不会自动升级</p>
				</div>
			</div>
			{installations.kind === "loading" ||
			(installations.kind === "unavailable" && retrying) ? (
				<SkillHubLoading>正在读取我的安装…</SkillHubLoading>
			) : installations.kind === "unavailable" ? (
				<SkillHubReadFailure
					retryable={installations.retryable}
					reason={installations.reason}
					retryTitle="暂时无法读取我的安装"
					retryDescription="已安装的版本和 Agent 绑定不受影响。"
					deniedText="当前账号没有读取我的安装的权限。"
					unavailableText="我的安装暂时无法访问，请联系管理员。"
					onRetry={onRetry}
					retrying={retrying}
				/>
			) : !visible || visible.length === 0 ? (
				<SkillHubEmpty
					title="我的库还是空的"
					description="在 Skill Hub 打开一个固定版本，加入我的库后会显示在这里。"
					action={
						<Link
							className={buttonVariants({ variant: "outline" })}
							to="/skills"
						>
							浏览 Skill Hub
						</Link>
					}
				/>
			) : (
				<div className="skill-surface">
					{visible.map((item) => (
						<InstallationRow
							key={item.installationId}
							item={item}
							removing={removing === item.installationId}
							disabled={removing !== undefined}
							failure={
								failure?.installationId === item.installationId
									? failure.text
									: undefined
							}
							onRemove={() => void remove(item)}
						/>
					))}
				</div>
			)}
		</section>
	);
}

function InstallationRow({
	item,
	removing,
	disabled,
	failure,
	onRemove,
}: {
	item: SkillHubInstallationListItemV1;
	removing: boolean;
	disabled: boolean;
	failure?: string;
	onRemove: () => void;
}) {
	const { version } = item;
	const name = version.access === "visible" ? version.name : "版本不可用";
	return (
		<article className="skill-row">
			<span className="skill-mark" aria-hidden="true">
				<Package />
			</span>
			<div className="skill-row-copy">
				<h3>{name}</h3>
				<div className="skill-row-badges">
					{version.access === "visible" ? (
						version.state === "revoked" ? (
							<SkillHubStateChip state="revoked" />
						) : (
							<SkillHubScopePill version={version} />
						)
					) : (
						<Badge tone="gray">当前无权查看</Badge>
					)}
					{item.needUpgrade && version.access === "visible" ? (
						<Badge tone="amber">有新版本</Badge>
					) : null}
				</div>
			</div>
			<div className="skill-row-meta">
				{version.access === "visible" ? (
					<strong>v{version.version}</strong>
				) : (
					<>
						版本已撤销或你已无权查看，可以移出我的库
						<span className="block">
							加入于 <Timestamp value={item.installedAt} />
						</span>
					</>
				)}
			</div>
			<div className="skill-actions">
				{version.access === "visible" ? (
					<Link
						className={buttonVariants({ variant: "ghost" })}
						to="/skills/$skillVersionId"
						params={{ skillVersionId: item.skillVersionId }}
						aria-label={withObjectName("详情", name)}
					>
						详情
					</Link>
				) : null}
				<Button
					type="button"
					variant="ghost"
					disabled={disabled}
					onClick={onRemove}
					aria-label={withObjectName(
						removing ? "正在移出" : "移出我的库",
						name,
					)}
				>
					{removing ? "正在移出…" : "移出我的库"}
				</Button>
				{failure ? (
					<Alert tone="danger" role="alert" className="skill-action-error">
						<AlertDescription>{failure}</AlertDescription>
					</Alert>
				) : null}
			</div>
		</article>
	);
}
