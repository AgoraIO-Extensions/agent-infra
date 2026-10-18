import { createFileRoute } from "@tanstack/react-router";
import { EvaluationWorkbench } from "../features/evaluation/evaluation-workbench.js";

export const Route = createFileRoute("/eval")({
	component: EvaluationRoute,
});

function EvaluationRoute() {
	return (
		<main className="platform-content management-content">
			<EvaluationWorkbench />
		</main>
	);
}
