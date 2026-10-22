import { skillHubProjectContentLimitsV1 } from "@agent-infra/contracts/pilot";
import { Link } from "@tanstack/react-router";
import { Plus, X } from "lucide-react";
import {
	type FormEvent,
	type ReactNode,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { FormSection } from "@/components/ui/form-section";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	NativeSelect,
	NativeSelectOption,
} from "@/components/ui/native-select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { withObjectName } from "@/lib/accessible-name";
import type {
	SkillHubProjectContentV1,
	SkillHubProjectV1,
	SkillHubPublicationResponseV1,
} from "../../pilot/generated-v2/types.gen.js";
import type { CollectionReadUnavailable } from "../collection-read-failure.js";
import { skillHubVisibilityLabels } from "./skill-hub-labels.js";
import {
	publishSkillHubProjectVersion,
	saveSkillHubProjectContent,
} from "./skill-hub-management.js";
import { SkillHubStateChip } from "./skill-hub-scope-pill.js";
import { SkillHubLoading, SkillHubReadFailure } from "./skill-hub-screen.js";

export type SkillProjectContentState =
	| { kind: "loading" }
	| { kind: "ready"; content: SkillHubProjectContentV1 }
	| CollectionReadUnavailable;

export type SkillProjectContentActions = {
	saveContent: typeof saveSkillHubProjectContent;
	publishVersion: typeof publishSkillHubProjectVersion;
};

const defaultActions: SkillProjectContentActions = {
	saveContent: saveSkillHubProjectContent,
	publishVersion: publishSkillHubProjectVersion,
};

const directories = ["scripts", "references", "assets"] as const;
type Directory = (typeof directories)[number];
const directoryLabels: Record<Directory, string> = {
	scripts: "scripts/ 脚本",
	references: "references/ 参考资料",
	assets: "assets/ 资源",
};
// 与契约一致：目录内的相对路径，段内只允许字母、数字、点、短横线与下划线，不允许 . 或 ..。
const relativeName = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const visibilities = ["PRIVATE", "MEMBER", "ORGANIZATION", "MARKET"] as const;
type Visibility = (typeof visibilities)[number];
const encoder = new TextEncoder();
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

type DraftFile = {
	id: string;
	directory: Directory;
	name: string;
	encoding: "utf8" | "base64";
	content: string;
};
type Draft = { skillMd: string; files: DraftFile[] };
type Feedback = { tone: "status" | "alert"; text: string };
type RequestFailure = { status?: number; retryable?: boolean };

function failure(error: unknown): RequestFailure {
	return error && typeof error === "object" ? (error as RequestFailure) : {};
}

function bytesOf(file: { encoding: "utf8" | "base64"; content: string }) {
	if (file.encoding === "utf8") return encoder.encode(file.content).byteLength;
	const padding = file.content.endsWith("==")
		? 2
		: file.content.endsWith("=")
			? 1
			: 0;
	return (file.content.length / 4) * 3 - padding;
}

function formatBytes(value: number) {
	return value < 1024 ? `${value} B` : `${Math.round(value / 102.4) / 10} KB`;
}

function fromServer(content: SkillHubProjectContentV1): Draft {
	const skill = content.files.find((file) => file.path === "SKILL.md");
	return {
		skillMd: skill?.encoding === "utf8" ? skill.content : "",
		files: content.files
			.filter((file) => file.path !== "SKILL.md")
			.map((file) => {
				const [directory, ...rest] = file.path.split("/");
				return {
					id: crypto.randomUUID(),
					directory: directory as Directory,
					name: rest.join("/"),
					encoding: file.encoding,
					content: file.content,
				};
			}),
	};
}

function serialize(draft: Draft) {
	return JSON.stringify([
		draft.skillMd,
		draft.files.map((file) => [
			file.directory,
			file.name.trim(),
			file.encoding,
			file.content,
		]),
	]);
}

function toBody(draft: Draft, baseRevision: number) {
	return {
		schemaVersion: 1 as const,
		baseRevision,
		files: [
			{ path: "SKILL.md", encoding: "utf8" as const, content: draft.skillMd },
			...draft.files.map((file) => ({
				path: `${file.directory}/${file.name.trim()}`,
				encoding: file.encoding,
				content: file.content,
			})),
		],
	};
}

/** 上传的本地文件名按契约字符集规范化；不能编辑的二进制内容按 base64 保存。 */
function uploadedName(name: string) {
	const cleaned = name
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/^\.+$/, "");
	return cleaned || "file";
}

function contentFailureMessage(error: unknown) {
	const { status, retryable } = failure(error);
	if (status === 401) return "登录状态已失效，请重新登录后再试。";
	if (status === 403) return "当前账号不能修改这个项目，或项目已停用。";
	if (status === 409)
		return "内容已在其他地方修改。请重新读取后再编辑，未保存的修改会丢失。";
	if (status === 400) return "内容不符合要求，请检查文件路径、数量与大小。";
	if (status === 503 || retryable) return "暂时无法保存内容，可稍后重试。";
	return "保存内容失败，请稍后重试。";
}

function publishFailureMessage(error: unknown) {
	const { status, retryable } = failure(error);
	if (status === 401) return "登录状态已失效，请重新登录后再试。";
	if (status === 403)
		return "当前账号不能发布这个项目：项目可能已停用，或组织权限已变化。";
	if (status === 409)
		return "这个版本号已被使用，或内容已在其他地方修改。已提交的版本不能换包，修改内容请使用新的版本号。";
	if (status === 400)
		return "内容未通过检查（格式、大小或安全扫描），请修改后重新发布。";
	if (status === 503 || retryable) return "Skill 发布暂时不可用，可稍后重试。";
	return "发布失败，请稍后重试。";
}

function publishResultText(result: SkillHubPublicationResponseV1) {
	const { version, replayed } = result;
	const replay = replayed ? "这是重复提交，已返回第一次的结果。" : "";
	const text = {
		published: `v${version.version} 已发布，可以在 Skill Hub 中查看。`,
		pending_review: `v${version.version} 已提交审核，审核通过前不能安装。`,
		rejected: `v${version.version} 未通过审核。`,
		revoked: `v${version.version} 已撤销。`,
	}[version.state];
	return `${text}${replay}`;
}

/**
 * 「创建与发布」的项目内容编辑与网页发布（#2906）：编辑 SKILL.md 与 scripts/、references/、
 * assets/ 下的文件，按读取到的修订整体保存；发布只提交内容修订、版本号与范围，
 * 包、摘要与签名由服务端生成。按设计两栏布局（V-18）：左栏项目、内容与导入，右栏
 * 版本号、范围单选卡与「保存草稿 / 发布」。
 */
export function SkillProjectContentEditor({
	project,
	content,
	onRetry,
	retrying = false,
	onPublished,
	actions = defaultActions,
	before,
	after,
	notice,
}: {
	project: SkillHubProjectV1;
	content: SkillProjectContentState;
	/** 重新读取内容；返回的 Promise 完成后以服务端内容重新初始化草稿。 */
	onRetry?: () => unknown;
	retrying?: boolean;
	/** 发布成功后刷新本人版本等读取。 */
	onPublished?: () => void;
	actions?: SkillProjectContentActions;
	/** 左栏内容区之前的分区（项目信息）。 */
	before?: ReactNode;
	/** 左栏内容区之后的分区（导入固定来源）。 */
	after?: ReactNode;
	/** 右栏范围选择之后的静态说明（权限不会扩大）。 */
	notice?: ReactNode;
}) {
	const id = useId();
	const toast = useToast();
	const keys = useRef(new Map<string, { fingerprint: string; key: string }>());
	const skillMdInput = useRef<HTMLTextAreaElement>(null);
	const versionInput = useRef<HTMLInputElement>(null);
	const addFileButton = useRef<HTMLButtonElement>(null);
	const fileInputs = useRef(new Map<string, HTMLInputElement>());
	const [draft, setDraft] = useState<Draft>({ skillMd: "", files: [] });
	const [saved, setSaved] = useState<{ revision: number; snapshot: string }>();
	// 每次主动重新读取递增；草稿只在首次读到内容或重新读取完成后按服务端内容初始化。
	const [reload, setReload] = useState(0);
	const initialized = useRef(-1);
	const [conflict, setConflict] = useState(false);
	const [errors, setErrors] = useState<{
		skillMd?: string;
		files?: Record<string, string>;
		total?: string;
		version?: string;
	}>({});
	const [contentFeedback, setContentFeedback] = useState<Feedback>();
	const [publishFeedback, setPublishFeedback] = useState<Feedback>();
	const [publishResult, setPublishResult] =
		useState<SkillHubPublicationResponseV1>();
	const [busy, setBusy] = useState<"save" | "publish">();
	const [version, setVersion] = useState("");
	const [visibility, setVisibility] = useState<Visibility>("PRIVATE");

	// 首次读到内容、或冲突后重新读取完成时，以服务端内容为准初始化草稿。
	useEffect(() => {
		if (content.kind !== "ready" || initialized.current === reload) return;
		initialized.current = reload;
		const next = fromServer(content.content);
		setDraft(next);
		setSaved({ revision: content.content.revision, snapshot: serialize(next) });
		setErrors({});
	}, [content, reload]);

	function keyFor(scope: string, input: unknown) {
		const fingerprint = JSON.stringify(input);
		const previous = keys.current.get(scope);
		if (previous?.fingerprint === fingerprint) return previous.key;
		const key = crypto.randomUUID();
		keys.current.set(scope, { fingerprint, key });
		return key;
	}

	const ready = content.kind === "ready" && saved !== undefined;
	const dirty = ready && serialize(draft) !== saved.snapshot;
	const limits = skillHubProjectContentLimitsV1;
	const totalBytes =
		encoder.encode(draft.skillMd).byteLength +
		draft.files.reduce((sum, file) => sum + bytesOf(file), 0);

	function validateDraft() {
		const next: typeof errors = {};
		if (!draft.skillMd.trim())
			next.skillMd = "请填写 SKILL.md，说明用途和使用步骤。";
		else if (encoder.encode(draft.skillMd).byteLength > limits.maxFileBytes)
			next.skillMd = "SKILL.md 不能超过 256 KB。";
		const fileErrors: Record<string, string> = {};
		const paths = new Set<string>();
		for (const file of draft.files) {
			const name = file.name.trim();
			const path = `${file.directory}/${name}`;
			if (
				!relativeName.test(name) ||
				name.split("/").some((part) => part === "." || part === "..") ||
				encoder.encode(path).byteLength > 512
			)
				fileErrors[file.id] =
					"文件名只能使用字母、数字、点、短横线和下划线，可用 / 分隔子目录。";
			else if (paths.has(path)) fileErrors[file.id] = "文件路径重复。";
			else if (bytesOf(file) > limits.maxFileBytes)
				fileErrors[file.id] = "单个文件不能超过 256 KB。";
			paths.add(path);
		}
		for (const file of draft.files) {
			const path = `${file.directory}/${file.name.trim()}`;
			if (
				!fileErrors[file.id] &&
				[...paths].some((other) => other.startsWith(`${path}/`))
			)
				fileErrors[file.id] = "文件不能与子目录同名。";
		}
		if (Object.keys(fileErrors).length) next.files = fileErrors;
		if (draft.files.length + 1 > limits.maxFiles)
			next.total = `最多 ${limits.maxFiles} 个文件（含 SKILL.md）。`;
		else if (totalBytes > limits.maxTotalBytes)
			next.total = "所有文件合计不能超过 512 KB。";
		setErrors((current) => ({ ...next, version: current.version }));
		if (next.skillMd) {
			skillMdInput.current?.focus();
			return false;
		}
		const firstFile = draft.files.find((file) => fileErrors[file.id]);
		if (firstFile) {
			fileInputs.current.get(firstFile.id)?.focus();
			return false;
		}
		return !next.total;
	}

	/** 保存当前草稿；返回保存后的修订号，失败时返回 undefined。 */
	async function saveDraft(): Promise<number | undefined> {
		if (!saved) return undefined;
		const body = toBody(draft, saved.revision);
		try {
			const result = await actions.saveContent(
				project.projectId,
				body,
				keyFor("content-save", { projectId: project.projectId, body }),
			);
			keys.current.delete("content-save");
			setConflict(false);
			setSaved({ revision: result.revision, snapshot: serialize(draft) });
			setContentFeedback({
				tone: "status",
				text: `内容已保存（${result.fileCount} 个文件，${formatBytes(result.totalBytes)}）。`,
			});
			return result.revision;
		} catch (error) {
			setConflict(failure(error).status === 409);
			setContentFeedback({ tone: "alert", text: contentFailureMessage(error) });
			return undefined;
		}
	}

	async function submitContent(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (busy || !ready || !validateDraft()) return;
		setBusy("save");
		setContentFeedback(undefined);
		try {
			if (await saveDraft()) toast("Skill 内容已保存");
		} finally {
			setBusy(undefined);
		}
	}

	async function submitPublish(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (busy || !ready || !saved) return;
		const value = version.trim();
		if (!versionPattern.test(value)) {
			setErrors((current) => ({
				...current,
				version: "请填写版本号，例如 1.0.0；以字母或数字开头，最长 128 位。",
			}));
			versionInput.current?.focus();
			return;
		}
		setErrors((current) => ({ ...current, version: undefined }));
		if (!validateDraft()) return;
		setBusy("publish");
		setPublishFeedback(undefined);
		setPublishResult(undefined);
		try {
			// 有未保存的修改时先保存，再发布保存后的修订。
			let revision: number | undefined = saved.revision;
			if (dirty || revision === 0) {
				setContentFeedback(undefined);
				revision = await saveDraft();
				if (revision === undefined) {
					setPublishFeedback({
						tone: "alert",
						text: "内容没有保存，版本未发布。",
					});
					return;
				}
			}
			const body = {
				schemaVersion: 1 as const,
				contentRevision: revision,
				version: value,
				visibility,
			};
			const result = await actions.publishVersion(
				project.projectId,
				body,
				keyFor("project-publish", { projectId: project.projectId, body }),
			);
			keys.current.delete("project-publish");
			setPublishResult(result);
			setPublishFeedback({ tone: "status", text: publishResultText(result) });
			toast(
				result.version.state === "published"
					? "固定版本已发布"
					: "已提交审核，尚未进入可用目录",
			);
			onPublished?.();
		} catch (error) {
			setPublishFeedback({ tone: "alert", text: publishFailureMessage(error) });
		} finally {
			setBusy(undefined);
		}
	}

	function updateFile(fileId: string, change: Partial<DraftFile>) {
		setDraft((current) => ({
			...current,
			files: current.files.map((file) =>
				file.id === fileId ? { ...file, ...change } : file,
			),
		}));
		setErrors((current) => {
			if (!current.files?.[fileId]) return current;
			const { [fileId]: _removed, ...files } = current.files;
			return { ...current, files };
		});
	}

	function addFile(file: Omit<DraftFile, "id">) {
		const next = { ...file, id: crypto.randomUUID() };
		setDraft((current) => ({ ...current, files: [...current.files, next] }));
		return next.id;
	}

	async function upload(files: FileList | null) {
		for (const file of [...(files ?? [])]) {
			const bytes = new Uint8Array(await file.arrayBuffer());
			let text: string | undefined;
			try {
				text = strictUtf8.decode(bytes);
			} catch {
				text = undefined;
			}
			let binary = "";
			if (text === undefined)
				for (const byte of bytes) binary += String.fromCharCode(byte);
			addFile({
				directory: "assets",
				name: uploadedName(file.name),
				encoding: text === undefined ? "base64" : "utf8",
				content: text ?? btoa(binary),
			});
		}
	}

	if (
		content.kind === "loading" ||
		(content.kind === "unavailable" && retrying)
	)
		return (
			<SkillEditorLayout
				main={
					<>
						{before}
						<FormSection title="Skill 内容">
							<SkillHubLoading>正在读取 Skill 内容…</SkillHubLoading>
						</FormSection>
						{after}
					</>
				}
				aside={notice}
			/>
		);
	if (content.kind === "unavailable")
		return (
			<SkillEditorLayout
				main={
					<>
						{before}
						<FormSection title="Skill 内容">
							<SkillHubReadFailure
								retryable={content.retryable}
								reason={content.reason}
								retryTitle="暂时无法读取 Skill 内容"
								retryDescription="已发布的版本不受影响。"
								deniedText="当前账号不能编辑这个项目的内容。"
								unavailableText="Skill 内容暂时无法访问，请联系管理员。"
								onRetry={onRetry}
								retrying={retrying}
							/>
						</FormSection>
						{after}
					</>
				}
				aside={notice}
			/>
		);

	const fileError = (fileId: string) => errors.files?.[fileId];
	const shared = visibility !== "PRIVATE";
	// 设计主按钮：仅自己为「发布固定版本」，共享范围为「提交审核」；有未保存的修改时先保存。
	const publishLabel =
		busy === "publish"
			? shared
				? "正在提交…"
				: "正在发布…"
			: dirty
				? shared
					? "保存并提交审核"
					: "保存并发布"
				: shared
					? "提交审核"
					: "发布固定版本";
	const contentFormId = `${id}-content-form`;
	return (
		<SkillEditorLayout
			main={
				<>
					{before}
					<FormSection
						title="Skill 内容"
						description="SKILL.md 写明用途和使用步骤；脚本、参考资料和资源放在对应目录。已发布的版本不受后续修改影响。"
					>
						<form
							id={contentFormId}
							className="skill-editor-form"
							onSubmit={submitContent}
							noValidate
						>
							<Field className="skill-editor-full">
								<Label htmlFor={`${id}-skill-md`}>SKILL.md（任务说明）</Label>
								<Textarea
									ref={skillMdInput}
									id={`${id}-skill-md`}
									className="skill-content-text skill-md-text"
									value={draft.skillMd}
									spellCheck={false}
									placeholder={`# ${project.name}\n\n说明这个 Skill 的用途、触发条件和使用步骤。`}
									aria-invalid={errors.skillMd ? "true" : undefined}
									aria-describedby={
										errors.skillMd ? `${id}-skill-md-error` : undefined
									}
									onChange={(event) => {
										setDraft({ ...draft, skillMd: event.target.value });
										setErrors({ ...errors, skillMd: undefined });
									}}
								/>
								{errors.skillMd ? (
									<SkillFieldError id={`${id}-skill-md-error`}>
										{errors.skillMd}
									</SkillFieldError>
								) : null}
							</Field>

							<div className="skill-content-files">
								<h3 className="skill-content-heading">配套文件</h3>
								{draft.files.length === 0 ? (
									<p className="skill-field-help">
										还没有配套文件。可以添加脚本、参考资料或资源。
									</p>
								) : null}
								{draft.files.map((file, index) => {
									const label = `${file.directory}/${file.name.trim() || "未命名"}`;
									return (
										<fieldset key={file.id} className="skill-content-file">
											<legend className="sr-only">
												{`配套文件 ${index + 1}：${label}`}
											</legend>
											<div className="skill-editor-grid">
												<Field>
													<Label htmlFor={`${file.id}-directory`}>目录</Label>
													<NativeSelect
														id={`${file.id}-directory`}
														value={file.directory}
														onChange={(event) =>
															updateFile(file.id, {
																directory: event.target.value as Directory,
															})
														}
													>
														{directories.map((directory) => (
															<NativeSelectOption
																key={directory}
																value={directory}
															>
																{directoryLabels[directory]}
															</NativeSelectOption>
														))}
													</NativeSelect>
												</Field>
												<Field>
													<Label htmlFor={`${file.id}-name`}>文件名</Label>
													<Input
														ref={(node) => {
															if (node) fileInputs.current.set(file.id, node);
															else fileInputs.current.delete(file.id);
														}}
														id={`${file.id}-name`}
														value={file.name}
														maxLength={500}
														autoComplete="off"
														spellCheck={false}
														placeholder="run.sh"
														aria-invalid={
															fileError(file.id) ? "true" : undefined
														}
														aria-describedby={
															fileError(file.id)
																? `${file.id}-error`
																: undefined
														}
														onChange={(event) =>
															updateFile(file.id, { name: event.target.value })
														}
													/>
													{fileError(file.id) ? (
														<SkillFieldError id={`${file.id}-error`}>
															{fileError(file.id) ?? ""}
														</SkillFieldError>
													) : null}
												</Field>
												{file.encoding === "utf8" ? (
													<Field className="skill-editor-full">
														<Label htmlFor={`${file.id}-content`}>
															文件内容
														</Label>
														<Textarea
															id={`${file.id}-content`}
															className="skill-content-text"
															value={file.content}
															spellCheck={false}
															onChange={(event) =>
																updateFile(file.id, {
																	content: event.target.value,
																})
															}
														/>
													</Field>
												) : (
													<p className="skill-editor-full skill-field-help">
														<Badge tone="gray">二进制文件</Badge>{" "}
														{formatBytes(bytesOf(file))}
														，按原样打包，不能在网页上编辑。
													</p>
												)}
											</div>
											<div className="skill-actions skill-form-actions">
												<Button
													type="button"
													variant="ghost"
													aria-label={withObjectName("移除文件", label)}
													onClick={() => {
														setDraft({
															...draft,
															files: draft.files.filter(
																(item) => item.id !== file.id,
															),
														});
														// 移除后本组控件卸载，焦点交给「添加文本文件」，不落到 body。
														requestAnimationFrame(() =>
															addFileButton.current?.focus(),
														);
													}}
												>
													{/* 设计 icon('x')：ghost「移除」用叉号，不是垃圾桶（G5-10）。 */}
													<X aria-hidden="true" />
													移除
												</Button>
											</div>
										</fieldset>
									);
								})}
								<div className="skill-actions skill-form-actions">
									<Button
										ref={addFileButton}
										type="button"
										variant="outline"
										onClick={() => {
											const fileId = addFile({
												directory: "scripts",
												name: "",
												encoding: "utf8",
												content: "",
											});
											requestAnimationFrame(() =>
												fileInputs.current.get(fileId)?.focus(),
											);
										}}
									>
										{/* 设计 plus 图标（C2-14）。 */}
										<Plus aria-hidden="true" />
										添加文本文件
									</Button>
								</div>
								<Field>
									<Label htmlFor={`${id}-upload`}>上传文件到 assets/</Label>
									<Input
										id={`${id}-upload`}
										type="file"
										multiple
										onChange={(event) => {
											const input = event.currentTarget;
											void upload(input.files).then(() => {
												input.value = "";
											});
										}}
									/>
								</Field>
							</div>
							<p
								id={`${id}-limits`}
								className="skill-field-help skill-file-limits"
							>
								共 {draft.files.length + 1} 个文件，{formatBytes(totalBytes)}
								；最多 {limits.maxFiles} 个文件，单个 256 KB，合计 512 KB。
							</p>
							{errors.total ? (
								<SkillFieldError id={`${id}-total-error`}>
									{errors.total}
								</SkillFieldError>
							) : null}
						</form>
					</FormSection>
					{after}
				</>
			}
			aside={
				<form className="skill-editor-form" onSubmit={submitPublish} noValidate>
					{/* 设计 .field.section-tight：版本号距「版本与发布范围」标题 15px（C2-13）。 */}
					<Field className="skill-editor-version">
						<Label htmlFor={`${id}-version`}>版本号</Label>
						<Input
							ref={versionInput}
							id={`${id}-version`}
							value={version}
							maxLength={128}
							autoComplete="off"
							spellCheck={false}
							placeholder="1.0.0"
							aria-invalid={errors.version ? "true" : undefined}
							aria-describedby={
								errors.version ? `${id}-version-error` : undefined
							}
							onChange={(event) => {
								setVersion(event.target.value);
								setErrors({ ...errors, version: undefined });
							}}
						/>
						{errors.version ? (
							<SkillFieldError id={`${id}-version-error`}>
								{errors.version}
							</SkillFieldError>
						) : null}
					</Field>
					{/* 设计 .scope-choice：四张范围单选卡，附审核说明（V-18）。 */}
					<RadioGroup
						aria-label="发布范围"
						className="skill-scope-choice"
						value={visibility}
						onValueChange={(value) => setVisibility(value as Visibility)}
					>
						{visibilities.map((item) => {
							const disabled =
								item === "ORGANIZATION" && !project.organizationId;
							return (
								<Label
									key={item}
									variant="option"
									className="skill-scope-option"
									data-disabled={disabled || undefined}
								>
									<RadioGroupItem
										value={item}
										disabled={disabled}
										aria-labelledby={`${id}-scope-${item}`}
										aria-describedby={`${id}-scope-${item}-note`}
									/>
									<span>
										<span id={`${id}-scope-${item}`}>
											{skillHubVisibilityLabels[item]}
										</span>
										<small id={`${id}-scope-${item}-note`}>
											{item === "PRIVATE"
												? "自主创建内容可直接发布"
												: "需要独立审核后才可见"}
										</small>
									</span>
								</Label>
							);
						})}
					</RadioGroup>
					{project.organizationId ? null : (
						<p className="skill-field-help skill-scope-help">
							项目没有所属组织，不能选择组织共享。
						</p>
					)}
					{notice}
					<div className="skill-actions skill-editor-actions">
						{/* 「保存草稿」保存左栏的项目内容（Spec §11.6：项目内容是该项目的可变草稿）。 */}
						{/* 提交中保持可聚焦（aria-disabled），提交后焦点留在按钮上，不落到 body。 */}
						<Button
							type="submit"
							form={contentFormId}
							variant="outline"
							disabled={busy !== undefined}
							focusableWhenDisabled
						>
							{busy === "save" ? "正在保存…" : "保存草稿"}
						</Button>
						<Button
							type="submit"
							disabled={busy !== undefined}
							focusableWhenDisabled
						>
							{publishLabel}
						</Button>
						{dirty ? <Badge tone="amber">有未保存的修改</Badge> : null}
					</div>
					<SkillFeedback feedback={contentFeedback} />
					{conflict ? (
						<div className="skill-actions skill-form-actions">
							<Button
								type="button"
								variant="outline"
								onClick={() => {
									setConflict(false);
									setContentFeedback(undefined);
									void Promise.resolve(onRetry?.()).then(() => {
										setReload((value) => value + 1);
										// 按钮随冲突消失，焦点回到正文，不落到 body。
										requestAnimationFrame(() => skillMdInput.current?.focus());
									});
								}}
							>
								重新读取内容
							</Button>
						</div>
					) : null}
					<SkillFeedback feedback={publishFeedback}>
						{publishResult ? (
							<span className="skill-actions">
								<SkillHubStateChip state={publishResult.version.state} />
								<Link
									className={buttonVariants({ variant: "ghost" })}
									to="/skills/$skillVersionId"
									params={{
										skillVersionId: publishResult.version.skillVersionId,
									}}
								>
									查看版本详情
								</Link>
							</span>
						) : null}
					</SkillFeedback>
				</form>
			}
		/>
	);
}

/**
 * 设计 .editor-layout（V-18）：左栏编辑项目与内容、导入固定来源；右栏「版本与发布范围」。
 * 1023px 及以下单栏。
 */
export function SkillEditorLayout({
	main,
	aside,
}: {
	main: ReactNode;
	aside: ReactNode;
}) {
	const id = useId();
	return (
		<div className="skill-editor-layout">
			<div className="skill-surface skill-editor-surface">{main}</div>
			<aside
				className="skill-surface skill-editor-surface skill-editor-aside"
				aria-labelledby={`${id}-publish`}
			>
				<h2 id={`${id}-publish`}>版本与发布范围</h2>
				{aside}
			</aside>
		</div>
	);
}

function SkillFieldError({ id, children }: { id: string; children: string }) {
	return (
		<Alert
			id={id}
			tone="danger"
			role="alert"
			icon={null}
			className="skill-field-error"
		>
			{children}
		</Alert>
	);
}

function SkillFeedback({
	feedback,
	children,
}: {
	feedback?: Feedback;
	children?: ReactNode;
}) {
	if (!feedback) return null;
	return (
		<Alert
			tone={feedback.tone === "alert" ? "danger" : "info"}
			role={feedback.tone}
			className="mt-4"
		>
			<AlertDescription>{feedback.text}</AlertDescription>
			{children ? <div className="mt-2">{children}</div> : null}
		</Alert>
	);
}
