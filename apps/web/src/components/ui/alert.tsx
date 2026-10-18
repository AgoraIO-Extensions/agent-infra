import { cva } from "class-variance-authority";
import { CircleAlert, Info, TriangleAlert } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";

// 设计 .notice / .notice.warn / .notice.danger：只有图标随 tone 变色，文字不变红。
type AlertTone = "info" | "warn" | "danger";

const alertVariants = cva(
	"group/alert flex w-full items-start gap-[10px] rounded-[12px] border border-border bg-card px-[14px] py-[13px] text-left text-[13px] text-foreground leading-[1.65] [&>svg]:mt-[2px] [&>svg]:size-[17px] [&>svg]:shrink-0",
	{
		variants: {
			tone: {
				info: "[&>svg]:text-(--accent)",
				warn: "[&>svg]:text-(--warning)",
				danger: "[&>svg]:text-(--danger)",
			},
		},
		defaultVariants: {
			tone: "info",
		},
	},
);

const defaultIcons = {
	info: Info,
	warn: TriangleAlert,
	danger: CircleAlert,
} satisfies Record<AlertTone, React.ComponentType<{ "aria-hidden"?: boolean }>>;

type AlertProps = React.ComponentProps<"div"> & {
	tone?: AlertTone;
	// 传 null 时不显示图标；未传时使用 tone 的默认图标。
	icon?: React.ReactNode;
	// 兼容层：旧调用点的 variant；传了 tone 时忽略。
	variant?: "default" | "destructive" | null;
};

// 旧调用点把图标作为首个子元素传入（lucide 组件或 svg，都带 aria-hidden），
// 这里把它们挪到图标位；其它带 aria-hidden 的原生元素（如装饰 span）保留在内容列。
function isLeadingIcon(node: React.ReactNode) {
	if (!React.isValidElement<{ "aria-hidden"?: unknown }>(node)) return false;
	const hidden = node.props["aria-hidden"];
	return (
		(hidden === true || hidden === "true") &&
		(typeof node.type !== "string" || node.type === "svg")
	);
}

function splitLeadingIcons(children: React.ReactNode) {
	const items = React.Children.toArray(children);
	const icons: React.ReactNode[] = [];
	while (items.length > 0 && isLeadingIcon(items[0])) icons.push(items.shift());
	return { icons, content: items };
}

// 角色规则（组件不设默认 role）：首屏静态说明不设 role；异步结果与可恢复状态用
// role="status"；操作或读取失败用 role="alert"，且只在失败发生后渲染。
function Alert({
	className,
	tone,
	icon,
	variant,
	role,
	children,
	...props
}: AlertProps) {
	// 兼容层：未传 tone 的旧调用点保持 role="alert"、destructive 视为 danger，
	// 且不自动加图标。只供未迁移的对话页与两个浏览器面板使用。
	const legacy = tone === undefined;
	const resolvedTone: AlertTone =
		tone ?? (variant === "destructive" ? "danger" : "info");
	// 显式传了 icon 时不再拆分子元素，避免静默丢弃调用方的内容。
	const { icons, content } =
		icon === undefined
			? splitLeadingIcons(children)
			: { icons: [], content: React.Children.toArray(children) };
	const DefaultIcon = defaultIcons[resolvedTone];
	const resolvedIcon =
		icon !== undefined ? (
			icon
		) : icons.length > 0 ? (
			icons
		) : legacy ? null : (
			<DefaultIcon aria-hidden={true} />
		);
	return (
		<div
			data-slot="alert"
			data-tone={resolvedTone}
			role={role ?? (legacy ? "alert" : undefined)}
			className={cn(
				alertVariants({ tone: resolvedTone }),
				// 兼容层：旧 destructive 调用点大多没有图标，保留红色说明文字作为失败提示。
				legacy &&
					variant === "destructive" &&
					"[&_[data-slot=alert-description]]:text-(--danger-ink)",
				className,
			)}
			{...props}
		>
			{resolvedIcon}
			<div
				data-slot="alert-content"
				className="flex min-w-0 flex-1 flex-col [&>[data-slot=button]]:mt-[10px] [&>[data-slot=button]]:self-start"
			>
				{content}
			</div>
		</div>
	);
}

function AlertTitle({ className, ...props }: React.ComponentProps<"strong">) {
	return (
		<strong
			data-slot="alert-title"
			className={cn(
				"block font-[650] text-foreground [&_a]:underline [&_a]:underline-offset-3",
				className,
			)}
			{...props}
		/>
	);
}

function AlertDescription({
	className,
	...props
}: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="alert-description"
			className={cn(
				"text-[13px] text-muted-foreground leading-[1.65] [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground [&_p:not(:last-child)]:mb-2",
				className,
			)}
			{...props}
		/>
	);
}

// 操作区跟在说明之后，纵向排在内容列里，不与文字并排、不绝对定位。
function AlertAction({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="alert-action"
			className={cn("mt-[10px] flex flex-wrap gap-2", className)}
			{...props}
		/>
	);
}

export type { AlertProps, AlertTone };
export { Alert, AlertAction, AlertDescription, AlertTitle, alertVariants };
