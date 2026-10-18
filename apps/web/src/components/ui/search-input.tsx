import { Search } from "lucide-react";
import type * as React from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type SearchInputProps = Omit<React.ComponentProps<"input">, "type"> & {
	// 读屏标签；设计稿搜索框不显示可见标签，需要可见标签时用 Field + Label + Input。
	label: string;
	id: string;
	wrapperClassName?: string;
};

// 设计稿 .search-wrap：18px 图标距左 13px、垂直居中，输入框左内边距 39px。
function SearchInput({
	label,
	id,
	className,
	wrapperClassName,
	...props
}: SearchInputProps) {
	return (
		<div
			data-slot="search-input"
			className={cn("relative min-w-0 self-end", wrapperClassName)}
		>
			<Label className="sr-only" htmlFor={id}>
				{label}
			</Label>
			<Search
				aria-hidden="true"
				data-slot="search-input-icon"
				className="pointer-events-none absolute top-1/2 left-[13px] size-[18px] -translate-y-1/2 text-muted-foreground"
			/>
			<Input
				id={id}
				type="search"
				className={cn("pl-[39px]", className)}
				{...props}
			/>
		</div>
	);
}

export { SearchInput };
