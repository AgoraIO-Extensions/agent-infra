import { createFileRoute } from "@tanstack/react-router";
import { guideChapter } from "../features/user-guide/content";
import { ConnectionGuide } from "../features/user-guide/guide";
export const Route = createFileRoute("/connection/help")({
	validateSearch: (search: Record<string, unknown>) => ({
		chapter: guideChapter(search.chapter).id,
	}),
	head: () => ({ meta: [{ title: "Connection 使用指南" }] }),
	component: HelpRoute,
});
function HelpRoute() {
	const { chapter } = Route.useSearch();
	const navigate = Route.useNavigate();
	return (
		<ConnectionGuide
			chapter={chapter}
			onChapterChange={(id) =>
				void navigate({ search: { chapter: id }, resetScroll: false })
			}
		/>
	);
}
