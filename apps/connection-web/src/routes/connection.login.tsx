import { createFileRoute } from "@tanstack/react-router";

import { LoginPage } from "../pages/login-page";

export const Route = createFileRoute("/connection/login")({
	component: LoginRoute,
	validateSearch: (search: Record<string, unknown>) => ({
		returnTo: typeof search.returnTo === "string" ? search.returnTo : undefined,
	}),
});

function LoginRoute() {
	const { returnTo } = Route.useSearch();
	return <LoginPage returnTo={returnTo} />;
}
