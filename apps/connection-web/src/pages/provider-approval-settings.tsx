import { ChevronDown, Search } from "lucide-react";
import { useState } from "react";
import { Button } from "../components/ui/button";
import { providerLabel } from "../views";

type Setting = {
	providerId: string;
	approvalRequired: boolean;
	revision: string;
};

export function ProviderApprovalSettings(props: {
	settings?: Setting[];
	loading: boolean;
	failed: boolean;
	busy: boolean;
	onChange: (setting: Setting) => void;
}) {
	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState("all");
	const [page, setPage] = useState(1);
	const settings = props.settings ?? [];
	const needle = query.trim().toLocaleLowerCase();
	const filtered = settings.filter(
		(setting) =>
			(providerLabel(setting.providerId).toLocaleLowerCase().includes(needle) ||
				setting.providerId.toLocaleLowerCase().includes(needle)) &&
			(filter === "all" || setting.approvalRequired === (filter === "on")),
	);
	const pages = Math.max(1, Math.ceil(filtered.length / 15));
	const currentPage = Math.min(page, pages);
	const start = (currentPage - 1) * 15;
	return (
		<details className="provider-approval-settings">
			<summary>
				<strong>连接器审批设置</strong>
				<span className="provider-approval-hint">
					默认直接连接，按需开启审批
				</span>
				<span className="provider-approval-count" role="status">
					{props.loading
						? "正在加载…"
						: props.failed
							? "设置加载失败"
							: `${settings.filter((item) => item.approvalRequired).length} / ${settings.length} 已开启审批`}
				</span>
				<span className="provider-approval-expand">
					<span className="when-closed">展开设置</span>
					<span className="when-open">收起</span>
					<ChevronDown size={14} aria-hidden="true" />
				</span>
			</summary>
			<div className="provider-approval-body">
				<div className="provider-approval-tools">
					<label className="provider-approval-search">
						<Search size={15} aria-hidden="true" />
						<input
							aria-label="搜索连接器"
							placeholder="搜索连接器名称…"
							value={query}
							onChange={(event) => {
								setQuery(event.target.value);
								setPage(1);
							}}
						/>
					</label>
					<fieldset
						className="provider-approval-filters"
						aria-label="审批状态筛选"
					>
						{(
							[
								["all", "全部"],
								["on", "需要审批"],
								["off", "直接连接"],
							] as const
						).map(([value, label]) => (
							<button
								key={value}
								type="button"
								aria-pressed={filter === value}
								onClick={() => {
									setFilter(value);
									setPage(1);
								}}
							>
								{label}
							</button>
						))}
					</fieldset>
				</div>
				<div className="provider-approval-table-wrap">
					<table className="provider-approval-table">
						<thead>
							<tr>
								<th scope="col">连接器</th>
								<th scope="col">连接方式</th>
								<th scope="col">需要审批</th>
							</tr>
						</thead>
						<tbody>
							{filtered.slice(start, start + 15).map((setting) => (
								<tr key={setting.providerId}>
									<td>{providerLabel(setting.providerId)}</td>
									<td>
										<span
											className={
												setting.approvalRequired
													? "provider-approval-enabled"
													: "provider-approval-disabled"
											}
										>
											{setting.approvalRequired ? "需要审批" : "直接连接"}
										</span>
									</td>
									<td>
										<input
											type="checkbox"
											role="switch"
											aria-checked={setting.approvalRequired}
											className="provider-approval-switch"
											aria-label={`${providerLabel(setting.providerId)}需要审批`}
											checked={setting.approvalRequired}
											disabled={props.busy || props.loading || props.failed}
											onChange={() => props.onChange(setting)}
										/>
									</td>
								</tr>
							))}
							{!filtered.length ? (
								<tr>
									<td colSpan={3} className="provider-approval-empty">
										{props.loading
											? "正在加载审批设置…"
											: props.failed
												? "暂时无法显示审批设置。"
												: settings.length
													? "没有匹配的连接器，请修改搜索或筛选条件。"
													: "当前没有可配置的连接器。"}
									</td>
								</tr>
							) : null}
						</tbody>
					</table>
					<div className="provider-approval-pagination">
						<span>
							共 {filtered.length} 个
							{filtered.length
								? ` · ${start + 1}–${Math.min(start + 15, filtered.length)}`
								: ""}
						</span>
						<div>
							<span>每页 15 条</span>
							<Button
								variant="secondary"
								size="text"
								aria-label="上一页连接器"
								disabled={currentPage === 1}
								onClick={() => setPage(currentPage - 1)}
							>
								上一页
							</Button>
							<span>
								{currentPage} / {pages}
							</span>
							<Button
								variant="secondary"
								size="text"
								aria-label="下一页连接器"
								disabled={currentPage === pages}
								onClick={() => setPage(currentPage + 1)}
							>
								下一页
							</Button>
						</div>
					</div>
				</div>
				<p className="provider-approval-explanation">
					默认关闭，可直接连接账号。开启后，无有效审批资格的已有账号也无法发起新调用。关闭不自动恢复已暂停或撤销的客户端授权，账号验证和
					Action 授权仍需分别完成。
				</p>
			</div>
		</details>
	);
}
