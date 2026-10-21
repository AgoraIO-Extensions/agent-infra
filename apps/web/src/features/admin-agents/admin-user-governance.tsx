import { useEffect, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FormSection } from "@/components/ui/form-section";
import { withObjectName } from "@/lib/accessible-name";
import {
	getPlatformUserDisabledV2,
	setPlatformUserDisabledV2,
} from "../../pilot/generated-v2/sdk.gen.js";
import { DirectoryPicker, DirectoryRecords } from "../directory-fields.js";

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
	// 禁用触发按钮的可访问名称带上所选员工姓名（F-11），统一为「禁用员工：{姓名}」；
	// 未解析的目录记录不写进名称。
	const [userName, setUserName] = useState("");
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState("");
	const [failed, setFailed] = useState(false);
	const [status, setStatus] = useState<DisableStatus | undefined>();
	const generation = useRef(0);
	// 确认后触发器会因提交中而禁用，焦点回到本区块标题而不是 body。
	const heading = useRef<HTMLHeadingElement>(null);

	useEffect(() => {
		const attempt = ++generation.current;
		setMessage("");
		if (!userId) {
			setStatus(undefined);
			return;
		}
		setFailed(false);
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
		const attempt = ++generation.current;
		setBusy(true);
		setMessage("");
		setFailed(false);
		try {
			const result = await setPlatformUserDisabledV2({
				path: { userId: targetUserId },
				body: { schemaVersion: 1, disabled },
				responseStyle: "fields",
				throwOnError: false,
			});
			if (result.response?.status !== 200 || !result.data)
				throw new Error("request failed");
			if (attempt !== generation.current) return;
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
			if (attempt === generation.current) {
				setStatus("unavailable");
				setFailed(true);
				setMessage("操作未确认，请刷新目录记录后重试。未显示上游错误详情。");
			}
		} finally {
			setBusy(false);
		}
	}

	return (
		<FormSection
			title="员工访问控制"
			description="从当前服务端目录选择员工后执行禁用或解除禁用。页面不显示或保存凭证，最终权限由服务端重新判断。"
			headingRef={heading}
		>
			<div className="mt-4">
				<DirectoryPicker
					describedBy="admin-user-governance-help"
					help="使用当前目录记录选择员工"
					id="admin-user-governance-user"
					kind="user"
					label="员工"
					closeOnSelect
					onChange={(value, selection) => {
						setUserId(oneUser(value));
						// selection 与 value 同序，最后一项即当前员工。
						const selected = selection.at(-1);
						setUserName(selected?.resolved ? selected.name : "");
					}}
					value={userId}
				/>
			</div>
			<p id="admin-user-governance-help" className="governance-status">
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
			<div className="governance-actions">
				{/* 禁用会立即终止对方的平台访问，先确认对象与后果；解除禁用直接提交。 */}
				<ConfirmDialog
					disabled={busy || status === "loading" || !userId}
					trigger={
						<Button
							variant="outline"
							aria-label={withObjectName(
								busy ? "提交中…" : "禁用员工",
								userName,
							)}
						>
							{busy ? "提交中…" : "禁用员工"}
						</Button>
					}
					title="禁用这名员工？"
					subject={{
						name: (
							<DirectoryRecords
								targets={userId ? [{ kind: "user", userId }] : []}
								empty="未选择员工"
							/>
						),
					}}
					description="禁用后对方立即不能登录平台，也不能通过平台入口使用或管理 Agent；进行中的任务会收到取消请求。之后可以「解除禁用」恢复资格，已取消的任务不会恢复。"
					confirmLabel="禁用员工"
					finalFocus={heading}
					onConfirm={() => void updateDisabled(true)}
				/>
				<Button
					disabled={busy || status === "loading" || !userId}
					onClick={() => void updateDisabled(false)}
					variant="outline"
				>
					解除禁用
				</Button>
			</div>
			{message ? (
				<Alert
					tone={failed ? "danger" : "info"}
					role={failed ? "alert" : "status"}
					className="mt-4"
				>
					<AlertDescription>{message}</AlertDescription>
				</Alert>
			) : null}
		</FormSection>
	);
}
