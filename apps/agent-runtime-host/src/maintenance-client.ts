import { spawn } from "node-pty";
import { serveMaintenanceClient } from "./maintenance-client-stream.js";

// Kubernetes can keep an exec process alive after its transport disappears.
// Each connection owns one tmux client. The shell runs in the separate tmux server.
const terminal = spawn(
	"tmux",
	[
		"-u",
		"-L",
		"maintenance",
		"-f",
		"/app/maintenance-tmux.conf",
		"new-session",
		"-A",
		"-s",
		"deployment",
		"-c",
		"/deployment",
	],
	{ name: "xterm-256color", cwd: "/deployment", encoding: null },
);
process.once(
	"SIGTERM",
	serveMaintenanceClient(terminal, process.stdin, process.stdout),
);
