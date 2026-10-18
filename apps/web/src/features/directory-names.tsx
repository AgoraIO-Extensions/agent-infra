import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { IdentifierText } from "@/components/ui/identifier-text";

export type DirectoryKind = "user" | "organization";
export type DirectoryOption = {
	id: string;
	name: string;
	secondary: string;
	detail?: string;
	type: DirectoryKind;
};
export type DirectoryTarget =
	| { kind: "user"; userId: string }
	| { kind: "organization"; organizationId: string };

/** 目录搜索与按 canonical ID 反查；ID 按 50 个一批读取。 */
export async function readDirectory(
	kind: DirectoryKind,
	query: string,
	ids: readonly string[],
	signal: AbortSignal,
): Promise<DirectoryOption[]> {
	const batches: readonly string[][] = ids.length
		? Array.from({ length: Math.ceil(ids.length / 50) }, (_, index) =>
				ids.slice(index * 50, (index + 1) * 50),
			)
		: [[]];
	const results = await Promise.all(
		batches.map(async (batch) => {
			const params = new URLSearchParams({ kind, q: query, limit: "50" });
			if (batch.length) params.set("ids", batch.join(","));
			const response = await fetch(`/api/v2/directory/search?${params}`, {
				signal,
				headers: { Accept: "application/json" },
			});
			if (!response.ok) throw new Error("directory search unavailable");
			const body = (await response.json()) as {
				items?: {
					kind: DirectoryKind;
					canonicalId: string;
					displayName: string;
					email?: string;
					organizationPath?: string;
				}[];
			};
			if (
				!Array.isArray(body.items) ||
				body.items.some(
					(item) =>
						!item ||
						typeof item.canonicalId !== "string" ||
						typeof item.displayName !== "string" ||
						(item.email !== undefined && typeof item.email !== "string") ||
						(item.organizationPath !== undefined &&
							typeof item.organizationPath !== "string"),
				)
			)
				throw new Error("directory response invalid");
			return body.items
				.filter(
					(item) =>
						item.kind === kind &&
						(!batch.length || batch.includes(item.canonicalId)),
				)
				.map((item) => ({
					id: item.canonicalId,
					name: item.displayName,
					secondary:
						kind === "user"
							? (item.email ?? "")
							: (item.organizationPath ?? ""),
					detail: kind === "user" ? item.organizationPath : undefined,
					type: item.kind,
				}));
		}),
	);
	return results.flat();
}

export const unresolvedDirectoryLabels: Record<DirectoryKind, string> = {
	user: "未识别的用户",
	organization: "未识别的组织",
};

const text = (value: string | null | undefined) => value?.trim() ?? "";

/** 人员主文字依次取显示名、邮箱；都没有时为「未识别的用户」，不回退到 ID。 */
export function formatPerson(
	person: { displayName?: string | null; email?: string | null },
	unresolved = unresolvedDirectoryLabels.user,
) {
	const name = text(person.displayName) || text(person.email) || unresolved;
	const email = text(person.email);
	return { name, secondary: email === name ? "" : email };
}

/** 组织主文字取名称，次要文字为组织路径；都没有时为「未识别的组织」。 */
export function formatOrganization(
	organization: { name?: string | null; path?: string | null },
	unresolved = unresolvedDirectoryLabels.organization,
) {
	const path = text(organization.path);
	const name = text(organization.name) || path || unresolved;
	return { name, secondary: path === name ? "" : path };
}

export type DirectoryName = {
	id: string;
	name: string;
	secondary: string;
	resolved: boolean;
};
export type DirectoryNames = {
	status: "loading" | "ready" | "error";
	resolve: (id: string) => DirectoryName;
	retry: () => void;
};

/**
 * 页面级目录批量读取：同一页面把要显示的同类 ID 合并后调用一次。
 * ID 去重排序后作为 query key，相同集合共享缓存；后台重取或集合变化时保留上一次结果，
 * 已显示的名称不会被加载文案替换。
 */
export function useDirectoryNames(
	kind: DirectoryKind,
	ids: readonly string[],
): DirectoryNames {
	const key = [...new Set(ids.filter(Boolean))].sort();
	const query = useQuery({
		queryKey: ["directory-names", kind, key],
		queryFn: ({ signal }) => readDirectory(kind, "", key, signal),
		enabled: key.length > 0,
		staleTime: 5 * 60_000,
		placeholderData: keepPreviousData,
		retry: false,
	});
	const records = new Map((query.data ?? []).map((item) => [item.id, item]));
	return {
		// 后台重取失败但仍有上一次结果时继续显示名称，不提示读取失败。
		status:
			key.length === 0 || (query.data !== undefined && !query.isPlaceholderData)
				? "ready"
				: query.isError
					? "error"
					: "loading",
		resolve(id) {
			const record = records.get(id);
			const formatted =
				kind === "user"
					? formatPerson({
							displayName: record?.name,
							email: record?.secondary,
						})
					: formatOrganization({ name: record?.name, path: record?.secondary });
			return { id, ...formatted, resolved: Boolean(record) };
		},
		retry() {
			void query.refetch();
		},
	};
}

const targetId = (target: DirectoryTarget) =>
	target.kind === "user" ? target.userId : target.organizationId;

export type AvailabilityNames = Omit<DirectoryNames, "resolve"> & {
	resolve: (target: DirectoryTarget) => DirectoryName;
};

/** 使用范围同时含用户与组织：每类各读一次，合并为一个状态。 */
export function useAvailabilityNames(
	targets: readonly DirectoryTarget[],
): AvailabilityNames {
	const users = useDirectoryNames(
		"user",
		targets.flatMap((target) =>
			target.kind === "user" ? [target.userId] : [],
		),
	);
	const organizations = useDirectoryNames(
		"organization",
		targets.flatMap((target) =>
			target.kind === "organization" ? [target.organizationId] : [],
		),
	);
	const statuses = [users.status, organizations.status];
	return {
		status: statuses.includes("error")
			? "error"
			: statuses.includes("loading")
				? "loading"
				: "ready",
		resolve: (target: DirectoryTarget) =>
			(target.kind === "user" ? users : organizations).resolve(
				targetId(target),
			),
		retry() {
			if (users.status === "error") users.retry();
			if (organizations.status === "error") organizations.retry();
		},
	};
}

/** 页面唯一的目录读取失败提示；单元格与 chip 不各自渲染状态。 */
export function DirectoryReadAlert({
	names,
	className,
}: {
	names: readonly Pick<DirectoryNames, "status" | "retry">[];
	className?: string;
}) {
	const failed = names.filter((item) => item.status === "error");
	if (!failed.length) return null;
	return (
		<Alert tone="danger" role="alert" className={className}>
			<AlertDescription>
				目录暂时无法读取，人员和组织名称暂不显示。
			</AlertDescription>
			<AlertAction>
				<Button
					type="button"
					variant="outline"
					onClick={() => {
						for (const item of failed) item.retry();
					}}
				>
					<RefreshCw aria-hidden="true" data-icon="inline-start" />
					重新读取目录
				</Button>
			</AlertAction>
		</Alert>
	);
}

/**
 * 单个人员或组织名称。读取中显示非 live 占位；未解析时显示「未识别的用户 / 组织」，
 * 只有系统管理员与审计页面传 identifier 时才附 ID 短形式以便核对。
 */
export function DirectoryNameText({
	name,
	status,
	identifier = false,
	secondary = false,
}: {
	name: DirectoryName;
	status: DirectoryNames["status"];
	identifier?: boolean;
	secondary?: boolean;
}) {
	if (!name.resolved && status === "loading")
		return (
			<span className="directory-name-pending text-muted-foreground">
				读取中…
			</span>
		);
	return (
		<>
			<span className="directory-name">{name.name}</span>
			{!name.resolved && identifier ? (
				<>
					{" "}
					<IdentifierText value={name.id} label="ID" />
				</>
			) : null}
			{secondary && name.resolved && name.secondary ? (
				<small className="block break-words text-muted-foreground">
					{name.secondary}
				</small>
			) : null}
		</>
	);
}

/** 使用范围的名称展示：每个对象一项，不以数量或删除信息替代名称。 */
export function AvailabilityNameList({
	targets,
	names,
	layout = "inline",
	identifier = false,
	empty,
}: {
	targets: readonly DirectoryTarget[];
	names: AvailabilityNames;
	layout?: "inline" | "list";
	identifier?: boolean;
	empty: string;
}) {
	if (!targets.length) return <>{empty}</>;
	if (layout === "list")
		return (
			<ul className="space-y-2">
				{targets.map((target) => (
					<li key={`${target.kind}:${targetId(target)}`}>
						<DirectoryNameText
							name={names.resolve(target)}
							status={names.status}
							identifier={identifier}
							secondary
						/>
					</li>
				))}
			</ul>
		);
	return (
		<span className="directory-name-list">
			{targets.map((target, index) => (
				<span key={`${target.kind}:${targetId(target)}`}>
					{index ? "、" : null}
					<DirectoryNameText
						name={names.resolve(target)}
						status={names.status}
						identifier={identifier}
					/>
				</span>
			))}
		</span>
	);
}
