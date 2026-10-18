import { ChevronDownIcon } from "lucide-react";
import type * as React from "react";
import { cn } from "@/lib/utils";

type NativeSelectProps = Omit<React.ComponentProps<"select">, "size"> & {
	size?: "sm" | "default";
};

function NativeSelect({
	className,
	size = "default",
	...props
}: NativeSelectProps) {
	return (
		<div
			className={cn(
				"group/native-select relative w-full min-w-0 has-[select:disabled]:opacity-50",
				className,
			)}
			data-slot="native-select-wrapper"
			data-size={size}
		>
			<select
				data-slot="native-select"
				data-size={size}
				className="h-11 w-full min-w-0 select-none appearance-none rounded-[10px] border border-input bg-transparent py-[9px] pr-10 pl-3 text-[13px] leading-6 outline-none transition-colors selection:bg-primary selection:text-primary-foreground placeholder:text-[var(--muted-ink)] focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/25 disabled:cursor-not-allowed aria-invalid:border-destructive aria-invalid:ring-1 aria-invalid:ring-destructive/20 data-[size=sm]:h-[38px] data-[size=sm]:rounded-[10px] data-[size=sm]:py-1.5 md:text-sm dark:bg-input/30 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 dark:hover:bg-input/50"
				{...props}
			/>
			<ChevronDownIcon
				className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 select-none text-muted-foreground"
				aria-hidden="true"
				data-slot="native-select-icon"
			/>
		</div>
	);
}

function NativeSelectOption({
	className,
	...props
}: React.ComponentProps<"option">) {
	return (
		<option
			data-slot="native-select-option"
			className={cn("bg-[Canvas] text-[CanvasText]", className)}
			{...props}
		/>
	);
}

function NativeSelectOptGroup({
	className,
	...props
}: React.ComponentProps<"optgroup">) {
	return (
		<optgroup
			data-slot="native-select-optgroup"
			className={cn("bg-[Canvas] text-[CanvasText]", className)}
			{...props}
		/>
	);
}

export { NativeSelect, NativeSelectOptGroup, NativeSelectOption };
