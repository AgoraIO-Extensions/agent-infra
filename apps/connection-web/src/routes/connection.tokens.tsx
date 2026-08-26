import { createFileRoute } from "@tanstack/react-router";

import { TokensPage } from "../pages/tokens-page";

export const Route = createFileRoute("/connection/tokens")({
	component: TokensPage,
});
