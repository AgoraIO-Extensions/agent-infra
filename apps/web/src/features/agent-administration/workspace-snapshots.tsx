import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { LoadingLine } from "@/components/ui/spinner";
import type {
	Client,
	RequestResult,
} from "../../pilot/generated-v2/client/index.js";
import {
	deleteWorkspaceSnapshotV1,
	listWorkspaceSnapshotsV1,
} from "../../pilot/generated-v2/sdk.gen.js";
import type {
	DeleteWorkspaceSnapshotV1Errors,
	DeleteWorkspaceSnapshotV1Responses,
	ListWorkspaceSnapshotsV1Errors,
	ListWorkspaceSnapshotsV1Responses,
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
			ListWorkspaceSnapshotsV1Responses,
			ListWorkspaceSnapshotsV1Errors,
			false
		>
	> = await listWorkspaceSnapshotsV1<false>({
		client,
		signal,
		responseStyle: "fields",
		throwOnError: false,
	});
	if (result.response?.status !== 200 || !result.data)
		return unavailable(result.error);
	return { kind: "ready", snapshots: result.data };
}

export async function unbindWorkspaceSnapshot(
	snapshotId: string,
	idempotencyKey: string,
	client?: Client,
): Promise<WorkspaceSnapshotMetadataV1> {
	const result: Awaited<
		RequestResult<
			DeleteWorkspaceSnapshotV1Responses,
			DeleteWorkspaceSnapshotV1Errors,
			false
		>
	> = await deleteWorkspaceSnapshotV1<false>({
		client,
		path: { snapshotId },
		headers: { "Idempotency-Key": idempotencyKey },
		responseStyle: "fields",
		throwOnError: false,
	});
	if (result.response?.status !== 200 || !result.data)
		throw new Error("Workspace snapshot could not be unbound");
	return result.data;
}

export function useWorkspaceSnapshots({
	identityKey,
	client,
}: {
	identityKey: string;
	client?: Client;
}) {
	const queryClient = useQueryClient();
	const queryKey = useMemo(
		() => ["workspace-snapshots", identityKey],
		[identityKey],
	);
	const query = useQuery({
		queryKey,
		queryFn: ({ signal }) => loadWorkspaceSnapshots(client, signal),
		enabled: Boolean(identityKey),
		retry: false,
	});
	const remove = useMutation({
		mutationFn: ({
			snapshotId,
			idempotencyKey,
		}: {
			snapshotId: string;
			idempotencyKey: string;
		}) => unbindWorkspaceSnapshot(snapshotId, idempotencyKey, client),
		onSuccess: () => queryClient.invalidateQueries({ queryKey }),
	});
	return { ...query, remove, queryKey };
}

type WorkspaceSnapshotsPanelProps = {
	readonly identityKey: string;
	readonly sourceKind: "standard" | "custom";
	readonly client?: Client;
};

/** Metadata-only snapshot management. Standard templates explicitly cannot bind snapshots. */
export function WorkspaceSnapshotsPanel({
	identityKey,
	sourceKind,
	client,
}: WorkspaceSnapshotsPanelProps) {
	const snapshots = useWorkspaceSnapshots({ identityKey, client });
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
	if (snapshots.data?.kind === "unavailable") {
		return (
			<Card aria-label="工作区快照">
				<h3 className="font-medium text-sm">工作区快照</h3>
				<p className="mt-1 text-muted-foreground text-sm">
					暂时无法读取快照元数据。
				</p>
				{snapshots.data.retryable ? (
					<Button
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
	return (
		<Card aria-label="工作区快照">
			<div className="flex items-center justify-between gap-3">
				<div>
					<h3 className="font-medium text-sm">工作区快照</h3>
					<p className="mt-1 text-muted-foreground text-sm">
						平台托管、内容寻址、只读挂载。仅显示元数据。
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
							className="flex items-center justify-between gap-3 rounded border border-border p-3"
						>
							<div className="min-w-0">
								<div className="flex items-center gap-2">
									<strong className="truncate">
										{snapshot.bindings
											.map((binding) => binding.name)
											.join(", ") || "未绑定"}
									</strong>
									<Badge variant="tag">{snapshot.status}</Badge>
								</div>
								<div className="mt-1 text-muted-foreground text-xs">
									{snapshot.digest} · {snapshot.sizeBytes} bytes ·{" "}
									{snapshot.bindings.length} 个绑定
								</div>
							</div>
							<Button
								variant="outline"
								size="sm"
								disabled={
									snapshots.remove.isPending || snapshot.bindings.length > 0
								}
								title={
									snapshot.bindings.length > 0 ? "仍有 Agent 绑定" : "解绑快照"
								}
								onClick={() =>
									void snapshots.remove.mutateAsync({
										snapshotId: snapshot.snapshotId,
										idempotencyKey: crypto.randomUUID(),
									})
								}
							>
								解绑
							</Button>
						</li>
					))}
				</ul>
			)}
		</Card>
	);
}
