import { ListFilter, RotateCcw } from "lucide-react";
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
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	type ConversationCapabilityPickerStateV1,
	type ConversationCapabilitySelectionV1,
	type ConversationCapabilityV1,
	confirmConversationCapability,
	createConversationCapabilityPickerState,
	filterConversationCapabilities,
	markConversationCapabilityConfirmed,
	moveConversationCapabilitySelection,
	resetConversationCapabilityScope,
	selectConversationCapability,
	updateConversationCapabilityParameter,
	updateConversationCapabilityQuery,
} from "./conversation-capability-picker.js";

function sameCapability(
	left: ConversationCapabilityV1,
	right: ConversationCapabilityV1,
) {
	return (
		left.kind === right.kind &&
		left.name === right.name &&
		left.source === right.source &&
		left.version === right.version &&
		left.identity === right.identity &&
		left.directoryRevision === right.directoryRevision
	);
}

type ConversationCapabilityComboboxProps = Readonly<{
	capabilities: readonly ConversationCapabilityV1[];
	draft: string;
	disabled: boolean;
	anchorRef: RefObject<HTMLElement | null>;
	onDraftChange: (value: string) => void;
	onSelectionChange?: (
		selection: ConversationCapabilitySelectionV1 | undefined,
	) => void;
}>;

type ConversationCapabilityComboboxState = Readonly<{
	open: boolean;
	slashDraft: boolean;
	query: string;
	filtered: readonly ConversationCapabilityV1[];
	activeIndex: number;
	selected: ConversationCapabilityV1 | undefined;
	selection: ConversationCapabilitySelectionV1 | undefined;
	listboxId: string;
	position?: { left: number; top: number };
	handleKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
	select: (capability: ConversationCapabilityV1) => void;
	dismiss: () => void;
}>;

function slashQuery(value: string) {
	const match = /^\/([^\s]*)/.exec(value);
	return match ? { token: match[0], query: match[1] } : undefined;
}

/**
 * Drives the slash-command combobox in the message composer. Keeping this
 * state separate from the legacy directory panel means the keyboard contract
 * is shared by new and existing conversation shells without duplicating the
 * metadata filtering rules.
 */
export function useConversationCapabilityCombobox({
	capabilities,
	draft,
	disabled,
	anchorRef,
	onDraftChange,
	onSelectionChange,
}: ConversationCapabilityComboboxProps): ConversationCapabilityComboboxState {
	const [activeIndex, setActiveIndex] = useState(0);
	const [selected, setSelected] = useState<ConversationCapabilityV1>();
	const [dismissedDraft, setDismissedDraft] = useState<string>();
	const previousDraft = useRef(draft);
	const listboxId = `conversation-capabilities-${useId().replaceAll(":", "")}`;
	const currentSlash = slashQuery(draft);
	const currentToken = currentSlash?.token;
	const currentQuery = currentSlash?.query;
	const filtered = useMemo(
		() =>
			currentQuery === undefined
				? []
				: filterConversationCapabilities(capabilities, currentQuery),
		[capabilities, currentQuery],
	);
	const selectedAuthorized =
		selected !== undefined &&
		capabilities.some(
			(capability) =>
				capability.kind === selected.kind &&
				capability.name === selected.name &&
				capability.identity === selected.identity &&
				capability.directoryRevision === selected.directoryRevision,
		);
	const selectedMatchesDraft =
		selected !== undefined &&
		selectedAuthorized &&
		currentSlash?.token.toLocaleLowerCase() ===
			`/${selected.name}`.toLocaleLowerCase();
	const selection = useMemo(
		() =>
			selectedMatchesDraft && selected && currentToken
				? {
						kind: selected.kind,
						name: selected.name,
						parameterText: draft.slice(currentToken.length).trim(),
						...(selected.identity ? { capabilityId: selected.identity } : {}),
						...(selected.directoryRevision
							? { directoryRevision: selected.directoryRevision }
							: {}),
					}
				: undefined,
		[selected, selectedMatchesDraft, currentToken, draft],
	);
	useEffect(() => {
		if (previousDraft.current !== draft) {
			previousDraft.current = draft;
			setDismissedDraft(undefined);
		}
		if (!selectedMatchesDraft && selected !== undefined) {
			setSelected(undefined);
			onSelectionChange?.(undefined);
		}
		if (activeIndex >= filtered.length && filtered.length > 0)
			setActiveIndex(filtered.length - 1);
	}, [
		activeIndex,
		draft,
		filtered.length,
		onSelectionChange,
		selected,
		selectedMatchesDraft,
	]);
	useEffect(() => {
		onSelectionChange?.(selection);
	}, [onSelectionChange, selection]);
	const open =
		!disabled &&
		currentSlash !== undefined &&
		!selectedMatchesDraft &&
		dismissedDraft !== draft &&
		filtered.length > 0;
	const select = useCallback(
		(capability: ConversationCapabilityV1) => {
			if (!currentSlash) return;
			const suffix = draft.slice(currentSlash.token.length);
			const nextDraft = `/${capability.name}${suffix}`;
			setSelected(capability);
			setActiveIndex(0);
			setDismissedDraft(nextDraft);
			onDraftChange(nextDraft);
			onSelectionChange?.({
				kind: capability.kind,
				name: capability.name,
				parameterText: suffix.trim(),
				...(capability.identity ? { capabilityId: capability.identity } : {}),
				...(capability.directoryRevision
					? { directoryRevision: capability.directoryRevision }
					: {}),
			});
		},
		[currentSlash, draft, onDraftChange, onSelectionChange],
	);
	const dismiss = useCallback(() => setDismissedDraft(draft), [draft]);
	const handleKeyDown = useCallback(
		(event: KeyboardEvent<HTMLElement>) => {
			if (event.nativeEvent.isComposing || !open) return;
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				setActiveIndex((current) => {
					if (filtered.length === 0) return 0;
					const delta = event.key === "ArrowDown" ? 1 : -1;
					return (current + delta + filtered.length) % filtered.length;
				});
				return;
			}
			if (event.key === "Home" || event.key === "End") {
				event.preventDefault();
				setActiveIndex(
					event.key === "Home" ? 0 : Math.max(filtered.length - 1, 0),
				);
				return;
			}
			if (
				(event.key === "Enter" || event.key === "Tab") &&
				filtered[activeIndex]
			) {
				event.preventDefault();
				select(filtered[activeIndex]);
				return;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				dismiss();
			}
		},
		[activeIndex, dismiss, filtered, open, select],
	);
	const [position, setPosition] = useState<{ left: number; top: number }>();
	useLayoutEffect(() => {
		if (!open) return;
		const updatePosition = () => {
			const anchor = anchorRef.current;
			if (!anchor) return;
			const rect = anchor.getBoundingClientRect();
			const width = Math.min(320, window.innerWidth - 32);
			const left = Math.min(
				Math.max(16, rect.left),
				window.innerWidth - width - 16,
			);
			const top = rect.bottom + 8;
			setPosition({ left, top });
		};
		updatePosition();
		window.addEventListener("resize", updatePosition);
		window.addEventListener("scroll", updatePosition, true);
		return () => {
			window.removeEventListener("resize", updatePosition);
			window.removeEventListener("scroll", updatePosition, true);
		};
	}, [anchorRef, open]);
	return {
		open,
		slashDraft: currentSlash !== undefined,
		query: currentSlash?.query ?? "",
		filtered,
		activeIndex,
		selected: selectedMatchesDraft ? selected : undefined,
		selection,
		listboxId,
		handleKeyDown,
		select,
		dismiss,
		position,
	};
}

export function ConversationCapabilityMenu({
	state,
}: {
	state: ConversationCapabilityComboboxState & {
		position?: { left: number; top: number };
	};
}) {
	if (!state.open) return null;
	return (
		<div
			id={state.listboxId}
			role="listbox"
			aria-label="命令或 Skill"
			className="fixed z-[120] max-h-[min(248px,40dvh)] w-[min(320px,calc(100vw-32px))] overflow-y-auto rounded-[12px] border bg-popover p-1 text-popover-foreground shadow-lg"
			style={state.position}
		>
			{state.filtered.map((capability, index) => (
				<button
					key={`${capability.kind}:${capability.name}:${capability.identity ?? ""}`}
					type="button"
					role="option"
					aria-selected={index === state.activeIndex}
					id={`${state.listboxId}-${index}`}
					className={`flex min-h-11 w-full items-start gap-2 rounded-[10px] px-3 py-2 text-left text-sm ${index === state.activeIndex ? "bg-accent text-accent-foreground" : "hover:bg-muted"}`}
					onMouseDown={(event) => event.preventDefault()}
					onClick={() => state.select(capability)}
				>
					<span className="min-w-0 flex-1">
						<strong className="block break-all">/{capability.name}</strong>
						<span className="block truncate text-muted-foreground text-xs">
							{capability.description}
						</span>
					</span>
					<Badge variant="secondary">{capability.kind}</Badge>
				</button>
			))}
		</div>
	);
}

function reconcileState(
	state: ConversationCapabilityPickerStateV1,
	scopeKey: string,
	capabilities: readonly ConversationCapabilityV1[],
	disabled: boolean,
) {
	const scoped = resetConversationCapabilityScope(state, scopeKey);
	if (disabled)
		return {
			...scoped,
			selected: undefined,
			parameterText: "",
			confirmed: false,
		};
	if (
		!scoped.selected ||
		capabilities.some((capability) =>
			sameCapability(capability, scoped.selected as ConversationCapabilityV1),
		)
	)
		return scoped;
	return {
		...scoped,
		selected: undefined,
		parameterText: "",
		confirmed: false,
	};
}

export function ConversationCapabilityPickerPanel({
	capabilities,
	scopeKey,
	disabled,
	onConfirm,
}: {
	capabilities: readonly ConversationCapabilityV1[];
	scopeKey: string;
	disabled: boolean;
	onConfirm?: (selection: ConversationCapabilitySelectionV1) => void;
}) {
	const [open, setOpen] = useState(false);
	const [state, setState] = useState<ConversationCapabilityPickerStateV1>(() =>
		createConversationCapabilityPickerState(scopeKey),
	);
	const scopedState = useMemo(
		() => reconcileState(state, scopeKey, capabilities, disabled),
		[state, scopeKey, capabilities, disabled],
	);
	useEffect(() => {
		setState((current) =>
			reconcileState(current, scopeKey, capabilities, disabled),
		);
	}, [scopeKey, capabilities, disabled]);
	const filtered = useMemo(
		() => filterConversationCapabilities(capabilities, scopedState.query),
		[capabilities, scopedState.query],
	);
	const selected = scopedState.selected;
	const confirmed = scopedState.confirmed;
	function update(next: ConversationCapabilityPickerStateV1) {
		setState(next);
	}
	function onQuery(value: string) {
		update(updateConversationCapabilityQuery(scopedState, value));
	}
	function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
		if (event.nativeEvent.isComposing) return;
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			update(
				moveConversationCapabilitySelection(
					scopedState,
					capabilities,
					event.key === "ArrowDown" ? 1 : -1,
				),
			);
		} else if (event.key === "Enter" && filtered[scopedState.selectedIndex]) {
			event.preventDefault();
			update(
				selectConversationCapability(
					scopedState,
					filtered[scopedState.selectedIndex],
				),
			);
		}
	}
	function reset() {
		update(createConversationCapabilityPickerState(scopeKey));
	}
	if (capabilities.length === 0) return null;
	return (
		<section
			className="mb-5 rounded-[14px] border bg-card p-4"
			aria-label="对话能力"
		>
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex items-center gap-2">
					<ListFilter className="size-4" aria-hidden="true" />
					<h2 className="font-medium">选择命令或 Skill</h2>
					<Badge variant="outline">{capabilities.length} 项</Badge>
				</div>
				<Button
					type="button"
					variant="ghost"
					disabled={disabled}
					aria-expanded={open}
					onClick={() => setOpen((value) => !value)}
				>
					{open ? "收起" : "打开"}
				</Button>
			</div>
			{open && (
				<div className="mt-4 space-y-3">
					<Input
						value={scopedState.query}
						aria-label="搜索命令或 Skill"
						placeholder="输入名称、说明或来源"
						disabled={disabled}
						onChange={(event) => onQuery(event.target.value)}
						onKeyDown={onKeyDown}
					/>
					<div className="grid gap-2">
						{filtered.length === 0 ? (
							<p className="text-muted-foreground text-sm">没有匹配的能力。</p>
						) : (
							filtered.map((capability, index) => (
								<Button
									variant="ghost"
									type="button"
									aria-pressed={selected?.name === capability.name}
									key={`${capability.kind}:${capability.name}`}
									className={`min-h-11 rounded-[10px] border px-3 py-2 text-left ${index === scopedState.selectedIndex ? "border-primary bg-muted" : "border-border"}`}
									disabled={disabled}
									onClick={() =>
										update(
											selectConversationCapability(scopedState, capability),
										)
									}
								>
									<span className="flex items-center justify-between gap-2">
										<strong className="break-all">{capability.name}</strong>
										<Badge variant="secondary">{capability.kind}</Badge>
									</span>
									<span className="mt-1 block text-muted-foreground text-sm">
										{capability.description}
									</span>
									<span className="mt-1 block text-muted-foreground text-xs">
										{capability.source}
										{capability.version ? ` · ${capability.version}` : ""}
									</span>
								</Button>
							))
						)}
					</div>
					{selected && (
						<div className="space-y-3 rounded-[10px] border border-dashed p-3">
							<p className="font-medium">{selected.name} 参数</p>
							<Input
								value={scopedState.parameterText}
								aria-label="能力参数"
								placeholder={selected.parameterHint ?? "可选参数"}
								disabled={disabled}
								onChange={(event) =>
									update(
										updateConversationCapabilityParameter(
											scopedState,
											event.target.value,
										),
									)
								}
							/>
							<div className="flex flex-wrap gap-2">
								<Button
									type="button"
									disabled={
										disabled ||
										confirmed ||
										confirmConversationCapability(scopedState) === undefined
									}
									onClick={() => {
										const next =
											markConversationCapabilityConfirmed(scopedState);
										update(next);
										const selection = confirmConversationCapability(next);
										if (selection) onConfirm?.(selection);
									}}
								>
									确认选择
								</Button>
								<Button type="button" variant="ghost" onClick={reset}>
									<RotateCcw aria-hidden="true" />
									清除
								</Button>
							</div>
						</div>
					)}
					{confirmed && (
						<Alert>
							<AlertDescription>
								选择已确认，正在通过当前会话接缝提交。
							</AlertDescription>
						</Alert>
					)}
				</div>
			)}
		</section>
	);
}
