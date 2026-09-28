import type { ApprovalPolicyCatalog } from "@agent-infra/connection-contracts";
import { useQuery } from "@tanstack/react-query";
import { BookOpen } from "lucide-react";
import { useState } from "react";

import { connectionApi } from "../api";
import { Button } from "../components/ui/button";
import { PageError } from "../shell";

export function ApprovalPolicySelection(props: {
	allowPermanent: boolean;
	catalog: ApprovalPolicyCatalog | undefined;
	disclaimerIds: string[];
	durationDays: number | "";
	editable: boolean;
	locked: boolean;
	onAllowPermanent: (value: boolean) => void;
	onDisclaimerIds: (ids: string[]) => void;
	onDurationDays: (days: number | "") => void;
	onOpenDirectory: () => void;
	onProfile: (id: string) => void;
	onProvider: (id: string) => void;
	profileId: string;
	providerReleaseId: string;
}) {
	const [actionQuery, setActionQuery] = useState("");
	const provider = props.catalog?.providers.find(
		(item) => item.providerReleaseId === props.providerReleaseId,
	);
	const detail = useQuery({
		queryKey: ["approval-profile-detail", props.profileId],
		queryFn: () => connectionApi.getApprovalCapabilityProfile(props.profileId),
		enabled: Boolean(props.profileId),
	});
	const globals =
		props.catalog?.disclaimers.filter(
			(item) => item.kind === "GLOBAL" && item.status === "PUBLISHED",
		) ?? [];
	const selectedGlobalId =
		props.disclaimerIds.find((id) =>
			props.catalog?.disclaimers.some(
				(item) => item.id === id && item.kind === "GLOBAL",
			),
		) ??
		(props.editable ? globals[0]?.id : undefined) ??
		"";
	const selectedGlobal = props.catalog?.disclaimers.find(
		(item) => item.id === selectedGlobalId,
	);
	const providerDisclaimers =
		props.catalog?.disclaimers.filter(
			(item) =>
				item.kind === "PROVIDER" &&
				item.providerId === provider?.provider &&
				(item.status === "PUBLISHED" || props.disclaimerIds.includes(item.id)),
		) ?? [];
	const actions = detail.data?.profile.actions ?? [];
	const visibleActions = actions.filter(
		(action) =>
			action.name.toLowerCase().includes(actionQuery.trim().toLowerCase()) ||
			action.effect.toLowerCase().includes(actionQuery.trim().toLowerCase()),
	);

	return (
		<div className="approval-catalog-editor approval-policy-selection">
			<label>
				Provider
				<select
					value={props.providerReleaseId}
					disabled={props.locked}
					onChange={(event) => props.onProvider(event.target.value)}
				>
					<option value="">选择连接器</option>
					{props.catalog?.providers.map((item) => (
						<option key={item.providerReleaseId} value={item.providerReleaseId}>
							{item.provider} · {item.providerReleaseId}
						</option>
					))}
				</select>
			</label>
			<label>
				能力包
				<select
					value={props.profileId}
					disabled={props.locked}
					onChange={(event) => {
						props.onProfile(event.target.value);
						setActionQuery("");
					}}
				>
					<option value="">选择已发布能力包</option>
					{props.catalog?.profiles
						.filter(
							(item) =>
								item.providerReleaseId === props.providerReleaseId &&
								(item.status === "PUBLISHED" || item.id === props.profileId),
						)
						.map((item) => (
							<option key={item.id} value={item.id}>
								{item.name} · {item.effectCeiling}
							</option>
						))}
				</select>
			</label>
			{props.profileId ? (
				<section aria-label="所选能力包">
					<div className="approval-directory-version-head">
						<h3>{detail.data?.profile.name ?? "能力清单"}</h3>
						<span>
							{actions.filter((action) => action.effect === "READ").length} 读 /{" "}
							{actions.filter((action) => action.effect === "WRITE").length} 写
						</span>
					</div>
					{detail.isError ? (
						<PageError error={detail.error} />
					) : detail.isPending ? (
						<p role="status">正在加载能力清单…</p>
					) : (
						<>
							<input
								type="search"
								aria-label="搜索已选能力"
								placeholder="搜索已选能力"
								value={actionQuery}
								onChange={(event) => setActionQuery(event.target.value)}
							/>
							<div className="approval-action-list">
								{visibleActions.map((action) => (
									<div key={action.id} className="approval-action-detail">
										<span>
											<strong>{action.name}</strong>
											<small>{action.description}</small>
										</span>
										<small
											className={
												action.effect === "WRITE" ? "approval-action-write" : ""
											}
										>
											{action.effect}
										</small>
									</div>
								))}
							</div>
						</>
					)}
					<Button variant="secondary" onClick={props.onOpenDirectory}>
						<BookOpen size={15} />
						在目录中复制或管理
					</Button>
				</section>
			) : (
				<Button variant="secondary" onClick={props.onOpenDirectory}>
					<BookOpen size={15} />
					管理能力目录
				</Button>
			)}
			<div>
				<h3>免责声明</h3>
				{selectedGlobal ? (
					<>
						<label className="approval-disclaimer">
							<input type="checkbox" checked disabled />
							全局基础条款 · {selectedGlobal.locale}
							<strong>必需</strong>
						</label>
						{globals.length > 1 && props.editable ? (
							<select
								aria-label="全局条款版本"
								value={selectedGlobalId}
								onChange={(event) =>
									props.onDisclaimerIds([
										event.target.value,
										...props.disclaimerIds.filter(
											(id) =>
												!props.catalog?.disclaimers.some(
													(item) => item.id === id && item.kind === "GLOBAL",
												),
										),
									])
								}
							>
								{globals.map((item) => (
									<option key={item.id} value={item.id}>
										{item.locale} · {item.id}
									</option>
								))}
							</select>
						) : null}
						<div className="approval-disclaimer-content">
							{selectedGlobal.content}
						</div>
					</>
				) : (
					<p role="status">
						{globals.length
							? "当前策略未绑定全局基础条款。"
							: "尚未发布全局基础条款，可保存草稿但不能发布策略。"}
					</p>
				)}
				{providerDisclaimers.map((item) => (
					<div key={item.id}>
						<label className="approval-disclaimer">
							<input
								type="checkbox"
								disabled={!props.editable}
								checked={props.disclaimerIds.includes(item.id)}
								onChange={() =>
									props.onDisclaimerIds(
										props.disclaimerIds.includes(item.id)
											? props.disclaimerIds.filter((id) => id !== item.id)
											: [...props.disclaimerIds, item.id],
									)
								}
							/>
							{item.providerId} 附加条款 · {item.locale}
						</label>
						{props.disclaimerIds.includes(item.id) ? (
							<div className="approval-disclaimer-content">{item.content}</div>
						) : null}
					</div>
				))}
			</div>
			{props.editable ? (
				<>
					<label>
						允许时长（天）
						<input
							type="number"
							min={1}
							max={3650}
							value={props.durationDays}
							onChange={(event) =>
								props.onDurationDays(
									event.target.value === "" ? "" : Number(event.target.value),
								)
							}
						/>
					</label>
					<label className="approval-toggle">
						<input
							type="checkbox"
							checked={props.allowPermanent}
							onChange={(event) => props.onAllowPermanent(event.target.checked)}
						/>
						允许永久有效
					</label>
				</>
			) : null}
		</div>
	);
}
