# Platform Web 基础组件

UI 选型以[工程 Spec §2.1](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#21-技术栈)为准。
本次迁移对应 [#389](https://github.com/AgoraIO-Extensions/agent-infra/issues/389)，不增加产品能力。

## 组件与调用方

`apps/web/components.json` 保持 `base-lyra`、`neutral`、CSS variables、`@/` aliases 和 lucide。
组件由 lockfile 中的 shadcn CLI 生成：

```bash
pnpm --filter @agent-infra/web exec shadcn add button input textarea native-select checkbox label badge --yes
```

生成后将 `cn` 导入适配到既有 `@/lib/utils` alias，显式声明 Base UI、CVA、clsx、
tailwind-merge 与 lucide 依赖。主题变量在 `src/index.css`，按页面需要只定义实际使用的 token。
默认表单控件保留 44px 操作高度；输入文字、按钮换行和焦点环在基础组件中统一维护。

| 组件 | 实际调用方 |
| --- | --- |
| `Button` / `buttonVariants` | 申请创建、编辑、重新提交、撤回，审批，Owner 配置，生命周期，页面导航 |
| `Input` | 申请和 Owner 配置中的文本、密码字段 |
| `Textarea` | 申请、Owner 配置、多值字段、审批驳回原因 |
| `NativeSelect` / `NativeSelectOption` | 申请来源、身份责任；保留原生选择和禁用语义 |
| `Checkbox` | 申请和 Owner 的模型配置开关 |
| `Label` | 上述表单的可访问名称 |
| `Badge` | Agent 列表、我的 Agent、审批列表的服务或管理状态 |

普通导航保留 TanStack `Link` 或语义链接；需要控件外观时使用 `buttonVariants`，不改变链接角色。
段落、列表、定义列表、表单和 fieldset 保持语义 HTML。
申请详情和 Agent 详情使用索引路由，确保编辑和配置子路径能渲染对应页面。

## 静态规则

`pnpm check` 执行 `tests/support/web-ui-policy.mjs`，`pnpm test` 执行正负样例。
检查 `apps/web/src/routes` 和 `apps/web/src/features` 中的 TypeScript/JavaScript JSX：

- 拒绝原生 `button/input/textarea/select/option/optgroup/label/summary`。
- 拒绝原生元素直接声明通用控件角色，如 `button/checkbox/combobox/textbox`。
- 允许 `components/ui` 内部、普通语义 HTML、测试文件和三个具名现有测试 helper；生产页面不得导入测试 helper。
- 唯一具名例外 `hidden-form-value` 只接受带 `data-native-control="hidden-form-value"` 和字面量
  `type="hidden"` 的 input，理由是传递不可见表单元数据。动态 type、属性 spread、其他标签或
  未知例外名均失败。当前生产页面没有使用原生例外。

规则检查直接 JSX 声明，不是任意 JavaScript 数据流分析。新增例外必须在规则中限定结构、
记录理由，并添加正负测试；不得增加业务文件级或目录通配排除。

## 验证

```bash
pnpm --filter @agent-infra/web test
pnpm --filter @agent-infra/web exec playwright install chromium
pnpm --filter @agent-infra/web test:browser
```

浏览器测试运行实际生产构建，通过已有契约校验 Fake 拦截 API；不依赖真实凭证，不代表真实后端验收。
桌面 1440×1000、移动 390×844 覆盖申请创建、编辑、重新提交、撤回，审批批准与驳回，
Owner 配置、Secret 清空、模型复选框、停止、重启、镜像升级，以及普通员工的权限负向场景。
同时检查 Tab/Enter/Space、必填校验、可访问名称、焦点环、结果焦点、pending 禁用、loading、
empty、error 和布局边界。

CI 保存 `web-management-<head SHA>` artifact，HTML 报告包含 head 元数据、旅程结果及截图。
PR 的人工 UI 验收仍遵循[工作流 §7.4](../architecture/SPEC-ai-native-development-workflow.md#74-人工验证)。
[#192](https://github.com/AgoraIO-Extensions/agent-infra/issues/192) 可复用这些基础组件；
[#194](https://github.com/AgoraIO-Extensions/agent-infra/issues/194) 的 UI 基础验收仍以 #389 完成为前提。
