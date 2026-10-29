import {
	EvaluationDatasetContentV1Schema,
	EvaluationDatasetPageV1Schema,
} from "@agent-infra/contracts/pilot";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import {
	confirmEvaluationContentV1,
	createEvaluationDatasetV1,
	deleteEvaluationContentV1,
	grantEvaluationPurposeV1,
	listEvaluationDatasetsV1,
	readEvaluationContentV1,
	reserveEvaluationVersionV1,
	revokeEvaluationPurposeV1,
	uploadEvaluationContentV1,
} from "../../pilot/generated-v2/sdk.gen.js";
import { DirectoryPicker } from "../directory-fields.js";

type Page = ReturnType<typeof EvaluationDatasetPageV1Schema.parse>;
const purposeOptions = [
	{ id: "import", label: "导入" },
	{ id: "read", label: "读取内容" },
	{ id: "run", label: "运行" },
	{ id: "score", label: "评分" },
	{ id: "review", label: "独立复核" },
	{ id: "analyze", label: "分析" },
	{ id: "manage_grants", label: "管理授权" },
	{ id: "delete", label: "删除" },
] as const;
export function EvaluationDatasets({
	selectedVersion,
	onRun,
	currentUserId,
}: {
	selectedVersion?: { datasetId: string; versionId: string } | null;
	onRun?: (datasetId: string, versionId: string) => void;
	currentUserId?: string;
} = {}) {
	const readGeneration = useRef(0);
	const mounted = useRef(true);
	const commandInFlight = useRef(false);
	const intentKey = useRef(crypto.randomUUID());
	const pendingIntent = useRef<
		(() => Promise<{ error?: unknown; response?: Response }>) | null
	>(null);
	const [uncertain, setUncertain] = useState(false);
	const [page, setPage] = useState<Page | null>(null);
	const [message, setMessage] = useState("");
	const [busy, setBusy] = useState(false);
	const [name, setName] = useState("");
	const [scope, setScope] = useState("");
	const [recipient, setRecipient] = useState("");
	const [expiresAt, setExpiresAt] = useState("");
	const [application, setApplication] = useState(false);
	const [versionId, setVersionId] = useState("");
	const [selectedDatasetId, setSelectedDatasetId] = useState("");
	const [operations, setOperations] = useState<
		Array<(typeof purposeOptions)[number]["id"]>
	>(["import", "read", "delete"]);
	useEffect(() => {
		if (selectedVersion) {
			setSelectedDatasetId(selectedVersion.datasetId);
			setVersionId(selectedVersion.versionId);
		}
	}, [selectedVersion]);
	const [json, setJson] = useState("");
	const [content, setContent] = useState("");
	const reload = useCallback(async () => {
		const generation = ++readGeneration.current;
		setContent("");
		setPage(null);
		if (!commandInFlight.current) setBusy(false);
		const r = await listEvaluationDatasetsV1({
			responseStyle: "fields",
			throwOnError: false,
		});
		if (generation !== readGeneration.current) return;
		const data = EvaluationDatasetPageV1Schema.safeParse(r.data);
		if (!data.success) {
			setPage(null);
			throw new Error(
				"评测未配置、权限已变更或服务暂不可用，请联系授权管理者并刷新。",
			);
		}
		setPage(data.data);
	}, []);
	useEffect(() => {
		mounted.current = true;
		void reload().catch((e) => {
			if (mounted.current) setMessage(e.message);
		});
		return () => {
			mounted.current = false;
			readGeneration.current++;
		};
	}, [reload]);
	async function command(
		run: () => Promise<{ error?: unknown; response?: Response }>,
	) {
		if (commandInFlight.current || !mounted.current) return;
		commandInFlight.current = true;
		pendingIntent.current = run;
		setBusy(true);
		readGeneration.current++;
		setMessage("");
		setContent("");
		try {
			const r = await run();
			if (!mounted.current) return;
			if (r.error) {
				if (
					!uncertain &&
					r.response &&
					[400, 401, 403, 404, 409].includes(r.response.status)
				) {
					pendingIntent.current = null;
					intentKey.current = crypto.randomUUID();
					setUncertain(false);
					setMessage("操作已被拒绝，请检查当前授权、输入或版本修订后重试。");
					return;
				}
				throw new Error();
			}
			pendingIntent.current = null;
			intentKey.current = crypto.randomUUID();
			setUncertain(false);
			await reload().catch(() =>
				setMessage("操作已完成，但列表刷新失败，请手动刷新。"),
			);
		} catch {
			if (!mounted.current) return;
			setUncertain(true);
			setMessage(
				"操作未确认；刷新不会解除待确认状态。可使用同一请求标识重放原操作，不会自动重试写入。",
			);
		} finally {
			commandInFlight.current = false;
			if (mounted.current) setBusy(false);
		}
	}
	const headers = () => ({ "Idempotency-Key": intentKey.current });
	const options = {
		responseStyle: "fields" as const,
		throwOnError: false as const,
	};
	return (
		<section aria-labelledby="evaluation-data-heading" className="space-y-4">
			<h2 id="evaluation-data-heading">评测集与用途授权</h2>
			{message && (
				<Alert tone="danger" role="alert">
					<AlertDescription>{message}</AlertDescription>
				</Alert>
			)}
			<Button onClick={() => void reload().catch((e) => setMessage(e.message))}>
				刷新评测集
			</Button>
			{uncertain && (
				<Button
					disabled={busy}
					onClick={() => {
						const run = pendingIntent.current;
						if (run) void command(run);
					}}
				>
					重放原操作
				</Button>
			)}
			<form
				className="space-y-2"
				onSubmit={(e) => {
					e.preventDefault();
					void command(() =>
						createEvaluationDatasetV1({
							...options,
							body: { name, scope },
							headers: headers(),
						}),
					);
				}}
			>
				<Label htmlFor="eval-name">评测集名称</Label>
				<Input
					id="eval-name"
					value={name}
					onChange={(e) => setName(e.target.value)}
				/>
				<Label htmlFor="eval-scope">部署批准的范围</Label>
				<Input
					id="eval-scope"
					value={scope}
					onChange={(e) => setScope(e.target.value)}
				/>
				<Button type="submit" disabled={busy || uncertain || !name || !scope}>
					创建空评测集
				</Button>
			</form>
			<p>
				导入 JSON 须包含部署批准的
				provenance.approvalId；真实材料还须由部署记录脱敏确认。创建和预留版本不授予内容访问权。授权管理者须显式授予该版本的导入、读取或删除操作。
			</p>
			{page?.items.length === 0 && <p>当前没有可见评测集。</p>}
			{page?.items.map((dataset) => (
				<section
					key={dataset.datasetId}
					className="min-w-0 space-y-3 break-words rounded border p-4"
					aria-label={dataset.name}
				>
					<h3>{dataset.name}</h3>
					<p>
						范围：{dataset.scope}；修订：{dataset.revision}
					</p>
					<Button
						disabled={busy || uncertain}
						onClick={() =>
							void command(() =>
								reserveEvaluationVersionV1({
									...options,
									path: { datasetId: dataset.datasetId },
									body: {
										expectedRevision: dataset.revision,
										sourceVersionId: null,
									},
									headers: headers(),
								}),
							)
						}
					>
						预留新版本
					</Button>
					{dataset.versions.map((version) => (
						<div key={version.versionId} className="space-y-2">
							<p>
								版本 {version.versionId} · {version.status} · 到期{" "}
								{version.expiresAt}
							</p>
							<Button
								variant="outline"
								disabled={busy || uncertain}
								onClick={() => {
									setSelectedDatasetId(dataset.datasetId);
									setVersionId(version.versionId);
								}}
							>
								选择此版本
							</Button>
							<Button
								variant="outline"
								disabled={busy || uncertain}
								aria-label={`基于版本 ${version.versionId} 创建新版本`}
								onClick={() =>
									void command(() =>
										reserveEvaluationVersionV1({
											...options,
											path: { datasetId: dataset.datasetId },
											body: {
												expectedRevision: dataset.revision,
												sourceVersionId: version.versionId,
											},
											headers: headers(),
										}),
									)
								}
							>
								基于此版本创建新版本
							</Button>
							{onRun && (
								<Button
									variant="outline"
									disabled={busy || uncertain || version.status !== "available"}
									aria-label={`运行版本 ${version.versionId}`}
									onClick={() => onRun(dataset.datasetId, version.versionId)}
								>
									用此版本运行实验
								</Button>
							)}
							<Button
								variant="outline"
								disabled={busy || uncertain || version.status !== "available"}
								onClick={() => {
									setBusy(true);
									const generation = ++readGeneration.current;
									setContent("");
									void readEvaluationContentV1({
										...options,
										path: {
											datasetId: dataset.datasetId,
											versionId: version.versionId,
										},
									})
										.then((r) => {
											const parsed = EvaluationDatasetContentV1Schema.safeParse(
												r.data,
											);
											if (!parsed.success) throw new Error();
											if (generation === readGeneration.current)
												setContent(JSON.stringify(parsed.data, null, 2));
										})
										.catch(() => {
											if (generation !== readGeneration.current) return;
											setContent("");
											setMessage("内容不可用或用途授权已撤销。");
										})
										.finally(() => {
											if (generation === readGeneration.current) setBusy(false);
										});
								}}
							>
								读取内容
							</Button>
							<Button
								variant="outline"
								disabled={busy || uncertain || version.status !== "uploading"}
								onClick={() =>
									void command(() =>
										confirmEvaluationContentV1({
											...options,
											path: {
												datasetId: dataset.datasetId,
												versionId: version.versionId,
											},
										}),
									)
								}
							>
								核实上传
							</Button>
							<ConfirmDialog
								disabled={
									busy ||
									uncertain ||
									version.status === "deleted" ||
									version.status === "deleting"
								}
								trigger={<Button variant="outline">删除内容</Button>}
								title="删除这个评测版本的内容？"
								subject={{ name: version.versionId }}
								description="内容会立即变为不可读取，并按部署政策清理。此操作不会删除其他业务任务。"
								confirmLabel="确认删除"
								onConfirm={() =>
									void command(() =>
										deleteEvaluationContentV1({
											...options,
											path: {
												datasetId: dataset.datasetId,
												versionId: version.versionId,
											},
											body: { expectedRevision: version.revision },
											headers: headers(),
										}),
									)
								}
							/>
						</div>
					))}
					<form
						className="space-y-2"
						onSubmit={(e) => {
							e.preventDefault();

							void command(() =>
								grantEvaluationPurposeV1({
									...options,
									path: { datasetId: dataset.datasetId },
									body: {
										expectedRevision: dataset.revision,
										principal: {
											kind: application ? "application" : "user",
											id: recipient,
										},
										versionIds: [versionId],
										operations: [...operations],
										expiresAt,
									},
									headers: headers(),
								}),
							);
						}}
					>
						<Label htmlFor={`version-${dataset.datasetId}`}>
							待授权或导入版本
						</Label>
						<NativeSelect
							id={`version-${dataset.datasetId}`}
							value={selectedDatasetId === dataset.datasetId ? versionId : ""}
							disabled={busy || uncertain}
							onChange={(e) => {
								setSelectedDatasetId(dataset.datasetId);
								setVersionId(e.target.value);
							}}
						>
							<option value="">选择此评测集版本</option>
							{dataset.versions.map((v) => (
								<option key={v.versionId} value={v.versionId}>
									{v.versionId} · {v.status}
								</option>
							))}
						</NativeSelect>
						{application ? (
							<>
								<Label htmlFor={`recipient-${dataset.datasetId}`}>
									已登记应用的稳定 ID
								</Label>
								<Input
									id={`recipient-${dataset.datasetId}`}
									value={recipient}
									disabled={busy || uncertain}
									onChange={(e) => setRecipient(e.target.value)}
								/>
							</>
						) : (
							<DirectoryPicker
								id={`recipient-${dataset.datasetId}`}
								label="授权接收用户"
								help="从目录选择一名用户；授予用途不改变其 Agent 使用权。"
								kind="user"
								value={recipient}
								disabled={busy || uncertain}
								closeOnSelect
								onChange={(_value, selection) =>
									setRecipient(selection.at(-1)?.id ?? "")
								}
							/>
						)}
						{!application && currentUserId && (
							<Button
								variant="outline"
								disabled={busy || uncertain}
								onClick={() => setRecipient(currentUserId)}
							>
								选择当前用户
							</Button>
						)}
						<Button
							type="button"
							variant="outline"
							onClick={() => {
								setApplication(!application);
								setRecipient("");
							}}
						>
							主体类型：{application ? "应用" : "用户"}
						</Button>
						<fieldset
							className="grid gap-3 sm:grid-cols-2"
							disabled={busy || uncertain}
						>
							<legend>明确授予的用途</legend>
							{purposeOptions.map((p) => (
								<Label
									className="flex min-h-11 items-center gap-3"
									key={p.id}
									htmlFor={`eval-purpose-${dataset.datasetId}-${p.id}`}
								>
									<Checkbox
										id={`eval-purpose-${dataset.datasetId}-${p.id}`}
										checked={operations.includes(p.id)}
										onCheckedChange={(checked) =>
											setOperations((v) =>
												checked ? [...v, p.id] : v.filter((id) => id !== p.id),
											)
										}
									/>
									{p.label}
								</Label>
							))}
						</fieldset>
						<Label htmlFor={`expiry-${dataset.datasetId}`}>
							授权到期时间（UTC ISO）
						</Label>
						<Input
							id={`expiry-${dataset.datasetId}`}
							value={expiresAt}
							onChange={(e) => setExpiresAt(e.target.value)}
						/>
						<Button
							type="submit"
							disabled={
								busy ||
								uncertain ||
								!recipient ||
								!versionId ||
								selectedDatasetId !== dataset.datasetId ||
								!operations.length ||
								!expiresAt
							}
						>
							显式授予用途权限
						</Button>
					</form>
					{dataset.grants.map((g) => (
						<div key={g.grantId}>
							<span className="break-all">
								{g.principal.kind}:{g.principal.id} · {g.operations.join(", ")}{" "}
								· {g.revoked ? "已撤销" : "有效期至"} {g.expiresAt}
							</span>
							<Button
								variant="outline"
								disabled={busy || uncertain || g.revoked}
								onClick={() =>
									void command(() =>
										revokeEvaluationPurposeV1({
											...options,
											path: {
												datasetId: dataset.datasetId,
												grantId: g.grantId,
											},
											body: { expectedRevision: g.revision },
											headers: headers(),
										}),
									)
								}
							>
								撤销授权
							</Button>
						</div>
					))}
					<form
						className="space-y-2"
						onSubmit={(e) => {
							e.preventDefault();
							let parsed: ReturnType<
								typeof EvaluationDatasetContentV1Schema.parse
							>;
							try {
								parsed = EvaluationDatasetContentV1Schema.parse(
									JSON.parse(json),
								);
							} catch {
								setMessage(
									"请提供有效的样本、判定标准及部署批准的 provenance.approvalId。",
								);
								return;
							}
							void command(() =>
								uploadEvaluationContentV1({
									...options,
									path: { datasetId: dataset.datasetId, versionId },
									body: parsed,
									headers: headers(),
								}),
							);
						}}
					>
						<Label htmlFor={`import-${dataset.datasetId}`}>
							获准的样本与判定标准 JSON
						</Label>
						<Textarea
							id={`import-${dataset.datasetId}`}
							value={json}
							onChange={(e) => setJson(e.target.value)}
						/>
						<Button
							type="submit"
							disabled={
								busy ||
								uncertain ||
								!versionId ||
								selectedDatasetId !== dataset.datasetId ||
								!json
							}
						>
							导入所选版本
						</Button>
					</form>
				</section>
			))}
			{content && (
				<section aria-label="已授权评测内容">
					<pre className="whitespace-pre-wrap break-words">{content}</pre>
					<Button
						onClick={() => {
							readGeneration.current++;
							setContent("");
						}}
					>
						关闭内容
					</Button>
				</section>
			)}
		</section>
	);
}
