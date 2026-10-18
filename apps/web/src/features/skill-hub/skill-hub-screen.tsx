import { Link } from "@tanstack/react-router";
import { ArrowRight, RefreshCw, Search, Sparkles } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	NativeSelect,
	NativeSelectOption,
} from "@/components/ui/native-select";
import type { SkillHubVersionMetadataV1 } from "../../pilot/generated-v2/types.gen.js";
import type {
	SkillHubDirectoryState,
	SkillHubVersionState,
} from "./skill-hub.js";

export const skillHubSearchMaxLength = 256;

export const skillHubProviderLabels = {
	system: "平台内置",
	my_library: "我的库",
	market: "市场",
	clawhub: "ClawHub",
	skillhub: "Skill Hub",
	npx: "npx",
	github: "GitHub",
} satisfies Record<SkillHubVersionMetadataV1["provider"], string>;

export const skillHubVisibilityLabels = {
	PRIVATE: "私人",
	MEMBER: "成员",
	ORGANIZATION: "组织",
	MARKET: "市场",
} satisfies Record<SkillHubVersionMetadataV1["visibility"], string>;

type SkillHubDirectoryScreenProps = {
	state: SkillHubDirectoryState | { kind: "loading" };
	onRetry?: () => void;
	retrying?: boolean;
};

export function SkillHubVersionBadges({
	version,
}: {
	version: SkillHubVersionMetadataV1;
}) {
	const providerLabel = skillHubProviderLabels[version.provider];
	const visibilityLabel = skillHubVisibilityLabels[version.visibility];

	return (
		<div className="flex flex-wrap gap-2">
			<Badge
				variant="outline"
				className="min-h-0 rounded-[7px] bg-muted/40 px-2 py-[3px] text-muted-foreground leading-4"
				aria-label={`可见范围：${visibilityLabel}；来源：${providerLabel}`}
			>
				范围：{visibilityLabel} · 来源：{providerLabel}
			</Badge>
			<Badge variant="outline">已发布</Badge>
		</div>
	);
}

export function SkillHubDirectoryScreen({
	state,
	onRetry,
	retrying = false,
}: SkillHubDirectoryScreenProps) {
	const searchId = useId();
	const [query, setQuery] = useState("");
	const [provider, setProvider] = useState<
		"all" | SkillHubVersionMetadataV1["provider"]
	>("all");
	const [visibility, setVisibility] = useState<
		"all" | SkillHubVersionMetadataV1["visibility"]
	>("all");
	const versions = state.kind === "ready" ? state.versions : [];
	const normalizedQuery = query.trim().toLocaleLowerCase();
	const visibleVersions = useMemo(
		() =>
			versions.filter((version) => {
				const searchable = [
					version.name,
					version.version,
					skillHubProviderLabels[version.provider],
					skillHubVisibilityLabels[version.visibility],
				]
					.join("\n")
					.toLocaleLowerCase();
				return (
					(provider === "all" || version.provider === provider) &&
					(visibility === "all" || version.visibility === visibility) &&
					searchable.includes(normalizedQuery)
				);
			}),
		[versions, normalizedQuery, provider, visibility],
	);

	return (
		<section aria-labelledby="skill-hub-heading">
			<header className="page-heading">
				<div>
					<p className="page-eyebrow">工作区 / Skill Hub</p>
					<h1 id="skill-hub-heading" className="font-semibold text-[28px]">
						Skill 目录
					</h1>
					<p className="mt-2 text-muted-foreground">
						这里只展示服务端按当前身份授权的固定版本 metadata。
					</p>
				</div>
				{state.kind === "ready" ? (
					<Badge
						variant="outline"
						aria-label={`共 ${versions.length} 个 Skill 版本`}
					>
						{versions.length} 个版本
					</Badge>
				) : null}
			</header>

			{state.kind === "loading" ? (
				<p className="loading-line" role="status">
					正在加载 Skill 目录…
				</p>
			) : state.kind === "unavailable" ? (
				<Alert>
					<AlertDescription>
						{state.retryable
							? "Skill 目录暂时无法读取，请稍后重试。"
							: state.reason === "denied"
								? "当前账号没有读取 Skill 目录的权限。"
								: "Skill 目录暂时无法访问，请联系管理员。"}
					</AlertDescription>
					{state.retryable && onRetry ? (
						<Button
							className="mt-4"
							variant="outline"
							onClick={onRetry}
							disabled={retrying}
						>
							<RefreshCw
								aria-hidden="true"
								className={retrying ? "animate-spin" : ""}
							/>
							重试
						</Button>
					) : null}
				</Alert>
			) : (
				<>
					<div className="directory-filters skill-hub-filters">
						<div className="directory-search w-full space-y-2">
							<Label className="sr-only" htmlFor={searchId}>
								搜索 Skill
							</Label>
							<div className="search relative">
								<Search
									aria-hidden="true"
									className="pointer-events-none absolute top-3 left-3 size-5 text-muted-foreground"
								/>
								<Input
									id={searchId}
									className="pl-10"
									type="search"
									placeholder="搜索名称、版本或来源"
									maxLength={skillHubSearchMaxLength}
									value={query}
									onChange={(event) => setQuery(event.target.value)}
								/>
							</div>
						</div>
						<div className="directory-filter">
							<Label htmlFor={`${searchId}-provider`}>来源</Label>
							<NativeSelect
								id={`${searchId}-provider`}
								value={provider}
								onChange={(event) =>
									setProvider(
										event.target.value as
											| "all"
											| SkillHubVersionMetadataV1["provider"],
									)
								}
							>
								<NativeSelectOption value="all">全部来源</NativeSelectOption>
								{Object.entries(skillHubProviderLabels).map(
									([value, label]) => (
										<NativeSelectOption key={value} value={value}>
											{label}
										</NativeSelectOption>
									),
								)}
							</NativeSelect>
						</div>
						<div className="directory-filter">
							<Label htmlFor={`${searchId}-visibility`}>可见范围</Label>
							<NativeSelect
								id={`${searchId}-visibility`}
								value={visibility}
								onChange={(event) =>
									setVisibility(
										event.target.value as
											| "all"
											| SkillHubVersionMetadataV1["visibility"],
									)
								}
							>
								<NativeSelectOption value="all">全部范围</NativeSelectOption>
								{Object.entries(skillHubVisibilityLabels).map(
									([value, label]) => (
										<NativeSelectOption key={value} value={value}>
											{label}
										</NativeSelectOption>
									),
								)}
							</NativeSelect>
						</div>
					</div>
					<div className="mt-4" role="status" aria-live="polite">
						{normalizedQuery || provider !== "all" || visibility !== "all"
							? [
									"当前授权 ",
									versions.length,
									" 个版本，匹配 ",
									visibleVersions.length,
									" 个",
								].join("")
							: ["当前授权 ", versions.length, " 个版本"].join("")}
					</div>
					{visibleVersions.length > 0 ? (
						<div className="skill-directory mt-4">
							{visibleVersions.map((version) => (
								<article className="skill-row" key={version.skillVersionId}>
									<div className="skill-mark" aria-hidden="true">
										<Sparkles size={20} />
									</div>
									<div className="min-w-0">
										<h2>
											<Link
												className="skill-row-link"
												to="/skills/$skillVersionId"
												params={{ skillVersionId: version.skillVersionId }}
											>
												{version.name}
											</Link>
										</h2>
										<p>版本 {version.version}</p>
										<p className="truncate">
											版本 ID：{version.skillVersionId}
										</p>
									</div>
									<SkillHubVersionBadges version={version} />
									<Link
										className={buttonVariants({ variant: "ghost" })}
										to="/skills/$skillVersionId"
										params={{ skillVersionId: version.skillVersionId }}
									>
										查看详情 <ArrowRight aria-hidden="true" />
									</Link>
								</article>
							))}
						</div>
					) : (
						<Empty className="mt-6">
							<EmptyDescription>
								没有匹配当前筛选条件的 Skill 版本。
							</EmptyDescription>
							{normalizedQuery || provider !== "all" || visibility !== "all" ? (
								<Button
									className="mt-4"
									variant="outline"
									onClick={() => {
										setQuery("");
										setProvider("all");
										setVisibility("all");
									}}
								>
									清除筛选
								</Button>
							) : null}
						</Empty>
					)}
					<p className="mt-6 text-muted-foreground text-sm">
						发布、安装、Agent 绑定和 Worker/Runtime
						同步状态需要对应服务端契约后才会在此显示。
					</p>
				</>
			)}
		</section>
	);
}

type SkillHubVersionScreenProps = {
	state: SkillHubVersionState | { kind: "loading" };
	onRetry?: () => void;
	retrying?: boolean;
};

export function SkillHubVersionScreen({
	state,
	onRetry,
	retrying = false,
}: SkillHubVersionScreenProps) {
	if (state.kind === "loading") {
		return <p aria-live="polite">正在加载 Skill 版本…</p>;
	}
	if (state.kind === "unavailable") {
		return (
			<Alert>
				<AlertDescription>
					{state.retryable
						? "Skill 版本暂时无法读取，请稍后重试。"
						: state.reason === "denied"
							? "当前账号没有读取该 Skill 版本的权限。"
							: "Skill 版本暂时无法访问，请联系管理员。"}
				</AlertDescription>
				{state.retryable && onRetry ? (
					<Button
						className="mt-4"
						variant="outline"
						onClick={onRetry}
						disabled={retrying}
					>
						<RefreshCw
							aria-hidden="true"
							className={retrying ? "animate-spin" : ""}
						/>
						重试
					</Button>
				) : null}
			</Alert>
		);
	}
	const version = state.version;
	return (
		<section aria-labelledby="skill-version-heading">
			<Link className={buttonVariants({ variant: "outline" })} to="/skills">
				返回 Skill 目录
			</Link>
			<header className="page-heading mt-6">
				<div>
					<p className="page-eyebrow">Skill Hub / 版本详情</p>
					<h1 id="skill-version-heading" className="font-semibold text-[28px]">
						{version.name}
					</h1>
					<p className="mt-2 text-muted-foreground">
						固定版本 {version.version}
					</p>
				</div>
				<SkillHubVersionBadges version={version} />
			</header>
			<dl className="mt-6 grid gap-4 sm:grid-cols-2">
				<Detail label="版本 ID" value={version.skillVersionId} />
				<Detail label="Skill ID" value={version.skillId} />
				<Detail label="包摘要" value={version.packageDigest} />
				<Detail label="Manifest 摘要" value={version.manifestDigest} />
				<Detail label="签名摘要" value={version.signatureDigest} />
			</dl>
			<p className="mt-6 text-muted-foreground text-sm">
				详情只回读服务端授权的 metadata，不暴露包正文、对象存储地址或凭证。
			</p>
		</section>
	);
}

function Detail({ label, value }: { label: string; value: string }) {
	return (
		<div className="rounded-lg border bg-card p-4">
			<dt className="text-muted-foreground text-sm">{label}</dt>
			<dd className="mt-1 break-all font-mono text-sm">{value}</dd>
		</div>
	);
}
