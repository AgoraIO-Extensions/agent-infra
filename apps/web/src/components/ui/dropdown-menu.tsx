import { Menu } from "@base-ui/react/menu";
import { Check } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";

// 设计 #chat-settings .chat-setting-menu：role=menu + menuitemradio，弹层没有入场动画。
// 非模态：打开菜单不锁页面滚动，焦点在关闭后回到触发器（base-ui 默认行为）。
function DropdownMenu({ modal = false, ...props }: Menu.Root.Props) {
	return <Menu.Root modal={modal} {...props} />;
}

function DropdownMenuTrigger({ className, ...props }: Menu.Trigger.Props) {
	return (
		<Menu.Trigger
			data-slot="dropdown-menu-trigger"
			className={cn(className)}
			{...props}
		/>
	);
}

type DropdownMenuContentProps = Menu.Popup.Props &
	Pick<
		Menu.Positioner.Props,
		"side" | "align" | "sideOffset" | "collisionPadding"
	>;

/** 默认从触发器向上展开、左对齐，并在视口四边各留 16px（设计 positionChatSettingsMenus）。 */
function DropdownMenuContent({
	className,
	side = "top",
	align = "start",
	sideOffset = 6,
	collisionPadding = 16,
	"aria-label": label,
	children,
	...props
}: DropdownMenuContentProps) {
	// base-ui 默认用触发器给菜单命名；传了 aria-label 时改用隐藏标签，让菜单有自己的名称。
	const labelId = React.useId();
	return (
		<Menu.Portal>
			<Menu.Positioner
				className="z-50 outline-none"
				side={side}
				align={align}
				sideOffset={sideOffset}
				collisionPadding={collisionPadding}
			>
				<Menu.Popup
					data-slot="dropdown-menu-content"
					className={cn(
						"max-h-[min(304px,48dvh)] max-w-[calc(100vw-32px)] overflow-auto overscroll-contain rounded-[12px] border border-border bg-(--surface) p-[5px] text-(--fg) outline-none [box-shadow:var(--shadow)]",
						className,
					)}
					{...props}
					aria-labelledby={label ? labelId : props["aria-labelledby"]}
				>
					{label && (
						<span id={labelId} hidden>
							{label}
						</span>
					)}
					{children}
				</Menu.Popup>
			</Menu.Positioner>
		</Menu.Portal>
	);
}

function DropdownMenuGroup(props: Menu.Group.Props) {
	return <Menu.Group data-slot="dropdown-menu-group" {...props} />;
}

function DropdownMenuLabel({ className, ...props }: Menu.GroupLabel.Props) {
	return (
		<Menu.GroupLabel
			data-slot="dropdown-menu-label"
			className={cn(
				"px-[9px] py-[7px] text-[11px] text-muted-foreground leading-[1.5]",
				className,
			)}
			{...props}
		/>
	);
}

function DropdownMenuRadioGroup(props: Menu.RadioGroup.Props) {
	return <Menu.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />;
}

/** 设计 .chat-setting-option：命中 44px，选中项右侧 16px 勾。选择后默认关闭菜单。 */
function DropdownMenuRadioItem({
	className,
	children,
	closeOnClick = true,
	...props
}: Menu.RadioItem.Props & { children?: React.ReactNode }) {
	return (
		<Menu.RadioItem
			data-slot="dropdown-menu-radio-item"
			closeOnClick={closeOnClick}
			className={cn(
				"flex min-h-[44px] w-full cursor-default select-none items-center justify-between gap-[12px] rounded-[8px] border border-transparent p-[9px] text-left text-(--fg) text-[13px] outline-none data-disabled:pointer-events-none data-highlighted:border-border data-highlighted:bg-(--surface-raised) data-disabled:opacity-50",
				className,
			)}
			{...props}
		>
			<span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
			<Menu.RadioItemIndicator className="flex shrink-0">
				<Check aria-hidden="true" className="size-4" />
			</Menu.RadioItemIndicator>
		</Menu.RadioItem>
	);
}

function DropdownMenuSeparator({ className, ...props }: Menu.Separator.Props) {
	return (
		<Menu.Separator
			data-slot="dropdown-menu-separator"
			className={cn("mx-0 my-[4px] h-px bg-border", className)}
			{...props}
		/>
	);
}

export {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
};
