# Jenkins Pipeline 管理闭环

状态：需求负责人于 2026-10-15 批准。关联 [Issue #2543](https://github.com/AgoraIO-Extensions/agent-infra/issues/2543)。
实现、真实 Provider 验收与生产发布是独立结果。

## 决策

- Jenkins CI/Release 发布新 immutable v9，旧 v8 源码和执行路由保留。复用固定 origin、
  用户 API Token、CI 机器网关、Connection 幂等与审计。新增 Action 不自动进入旧 Grant。
- 新增 `list_folder_jobs`、`get_pipeline_config`、`get_build_parameters` READ；
  `create_pipeline`、`update_pipeline`、`enable_pipeline`、`disable_pipeline`、
  `cancel_queue_item` WRITE。运行、Build、日志与 artifact 复用原能力。
- 创建指定完整 Job 名称，父 Folder 必须已存在；只生成 `flow-definition`，定义为 sandbox inline
  script 或 Git SCM Jenkinsfile。SCM URL 只允许无内嵌凭证的 HTTPS/SSH Git 地址，不能作为
  Connection HTTP 请求目标；网络访问和已有 `credentialsId` 的使用由 Jenkins 权限控制。
  不接收 Token/密码，不枚举凭证，也不开放关闭 sandbox、任意 XML、脚本审批或插件安装。
- 配置读取最多 256 KiB，只返回结构化定义、描述、disabled 和原始 bytes SHA-256，不返回原始
  XML。脚本与 SCM 地址可能含业务敏感信息，进入调用结果前应由用户核对，不在审计中附加正文。
  不支持的定义类型 fail closed。参数发现排除 password/未知类型默认值。
- 更新必须携带读取到的 `expectedConfigSha256`，冲突在 POST 前拒绝；只替换 definition 与
  显式描述，保留其他配置。Jenkins `config.xml` 没有原子条件写入，摘要预检与提交存在窗口，
  不宣称强一致 CAS；避免与 UI/其他自动化并发编辑。启用/禁用要求同样摘要预检，调用专用 endpoint。
- XML 使用严格解析器，拒绝 DTD/外部实体，限定大小/深度/节点数；输入文本按 XML 字符规则校验和转义。
  创建遇到同名冲突不得覆盖，创建/更新不触发构建。Item/Create、Item/Configure、Item/Read、
  Item/Cancel 等实际权限由 Jenkins 按用户执行；Connection 授权不授予 Jenkins 原生权限。
- 取消排队需同时指定 Job 与 Queue ID，先按固定 endpoint 查询并核对 task 所属 Job，不能只凭
  Queue ID 取消其他 Job。停止运行中 Build 继续使用 `abort_build`。
- WRITE 每次只提交一次；断线、超时或 5xx 为 `UNCERTAIN`，不能自动重试。返回目标及核验 Action，
  创建后读取配置核验、更新后对比定义、启停读取 disabled、取消查询 queue/build。
  同名 Job 已存在不能证明本次创建成功；核验不自动把未知调用改写为成功。
- 不开放复制、Folder 管理、删除、重命名/移动、Multibranch 管理。插件缺失/无权限/同名冲突
  保留 HTTP 原因；禁止降级为任意请求或管理员凭证。

## 验证与发布

正负向测试覆盖两个 profile、路径/XML 注入、DTD、大小限制、摘要冲突、非目标配置保留、
密码参数隐藏、队列归属和提交未知。沿用跨用户/Consumer/Grant 拒绝测试。
实际启用前，两套 deployment 分别使用经批准的测试目标完成读写与错误路径验证；
未取得测试目标时不能调用生产写操作，也不能宣称实测通过。
