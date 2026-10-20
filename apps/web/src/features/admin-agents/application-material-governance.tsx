import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { FormSection } from "@/components/ui/form-section";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	NativeSelect,
	NativeSelectOption,
} from "@/components/ui/native-select";
import {
	grantApplicationMaterialV2,
	readApplicationMaterialV2,
	revokeApplicationMaterialV2,
} from "../../pilot/generated-v2/sdk.gen.js";
import type { ReadApplicationMaterialV2Responses } from "../../pilot/generated-v2/types.gen.js";

type MaterialMetadata = ReadApplicationMaterialV2Responses[200]["metadata"];
type MaterialStatus =
	| "loading"
	| "active"
	| "revoked"
	| "absent"
	| "unavailable";

export function ApplicationMaterialGovernance() {
	const [applicationId, setApplicationId] = useState("");
	const [principalType, setPrincipalType] = useState<"user" | "application">(
		"user",
	);
	const [principalId, setPrincipalId] = useState("");
	const [metadata, setMetadata] = useState<MaterialMetadata>();
	const [status, setStatus] = useState<MaterialStatus>();
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState("");

	useEffect(() => {
		const application = applicationId.trim();
		const principal = principalId.trim();
		if (!application || !principal) {
			setMetadata(undefined);
			setStatus(undefined);
			setMessage("");
			return;
		}
		let cancelled = false;
		setStatus("loading");
		setMetadata(undefined);
		setMessage("");
		void readApplicationMaterialV2({
			path: {
				applicationId: application,
				principalType,
				principalId: principal,
			},
			responseStyle: "fields",
			throwOnError: false,
		}).then((result) => {
			if (cancelled) return;
			if (result.response?.status === 200 && result.data) {
				setMetadata(result.data.metadata);
				setStatus(result.data.metadata.revokedAt ? "revoked" : "active");
			} else if (result.response?.status === 404) {
				setStatus("absent");
			} else {
				setStatus("unavailable");
			}
		});
		return () => {
			cancelled = true;
		};
	}, [applicationId, principalId, principalType]);

	async function grant() {
		if (busy || !applicationId.trim() || !principalId.trim()) return;
		setBusy(true);
		setMessage("");
		try {
			const result = await grantApplicationMaterialV2({
				path: { applicationId: applicationId.trim() },
				body: { principalType, principalId: principalId.trim() },
				responseStyle: "fields",
				throwOnError: false,
			});
			if (result.response?.status !== 201 || !result.data)
				throw new Error("request failed");
			setMetadata(result.data.metadata);
			setStatus(result.data.metadata.revokedAt ? "revoked" : "active");
			setMessage(
				result.data.replayed ? "授权已幂等重放。" : "材料授权已确认。 ",
			);
		} catch {
			setStatus("unavailable");
			setMessage("授权未确认，请重新读取当前授权后重试。未显示凭证材料。 ");
		} finally {
			setBusy(false);
		}
	}

	async function revoke() {
		if (busy || !metadata || status !== "active") return;
		setBusy(true);
		setMessage("");
		try {
			const result = await revokeApplicationMaterialV2({
				path: {
					applicationId: applicationId.trim(),
					principalType,
					principalId: principalId.trim(),
				},
				body: {
					expectedRevision: metadata.authorizationRevision,
					status: "revoked",
				},
				responseStyle: "fields",
				throwOnError: false,
			});
			if (result.response?.status !== 200 || !result.data)
				throw new Error("request failed");
			setMetadata(result.data.metadata);
			setStatus("revoked");
			setMessage(
				result.data.replayed ? "撤销已幂等重放。" : "材料授权已撤销。 ",
			);
		} catch {
			setStatus("unavailable");
			setMessage("撤销未确认，请重新读取当前授权后重试。 ");
		} finally {
			setBusy(false);
		}
	}

	return (
		<FormSection
			title="应用凭证材料授权"
			description="系统管理员可按明确的应用与接收主体 ID 授权或撤销材料。页面只显示授权 metadata，不显示凭证材料。"
		>
			<div className="mt-4 grid gap-3 md:grid-cols-3">
				<Field>
					<Label htmlFor="material-application-id">应用 ID</Label>
					<Input
						id="material-application-id"
						value={applicationId}
						disabled={busy}
						onChange={(event) => setApplicationId(event.target.value)}
					/>
				</Field>
				<Field>
					<Label htmlFor="material-principal-type">接收主体类型</Label>
					<NativeSelect
						id="material-principal-type"
						value={principalType}
						disabled={busy}
						onChange={(event) =>
							setPrincipalType(event.target.value as "user" | "application")
						}
					>
						<NativeSelectOption value="user">用户</NativeSelectOption>
						<NativeSelectOption value="application">应用</NativeSelectOption>
					</NativeSelect>
				</Field>
				<Field>
					<Label htmlFor="material-principal-id">接收主体 ID</Label>
					<Input
						id="material-principal-id"
						value={principalId}
						disabled={busy}
						onChange={(event) => setPrincipalId(event.target.value)}
					/>
				</Field>
			</div>
			<p className="governance-status">
				{status === "loading"
					? "当前授权：读取中…"
					: status === "active"
						? "当前授权：有效"
						: status === "revoked"
							? "当前授权：已撤销"
							: status === "absent"
								? "当前授权：未找到"
								: status === "unavailable"
									? "当前授权：暂时无法确认"
									: "填写应用和接收主体 ID 后读取当前授权。"}
			</p>
			<div className="governance-actions">
				<Button
					disabled={
						busy ||
						status === "loading" ||
						!applicationId.trim() ||
						!principalId.trim()
					}
					onClick={() => void grant()}
				>
					授权材料
				</Button>
				<Button
					variant="outline"
					disabled={busy || status !== "active"}
					onClick={() => void revoke()}
				>
					撤销材料授权
				</Button>
			</div>
			{message ? (
				// 失败（status 变为 unavailable）用 role="alert"，确认结果用 role="status"。
				<Alert
					tone={status === "unavailable" ? "danger" : "info"}
					role={status === "unavailable" ? "alert" : "status"}
					className="mt-4"
				>
					<AlertDescription>{message}</AlertDescription>
				</Alert>
			) : null}
		</FormSection>
	);
}
