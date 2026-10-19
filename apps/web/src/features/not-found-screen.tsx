import { Link } from "@tanstack/react-router";
import { Bot, House } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { PageStateCard } from "./page-state-card";

/** 路由未匹配时在应用外壳内显示，导航和账号区保持可用（#2297）。 */
export function NotFoundScreen() {
	return (
		<main className="platform-content management-content">
			<section aria-labelledby="not-found-heading">
				<header className="page-heading">
					<div>
						<h1 id="not-found-heading">页面不存在</h1>
					</div>
				</header>
				<PageStateCard
					kind="not-found"
					action={
						<>
							<Link className={buttonVariants()} to="/">
								<House aria-hidden="true" data-icon="inline-start" />
								返回工作台
							</Link>
							{/* exact：未匹配的 /agents/... 地址以 /agents 为前缀，不让 Link 补 aria-current。 */}
							<Link
								activeOptions={{ exact: true }}
								className={buttonVariants({ variant: "outline" })}
								to="/agents"
							>
								<Bot aria-hidden="true" data-icon="inline-start" />
								前往 Agent 目录
							</Link>
						</>
					}
				/>
			</section>
		</main>
	);
}
