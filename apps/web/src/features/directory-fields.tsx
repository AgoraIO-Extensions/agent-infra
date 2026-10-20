import { SearchIcon, XIcon } from "lucide-react";
import { type RefObject, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Listbox, ListboxOption } from "@/components/ui/listbox";
import { cn } from "@/lib/utils";
import {
	AvailabilityNameList,
	type DirectoryKind,
	type DirectoryOption,
	DirectoryReadAlert,
	type DirectoryTarget,
	readDirectory,
	unresolvedDirectoryLabels,
	useAvailabilityNames,
} from "./directory-names.js";

/** 只读的使用范围：用户与组织合并读取，读取失败时只出现一条提示。 */
export function DirectoryRecords({
	targets,
	empty = "未提供范围信息",
}: {
	targets: readonly DirectoryTarget[];
	empty?: string;
}) {
	const names = useAvailabilityNames(targets);
	return (
		<div className="space-y-2">
			<DirectoryReadAlert names={[names]} />
			<AvailabilityNameList
				targets={targets}
				names={names}
				layout="list"
				empty={empty}
			/>
		</div>
	);
}

function splitDirectoryValue(value: string) {
	return value
		.split(/\n|,/)
		.map((item) => item.trim())
		.filter(Boolean);
}

function remember(
	current: Record<string, DirectoryOption>,
	nextOptions: readonly DirectoryOption[],
) {
	const merged = { ...current };
	for (const option of nextOptions) merged[option.id] = option;
	return merged;
}

/**
 * 选择器结果层的收起时机：Esc 由调用方处理；点击选择器之外；键盘把焦点移出选择器
 * （例如 Tab 到下一个字段）。指针操作在 click 之后才收起：窄屏结果层在文档流中，
 * 按下时收起会让下方控件位移、点击落空。目录选择器与审计 Agent 选择器共用。
 */
export function usePickerDismiss(
	pickerRef: RefObject<HTMLElement | null>,
	expanded: boolean,
	close: () => void,
) {
	const closeRef = useRef(close);
	closeRef.current = close;
	useEffect(() => {
		const picker = pickerRef.current;
		if (!expanded || !picker) return;
		let pointerOutside = false;
		const inside = (target: EventTarget | null) =>
			target instanceof Node && picker.contains(target);
		const markPointer = (event: PointerEvent) => {
			pointerOutside = !inside(event.target);
		};
		const closeOnOutsideClick = (event: MouseEvent) => {
			pointerOutside = false;
			// 选中或移除会在冒泡途中卸载被点击的节点，按派发时的事件路径判断是否在选择器内。
			if (!event.composedPath().includes(picker)) closeRef.current();
		};
		const resetPointer = () => {
			pointerOutside = false;
		};
		const closeOnFocusLeave = (event: FocusEvent) => {
			const next = event.relatedTarget;
			if (inside(next) || pointerOutside) return;
			if (next) closeRef.current();
		};
		document.addEventListener("pointerdown", markPointer, true);
		// 捕获阶段监听：外部元素阻止冒泡时也能收起。
		document.addEventListener("click", closeOnOutsideClick, true);
		document.addEventListener("keydown", resetPointer, true);
		picker.addEventListener("focusout", closeOnFocusLeave);
		return () => {
			document.removeEventListener("pointerdown", markPointer, true);
			document.removeEventListener("click", closeOnOutsideClick, true);
			document.removeEventListener("keydown", resetPointer, true);
			picker.removeEventListener("focusout", closeOnFocusLeave);
		};
	}, [pickerRef, expanded]);
}

export type DirectorySelection = {
	id: string;
	name: string;
	secondary: string;
	resolved: boolean;
};
type UnresolvedReason = "missing" | "failed";

// 未解析记录的占位序号按 ID 固定：移除其他 chip 不会改名，同页不同选择器也不会重名。
const placeholderNumbers: Record<DirectoryKind, Map<string, number>> = {
	user: new Map(),
	organization: new Map(),
};
function placeholderNumber(kind: DirectoryKind, item: string) {
	const numbers = placeholderNumbers[kind];
	const known = numbers.get(item);
	if (known) return known;
	const next = numbers.size + 1;
	numbers.set(item, next);
	return next;
}
// 读取中与读取失败的中性占位：都还不能断定记录不存在，「未识别的…」只用于目录确认缺失。
const neutralDirectoryLabels: Record<DirectoryKind, string> = {
	user: "用户",
	organization: "组织",
};

export function DirectoryPicker({
	id,
	label,
	help,
	kind,
	value,
	onChange,
	error,
	describedBy,
	errorId: validationErrorId = `${id}-error`,
	disabled = false,
	required = false,
	fallbackLabels,
	closeOnSelect = false,
	placeholder,
}: {
	id: string;
	label: string;
	help: string;
	kind: DirectoryKind;
	value: string;
	onChange: (value: string, selection: readonly DirectorySelection[]) => void;
	error?: string;
	describedBy?: string;
	errorId?: string;
	disabled?: boolean;
	required?: boolean;
	/** 调用方已知的显示名，只在目录未返回该记录时使用。 */
	fallbackLabels?: Readonly<Record<string, string>>;
	/** 只取一项的调用方（例如员工访问控制）选中后收起，避免结果层盖住后续操作。 */
	closeOnSelect?: boolean;
	/** 未选择任何项时的占位符；不提供时按目录类型显示默认文案。 */
	placeholder?: string;
}) {
	const selectedIds = splitDirectoryValue(value);
	const selectedKey = selectedIds.join(",");
	const [query, setQuery] = useState("");
	const [open, setOpen] = useState(false);
	const [activeIndex, setActiveIndex] = useState(0);
	const [loading, setLoading] = useState(false);
	const [directoryOptions, setDirectoryOptions] = useState<DirectoryOption[]>(
		[],
	);
	const [knownDirectoryOptions, setKnownDirectoryOptions] = useState<
		Record<string, DirectoryOption>
	>({});
	const knownRef = useRef(knownDirectoryOptions);
	knownRef.current = knownDirectoryOptions;
	const [unresolvedReasons, setUnresolvedReasons] = useState<
		Record<string, UnresolvedReason>
	>({});
	const reasonsRef = useRef(unresolvedReasons);
	reasonsRef.current = unresolvedReasons;
	const [directoryError, setDirectoryError] = useState(false);
	const pickerRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const expanded = open && !disabled;
	usePickerDismiss(pickerRef, expanded, () => setOpen(false));
	// 搜索结果：只在展开时读取。
	useEffect(() => {
		if (!expanded) return;
		const controller = new AbortController();
		setDirectoryOptions([]);
		setActiveIndex(0);
		setLoading(true);
		setDirectoryError(false);
		readDirectory(kind, query, [], controller.signal)
			.then((nextOptions) => {
				if (controller.signal.aborted) return;
				setDirectoryOptions(nextOptions);
				setKnownDirectoryOptions((current) => remember(current, nextOptions));
			})
			.catch((error: unknown) => {
				if (
					controller.signal.aborted ||
					(error instanceof DOMException && error.name === "AbortError")
				)
					return;
				setDirectoryOptions([]);
				setDirectoryError(true);
			})
			.finally(() => {
				if (!controller.signal.aborted) setLoading(false);
			});
		return () => controller.abort();
	}, [expanded, kind, query]);
	// 已选记录：按 canonical ID 反查新出现或上次读取失败的条目，区分「缺失」与「读取失败」；
	// 已确认缺失的条目不再重复请求。
	useEffect(() => {
		const missing = selectedKey
			? selectedKey
					.split(",")
					.filter(
						(item) =>
							!knownRef.current[item] && reasonsRef.current[item] !== "missing",
					)
			: [];
		if (!missing.length) return;
		const controller = new AbortController();
		setUnresolvedReasons((current) => {
			const next = { ...current };
			for (const item of missing) delete next[item];
			return next;
		});
		readDirectory(kind, "", missing, controller.signal)
			.then((found) => {
				if (controller.signal.aborted) return;
				setKnownDirectoryOptions((current) => remember(current, found));
				const foundIds = new Set(found.map((option) => option.id));
				setUnresolvedReasons((current) => {
					const next = { ...current };
					for (const item of missing)
						if (!foundIds.has(item)) next[item] = "missing";
					return next;
				});
			})
			.catch((error: unknown) => {
				if (
					controller.signal.aborted ||
					(error instanceof DOMException && error.name === "AbortError")
				)
					return;
				setUnresolvedReasons((current) => {
					const next = { ...current };
					for (const item of missing) next[item] = "failed";
					return next;
				});
			});
		return () => controller.abort();
	}, [kind, selectedKey]);
	const visibleOptions = directoryOptions.filter(
		(option) => !selectedIds.includes(option.id),
	);
	const listboxId = `${id}-options`;
	const showListbox =
		expanded && !loading && !directoryError && visibleOptions.length > 0;
	const describe = (
		ids: readonly string[],
		extra?: DirectoryOption,
	): DirectorySelection[] => {
		return ids.map((item) => {
			const option = extra?.id === item ? extra : knownDirectoryOptions[item];
			if (option)
				return {
					id: item,
					name: option.name,
					secondary: option.secondary,
					resolved: true,
				};
			const fallback = fallbackLabels?.[item]?.trim();
			const reason = unresolvedReasons[item];
			// 没有已知显示名时用可区分的序号占位，不显示内部 ID，也不让多个移除钮同名；
			// 只有目录确认缺失才下「未识别」的结论，读取中与读取失败都用中性占位。
			return {
				id: item,
				name:
					fallback ||
					`${
						reason === "missing"
							? unresolvedDirectoryLabels[kind]
							: neutralDirectoryLabels[kind]
					} ${placeholderNumber(kind, item)}`,
				secondary:
					reason === "failed"
						? "目录详情暂时无法读取"
						: reason === "missing"
							? "目录中暂未找到该记录"
							: "正在读取目录详情…",
				resolved: false,
			};
		});
	};
	const selected = describe(selectedIds);
	const focusInput = () =>
		requestAnimationFrame(() => {
			const input = inputRef.current;
			if (!input) return;
			input.focus();
			const end = input.value.length;
			input.setSelectionRange(end, end);
		});
	const add = (option: DirectoryOption | undefined) => {
		if (
			disabled ||
			!expanded ||
			loading ||
			directoryError ||
			!option ||
			selectedIds.includes(option.id)
		)
			return;
		const next = [...selectedIds, option.id];
		onChange(next.join("\n"), describe(next, option));
		// 选中后保持展开，焦点回到输入框，便于连续多选。
		setQuery("");
		setActiveIndex(0);
		setOpen(!closeOnSelect);
		focusInput();
	};
	const remove = (item: string) => {
		if (disabled) return;
		const next = selectedIds.filter((selectedId) => selectedId !== item);
		onChange(next.join("\n"), describe(next));
		setOpen(true);
		focusInput();
	};
	const clearQuery = () => {
		setQuery("");
		setActiveIndex(0);
		setOpen(true);
		focusInput();
	};
	const keepInputFocus = (event: { preventDefault: () => void }) =>
		event.preventDefault();
	return (
		<div className="directory-field" ref={pickerRef}>
			<Label htmlFor={id}>{label}</Label>
			<div
				className={cn("directory-control", error && "directory-control-error")}
			>
				<div className="directory-chips">
					{selected.map((item) => (
						<span
							className="directory-chip"
							data-resolved={item.resolved || undefined}
							key={item.id}
						>
							<span className="directory-chip-label">
								<span className="directory-chip-name">{item.name}</span>
								{item.secondary ? <small>{item.secondary}</small> : null}
							</span>
							<Button
								disabled={disabled}
								aria-label={`移除 ${item.name}`}
								className="directory-chip-remove"
								onClick={() => remove(item.id)}
								onMouseDown={keepInputFocus}
								size="icon"
								type="button"
								variant="ghost"
							>
								<XIcon aria-hidden="true" size={14} />
							</Button>
						</span>
					))}
				</div>
				<Input
					ref={inputRef}
					autoComplete="off"
					disabled={disabled}
					aria-required={required || undefined}
					role="combobox"
					aria-activedescendant={
						showListbox && visibleOptions[activeIndex]
							? `${id}-${visibleOptions[activeIndex].id}`
							: undefined
					}
					aria-autocomplete="list"
					aria-controls={showListbox ? listboxId : undefined}
					aria-describedby={
						[describedBy, error ? validationErrorId : undefined]
							.filter(Boolean)
							.join(" ") || undefined
					}
					aria-expanded={expanded}
					aria-invalid={error ? true : undefined}
					aria-label={label}
					className="directory-input"
					id={id}
					onChange={(event) => {
						setQuery(event.target.value);
						setActiveIndex(0);
						setOpen(true);
					}}
					onClick={() => setOpen(true)}
					onFocus={() => setOpen(true)}
					onKeyDown={(event) => {
						if (event.key === "ArrowDown") {
							event.preventDefault();
							setOpen(true);
							setActiveIndex((index) =>
								Math.min(index + 1, Math.max(visibleOptions.length - 1, 0)),
							);
						} else if (event.key === "ArrowUp") {
							event.preventDefault();
							setOpen(true);
							setActiveIndex((index) => Math.max(index - 1, 0));
						} else if (event.key === "Enter") {
							event.preventDefault();
							add(visibleOptions[activeIndex]);
						} else if (event.key === "Escape" && expanded) {
							event.preventDefault();
							event.stopPropagation();
							setOpen(false);
						}
					}}
					placeholder={
						selected.length > 0
							? "继续搜索姓名、邮箱或组织"
							: (placeholder ??
								(kind === "user" ? "搜索姓名或邮箱" : "搜索组织名称或路径"))
					}
					value={query}
				/>
			</div>
			{expanded && (
				<div className="directory-menu">
					{loading ? (
						<div className="directory-status" role="status" aria-live="polite">
							<span className="directory-status-spinner" aria-hidden="true" />
							<p>
								<strong>正在读取目录</strong>
								正在同步可搜索的人员和组织范围…
							</p>
						</div>
					) : directoryError ? (
						<div className="directory-status" role="status" aria-live="polite">
							<SearchIcon aria-hidden="true" size={16} />
							<p>
								<strong>目录暂时无法读取</strong>
								请稍后重试或联系管理员。
							</p>
						</div>
					) : visibleOptions.length === 0 ? (
						<div className="directory-status" role="status" aria-live="polite">
							<SearchIcon aria-hidden="true" size={16} />
							<p>
								<strong>{query ? "没有匹配结果" : "目录为空"}</strong>
								{query
									? "试试姓名、邮箱、组织名称或路径。"
									: "输入关键词后开始搜索。"}
							</p>
						</div>
					) : (
						<Listbox
							aria-label={`${label}搜索结果`}
							className="directory-results"
							id={listboxId}
						>
							{visibleOptions.map((option, index) => (
								<ListboxOption
									aria-selected={false}
									className={cn(
										"directory-result",
										index === activeIndex && "directory-result-active",
									)}
									id={`${id}-${option.id}`}
									key={option.id}
									onClick={() => add(option)}
									onMouseDown={keepInputFocus}
									onMouseEnter={() => setActiveIndex(index)}
									type="button"
									variant="ghost"
								>
									<span className="directory-result-mark" aria-hidden="true">
										{option.type === "user" ? "人" : "组"}
									</span>
									<span className="directory-result-copy">
										<strong className="directory-result-name">
											{option.name}
										</strong>
										<small className="directory-result-meta">
											{option.secondary}
										</small>
										{option.detail ? (
											<small className="directory-result-meta">
												{option.detail}
											</small>
										) : null}
									</span>
								</ListboxOption>
							))}
						</Listbox>
					)}
					{query && !loading ? (
						<Button
							className="directory-clear"
							onClick={clearQuery}
							onMouseDown={keepInputFocus}
							tabIndex={-1}
							type="button"
							variant="ghost"
						>
							清空搜索
						</Button>
					) : null}
				</div>
			)}
			<div className="directory-help">
				<span>{help}</span>
				<span>已选 {selected.length} 项 · Enter 添加</span>
			</div>
			{error ? (
				<p
					aria-live="assertive"
					className="text-destructive text-sm"
					id={validationErrorId}
				>
					{error}
				</p>
			) : null}
		</div>
	);
}
