import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { connectionApi } from "../api";

type Candidate = Awaited<
	ReturnType<typeof connectionApi.searchApprovalEmployees>
>["candidates"][number];

export function EmployeePicker({
	label,
	onSelect,
	onQueryChange,
	excludedIds = [],
	disabled = false,
}: {
	label: string;
	onSelect: (candidate: Candidate) => void;
	onQueryChange?: () => void;
	excludedIds?: string[];
	disabled?: boolean;
}) {
	const id = useId();
	const [query, setQuery] = useState("");
	const [debounced, setDebounced] = useState("");
	const [open, setOpen] = useState(false);
	const [active, setActive] = useState(-1);
	useEffect(() => {
		if (active >= 0)
			document
				.getElementById(`${id}-${active}`)
				?.scrollIntoView?.({ block: "nearest" });
	}, [active, id]);
	const normalized = query.trim();
	useEffect(() => {
		const timer = setTimeout(() => setDebounced(normalized), 250);
		return () => clearTimeout(timer);
	}, [normalized]);
	const candidates = useQuery({
		queryKey: ["approval-employees", debounced],
		queryFn: () => connectionApi.searchApprovalEmployees(debounced),
		enabled:
			!disabled && open && debounced.length >= 2 && debounced === normalized,
		retry: false,
		staleTime: 0,
	});
	const loading = normalized !== debounced || candidates.isFetching;
	const options =
		loading || candidates.isError
			? []
			: (candidates.data?.candidates ?? []).filter(
					(item) => !excludedIds.includes(item.candidateId),
				);
	const expanded = open && !disabled && normalized.length >= 2;
	const select = (candidate: Candidate) => {
		onSelect(candidate);
		setQuery("");
		setOpen(false);
		setActive(-1);
	};
	return (
		<fieldset
			className="employee-picker"
			onBlur={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
			}}
		>
			<label htmlFor={id}>{label}</label>
			<div className="approval-search">
				<Search size={15} aria-hidden="true" />
				<input
					id={id}
					role="combobox"
					aria-autocomplete="list"
					aria-expanded={expanded}
					aria-controls={expanded ? `${id}-options` : undefined}
					aria-activedescendant={
						expanded && options[active] ? `${id}-${active}` : undefined
					}
					placeholder="姓名或邮箱"
					maxLength={64}
					value={query}
					disabled={disabled}
					onFocus={() => setOpen(true)}
					onChange={(event) => {
						onQueryChange?.();
						setQuery(event.target.value);
						setOpen(true);
						setActive(-1);
					}}
					onKeyDown={(event) => {
						if (event.key === "Escape") {
							setOpen(false);
							return;
						}
						if (event.key === "ArrowDown" || event.key === "ArrowUp") {
							event.preventDefault();
							setOpen(true);
							setActive((current) =>
								options.length
									? (event.key === "ArrowDown"
											? current + 1
											: current <= 0
												? options.length - 1
												: current - 1) % options.length
									: -1,
							);
						}
						if (event.key === "Enter" && expanded) {
							event.preventDefault();
							const candidate = options[active];
							if (candidate) select(candidate);
						}
					}}
				/>
			</div>
			{expanded ? (
				<div className="employee-picker-dropdown">
					{loading ? (
						<p role="status">正在搜索员工...</p>
					) : candidates.isError ? (
						<div role="alert">
							<p>员工目录暂不可用，请联系管理员检查目录配置或稍后重试。</p>
							<button type="button" onClick={() => void candidates.refetch()}>
								重试
							</button>
						</div>
					) : options.length === 0 ? (
						<p role="status">未找到可选员工</p>
					) : null}
					<div
						id={`${id}-options`}
						role="listbox"
						aria-label={`${label}候选人`}
					>
						{options.map((candidate, index) => (
							<button
								type="button"
								role="option"
								aria-selected={active === index}
								id={`${id}-${index}`}
								key={candidate.candidateId}
								className="approval-candidate"
								onMouseDown={(event) => event.preventDefault()}
								onClick={() => select(candidate)}
							>
								<span>{candidate.displayName}</span>
								<small>{candidate.email}</small>
							</button>
						))}
					</div>
				</div>
			) : null}
		</fieldset>
	);
}
