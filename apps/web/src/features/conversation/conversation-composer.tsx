import { Send, Square } from "lucide-react";
import {
	type ReactNode,
	type RefObject,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { Button } from "../../components/ui/button.js";
import { Label } from "../../components/ui/label.js";
import { Textarea } from "../../components/ui/textarea.js";
import {
	ComposerModelControls,
	type ComposerModelControlsProps,
} from "./composer-model-controls.js";
import {
	type CapabilityComposer,
	CapabilityMenu,
	CapabilitySelection,
	CapabilityTrigger,
	capabilityComboboxProps,
	catalogAvailable,
} from "./conversation-capability-menu.js";
import {
	type CapabilityInvocationBody,
	type ConversationCapabilityV1,
	prepareCapabilityInvocation,
} from "./conversation-capability-picker.js";

/** 设计 isCompactChatSettings：composer 宽 ≤440 时进入紧凑态。 */
const compactComposerWidth = 440;

function useCompactComposer(form: RefObject<HTMLFormElement | null>) {
	const [compact, setCompact] = useState(false);
	useLayoutEffect(() => {
		const element = form.current;
		if (!element || typeof ResizeObserver === "undefined") return;
		const measure = () =>
			setCompact(element.getBoundingClientRect().width <= compactComposerWidth);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [form]);
	return compact;
}

export type ConversationComposerProps = {
	composerId: string;
	textarea: RefObject<HTMLTextAreaElement | null>;
	draft: string;
	draftDisabled: boolean;
	/** 普通消息与能力调用共同的发送前提（会话就绪、没有挂起命令、模型设置已保存等）。 */
	submitReady: boolean;
	/** 能力调用额外要求没有进行中的回复。 */
	invokeReady: boolean;
	sendLabel: string;
	capability: CapabilityComposer;
	model?: ComposerModelControlsProps;
	/** 不可重试的模型保存失败原因，显示在工具栏上方。 */
	modelFailure?: string;
	/** 进行中回复的停止入口。 */
	stop?: { label: string; disabled: boolean; onStop: () => void };
	/** composer 顶部的附件入口（会话文件迁移前仍在 composer 内）。 */
	attachments?: ReactNode;
	formAttributes: Record<`data-${string}`, string>;
	onSendMessage: () => void;
	onInvokeCapability: (
		body: CapabilityInvocationBody,
		selected: ConversationCapabilityV1,
	) => void;
};

/**
 * 设计 .composer：唯一的输入框承载消息与 / 命令搜索；工具栏左侧是「命令 / Skill」、
 * 模型与思考入口，右侧是停止与发送。
 */
export function ConversationComposer({
	composerId,
	textarea,
	draft,
	draftDisabled,
	submitReady,
	invokeReady,
	sendLabel,
	capability,
	model,
	modelFailure,
	stop,
	attachments,
	formAttributes,
	onSendMessage,
	onInvokeCapability,
}: ConversationComposerProps) {
	const form = useRef<HTMLFormElement>(null);
	const composing = useRef(false);
	const compact = useCompactComposer(form);
	const { selected, catalog } = capability;
	const canSubmit = selected
		? submitReady && invokeReady
		: submitReady && Boolean(draft.trim());
	function submit() {
		if (!canSubmit) return;
		if (selected) {
			if (!capability.selectionValid) return;
			const prepared = prepareCapabilityInvocation(selected, draft);
			if ("error" in prepared) {
				capability.setError(prepared.error);
				textarea.current?.focus();
				return;
			}
			capability.setError(undefined);
			onInvokeCapability(prepared.body, selected);
			return;
		}
		if (draft.startsWith("/")) {
			// 目录可用时，未选择目录项的 / 草稿不作为普通消息发出；目录不可用时按普通消息发送。
			if (catalogAvailable(catalog)) {
				capability.setError("请先选择目录中的命令或 Skill。");
				capability.onDraftChange(draft);
				return;
			}
			if (catalog.status === "loading") {
				capability.setError("命令与 Skill 目录正在读取，请稍后再发送。");
				return;
			}
		}
		capability.setError(undefined);
		onSendMessage();
	}
	const placeholder = selected
		? selected.kind === "skill"
			? "补充这次任务的目标与范围…"
			: "这项只读命令不需要额外参数"
		: "输入消息，或 / 搜索命令与 Skill…";
	return (
		<form
			ref={form}
			className="composer-zone composer"
			data-compact={compact ? "true" : "false"}
			{...formAttributes}
			onSubmit={(event) => {
				event.preventDefault();
				submit();
			}}
		>
			<CapabilityMenu
				capability={capability}
				anchor={form}
				textarea={textarea}
			/>
			{attachments}
			<CapabilitySelection capability={capability} />
			<Label className="sr-only" htmlFor={composerId}>
				消息
			</Label>
			<Textarea
				ref={textarea}
				id={composerId}
				rows={3}
				value={draft}
				disabled={draftDisabled}
				placeholder={placeholder}
				{...capabilityComboboxProps(capability)}
				onFocus={(event) => {
					const input = event.currentTarget;
					const bounds = input.getBoundingClientRect();
					// Browsers may reveal only the caret when returning from execution details.
					if (bounds.top < 0 || bounds.bottom > window.innerHeight)
						input.scrollIntoView({ block: "nearest" });
				}}
				onChange={(event) => capability.onDraftChange(event.target.value)}
				onCompositionStart={() => {
					composing.current = true;
				}}
				onCompositionEnd={() => {
					composing.current = false;
				}}
				onKeyDown={(event) => {
					const imeComposing =
						event.nativeEvent.isComposing ||
						event.keyCode === 229 ||
						composing.current;
					if (capability.onKeyDown(event, imeComposing)) return;
					if (event.key === "Enter" && !event.shiftKey && !imeComposing) {
						event.preventDefault();
						submit();
					}
				}}
			/>
			{modelFailure && (
				<p className="model-preference-failure" role="status">
					{modelFailure}
				</p>
			)}
			<div className="composer-controls">
				<div className="composer-toolbar">
					<CapabilityTrigger capability={capability} disabled={draftDisabled} />
					{model && <ComposerModelControls {...model} compact={compact} />}
				</div>
				<div className="composer-actions">
					{stop && (
						<Button
							type="button"
							variant="outline"
							className="composer-stop"
							disabled={stop.disabled}
							onClick={stop.onStop}
						>
							<Square aria-hidden="true" />
							<span className="composer-stop-label">{stop.label}</span>
						</Button>
					)}
					<Button
						type="submit"
						size="sm"
						data-c02-send-button="send"
						disabled={!canSubmit}
					>
						<Send aria-hidden="true" />
						<span className="composer-send-label">
							{selected ? "确认发送" : sendLabel}
						</span>
					</Button>
				</div>
			</div>
		</form>
	);
}
