import { Link } from "@tanstack/react-router";
import { Bot, House } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";

/** 路由未匹配时在应用外壳内显示，导航和账号区保持可用（#2297）。 */
export function NotFoundScreen() {
	return (
		<main className="platform-content management-content">
			<section aria-labelledby="not-found-heading" className="space-y-4">
				<h1 id="not-found-heading" className="font-semibold text-[28px]">
					页面不存在
				</h1>
				<p className="text-muted-foreground">
					链接可能已失效或地址有误。可以回到工作台，或从 Agent 目录重新进入。
				</p>
				<div className="flex flex-wrap gap-3">
					<Link className={buttonVariants()} to="/">
						<House aria-hidden="true" data-icon="inline-start" />
						返回工作台
					</Link>
					<Link className={buttonVariants({ variant: "outline" })} to="/agents">
						<Bot aria-hidden="true" data-icon="inline-start" />
						前往 Agent 目录
					</Link>
				</div>
			</section>
		</main>
	);
}
