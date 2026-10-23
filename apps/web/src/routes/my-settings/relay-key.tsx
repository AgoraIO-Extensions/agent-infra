import { createFileRoute } from "@tanstack/react-router";
import { useApplicationSession } from "../../features/application-shell.js";
import { PersonalRelayKeyScreen } from "../../features/personal-relay-key/personal-relay-key-screen.js";
import { useSessionRecheck } from "../../features/session-recheck.js";

export const Route = createFileRoute("/my-settings/relay-key")({
	component: RelayKeyRoute,
});

function RelayKeyRoute() {
	const { session } = useApplicationSession();
	// 401 后的「重新登录」经壳层重新确认会话；仍有效时由页面重读状态（W-03，#3292 N9-3-04）。
	const relogin = useSessionRecheck();
	return (
		<PersonalRelayKeyScreen
			userId={session.user.userId}
			onSessionExpired={relogin.recheck}
		/>
	);
}
