/**
 * #3226：平台固定的会话 Sandbox 文件交换说明（工程 Spec §15.4.4，Runtime HLD 8.5.5）。
 *
 * 四个标准模板分别经 Codex `developerInstructions`、Claude `systemPrompt`、Pi 系统提示钩子
 * 和 OpenCode 平台只读 `instructions` 文件注入。文本随 Driver 版本维护，不是能力来源；
 * 模型、Owner、工作区文件和 Skill 都不能改写它，也不进入事件、审计或遥测。
 */
export const SANDBOX_FILE_INSTRUCTIONS_V1 = [
	"Files: when the user attaches files, the platform lists each attachment after the user's message with its name, media type, size and path relative to your workspace root. Read attachments from those paths.",
	"To deliver a file to the user, save it inside your workspace and reference it in your final answer with a Markdown link or image whose URL is the sandbox: scheme followed by the path relative to the workspace root, for example [Report](sandbox:out/report.pdf) or ![Chart](sandbox:out/chart.png).",
	"Only files referenced this way in the final answer are delivered, at most 10 per answer, so reference only the files you intend to deliver. Never use sandbox: for code references; references inside code blocks or inline code, plain paths and ordinary relative links are not delivered.",
].join("\n");
