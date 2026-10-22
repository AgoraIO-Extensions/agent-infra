import { Link } from "@tanstack/react-router";
import { ArrowRight, Layers, Plus, Search, TriangleAlert } from "lucide-react";
import { type ReactNode, useId, useMemo, useRef, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import { Field } from "@/components/ui/field";
import { Label } from "@/components/ui/label";
import {
	NativeSelect,
	NativeSelectOption,
} from "@/components/ui/native-select";
import { SearchInput } from "@/components/ui/search-input";
import { withObjectName } from "@/lib/accessible-name";
import type { SkillHubVersionMetadataV1 } from "../../pilot/generated-v2/types.gen.js";
import { RecoveryButton } from "../recovery-button.js";
import type { SkillHubDirectoryState } from "./skill-hub.js";
import {
	latestVersionPerSkill,
	skillHubProviderLabels,
	skillHubVisibilityLabels,
} from "./skill-hub-labels.js";
import { SkillHubScopePill } from "./skill-hub-scope-pill.js";

export const skillHubSearchMaxLength = 256;

type Provider = SkillHubVersionMetadataV1["provider"];
type Visibility = SkillHubVersionMetadataV1["visibility"];

type SkillHubDirectoryScreenProps = {
	state: SkillHubDirectoryState | { kind: "loading" };
	onRetry?: () => void;
	retrying?: boolean;
};

/** 设计 .skill-loading：两条静态 skeleton 加读取文案，整块是一个 status。 */
export function SkillHubLoading({ children }: { children: ReactNode }) {
	return (
		<div className="skill-surface skill-loading" role="status">
			<div className="skill-skeleton" aria-hidden="true" />
			<div className="skill-skeleton" aria-hidden="true" />
			<p>{children}</p>
		</div>
	);
}

/** 设计 skillEmpty：虚线空态，图标 + 标题 + 说明，可带一个操作。 */
export function SkillHubEmpty({
	title,
	description,
	icon = <Search aria-hidden="true" />,
	action,
	role,
}: {
	title: string;
	description: string;
	icon?: ReactNode;
	action?: ReactNode;
	role?: "alert" | "status";
}) {
	return (
		<Empty>
			<EmptyHeader role={role}>
				<EmptyMedia>{icon}</EmptyMedia>
				<EmptyTitle>{title}</EmptyTitle>
				<EmptyDescription>{description}</EmptyDescription>
			</EmptyHeader>
			{action ? <EmptyContent>{action}</EmptyContent> : null}
		</Empty>
	);
}

/** 读取失败：可重试时给「重新读取」，403 与不可重试失败只说明原因。 */
export function SkillHubReadFailure({
	retryable,
	reason,
	retryTitle,
	retryDescription,
	deniedText,
	unavailableText,
	onRetry,
	retrying,
}: {
	retryable: boolean;
	reason?: string;
	retryTitle: string;
	retryDescription: string;
	deniedText: string;
	unavailableText: string;
	onRetry?: () => void;
	retrying?: boolean;
}) {
	if (retryable)
		return (
			<SkillHubEmpty
				role="alert"
				icon={<TriangleAlert aria-hidden="true" />}
				title={retryTitle}
				description={retryDescription}
				action={
					onRetry ? (
						<RecoveryButton
							variant="outline"
							recoveryKey="重新读取"
							busy={retrying}
							onClick={onRetry}
						>
							重新读取
						</RecoveryButton>
					) : undefined
				}
			/>
		);
	return (
		<SkillHubEmpty
			role="alert"
			icon={<TriangleAlert aria-hidden="true" />}
			title={reason === "denied" ? "没有读取权限" : "暂时无法访问"}
			description={reason === "denied" ? deniedText : unavailableText}
		/>
	);
}

export function SkillHubDirectoryScreen({
	state,
	onRetry,
	retrying = false,
}: SkillHubDirectoryScreenProps) {
	const searchId = useId();
	const searchRef = useRef<HTMLInputElement>(null);
	const [query, setQuery] = useState("");
	const [provider, setProvider] = useState<"all" | Provider>("all");
	const [visibility, setVisibility] = useState<"all" | Visibility>("all");
	const versions = state.kind === "ready" ? state.versions : [];
	const normalizedQuery = query.trim().toLocaleLowerCase();
	const filtered =
		normalizedQuery || provider !== "all" || visibility !== "all";
	const skills = useMemo(() => latestVersionPerSkill(versions), [versions]);
	// 先按版本筛选再分组：每行显示该 Skill 符合条件的最高版本。
	const visibleSkills = useMemo(
		() =>
			latestVersionPerSkill(
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
			),
		[versions, normalizedQuery, provider, visibility],
	);
	// 重新读取期间（失败后点「重新读取」）也先显示加载态。
	const loading =
		state.kind === "loading" || (state.kind === "unavailable" && retrying);

	function clearFilters() {
		setQuery("");
		setProvider("all");
		setVisibility("all");
		searchRef.current?.focus();
	}

	return (
		<section className="skill-page" aria-labelledby="skill-hub-heading">
			<header className="page-heading">
				<div>
					<p className="page-eyebrow">工作区 / Skill Hub</p>
					<h1 id="skill-hub-heading">Skill Hub</h1>
					<p>搜索可复用的 Skill，选定版本后加入自己的库。</p>
				</div>
				<div className="skill-actions">
					<Link className={buttonVariants()} to="/skills/manage/new">
						<Plus aria-hidden="true" />
						创建或导入
					</Link>
				</div>
			</header>

			<div className="skill-toolbar">
				<SearchInput
					ref={searchRef}
					wrapperClassName="w-full"
					label="搜索 Skill"
					id={searchId}
					placeholder="搜索名称、版本或来源"
					maxLength={skillHubSearchMaxLength}
					value={query}
					onChange={(event) => setQuery(event.target.value)}
				/>
				<Field>
					<Label className="sr-only" htmlFor={`${searchId}-provider`}>
						来源
					</Label>
					<NativeSelect
						id={`${searchId}-provider`}
						value={provider}
						onChange={(event) =>
							setProvider(event.target.value as "all" | Provider)
						}
					>
						<NativeSelectOption value="all">全部来源</NativeSelectOption>
						{Object.entries(skillHubProviderLabels).map(([value, label]) => (
							<NativeSelectOption key={value} value={value}>
								{label}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</Field>
				<Field>
					<Label className="sr-only" htmlFor={`${searchId}-visibility`}>
						发布范围
					</Label>
					<NativeSelect
						id={`${searchId}-visibility`}
						value={visibility}
						onChange={(event) =>
							setVisibility(event.target.value as "all" | Visibility)
						}
					>
						<NativeSelectOption value="all">全部范围</NativeSelectOption>
						{Object.entries(skillHubVisibilityLabels).map(([value, label]) => (
							<NativeSelectOption key={value} value={value}>
								{label}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</Field>
			</div>

			<div className="section-heading">
				<div>
					<h2>Skill 目录</h2>
					<p>只显示当前范围内已发布的版本</p>
				</div>
				<Link
					className={buttonVariants({ variant: "ghost" })}
					to="/skills/manage"
				>
					{/* 设计 skButton icon:'arrow'：箭头在文字前（G4-24，同 Y-05 / Y-12）。 */}
					<ArrowRight aria-hidden="true" />
					我的 Skill
				</Link>
			</div>

			{loading ? (
				<SkillHubLoading>正在读取 Skill 目录…</SkillHubLoading>
			) : state.kind === "unavailable" ? (
				<SkillHubReadFailure
					retryable={state.retryable}
					reason={state.reason}
					retryTitle="暂时无法读取目录"
					retryDescription="已安装和绑定记录仍然保留。"
					deniedText="当前账号没有读取 Skill 目录的权限。"
					unavailableText="Skill 目录暂时无法访问，请联系管理员。"
					onRetry={onRetry}
					retrying={retrying}
				/>
			) : (
				<>
					{/* 计数只给读屏，视觉上不显示。 */}
					<p className="sr-only" role="status">
						{filtered
							? `共 ${skills.length} 个 Skill，匹配 ${visibleSkills.length} 个`
							: `共 ${skills.length} 个 Skill`}
					</p>
					{visibleSkills.length > 0 ? (
						<div className="skill-surface" data-skill-catalog="">
							{visibleSkills.map((version) => (
								<SkillCatalogRow key={version.skillId} version={version} />
							))}
						</div>
					) : (
						<SkillHubEmpty
							title={filtered ? "没有匹配的 Skill" : "目录中还没有 Skill"}
							description={
								filtered
									? "换个关键词，或清除筛选。"
									: "发布并通过审核的版本会显示在这里。"
							}
							action={
								filtered ? (
									<Button
										variant="outline"
										type="button"
										onClick={clearFilters}
									>
										清除筛选
									</Button>
								) : undefined
							}
						/>
					)}
				</>
			)}
		</section>
	);
}

function SkillCatalogRow({ version }: { version: SkillHubVersionMetadataV1 }) {
	return (
		<article className="skill-row">
			<span className="skill-mark" aria-hidden="true">
				<Layers />
			</span>
			<div className="skill-row-copy">
				<h2>{version.name}</h2>
				<SkillHubScopePill version={version} />
			</div>
			<div className="skill-row-meta">
				<strong>v{version.version}</strong>
			</div>
			<div className="skill-actions">
				{/* 每行只有这一个指向详情的链接（NI-100）。 */}
				<Link
					className={buttonVariants({ variant: "ghost" })}
					to="/skills/$skillVersionId"
					params={{ skillVersionId: version.skillVersionId }}
					aria-label={withObjectName("查看详情", version.name)}
				>
					{/* 箭头在文字前（G4-24）。 */}
					<ArrowRight aria-hidden="true" />
					查看详情
				</Link>
			</div>
		</article>
	);
}
