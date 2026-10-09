import { createFileRoute } from "@tanstack/react-router";
import { PersonalRelayKeyScreen } from "../../features/personal-relay-key/personal-relay-key-screen.js";
import { useApplicationSession } from "../../features/application-shell.js";

export const Route = createFileRoute("/my-settings/relay-key")({
	component: RelayKeyRoute,
});

function RelayKeyRoute() {
	const { session } = useApplicationSession();
	return <PersonalRelayKeyScreen userId={session.user.userId} />;
}
