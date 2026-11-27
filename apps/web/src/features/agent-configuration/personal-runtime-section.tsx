import {
	ExternalRuntimeDirectoryReceipt,
	type PersonalRuntimeBindingUpdate,
	PersonalRuntimeBindingView,
} from "@agent-infra/contracts/pilot";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Label } from "../../components/ui/label";
import {
	NativeSelect,
	NativeSelectOption,
} from "../../components/ui/native-select";
import {
	discoverMyExternalRuntimeTargetsV2,
	getAgentPersonalRuntimeV2,
	setAgentPersonalRuntimeV2,
} from "../../pilot/generated-v2";

type Selection = NonNullable<
	ReturnType<typeof PersonalRuntimeBindingUpdate.parse>["target"]
>;
const deviceStatus = { online: "在线", offline: "离线", unknown: "状态未知" };
const runtimeStatus = {
	available: "可用",
	unavailable: "不可用",
	unknown: "状态未知",
};
const actionLabel = { execute: "执行", resume: "续接", cancel: "取消" };

export function PersonalRuntimeSection({
	agentId,
	userId,
}: {
	agentId: string;
	userId: string;
}) {
	const client = useQueryClient();
	const key = ["personal-runtime", userId, agentId];
	const [draft, setDraft] = useState<Selection>();
	const binding = useQuery({
		queryKey: key,
		retry: false,
		queryFn: async ({ signal }) => {
			const { data, response } = await getAgentPersonalRuntimeV2({
				path: { agentId },
				signal,
			});
			if (!response?.ok) throw Error("无法读取个人 Runtime 绑定。");
			return PersonalRuntimeBindingView.parse(data);
		},
	});
	const saved = binding.data?.target;
	const serviceId =
		draft?.serviceId ??
		saved?.serviceId ??
		(binding.data?.services.length === 1 ? binding.data.services[0] : "");
	const deviceRef = draft?.deviceRef ?? saved?.deviceRef ?? "";
	const runtimeRef = draft?.runtimeRef ?? saved?.runtimeRef ?? "";
	const directory = useQuery({
		queryKey: ["personal-runtime-directory", userId, serviceId],
		retry: false,
		enabled: Boolean(
			serviceId &&
				binding.isSuccess &&
				binding.data.services.includes(serviceId),
		),
		queryFn: async ({ signal }) => {
			const { data, response } = await discoverMyExternalRuntimeTargetsV2({
				body: { id: serviceId },
				signal,
			});
			if (!response?.ok) throw Error("无法读取本人设备。");
			const { directory } = ExternalRuntimeDirectoryReceipt.parse(data);
			if (directory.instanceId !== serviceId || directory.subjectId !== userId)
				throw Error("无法核对设备归属。");
			return directory;
		},
	});
	const devices =
		directory.isSuccess && binding.data?.services.includes(serviceId)
			? directory.data.devices
			: [];
	const device = devices.find((item) => item.ref === deviceRef);
	const runtime = device?.runtimes.find((item) => item.ref === runtimeRef);
	const save = useMutation({
		mutationFn: async (target: Selection | null) => {
			if (!binding.data) throw Error("请先读取绑定。");
			const { data, response } = await setAgentPersonalRuntimeV2({
				path: { agentId },
				body: { expectedRevision: binding.data.revision, target },
			});
			if (!response?.ok)
				throw Error(
					response?.status === 409
						? "绑定或共享范围已变化。请核对最新配置，个人 Runtime 仅可绑定到本人独享的 Agent。"
						: "未能保存绑定，请核对设备归属和权限。",
				);
			return PersonalRuntimeBindingView.parse(data);
		},
		onSuccess: (data) => {
			client.setQueryData(key, data);
			setDraft(undefined);
		},
		onError: () => void binding.refetch(),
	});
	if (binding.isPending) return null;
	if (binding.isError)
		return <Alert tone="warn">无法读取个人 Runtime 绑定。</Alert>;
	if (!saved && binding.data.services.length === 0) return null;
	const savedDevice =
		saved?.serviceId === serviceId
			? devices.find((item) => item.ref === saved.deviceRef)
			: undefined;
	const savedRuntime = savedDevice?.runtimes.find(
		(item) => item.ref === saved?.runtimeRef,
	);
	return (
		<section className="grid gap-3" aria-label="个人 Runtime">
			<h2>个人 Runtime</h2>
			{saved && (
				<p>
					已绑定 {saved.serviceId} · {saved.deviceName}（{saved.deviceRef}） ·{" "}
					{saved.runtimeName}（{saved.runtimeRef}）
					{saved.serviceId === serviceId
						? " · " +
							deviceStatus[savedDevice?.status ?? "unknown"] +
							" · " +
							runtimeStatus[savedRuntime?.status ?? "unknown"]
						: ""}
				</p>
			)}
			<Label htmlFor="personal-runtime-service">执行服务</Label>
			<NativeSelect
				id="personal-runtime-service"
				value={serviceId}
				disabled={save.isPending}
				onChange={(e) =>
					setDraft({ serviceId: e.target.value, deviceRef: "", runtimeRef: "" })
				}
			>
				<NativeSelectOption value="">请选择服务</NativeSelectOption>
				{saved && !binding.data.services.includes(saved.serviceId) && (
					<NativeSelectOption value={saved.serviceId}>
						{saved.serviceId}（未启用）
					</NativeSelectOption>
				)}
				{binding.data.services.map((id) => (
					<NativeSelectOption key={id} value={id}>
						{id}
					</NativeSelectOption>
				))}
			</NativeSelect>
			<Label htmlFor="personal-runtime-device">我的设备</Label>
			<NativeSelect
				id="personal-runtime-device"
				value={device?.ref ?? ""}
				disabled={save.isPending || !devices.length}
				onChange={(e) =>
					setDraft({ serviceId, deviceRef: e.target.value, runtimeRef: "" })
				}
			>
				<NativeSelectOption value="">请选择设备</NativeSelectOption>
				{devices.map((item) => (
					<NativeSelectOption key={item.ref} value={item.ref}>
						{item.displayName}（{item.ref}） · {deviceStatus[item.status]}
					</NativeSelectOption>
				))}
			</NativeSelect>
			<Label htmlFor="personal-runtime-target">设备上的 Runtime</Label>
			<NativeSelect
				id="personal-runtime-target"
				value={runtime?.ref ?? ""}
				disabled={save.isPending || !device}
				onChange={(e) =>
					setDraft({ serviceId, deviceRef, runtimeRef: e.target.value })
				}
			>
				<NativeSelectOption value="">请选择 Runtime</NativeSelectOption>
				{device?.runtimes.map((item) => (
					<NativeSelectOption key={item.ref} value={item.ref}>
						{item.displayName}（{item.ref}） · {runtimeStatus[item.status]}
					</NativeSelectOption>
				))}
			</NativeSelect>
			{runtime && (
				<p>
					能力 ·{" "}
					{runtime.capabilities
						.map((action) => actionLabel[action])
						.join("、") || "无"}
				</p>
			)}
			{directory.isFetching && <p role="status">正在读取设备…</p>}
			{directory.isSuccess && !devices.length && (
				<p>当前服务没有已关联的设备。</p>
			)}
			{directory.isError && (
				<Alert tone="warn">
					无法读取本人设备。
					<Button type="button" onClick={() => void directory.refetch()}>
						重试
					</Button>
				</Alert>
			)}
			<div className="flex gap-2">
				<Button
					type="button"
					disabled={
						save.isPending ||
						!draft ||
						!runtime?.capabilities.includes("execute")
					}
					onClick={() => save.mutate({ serviceId, deviceRef, runtimeRef })}
				>
					保存个人 Runtime
				</Button>
				{saved && (
					<Button
						type="button"
						disabled={save.isPending}
						onClick={() => save.mutate(null)}
					>
						解除绑定
					</Button>
				)}
			</div>
			{save.isError && <Alert tone="warn">{save.error.message}</Alert>}
		</section>
	);
}
