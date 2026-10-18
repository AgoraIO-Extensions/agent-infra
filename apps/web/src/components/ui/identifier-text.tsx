import { CopyIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** 内部 ID 的短形式：超过 12 个字符时显示前 8 位加「…」。 */
export function shortIdentifier(value: string) {
	return value.length > 12 ? `${value.slice(0, 8)}…` : value;
}

/**
 * 内部 ID 只在需要核对时以等宽短形式出现，title 保留完整值；
 * copyable 时提供 44×44 的复制按钮，复制完整值后短暂提示「已复制」。
 */
function IdentifierText({
	value,
	label,
	copyable = false,
	className,
}: {
	value: string;
	label: string;
	copyable?: boolean;
	className?: string;
}) {
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) return;
		const timer = window.setTimeout(() => setCopied(false), 1600);
		return () => window.clearTimeout(timer);
	}, [copied]);
	const clipboard =
		typeof navigator === "undefined" ? undefined : navigator.clipboard;
	return (
		<span
			data-slot="identifier-text"
			className={cn("inline-flex max-w-full items-center gap-1", className)}
		>
			<code className="font-mono text-[0.92em]" title={value}>
				{shortIdentifier(value)}
			</code>
			{copyable && clipboard ? (
				<>
					<Button
						aria-label={`复制 ${label}`}
						size="icon"
						title={`复制 ${label}`}
						type="button"
						variant="ghost"
						onClick={() => {
							void clipboard.writeText(value).then(
								() => setCopied(true),
								() => setCopied(false),
							);
						}}
					>
						<CopyIcon aria-hidden="true" />
					</Button>
					{copied ? (
						<span role="status" className="text-muted-foreground text-xs">
							已复制
						</span>
					) : null}
				</>
			) : null}
		</span>
	);
}

export { IdentifierText };
