import { useQuery } from "@tanstack/react-query";
import { SearchIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Listbox, ListboxOption } from "@/components/ui/listbox";
import { cn } from "@/lib/utils";

type DirectoryPickerKind = "user" | "organization";
type DirectoryPickerOption = {
	id: string;
	name: string;
	secondary: string;
	detail?: string;
	type: DirectoryPickerKind;
};

async function readDirectory(
	kind: DirectoryPickerKind,
	query: string,
	ids: readonly string[],
	signal: AbortSignal,
): Promise<DirectoryPickerOption[]> {
	const batches: readonly string[][] = ids.length
		? Array.from({ length: Math.ceil(ids.length / 50) }, (_, index) =>
				ids.slice(index * 50, (index + 1) * 50),
			)
		: [[]];
	const results = await Promise.all(
		batches.map(async (batch) => {
			const params = new URLSearchParams({ kind, q: query, limit: "50" });
			if (batch.length) params.set("ids", batch.join(","));
			const response = await fetch(`/api/v2/directory/search?${params}`, {
				signal,
				headers: { Accept: "application/json" },
			});
			if (!response.ok) throw new Error("directory search unavailable");
			const body = (await response.json()) as {
				items?: {
					kind: DirectoryPickerKind;
					canonicalId: string;
					displayName: string;
					email?: string;
					organizationPath?: string;
				}[];
			};
			if (
				!Array.isArray(body.items) ||
				body.items.some(
					(item) =>
						!item ||
						typeof item.canonicalId !== "string" ||
						typeof item.displayName !== "string" ||
						(item.email !== undefined && typeof item.email !== "string") ||
						(item.organizationPath !== undefined &&
							typeof item.organizationPath !== "string"),
				)
			)
				throw new Error("directory response invalid");
			return body.items
				.filter(
					(item) =>
						item.kind === kind &&
						(!batch.length || batch.includes(item.canonicalId)),
				)
				.map((item) => ({
					id: item.canonicalId,
					name: item.displayName,
					secondary:
						kind === "user"
							? (item.email ?? "")
							: (item.organizationPath ?? ""),
					detail: kind === "user" ? item.organizationPath : undefined,
					type: item.kind,
				}));
		}),
	);
	return results.flat();
}

export function DirectoryRecords({
	kind,
	ids,
}: {
	kind: DirectoryPickerKind;
	ids: readonly string[];
}) {
	const directory = useQuery({
		queryKey: ["directory-records", kind, ids],
		queryFn: ({ signal }) => readDirectory(kind, "", ids, signal),
		gcTime: 0,
		retry: false,
	});
	if (directory.isPending || directory.isFetching)
		return <span role="status">正在读取目录…</span>;
	if (directory.isError) return <span role="status">目录暂时无法读取</span>;

	return (
		<ul className="space-y-2">
			{ids.map((id) => {
				const item = directory.data.find((item) => item.id === id);
				return (
					<li key={id}>
						{item ? (
							<>
								<span>{item.name}</span>
								{item.secondary ? (
									<small className="block break-words text-muted-foreground">
										{item.secondary}
									</small>
								) : null}
							</>
						) : (
							"目录记录不可用"
						)}
					</li>
				);
			})}
		</ul>
	);
}

function splitDirectoryValue(value: string) {
	return value
		.split(/\n|,/)
		.map((item) => item.trim())
		.filter(Boolean);
}

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
}: {
	id: string;
	label: string;
	help: string;
	kind: DirectoryPickerKind;
	value: string;
	onChange: (value: string) => void;
	error?: string;
	describedBy?: string;
	errorId?: string;
	disabled?: boolean;
	required?: boolean;
}) {
	const selectedIds = splitDirectoryValue(value);
	const selectedKey = selectedIds.join(",");
	const [query, setQuery] = useState("");
	const [open, setOpen] = useState(false);
	const [activeIndex, setActiveIndex] = useState(0);
	const [loading, setLoading] = useState(false);
	const [directoryOptions, setDirectoryOptions] = useState<
		DirectoryPickerOption[]
	>([]);
	const [knownDirectoryOptions, setKnownDirectoryOptions] = useState<
		Record<string, DirectoryPickerOption>
	>({});
	const [directoryError, setDirectoryError] = useState(false);
	const pickerRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		const closeOnOutsidePointer = (event: PointerEvent) => {
			if (
				event.target instanceof Node &&
				!pickerRef.current?.contains(event.target)
			)
				setOpen(false);
		};
		document.addEventListener("pointerdown", closeOnOutsidePointer);
		return () =>
			document.removeEventListener("pointerdown", closeOnOutsidePointer);
	}, [open]);
	useEffect(() => {
		if (!open && !selectedKey) return;
		const controller = new AbortController();
		setDirectoryOptions([]);
		setActiveIndex(0);
		setLoading(true);
		setDirectoryError(false);
		readDirectory(
			kind,
			open ? query : "",
			open ? [] : selectedKey.split(","),
			controller.signal,
		)
			.then((nextOptions) => {
				if (controller.signal.aborted) return;
				setDirectoryOptions(nextOptions);
				setKnownDirectoryOptions((current) => {
					const merged = { ...current };
					for (const option of nextOptions) merged[option.id] = option;
					return merged;
				});
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
	}, [kind, open, query, selectedKey]);
	const options = directoryOptions;
	const selected = selectedIds.map(
		(id) =>
			knownDirectoryOptions[id] ?? {
				id,
				name: "目录记录不可用",
				secondary: "无法读取目录详情，请重新搜索",
				type: kind,
			},
	);
	const add = (option: DirectoryPickerOption | undefined) => {
		if (
			disabled ||
			!open ||
			loading ||
			directoryError ||
			!option ||
			selectedIds.includes(option.id)
		)
			return;
		onChange([...selectedIds, option.id].join("\n"));
		setQuery("");
		setActiveIndex(0);
		setOpen(false);
	};
	const remove = (id: string) => {
		if (!disabled)
			onChange(selectedIds.filter((item) => item !== id).join("\n"));
	};
	return (
		<div className="directory-field" ref={pickerRef}>
			<Label htmlFor={id}>{label}</Label>
			<div
				className={cn("directory-control", error && "directory-control-error")}
			>
				<div className="directory-chips">
					{selected.map((item) => (
						<span className="directory-chip" key={item.id}>
							<span className="directory-chip-label">
								<span className="directory-chip-name">{item.name}</span>
								<small>{item.secondary}</small>
							</span>
							<Button
								disabled={disabled}
								aria-label={`移除 ${item.name}`}
								className="directory-chip-remove"
								onClick={() => remove(item.id)}
								size="icon-xs"
								type="button"
							>
								<XIcon aria-hidden="true" size={14} />
							</Button>
						</span>
					))}
				</div>
				<Input
					disabled={disabled}
					aria-required={required || undefined}
					role="combobox"
					aria-activedescendant={
						open && options[activeIndex]
							? `${id}-${options[activeIndex].id}`
							: undefined
					}
					aria-controls={`${id}-options`}
					aria-describedby={
						[describedBy, error ? validationErrorId : undefined]
							.filter(Boolean)
							.join(" ") || undefined
					}
					aria-expanded={open}
					aria-invalid={error ? true : undefined}
					aria-label={label}
					className="directory-input"
					id={id}
					onChange={(event) => {
						setQuery(event.target.value);
						setActiveIndex(0);
						setOpen(true);
					}}
					onFocus={() => setOpen(true)}
					onKeyDown={(event) => {
						if (event.key === "ArrowDown") {
							event.preventDefault();
							setOpen(true);
							setActiveIndex((index) =>
								Math.min(index + 1, Math.max(options.length - 1, 0)),
							);
						} else if (event.key === "ArrowUp") {
							event.preventDefault();
							setActiveIndex((index) => Math.max(index - 1, 0));
						} else if (event.key === "Enter") {
							event.preventDefault();
							add(options[activeIndex]);
						} else if (event.key === "Escape") {
							setOpen(false);
						}
					}}
					placeholder={
						selected.length > 0
							? "继续搜索姓名、邮箱或组织"
							: kind === "user"
								? "搜索姓名或邮箱"
								: "搜索组织名称或路径"
					}
					value={query}
				/>
			</div>
			{open && !disabled && (
				<Listbox
					aria-busy={loading}
					className="directory-menu"
					id={`${id}-options`}
				>
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
					) : options.length === 0 ? (
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
						<>
							{options.map((option, index) => (
								<ListboxOption
									aria-selected={selectedIds.includes(option.id)}
									className={cn(
										"directory-result",
										index === activeIndex && "directory-result-active",
									)}
									id={`${id}-${option.id}`}
									key={option.id}
									onClick={() => add(option)}
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
							<Button
								className="directory-clear"
								onClick={() => setQuery("")}
								size="xs"
								type="button"
								variant="ghost"
							>
								清空搜索
							</Button>
						</>
					)}
				</Listbox>
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
