import { Link } from "@tanstack/react-router";
import { Package, Settings } from "lucide-react";
import { useId, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Timestamp } from "@/components/ui/timestamp";
import { useToast } from "@/components/ui/toast";
import { withObjectName } from "@/lib/accessible-name";
import type { SkillHubInstallationListItemV1 } from "../../pilot/generated-v2/types.gen.js";
import type { SkillHubInstallationsState } from "./skill-hub.js";
import { skillHubProviderLabels } from "./skill-hub-labels.js";
import { uninstallSkillHubInstallation } from "./skill-hub-management.js";
import { SkillHubStateChip } from "./skill-hub-scope-pill.js";
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
 * 「已安装」（#2953，V-15）：只显示服务端按会话主体返回的本人安装。移出成功后先隐藏该行，
 * 再回读列表；回读到新列表后以服务端结果为准。区头右侧是「Agent 绑定」入口。
 */
export function MyInstallationsSection({
	installations,
	onRetry,
	onRelogin,
	retrying = false,
	onChanged,
	uninstall = uninstallSkillHubInstallation,
}: {
	installations: SkillHubInstallationsState | { kind: "loading" };
	onRetry?: () => void;
	/** 读取 401 时的「重新登录」。 */
	onRelogin?: () => void;
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
		<section aria-labelledby={`${id}-installations`}>
			<div className="section-heading">
				<div>
					<h2 id={`${id}-installations`} ref={heading} tabIndex={-1}>
						已安装
					</h2>
					<p>已安装版本不会自动变化，绑定和运行状态分开显示</p>
				</div>
				{/* 绑定在 Agent 的 Owner 配置中进行，入口直达「已创建」标签页选择 Agent。 */}
				<Link
					className={buttonVariants({ variant: "outline" })}
					to="/my-agents"
					search={{ tab: "owned" }}
				>
					<Settings aria-hidden="true" />
					Agent 绑定
				</Link>
			</div>
			{installations.kind === "loading" ||
			(installations.kind === "unavailable" && retrying) ? (
				<SkillHubLoading>正在读取已安装的 Skill…</SkillHubLoading>
			) : installations.kind === "unavailable" ? (
				<SkillHubReadFailure
					retryable={installations.retryable}
					reason={installations.reason}
					retryTitle="暂时无法读取已安装的 Skill"
					retryDescription="已安装的版本和 Agent 绑定不受影响。"
					deniedText="当前账号没有读取已安装 Skill 的权限。"
					unavailableText="已安装的 Skill 暂时无法访问，请联系管理员。"
					onRetry={onRetry}
					onRelogin={onRelogin}
					retrying={retrying}
					// 与「我创建的」同时失败时按钮仍可区分（#3292 N9-3-05）。
					objectName="已安装"
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
				{version.access === "visible" ? (
					<>
						{/* 设计已安装行（V-17、C2-10）：说明行为「固定版本 v{版本} · {来源}」，其下是发布状态与
						    「有新版本」；版本号、来源与状态都取安装投影，不另读版本详情。 */}
						<p>
							固定版本 v{version.version} ·{" "}
							{skillHubProviderLabels[version.provider]}
						</p>
						<div className="skill-row-badges">
							<SkillHubStateChip state={version.state} />
							{item.needUpgrade ? <Badge tone="amber">有新版本</Badge> : null}
						</div>
					</>
				) : (
					<div className="skill-row-badges">
						<Badge tone="gray">当前无权查看</Badge>
					</div>
				)}
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
				{/* 设计已安装行的 ghost「查看」（V-17）。 */}
				{version.access === "visible" ? (
					<Link
						className={buttonVariants({ variant: "ghost" })}
						to="/skills/$skillVersionId"
						params={{ skillVersionId: item.skillVersionId }}
						aria-label={withObjectName("查看", name)}
					>
						查看
					</Link>
				) : null}
				{/* 本行移出进行中是可聚焦的禁用（aria-disabled），焦点留在按钮上；成功后到「已安装」，
				    失败时仍在按钮上（#3242 K7-02）。其余行在此期间为原生禁用。 */}
				<Button
					type="button"
					variant="ghost"
					disabled={disabled}
					focusableWhenDisabled={removing}
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
