import { Link } from "@tanstack/react-router";

import type {
	AgentApplicationCreateRequestV1Writable,
	AgentApplicationProjectionV1,
	AgentApplicationUpdateRequestV1Writable,
} from "../../pilot/generated/types.gen.js";
import { agentManagementStatusLabels } from "../agent-management-status.js";
import { AgentApplicationForm } from "./agent-application-form.js";

type RequestError = Error & { readonly retryable?: boolean };

type AgentApplicationSubmissionScreenProps =
	| {
			error?: RequestError | null;
			mode: "create";
			onSubmit: (body: AgentApplicationCreateRequestV1Writable) => void;
			result?: AgentApplicationProjectionV1;
			submitting: boolean;
	  }
	| {
			application: AgentApplicationProjectionV1;
			error?: RequestError | null;
			mode: "update";
			onSubmit: (body: AgentApplicationUpdateRequestV1Writable) => void;
			result?: AgentApplicationProjectionV1;
			submitting: boolean;
	  };

export function AgentApplicationSubmissionScreen(
	props: AgentApplicationSubmissionScreenProps,
) {
	const heading =
		props.mode === "create"
			? "Create application"
			: props.application.status === "rejected"
				? "Resubmit application"
				: "Edit application";

	return (
		<section
			aria-labelledby="agent-application-submission-heading"
			className="space-y-6"
		>
			<header className="space-y-2 border-slate-200 border-b pb-5">
				<h1
					id="agent-application-submission-heading"
					className="font-semibold text-2xl text-slate-950"
				>
					{heading}
				</h1>
			</header>
			<AgentApplicationForm
				key={
					props.mode === "update" ? props.application.applicationId : "create"
				}
				{...props}
			/>
			{props.result ? (
				<p className="font-medium text-slate-950 text-sm" role="status">
					Application submitted:{" "}
					{agentManagementStatusLabels[props.result.status]}.
				</p>
			) : null}
			{props.result ? (
				<Link
					className="inline-flex min-h-11 items-center text-slate-700 text-sm underline underline-offset-4"
					params={{ applicationId: props.result.applicationId }}
					to="/my-agents/$applicationId"
				>
					Open application
				</Link>
			) : null}
			{props.error ? (
				<p className="text-slate-600 text-sm" role="alert">
					{props.error.retryable === false
						? "This application changed or is unavailable. Refresh the page."
						: "Unable to submit the application. Please try again shortly."}
				</p>
			) : null}
		</section>
	);
}
