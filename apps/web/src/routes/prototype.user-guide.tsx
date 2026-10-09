import { createFileRoute, notFound } from "@tanstack/react-router";
import { UserGuidePrototype } from "../features/user-guide-prototype/user-guide-prototype";

// Throwaway: three guide layouts on one route. Selection belongs to Issue #1599.
export const Route = createFileRoute("/prototype/user-guide")({
	beforeLoad: () => {
		if (!import.meta.env.DEV) throw notFound();
	},
	validateSearch: (search: Record<string, unknown>) => ({
		variant:
			search.variant === "B" || search.variant === "C" ? search.variant : "A",
		chapter: typeof search.chapter === "string" ? search.chapter : "01",
	}),
	component: GuideRoute,
});

function GuideRoute() {
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	return (
		<UserGuidePrototype
			variant={search.variant}
			chapter={search.chapter}
			onChange={(next) =>
				void navigate({
					search: { ...search, ...next },
					replace: true,
					resetScroll: next.variant !== undefined,
				})
			}
		/>
	);
}
