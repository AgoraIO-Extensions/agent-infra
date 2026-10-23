import { Layers, X } from "lucide-react";
import {
	type KeyboardEvent,
	type RefObject,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Listbox, ListboxOption } from "@/components/ui/listbox";
import { LoadingLine } from "@/components/ui/spinner";
import {
	capabilityKindLabel,
	capabilityVersionLabel,
} from "./conversation-capability-lifecycle.js";
import {
	type ConversationCapabilityV1,
	capabilityQuery,
	filterConversationCapabilities,
	moveCapabilityIndex,
	sameCapability,
} from "./conversation-capability-picker.js";

/**
 * 命令与 Skill 目录对当前会话的状态。只有 ready / partial 表示目录可用：此时以 / 开头、
 * 未选择目录项的草稿不会作为普通消息发出；其他状态下按普通消息发送（NI-86）。
 */
export type CapabilityCatalog =
	| { status: "unsupported" }
	| { status: "no-execution" }
	| { status: "loading" }
	| { status: "error"; retry: () => void }
	| {
			status: "ready" | "partial";
			capabilities: readonly ConversationCapabilityV1[];
	  };

const catalogNotices = {
	unsupported: "当前模板尚未接入命令与 Skill。",
	// 契约只支持按 Execution 读取目录（CK-04），首条消息之前没有可读的目录。
	"no-execution": "发送第一条消息后可使用命令与 Skill。",
} as const;

export function catalogAvailable(catalog: CapabilityCatalog) {
	return catalog.status === "ready" || catalog.status === "partial";
}

/**
 * composer 内唯一的命令 / Skill 状态：弹层开合、活动项、已选择项与 composer 内错误。
 * 选择结果不写回草稿；输入框正文就是 Skill 的补充参数。
 */
export function useCapabilityComposer({
	catalog,
	draft,
	setDraft,
	textarea,
	busy,
}: {
	catalog: CapabilityCatalog;
	draft: string;
	setDraft: (value: string) => void;
	textarea: RefObject<HTMLTextAreaElement | null>;
	/** 上一次调用尚在受理、执行或待核实：入口与选择都不可用。 */
	busy: boolean;
}) {
	const listboxId = useId();
	const [open, setOpen] = useState(false);
	const [activeIndex, setActiveIndex] = useState(0);
	const [selected, setSelected] = useState<ConversationCapabilityV1>();
	const [error, setError] = useState<string>();
	const insertedSlash = useRef(false);
	const capabilities =
		catalog.status === "ready" || catalog.status === "partial"
			? catalog.capabilities
			: undefined;
	const query = capabilityQuery(draft) ?? "";
	const options = useMemo(
		() =>
			capabilities ? filterConversationCapabilities(capabilities, query) : [],
		[capabilities, query],
	);
	const index = Math.min(activeIndex, Math.max(0, options.length - 1));
	// 目录刷新后已选择项不在目录中：保留选择并提示失效，不作为普通消息发送。
	const selectionValid =
		selected === undefined ||
		(capabilities?.some((item) => sameCapability(item, selected)) ?? false);
	const close = useCallback(() => {
		setOpen(false);
		if (insertedSlash.current && draft === "/") setDraft("");
		insertedSlash.current = false;
	}, [draft, setDraft]);
	function focusInput() {
		textarea.current?.focus();
	}
	function choose(capability: ConversationCapabilityV1) {
		if (busy) return;
		setSelected(capability);
		setError(undefined);
		setOpen(false);
		insertedSlash.current = false;
		if (draft.startsWith("/")) setDraft("");
		focusInput();
	}
	return {
		listboxId,
		query,
		open: open && !busy,
		options,
		activeIndex: index,
		selected,
		selectionValid,
		error,
		catalog,
		busy,
		setError,
		/** 草稿变化：以 / 开头时打开弹层并回到第一项，其他内容收起。 */
		onDraftChange(value: string) {
			setDraft(value);
			setActiveIndex(0);
			if (value.startsWith("/") && !busy) setOpen(true);
			else {
				setOpen(false);
				insertedSlash.current = false;
			}
		},
		/** 工具栏入口：草稿为空时插入 / 并打开；再次点击收起。 */
		toggle() {
			if (busy) return;
			if (open) {
				close();
				focusInput();
				return;
			}
			setActiveIndex(0);
			if (!draft) {
				insertedSlash.current = true;
				setDraft("/");
			}
			setOpen(true);
			focusInput();
		},
		close,
		choose,
		clearSelection() {
			setSelected(undefined);
			setError(undefined);
			focusInput();
		},
		/** 调用已受理：清除选择与草稿。 */
		accepted() {
			setSelected(undefined);
			setError(undefined);
			setDraft("");
		},
		/**
		 * 输入框键盘：弹层打开时 ↑↓ 移动活动项（首尾停住），Home / End 跳到第一项 / 最后一项，
		 * Enter / Tab 只选择不发送，Esc 收起且焦点留在输入框。返回 true 表示事件已被弹层处理。
		 */
		onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>, composing: boolean) {
			if (!open || busy || composing) return false;
			if (event.key === "Escape") {
				event.preventDefault();
				close();
				return true;
			}
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				setActiveIndex(
					moveCapabilityIndex(
						index,
						event.key === "ArrowDown" ? 1 : -1,
						options.length,
					),
				);
				return true;
			}
			// 弹层打开时 Home / End 移动活动项，不移动输入框光标（CH-02）；带修饰键（如 Shift 选择）
			// 或没有选项时交还输入框。
			if (
				(event.key === "Home" || event.key === "End") &&
				!event.shiftKey &&
				!event.ctrlKey &&
				!event.metaKey &&
				!event.altKey &&
				options.length
			) {
				event.preventDefault();
				setActiveIndex(event.key === "Home" ? 0 : options.length - 1);
				return true;
			}
			if (
				(event.key === "Enter" || event.key === "Tab") &&
				!event.shiftKey &&
				options[index]
			) {
				event.preventDefault();
				choose(options[index]);
				return true;
			}
			return false;
		},
	};
}

export type CapabilityComposer = ReturnType<typeof useCapabilityComposer>;

function optionId(listboxId: string, index: number) {
	return `${listboxId}-option-${index}`;
}

/** 输入框打开弹层时的 combobox 属性；弹层不存在时不设 role=combobox（NI-86）。 */
export function capabilityComboboxProps(capability: CapabilityComposer) {
	if (!capability.open) return {};
	return {
		role: "combobox",
		"aria-expanded": true,
		"aria-controls": capability.listboxId,
		"aria-autocomplete": "list" as const,
		"aria-activedescendant": capability.options[capability.activeIndex]
			? optionId(capability.listboxId, capability.activeIndex)
			: undefined,
	};
}

/** 设计 #chat-toolbar-controls 的「命令 / Skill」入口。 */
export function CapabilityTrigger({
	capability,
	disabled,
}: {
	capability: CapabilityComposer;
	disabled: boolean;
}) {
	return (
		<Button
			type="button"
			variant="ghost"
			className="capability-trigger"
			aria-label="选择命令或 Skill"
			aria-haspopup="listbox"
			aria-expanded={capability.open}
			aria-controls={capability.open ? capability.listboxId : undefined}
			title="命令 / Skill"
			disabled={disabled || capability.busy}
			data-capability-trigger=""
			onClick={() => capability.toggle()}
		>
			<Layers aria-hidden="true" />
			<span className="capability-trigger-label">命令 / Skill</span>
		</Button>
	);
}

/**
 * 设计 positionCapabilityPicker：fixed 弹层放在 composer 上方，宽 min(320, 视口-32)，
 * max-height 取 min(248, 上方可用空间, 40% 视口高)，左缘对齐入口按钮并钳制在 16px 边距内。
 * 设计以 .composer 为锚，它比输入框外框多 10px padding-top；这里的锚点就是输入框外框
 * （form.composer-zone），所以先上移 10px，弹层底边离输入框 18px（Z-07）。
 */
const designComposerPaddingTop = 10;

function usePickerPosition(
	open: boolean,
	menu: RefObject<HTMLElement | null>,
	anchor: RefObject<HTMLElement | null>,
) {
	useLayoutEffect(() => {
		if (!open) return;
		function place() {
			const element = menu.current;
			const composer = anchor.current;
			if (!element || !composer) return;
			const trigger = composer.querySelector("[data-capability-trigger]");
			const bounds = composer.getBoundingClientRect();
			const left = trigger?.getBoundingClientRect().left ?? bounds.left;
			const width = Math.min(320, window.innerWidth - 32);
			const top = Math.max(12, bounds.top - designComposerPaddingTop);
			const space = Math.max(80, top - 24);
			element.style.width = `${width}px`;
			element.style.maxHeight = `${Math.min(248, space, window.innerHeight * 0.4)}px`;
			element.style.left = `${Math.max(16, Math.min(left, window.innerWidth - width - 16))}px`;
			element.style.top = `${Math.max(12, top - element.offsetHeight - 8)}px`;
			element.style.visibility = "visible";
		}
		place();
		const observer =
			typeof ResizeObserver === "undefined"
				? undefined
				: new ResizeObserver(place);
		if (menu.current) observer?.observe(menu.current);
		window.addEventListener("resize", place);
		window.addEventListener("scroll", place, { capture: true, passive: true });
		return () => {
			observer?.disconnect();
			window.removeEventListener("resize", place);
			window.removeEventListener("scroll", place, { capture: true });
		};
	});
}

export function CapabilityMenu({
	capability,
	anchor,
	textarea,
}: {
	capability: CapabilityComposer;
	anchor: RefObject<HTMLElement | null>;
	textarea: RefObject<HTMLTextAreaElement | null>;
}) {
	const menu = useRef<HTMLElement>(null);
	const { open, options, activeIndex, catalog, listboxId, close, query } =
		capability;
	usePickerPosition(open, menu, anchor);
	// 活动项变化时保持在弹层可视区内。
	useEffect(() => {
		if (!open) return;
		document
			.getElementById(optionId(listboxId, activeIndex))
			?.scrollIntoView?.({ block: "nearest" });
	}, [open, listboxId, activeIndex]);
	// 点击弹层、入口、输入框以外区域时收起。
	useEffect(() => {
		if (!open) return;
		function onPointerDown(event: PointerEvent) {
			const target = event.target as Node | null;
			if (
				!target ||
				menu.current?.contains(target) ||
				textarea.current?.contains(target) ||
				anchor.current
					?.querySelector("[data-capability-trigger]")
					?.contains(target)
			)
				return;
			close();
		}
		document.addEventListener("pointerdown", onPointerDown, true);
		return () =>
			document.removeEventListener("pointerdown", onPointerDown, true);
	}, [open, close, textarea, anchor]);
	if (!open) return null;
	return (
		<section
			ref={menu}
			className="capability-menu"
			aria-label="命令与 Skill 选择"
			style={{ visibility: "hidden" }}
		>
			<div className="capability-menu-title">
				<span>命令 / Skill · 输入 / 搜索</span>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					className="capability-menu-close"
					aria-label="关闭命令选择"
					onMouseDown={(event) => event.preventDefault()}
					onClick={() => {
						close();
						textarea.current?.focus();
					}}
				>
					<X aria-hidden="true" />
				</Button>
			</div>
			{catalog.status === "loading" && (
				<LoadingLine className="capability-menu-state">正在读取…</LoadingLine>
			)}
			{catalog.status === "error" && (
				<>
					{/* 设计 .cap-picker-state + 同级 ghost「重试」：「重试」在状态行之后、左缘对齐菜单内容区，
					    不放进带 12px 9px 内边距的状态行（#3267 N8-1-02）。 */}
					<div className="capability-menu-state">
						<Alert
							tone="danger"
							role="alert"
							icon={null}
							className="capability-inline-alert"
						>
							目录读取失败
						</Alert>
					</div>
					<Button
						type="button"
						variant="ghost"
						onMouseDown={(event) => event.preventDefault()}
						onClick={() => {
							// 重读开始即换成读取行、按钮卸载：焦点先回到输入框（键盘触发时也不落到 body，
							// #3269 N8-3-02、#3267 N8-1-02）；鼠标按下时本就不离开输入框。
							textarea.current?.focus();
							catalog.retry();
						}}
					>
						重试
					</Button>
				</>
			)}
			{(catalog.status === "unsupported" ||
				catalog.status === "no-execution") && (
				<p className="capability-menu-state" role="status">
					{catalogNotices[catalog.status]}
				</p>
			)}
			{catalog.status === "partial" && (
				<p className="capability-menu-state" role="status">
					部分命令或 Skill 目录暂不可用，已隐藏对应旧数据。
				</p>
			)}
			{catalogAvailable(catalog) && options.length === 0 && (
				<p className="capability-menu-state" role="status">
					{query.trim()
						? "没有匹配项，换一个关键词试试。"
						: "没有已同步可用的命令或 Skill。"}
				</p>
			)}
			<Listbox id={listboxId} aria-label="命令与 Skill 搜索结果">
				{options.map((item, index) => (
					<ListboxOption
						key={`${item.kind}:${item.identity ?? item.name}`}
						id={optionId(listboxId, index)}
						type="button"
						variant="ghost"
						aria-selected={index === activeIndex}
						data-active={index === activeIndex ? "true" : undefined}
						className="capability-option"
						title={[item.description, item.source, item.version]
							.filter(Boolean)
							.join(" · ")}
						onMouseDown={(event) => event.preventDefault()}
						onClick={() => capability.choose(item)}
					>
						<span className="capability-option-copy">
							<strong>{item.name}</strong>
							<small>
								{item.kind === "skill"
									? [
											item.source,
											capabilityVersionLabel(item.kind, item.version),
										]
											.filter(Boolean)
											.join(" · ")
									: item.description}
							</small>
						</span>
						<span className="capability-option-kind">
							{item.kind === "skill" ? "Skill" : "只读命令"}
						</span>
					</ListboxOption>
				))}
			</Listbox>
			<div className="capability-menu-footer" aria-hidden="true">
				<span>↑ ↓ 切换</span>
				<span>Enter / Tab 选择</span>
				<span>Esc 收起</span>
			</div>
		</section>
	);
}

/** 设计 .cap-selection：选择条位于输入框上方，「移除」后可重新选择。 */
export function CapabilitySelection({
	capability,
}: {
	capability: CapabilityComposer;
}) {
	const { selected, selectionValid, error } = capability;
	return (
		<>
			{selected && (
				<div className="capability-selection">
					<div>
						<strong>
							{capabilityKindLabel(selected.kind)} · {selected.name}
						</strong>
						<small>
							{[
								selected.source,
								capabilityVersionLabel(selected.kind, selected.version),
								selectionValid ? "等待发送确认" : "当前选择已失效",
							]
								.filter(Boolean)
								.join(" · ")}
						</small>
					</div>
					<Button
						type="button"
						variant="ghost"
						onClick={() => capability.clearSelection()}
					>
						移除
					</Button>
				</div>
			)}
			{selected && !selectionValid && (
				<Alert
					tone="danger"
					role="alert"
					icon={null}
					className="capability-inline-alert capability-error"
				>
					版本或授权已变化，请重新选择；不会作为普通消息发送。
				</Alert>
			)}
			{error && (
				<Alert
					tone="danger"
					role="alert"
					icon={null}
					className="capability-inline-alert capability-error"
				>
					{error}
				</Alert>
			)}
		</>
	);
}
