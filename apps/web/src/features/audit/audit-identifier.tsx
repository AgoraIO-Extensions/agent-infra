import { Check, Copy } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const IDENTIFIER_PREVIEW_LENGTH = 18;

export function shortIdentifier(value: string | null | undefined) {
	if (!value) return "未提供";
	return value.length > IDENTIFIER_PREVIEW_LENGTH
		? `${value.slice(0, 8)}…${value.slice(-6)}`
		: value;
}

type AuditIdentifierProps = {
	value: string | null | undefined;
	label: string;
	compact?: boolean;
	className?: string;
};

/**
 * Render identifiers in audit-only surfaces without relying on a title tooltip.
 * Compact values use a shared button disclosure so keyboard and touch users can inspect
 * the complete value; detail values remain complete and offer an explicit copy
 * action for precise follow-up filtering.
 */
export function AuditIdentifier({
	value,
	label,
	compact = false,
	className,
}: AuditIdentifierProps) {
	const fullValueId = useId();
	const [copied, setCopied] = useState(false);
	const [expanded, setExpanded] = useState(false);
	if (!value)
		return (
			<span className={cn("text-muted-foreground", className)}>未提供</span>
		);
	const identifier: string = value;

	const preview = shortIdentifier(identifier);
	const canExpand = preview !== identifier;

	async function copyValue() {
		try {
			if (!navigator.clipboard) return;
			await navigator.clipboard.writeText(identifier);
			setCopied(true);
		} catch {
			setCopied(false);
		}
	}

	if (compact && canExpand) {
		return (
			<span
				className={cn(
					"audit-identifier inline-flex min-w-0 max-w-full flex-wrap items-start gap-1",
					className,
				)}
			>
				<Button
					type="button"
					variant="ghost"
					aria-expanded={expanded}
					aria-controls={expanded ? fullValueId : undefined}
					aria-label={`${expanded ? "收起" : "展开"}完整${label}`}
					title={identifier}
					className="h-auto min-h-11 max-w-full px-1 py-2 text-left font-normal"
					onClick={() => setExpanded((open) => !open)}
				>
					<code>{expanded ? "收起" : preview}</code>
				</Button>
				{expanded && (
					<code
						id={fullValueId}
						className="mt-1 block max-w-full break-all"
						data-full-value={identifier}
					>
						{identifier}
					</code>
				)}
			</span>
		);
	}

	return (
		<span
			className={cn(
				"audit-identifier inline-flex min-w-0 max-w-full items-start gap-2",
				className,
			)}
		>
			<code className="min-w-0 break-all" data-full-value={identifier}>
				{identifier}
			</code>
			<Button
				type="button"
				variant="ghost"
				size="icon"
				aria-label={`${copied ? "已复制" : "复制"}${label}`}
				title={`${copied ? "已复制" : "复制"}${label}`}
				onClick={() => void copyValue()}
			>
				{copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
			</Button>
		</span>
	);
}
