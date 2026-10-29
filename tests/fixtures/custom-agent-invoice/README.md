# 自有入口发票 Agent 参考应用

本应用用于验证一个真实调用模型的应用如何从本地迁入平台。它不是用户已有项目，也不证明
本地历史或记忆已导入。平台入口与迁入边界见
[迁入说明](../../../docs/agents/custom-agent-migration.md)。

应用接收有限的发票数字输入，调用固定模型服务计算，保存模型返回的文本，并通过自己的
HTTP API 查询结果。它采用 `self-managed` 模式；身份、业务结果与历史属于应用，不进入
Platform Task API 或平台会话。

## 配置和构建

使用 Node.js 24。以下配置由运行环境提供；不把真实凭据写进镜像或构建参数：

| 配置 | 用途 |
| --- | --- |
| `APP_TOKEN` | 应用自身的 Bearer 凭据，至少 16 个可见 ASCII 字符 |
| `MODEL_API_KEY` | 模型凭据，至少 16 个可见 ASCII 字符 |
| `MODEL_BASE_URL` | 固定模型服务基址；请求追加 `/v1/messages`，生产使用 HTTPS |
| `MODEL_ID` | 模型 ID |
| `DATA_DIR` | 应用可写的绝对目录；镜像默认 `/workspace/invoices`，使用平台自定义 Agent 的持久卷挂载 |
| `APP_VERSION` | 非秘密版本标记；镜像构建参数默认 `invoice-v1` |

`APP_TOKEN` 只代表一个应用身份。持有它的调用方共享该应用的结果访问权；需要不同用户独立
隔离时使用独立应用实例或另行实现身份体系。平台不会将这个凭据转换为 Platform API 身份。

从本目录构建，`BASE_IMAGE` 必须是已回读的 Node.js 24 镜像不可变引用：

```sh
docker build --build-arg BASE_IMAGE="$APPROVED_NODE_DIGEST" \
  --build-arg APP_VERSION=invoice-v1 -t invoice-reference:v1 .
```

继承镜像不赋予平台准入。发布后记录最终 Digest，按部署策略准入，再通过平台 API 创建。
生产配置使用 HTTPS；本机测试仅额外允许 `http://127.0.0.1`。应用不跟随模型服务重定向。

## 业务接口

应用监听 8080。`GET /healthz` 只返回健康状态和当前版本，不调用模型。

`POST /api/invoices` 使用 `Authorization: Bearer <APP_TOKEN>` 和
`Content-Type: application/json`，请求示例：

```json
{
  "items": [{ "quantity": 17, "unitPrice": 23.5 }, { "quantity": 9, "unitPrice": 12.4 }],
  "discountPercent": 8,
  "taxPercent": 6
}
```

输入最多 50 项、16 KiB，不接受额外字段或任意提示词。成功返回 201，字段为 `id`、
`result` 和创建该结果时的 `version`。`result` 来自真实模型响应，应用不替模型生成固定答案；
这个例子的独立计算预期为 `TOTAL=498.42`，验收方需要核对结果，不能只检查 HTTP 状态。
此参考应用不用于实际财务记账，也没有宣称模型计算始终正确。

使用相同应用凭据调用 `GET /api/invoices/{id}` 读取已保存结果。更换版本后原结果仍返回
原创建版本；`/healthz` 返回当前应用版本。未认证请求返回空的 401，错误凭据返回空的 403。
模型失败、超时或响应过大返回受控错误，不返回上游错误正文。

调用方重试 POST 可能产生新结果并再次调用模型；此参考接口没有幂等键契约。平台管理 API
的幂等性应在平台创建和生命周期请求中独立验证。

## 验证边界

仓库根目录运行：

```sh
node --test tests/custom-agent-invoice.test.mjs
```

这些测试通过公开 HTTP 接口使用受控模型服务验证请求转发、鉴权、输入限制、错误脱敏和
结果在服务实例重建及版本变更后保留。受控测试不证明真实模型、镜像准入或平台部署成功；
验收须另行完成本地真实模型基线及同一业务输入的部署后验证。
