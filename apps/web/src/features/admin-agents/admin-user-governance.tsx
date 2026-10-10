import { useEffect, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
	getPlatformUserDisabledV2,
	setPlatformUserDisabledV2,
} from "../../pilot/generated-v2/sdk.gen.js";
import { DirectoryPicker } from "../directory-fields.js";

type DisableStatus = "loading" | "disabled" | "enabled" | "unavailable";

function oneUser(value: string) {
	return (
		value
			.split(/\n|,/u)
			.map((item) => item.trim())
			.filter(Boolean)
			.at(-1) ?? ""
	);
}

export function AdminUserGovernance() {
	const [userId, setUserId] = useState("");
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState("");
	const [status, setStatus] = useState<DisableStatus | undefined>();
	const generation = useRef(0);

	useEffect(() => {
		const attempt = ++generation.current;
		setMessage("");
		if (!userId) {
			setStatus(undefined);
			return;
		}
		setStatus("loading");
		void getPlatformUserDisabledV2({
			path: { userId },
			responseStyle: "fields",
			throwOnError: false,
		})
			.then((result) => {
				if (attempt !== generation.current) return;
				if (result.response?.status !== 200 || !result.data) {
					setStatus("unavailable");
					return;
				}
				setStatus(result.data.disabled ? "disabled" : "enabled");
			})
			.catch(() => {
				if (attempt === generation.current) setStatus("unavailable");
			});
	}, [userId]);

	async function updateDisabled(disabled: boolean) {
		const targetUserId = userId.trim();
		if (!targetUserId || busy) return;
		setBusy(true);
		setMessage("");
		try {
			const result = await setPlatformUserDisabledV2({
				path: { userId: targetUserId },
				body: { schemaVersion: 1, disabled },
				responseStyle: "fields",
				throwOnError: false,
			});
			if (result.response?.status !== 200 || !result.data)
				throw new Error("request failed");
			setStatus(result.data.disabled ? "disabled" : "enabled");
			setMessage(
				`${disabled ? "禁用" : "解除禁用"}已确认；当前状态：${
					result.data.disabled ? "已禁用" : "未禁用"
				}；审计结果：${
					result.data.auditOutcome === "recorded"
						? "已记录"
						: "状态未变化，未新增记录"
				}。`,
			);
		} catch {
			setMessage("操作未确认，请刷新目录记录后重试。未显示上游错误详情。");
		} finally {
			setBusy(false);
		}
	}

	return (
		<section
			aria-labelledby="admin-user-governance-heading"
			className="detail-section space-y-4 border-border border-t pt-5"
		>
			<div>
				<h2
					id="admin-user-governance-heading"
					className="font-semibold text-foreground text-sm"
				>
					员工访问控制
				</h2>
				<p className="mt-1 text-muted-foreground text-sm">
					从当前服务端目录选择员工后执行禁用或解除禁用。页面不显示或保存凭证，最终权限由服务端重新判断。
				</p>
			</div>
			<DirectoryPicker
				describedBy="admin-user-governance-help"
				help="使用当前目录记录选择员工"
				id="admin-user-governance-user"
				kind="user"
				label="员工"
				onChange={(value) => setUserId(oneUser(value))}
				value={userId}
			/>
			<p
				id="admin-user-governance-help"
				className="text-muted-foreground text-xs"
			>
				{status === "loading"
					? "当前状态：读取中…"
					: status === "disabled"
						? "当前状态：已禁用"
						: status === "enabled"
							? "当前状态：未禁用"
							: status === "unavailable"
								? "当前状态暂时无法确认，请刷新后重试。"
								: "选择员工后读取当前服务端状态。"}
			</p>
			<div className="flex flex-wrap gap-3">
				<Button
					disabled={busy || !userId}
					onClick={() => void updateDisabled(true)}
					variant="destructive"
				>
					{busy ? "提交中…" : "禁用员工"}
				</Button>
				<Button
					disabled={busy || !userId}
					onClick={() => void updateDisabled(false)}
					variant="outline"
				>
					解除禁用
				</Button>
			</div>
			{message ? (
				<Alert role="status">
					<AlertDescription>{message}</AlertDescription>
				</Alert>
			) : null}
		</section>
	);
}
