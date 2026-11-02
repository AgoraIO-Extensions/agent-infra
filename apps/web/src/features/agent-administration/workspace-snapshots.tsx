import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadingLine } from "@/components/ui/spinner";
import type {
	Client,
	RequestResult,
} from "../../pilot/generated-v2/client/index.js";
import { listMyWorkspaceSnapshotsV1 } from "../../pilot/generated-v2/sdk.gen.js";
import type {
	ListMyWorkspaceSnapshotsV1Errors,
	ListMyWorkspaceSnapshotsV1Responses,
	WorkspaceSnapshotMetadataV1,
} from "../../pilot/generated-v2/types.gen.js";

export type WorkspaceSnapshotsState =
	| {
			readonly kind: "ready";
			readonly snapshots: readonly WorkspaceSnapshotMetadataV1[];
	  }
	| { readonly kind: "unavailable"; readonly retryable: boolean };

function unavailable(
	error: { readonly retryable?: boolean } | undefined,
): WorkspaceSnapshotsState {
	return { kind: "unavailable", retryable: error?.retryable !== false };
}

export async function loadWorkspaceSnapshots(
	client?: Client,
	signal?: AbortSignal,
): Promise<WorkspaceSnapshotsState> {
	const result: Awaited<
		RequestResult<
			ListMyWorkspaceSnapshotsV1Responses,
			ListMyWorkspaceSnapshotsV1Errors,
			false
		>
	> = await listMyWorkspaceSnapshotsV1<false>({
		client,
		signal,
		responseStyle: "fields",
		throwOnError: false,
	});
	if (result.response?.status !== 200 || !result.data)
		return unavailable(result.error);
	return { kind: "ready", snapshots: result.data };
}

export function useWorkspaceSnapshots({
	identityKey,
	client,
	enabled = true,
}: {
	identityKey: string;
	client?: Client;
	enabled?: boolean;
}) {
	const queryKey = useMemo(
		() => ["workspace-snapshots", identityKey],
		[identityKey],
	);
	const query = useQuery({
		queryKey,
		queryFn: ({ signal }) => loadWorkspaceSnapshots(client, signal),
		enabled: enabled && Boolean(identityKey),
		retry: false,
	});
	return { ...query, queryKey };
}

type WorkspaceSnapshotsPanelProps = {
	readonly identityKey: string;
	readonly sourceKind: "standard" | "custom";
	readonly client?: Client;
	readonly disabled?: boolean;
	readonly selected?: readonly { snapshotId: string; name: string }[];
	readonly onChange?: (
		bindings: readonly { snapshotId: string; name: string }[],
	) => void;
};

/** Metadata-only snapshot management. Standard templates explicitly cannot bind snapshots. */
export function WorkspaceSnapshotsPanel({
	identityKey,
	sourceKind,
	client,
	disabled = false,
	selected = [],
	onChange,
}: WorkspaceSnapshotsPanelProps) {
	const snapshots = useWorkspaceSnapshots({
		identityKey,
		client,
		enabled: sourceKind === "custom",
	});
	if (sourceKind === "standard") {
		return (
			<Card aria-label="工作区快照">
				<h3 className="font-medium text-sm">工作区快照</h3>
				<p className="mt-1 text-muted-foreground text-sm">
					标准模板不支持工作区快照。
				</p>
			</Card>
		);
	}
	if (snapshots.isLoading)
		return <LoadingLine aria-label="正在读取工作区快照" />;
	if (snapshots.isError || snapshots.data?.kind === "unavailable") {
		return (
			<Card aria-label="工作区快照">
				<h3 className="font-medium text-sm">工作区快照</h3>
				<p className="mt-1 text-muted-foreground text-sm">
					暂时无法读取快照元数据。
				</p>
				{snapshots.isError ||
				(snapshots.data?.kind === "unavailable" && snapshots.data.retryable) ? (
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => void snapshots.refetch()}
					>
						重试
					</Button>
				) : null}
			</Card>
		);
	}
	const values = snapshots.data?.snapshots ?? [];
	const selectedIds = new Set(selected.map(({ snapshotId }) => snapshotId));
	return (
		<Card aria-label="工作区快照">
			<div className="flex items-center justify-between gap-3">
				<div>
					<h3 className="font-medium text-sm">工作区快照</h3>
					<p className="mt-1 text-muted-foreground text-sm">
						选择快照并设置挂载名称。保存后生效，取消选择可解绑。
					</p>
				</div>
				<Badge variant="tag">{values.length} 个</Badge>
			</div>
			{values.length === 0 ? (
				<p className="mt-4 text-muted-foreground text-sm">暂无可用快照。</p>
			) : (
				<ul className="mt-4 space-y-2">
					{values.map((snapshot) => (
						<li
							key={snapshot.snapshotId}
							className="flex flex-wrap items-center justify-between gap-3 rounded border border-border p-3"
						>
							<div className="min-w-0">
								<div className="flex items-center gap-2">
									<strong className="break-all">{snapshot.snapshotId}</strong>
									<span>
										{snapshot.bindings
											.map((binding) => binding.name)
											.join(", ") || "未绑定"}
									</span>
									<Badge variant="tag">{snapshot.status}</Badge>
								</div>
								<div className="mt-1 break-all text-muted-foreground text-xs">
									{snapshot.digest} · {snapshot.sizeBytes} bytes ·{" "}
									{snapshot.bindings.length} 个绑定
								</div>
							</div>
							{onChange ? (
								<div className="flex items-center gap-2">
									<Label
										variant="option"
										htmlFor={`workspace-snapshot-${snapshot.snapshotId}`}
									>
										<Checkbox
											id={`workspace-snapshot-${snapshot.snapshotId}`}
											checked={selectedIds.has(snapshot.snapshotId)}
											disabled={
												disabled ||
												(!selectedIds.has(snapshot.snapshotId) &&
													(snapshot.status !== "ready" || selected.length >= 4))
											}
											onCheckedChange={(checked) => {
												const next = selected.filter(
													(binding) =>
														binding.snapshotId !== snapshot.snapshotId,
												);
												if (checked)
													next.push({
														snapshotId: snapshot.snapshotId,
														name:
															["repo", "repo-2", "repo-3", "repo-4"].find(
																(name) =>
																	!selected.some(
																		(binding) => binding.name === name,
																	),
															) ?? "repo",
													});
												onChange(next);
											}}
										/>
										选择快照 {snapshot.snapshotId}
									</Label>
									{selectedIds.has(snapshot.snapshotId) ? (
										<Input
											aria-label={`快照挂载名称 ${snapshot.snapshotId}`}
											className="w-36"
											required
											maxLength={63}
											pattern="[a-z0-9]((?:[a-z0-9]|-)*[a-z0-9])?"
											disabled={disabled}
											value={
												selected.find(
													(binding) =>
														binding.snapshotId === snapshot.snapshotId,
												)?.name ?? ""
											}
											onChange={(event) =>
												onChange(
													selected.map((binding) =>
														binding.snapshotId === snapshot.snapshotId
															? { ...binding, name: event.target.value }
															: binding,
													),
												)
											}
										/>
									) : null}
								</div>
							) : null}
						</li>
					))}
				</ul>
			)}
			{workspaceSnapshotBindingError(selected) ? (
				<Alert role="alert" tone="danger" className="mt-3">
					<AlertDescription>
						{workspaceSnapshotBindingError(selected)}
					</AlertDescription>
				</Alert>
			) : null}
		</Card>
	);
}

export function workspaceSnapshotBindingError(
	bindings: readonly { snapshotId: string; name: string }[],
): string | undefined {
	if (bindings.length > 4) return "最多选择 4 个快照。";
	if (
		bindings.some(
			({ name }) =>
				name.length > 63 || !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name),
		)
	)
		return "挂载名称须为 1 至 63 个小写字母、数字或连字符，且以字母或数字开头和结尾。";
	if (new Set(bindings.map(({ name }) => name)).size !== bindings.length)
		return "快照挂载名称不能重复。";
}
