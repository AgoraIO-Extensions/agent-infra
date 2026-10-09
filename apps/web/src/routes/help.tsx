import { createFileRoute } from "@tanstack/react-router";
import { UserGuide } from "../features/user-guide/user-guide";
import { guideChapter } from "../features/user-guide/user-guide-content";

export const Route = createFileRoute("/help")({
	validateSearch: (search: Record<string, unknown>) => ({
		chapter: guideChapter(search.chapter).id,
	}),
	head: () => ({ meta: [{ title: "使用指南 · Agora Agent" }] }),
	component: HelpRoute,
});

function HelpRoute() {
	const { chapter } = Route.useSearch();
	const navigate = Route.useNavigate();
	return (
		<UserGuide
			chapter={chapter}
			onChapterChange={(next) =>
				void navigate({ search: { chapter: next }, resetScroll: false })
			}
		/>
	);
}
