import { createFileRoute } from "@tanstack/react-router";
import { useApplicationSession } from "../../features/application-shell.js";
import { PersonalRelayKeyScreen } from "../../features/personal-relay-key/personal-relay-key-screen.js";

export const Route = createFileRoute("/my-settings/relay-key")({
	component: RelayKeyRoute,
});

function RelayKeyRoute() {
	const { session } = useApplicationSession();
	return <PersonalRelayKeyScreen userId={session.user.userId} />;
}
