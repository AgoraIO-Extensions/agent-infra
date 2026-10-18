import { Link } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { Field } from "@/components/ui/field";
import { Label } from "@/components/ui/label";
import {
	NativeSelect,
	NativeSelectOption,
} from "@/components/ui/native-select";
import { SearchInput } from "@/components/ui/search-input";
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

function VersionBadges({ version }: { version: SkillHubVersionMetadataV1 }) {
	return (
		<div className="flex flex-wrap gap-2">
			<Badge variant="secondary">
				{skillHubProviderLabels[version.provider]}
			</Badge>
			<Badge variant="outline">
				{skillHubVisibilityLabels[version.visibility]}
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
					<p className="page-eyebrow">我的管理 / Skill Hub</p>
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
				<p aria-live="polite">正在加载 Skill 目录…</p>
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
					<div className="directory-filters">
						<SearchInput
							wrapperClassName="directory-search w-full"
							label="搜索 Skill"
							id={searchId}
							placeholder="搜索名称、版本或来源"
							maxLength={skillHubSearchMaxLength}
							value={query}
							onChange={(event) => setQuery(event.target.value)}
						/>
						<Field>
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
						</Field>
						<Field>
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
						</Field>
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
						<div className="directory-grid mt-4">
							{visibleVersions.map((version) => (
								<article
									className="directory-card"
									key={version.skillVersionId}
								>
									<div className="space-y-3">
										<div>
											<h2 className="font-semibold text-lg">
												<Link
													className={buttonVariants({ variant: "link" })}
													to="/skills/$skillVersionId"
													params={{ skillVersionId: version.skillVersionId }}
												>
													{version.name}
												</Link>
											</h2>
											<p className="text-muted-foreground text-sm">
												版本 {version.version}
											</p>
										</div>
										<VersionBadges version={version} />
										<p className="truncate text-muted-foreground text-xs">
											版本 ID：{version.skillVersionId}
										</p>
									</div>
								</article>
							))}
						</div>
					) : (
						<Empty className="mt-6">
							<EmptyDescription>
								没有匹配当前筛选条件的 Skill 版本。
							</EmptyDescription>
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
				<VersionBadges version={version} />
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
