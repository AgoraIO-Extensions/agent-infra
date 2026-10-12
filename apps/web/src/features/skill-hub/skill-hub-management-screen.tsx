import {
	CheckCircle2,
	ClipboardCheck,
	FolderKanban,
	PackageOpen,
	RefreshCw,
} from "lucide-react";
import type { ReactNode } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import type { SkillHubDirectoryState } from "./skill-hub.js";
import {
	skillHubProviderLabels,
	skillHubVisibilityLabels,
} from "./skill-hub-screen.js";

export function SkillHubManagementScreen({
	state,
	isAdministrator,
	onRetry,
	retrying = false,
}: {
	state: SkillHubDirectoryState | { kind: "loading" };
	isAdministrator: boolean;
	onRetry?: () => void;
	retrying?: boolean;
}) {
	const versions = state.kind === "ready" ? state.versions : [];
	return (
		<section aria-labelledby="skill-hub-management-heading">
			<header className="page-heading">
				<div className="min-w-0">
					<p className="page-eyebrow">我的管理 / Skill Hub</p>
					<h1 id="skill-hub-management-heading">管理固定版本与 Agent 配置。</h1>
					<p>
						项目、发布、审核和 Agent
						配置共用同一版本事实；尚未接入的写操作保持不可用。
					</p>
				</div>
				<Button
					type="button"
					variant="ghost"
					onClick={onRetry}
					disabled={retrying}
				>
					<RefreshCw
						className={retrying ? "animate-spin" : ""}
						aria-hidden="true"
					/>
					刷新
				</Button>
			</header>

			{state.kind === "loading" ? (
				<p role="status">正在加载 Skill 版本…</p>
			) : state.kind === "unavailable" ? (
				<Alert>
					<AlertDescription>
						{state.retryable
							? "Skill Hub 状态暂时无法读取。"
							: "当前账号无法读取 Skill Hub 状态。"}
					</AlertDescription>
					{state.retryable && onRetry ? (
						<Button onClick={onRetry}>重试</Button>
					) : null}
				</Alert>
			) : (
				<div className="space-y-5">
					<div className="grid gap-4 md:grid-cols-2">
						<ManagementCard
							icon={<FolderKanban aria-hidden="true" />}
							title="项目与导入"
							description="创建、导入和编辑 Skill 项目。"
							button="创建项目"
						/>
						<ManagementCard
							icon={<PackageOpen aria-hidden="true" />}
							title="发布与版本"
							description="发布不可变版本并保留来源与摘要。"
							button="发布版本"
						/>
						<ManagementCard
							icon={<ClipboardCheck aria-hidden="true" />}
							title="共享审核"
							description={
								isAdministrator ? "审核或撤销共享发布。" : "管理员审核入口。"
							}
							button="打开审核"
						/>
						<ManagementCard
							icon={<CheckCircle2 aria-hidden="true" />}
							title="Agent 配置"
							description="配置固定版本并查看 sync / Applied 状态。"
							button="配置 Agent"
						/>
					</div>

					<section
						className="rounded-[14px] border bg-card p-5"
						aria-labelledby="skill-hub-published-heading"
					>
						<div className="flex flex-wrap items-center justify-between gap-3">
							<div>
								<p className="page-eyebrow">服务端授权 metadata</p>
								<h2
									id="skill-hub-published-heading"
									className="mt-1 font-semibold text-lg"
								>
									已发布版本
								</h2>
							</div>
							<Badge variant="outline">{versions.length} 个版本</Badge>
						</div>
						{versions.length === 0 ? (
							<Empty className="min-h-40">
								<EmptyHeader>
									<EmptyMedia variant="icon">
										<PackageOpen aria-hidden="true" />
									</EmptyMedia>
									<EmptyTitle>暂无已发布版本</EmptyTitle>
									<EmptyDescription>
										项目发布 API 接入后，版本会显示在这里。
									</EmptyDescription>
								</EmptyHeader>
							</Empty>
						) : (
							<ul className="mt-4 grid gap-3" aria-label="已发布 Skill 版本">
								{versions.map((version) => (
									<li
										key={version.skillVersionId}
										className="rounded-[10px] border p-4"
									>
										<div className="flex flex-wrap items-start justify-between gap-3">
											<div className="min-w-0">
												<h3 className="break-all font-medium">
													{version.name}
												</h3>
												<p className="mt-1 break-all text-muted-foreground text-sm">
													版本 {version.version} · {version.skillVersionId}
												</p>
											</div>
											<div className="flex flex-wrap gap-2">
												<Badge variant="secondary">
													{skillHubProviderLabels[version.provider]}
												</Badge>
												<Badge variant="outline">
													{skillHubVisibilityLabels[version.visibility]}
												</Badge>
												<Badge variant="outline">published</Badge>
											</div>
										</div>
										<p className="mt-3 break-all text-muted-foreground text-xs">
											digest: {version.packageDigest}
										</p>
										<p className="mt-2 text-muted-foreground text-sm">
											Agent sync / Applied 状态待正式配置查询接入。
										</p>
									</li>
								))}
							</ul>
						)}
					</section>
				</div>
			)}
		</section>
	);
}

function ManagementCard({
	icon,
	title,
	description,
	button,
}: {
	icon: ReactNode;
	title: string;
	description: string;
	button: string;
}) {
	return (
		<section className="rounded-[14px] border bg-card p-5">
			<div className="flex items-start gap-3">
				<div className="text-muted-foreground">{icon}</div>
				<div className="min-w-0">
					<h2 className="font-medium">{title}</h2>
					<p className="mt-2 text-muted-foreground text-sm">{description}</p>
				</div>
			</div>
			<Button
				className="mt-4"
				variant="outline"
				disabled
				title="等待正式 Skill Hub API"
			>
				{button}
			</Button>
		</section>
	);
}
