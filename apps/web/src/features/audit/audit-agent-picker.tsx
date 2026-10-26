import { useQuery } from "@tanstack/react-query";
import { SearchIcon, XIcon } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { IdentifierText } from "@/components/ui/identifier-text";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Listbox, ListboxOption } from "@/components/ui/listbox";
import { cn } from "@/lib/utils";
import { loadAdminAgents } from "../admin-agents/admin-agents.js";
import { loadAgentDiscovery } from "../agent-discovery/agent-discovery.js";
import { agentMarkGlyph } from "../agent-mark.js";
import { useApplicationSession } from "../application-shell.js";
import { usePickerDismiss } from "../directory-fields.js";
import type { AuditScope } from "./audit-query.js";

export type AuditAgentOption = { agentId: string; name: string };

/** 结果层最多列出的候选数；更多时提示继续输入缩小范围。 */
const maximumVisibleOptions = 50;

/**
 * 候选只来自服务端已授权的 Agent 列表：个人审计为当前可见的 Agent，平台审计为管理员
 * Agent 列表。选择器只帮助填写 agentId，审计查询仍由服务端按当前权限核验。
 */
export async function loadAuditAgentOptions(
	scope: AuditScope,
	signal: AbortSignal,
): Promise<AuditAgentOption[]> {
	const result =
		scope === "administrator"
			? await loadAdminAgents(undefined, signal)
			: await loadAgentDiscovery(undefined, "visible", signal);
	if (result.kind !== "ready") throw new Error("Agent list is unavailable");
	const options = new Map<string, AuditAgentOption>();
	for (const agent of result.agents)
		options.set(agent.agentId, { agentId: agent.agentId, name: agent.name });
	return [...options.values()].sort(
		(left, right) =>
			left.name.localeCompare(right.name, "zh-CN") ||
			left.agentId.localeCompare(right.agentId),
	);
}

/**
 * 审计 Agent 筛选：沿用目录选择器的交互（combobox + listbox、↑/↓/Enter/Esc、
 * 点击或焦点离开时收起、已选 chip 可移除），单选，按名称或 ID 搜索；
 * 调用方提交的仍是所选 Agent 的 ID。展开时才读取候选。
 */
export function AuditAgentPicker({
	id,
	label,
	scope,
	value,
	onChange,
}: {
	id: string;
	label: string;
	scope: AuditScope;
	value: AuditAgentOption | null;
	onChange: (value: AuditAgentOption | null) => void;
}) {
	const { identityKey } = useApplicationSession();
	const [query, setQuery] = useState("");
	const [open, setOpen] = useState(false);
	const [activeIndex, setActiveIndex] = useState(0);
	const pickerRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	usePickerDismiss(pickerRef, open, () => setOpen(false));
	const candidates = useQuery({
		queryKey: ["audit-agent-options", identityKey, scope],
		queryFn: ({ signal }) => loadAuditAgentOptions(scope, signal),
		enabled: open && Boolean(identityKey),
		retry: false,
		gcTime: 0,
		staleTime: 30_000,
	});
	const search = query.trim().toLocaleLowerCase();
	const matches = (candidates.data ?? []).filter(
		(option) =>
			option.agentId !== value?.agentId &&
			(!search ||
				option.name.toLocaleLowerCase().includes(search) ||
				option.agentId.toLocaleLowerCase().includes(search)),
	);
	const visibleOptions = matches.slice(0, maximumVisibleOptions);
	// 读取中只用于还没有候选时；展开后回到标签页等后台重读期间保留已列出的候选与当前选项（#3387）。
	// 读取失败不再提供旧候选（读取函数把无权与暂时失败合并为同一个错误）。
	const loading = candidates.isPending;
	const listboxId = `${id}-options`;
	const showListbox =
		open && !loading && !candidates.isError && visibleOptions.length > 0;
	// 同步把焦点留在输入框：异步回收会在用户已移到下一个字段后抢走焦点。
	const focusInput = () => {
		if (document.activeElement !== inputRef.current) inputRef.current?.focus();
	};
	const select = (option: AuditAgentOption | undefined) => {
		if (!open || loading || candidates.isError || !option) return;
		// 先回收焦点再收起：回收触发的 onFocus 不会重新展开结果层。
		focusInput();
		onChange(option);
		setQuery("");
		setActiveIndex(0);
		setOpen(false);
	};
	const keepInputFocus = (event: { preventDefault: () => void }) =>
		event.preventDefault();
	return (
		<div className="directory-field" ref={pickerRef}>
			<Label htmlFor={id}>{label}</Label>
			<div className="directory-control">
				{value ? (
					<div className="directory-chips">
						<span className="directory-chip" data-resolved>
							<span className="directory-chip-label">
								<span className="directory-chip-name">{value.name}</span>
							</span>
							<Button
								aria-label={`移除 ${value.name}`}
								className="directory-chip-remove"
								onClick={() => {
									onChange(null);
									setOpen(true);
									focusInput();
								}}
								onMouseDown={keepInputFocus}
								size="icon"
								type="button"
								variant="ghost"
							>
								<XIcon aria-hidden="true" size={14} />
							</Button>
						</span>
					</div>
				) : null}
				<Input
					ref={inputRef}
					autoComplete="off"
					role="combobox"
					aria-activedescendant={
						showListbox && visibleOptions[activeIndex]
							? `${id}-${visibleOptions[activeIndex].agentId}`
							: undefined
					}
					aria-autocomplete="list"
					aria-controls={showListbox ? listboxId : undefined}
					aria-expanded={open}
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
							// 结果层收起时 Enter 照常提交查询表单。
							if (!open) return;
							event.preventDefault();
							select(visibleOptions[activeIndex]);
						} else if (event.key === "Escape" && open) {
							event.preventDefault();
							event.stopPropagation();
							setOpen(false);
						}
					}}
					placeholder={value ? "搜索其他 Agent" : "搜索 Agent 名称"}
					value={query}
				/>
			</div>
			{open && (
				<div className="directory-menu">
					{loading ? (
						<div className="directory-status" role="status" aria-live="polite">
							<span className="directory-status-spinner" aria-hidden="true" />
							<p>
								<strong>正在读取 Agent</strong>
								只列出当前有权查看的 Agent。
							</p>
						</div>
					) : candidates.isError ? (
						<div className="directory-status" role="status" aria-live="polite">
							<SearchIcon aria-hidden="true" size={16} />
							<p>
								<strong>Agent 列表暂时无法读取</strong>
								请稍后重试。
							</p>
						</div>
					) : visibleOptions.length === 0 ? (
						<div className="directory-status" role="status" aria-live="polite">
							<SearchIcon aria-hidden="true" size={16} />
							<p>
								<strong>
									{search ? "没有匹配的 Agent" : "没有可选的 Agent"}
								</strong>
								{search
									? "试试其他名称或 Agent ID。"
									: "当前没有可筛选的 Agent。"}
							</p>
						</div>
					) : (
						<>
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
										id={`${id}-${option.agentId}`}
										key={option.agentId}
										onClick={() => select(option)}
										onMouseDown={keepInputFocus}
										onMouseEnter={() => setActiveIndex(index)}
										type="button"
										variant="ghost"
									>
										<span className="directory-result-mark" aria-hidden="true">
											{agentMarkGlyph(option.name)}
										</span>
										<span className="directory-result-copy">
											<strong className="directory-result-name">
												{option.name}
											</strong>
											<small className="directory-result-meta">
												<IdentifierText
													value={option.agentId}
													label="Agent ID"
												/>
											</small>
										</span>
									</ListboxOption>
								))}
							</Listbox>
							{matches.length > visibleOptions.length ? (
								<p className="directory-status">
									仅列出前 {maximumVisibleOptions} 项，继续输入名称缩小范围。
								</p>
							) : null}
						</>
					)}
				</div>
			)}
		</div>
	);
}
