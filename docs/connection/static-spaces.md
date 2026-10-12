# StaticSpaces 使用方式

完整工作流使用统一的 `StaticSpaces full`；操作资格由当前账号及空间角色决定。
新能力需重新公司审批和显式授权。版本和完整能力清单见
[完整工作流 ADR](../adr/ADR-connection-static-spaces-full-workflows.md)。

## 发布和分享

发布前选择个人、shared 或 public 空间。个人空间默认属于本人；shared/public 要确认空间名。
public 表示所有已登录用户可读，不是匿名公开。首次发布使用 publish_space，之后可上传单个
HTML 或静态包。Markdown 保持原始文件，先返回评审链接，再返回原文链接。

shared 空间还需选择仅本人、邮箱列表或组织组。确认规范化邮箱和 viewer 角色后添加成员；
组织组先搜索、查看名称/组织路径/人数、确认一个组后授权。组织组的当前及未来成员均可读，
但不获得写权限。owner 可以管理 owner/manager/viewer，manager 只能管理 viewer。
新增成员后浏览器可能需要退出重新登录才能获得更新后的组权限。

授权覆盖整个空间，不是仅一篇文章。分享操作必须明确空间、对象、角色与授予/撤销；
统一能力包不等于已经同意向任意人员共享内容。

## 评审、删除与索引

读取评审不会自动发表评论。用户明确要求时，先读取最新文档，再创建整体讨论、源码行选区
评论或回复线程。评论修改和删除仅限本人；文档变化后重新读取，不能重放旧选区。

删除文件会同时清理对应 Markdown 评论。删除空间包含整个内容目录、评论、组、ACL 及
shared 门户卡片；必须明确确认整个空间。生成目录索引默认不覆盖 index.html。

## 管理员操作

管理员接口仍在同一个 full 内，但只有当前 StaticSpaces 管理员身份可执行。普通用户连接
不会因此获得管理员资格。全局组、成员及 ACL 变更必须明确目标与影响范围；优先使用 scoped
分享接口。禁止设置根路径 ACL。groups=[] 表示所有登录用户可读，应明确确认该可见范围。

遗留内部账号创建仅支持无密码操作，不创建 LDAP 用户、不生成/重设/回传密码。普通发布和
分享不得顺带创建用户；找不到公司账号时由管理员检查目录同步。

## 浏览器状态和订阅

运行状态使用同源相对路由，订阅登记由读者登录浏览器完成，不把 Token 放入页面。
HTML 可订阅块保持稳定 data-sub/id，发布后检查 subscription_warnings；发布成功不等于已
登记订阅或收到企微消息。具体行为以
[上游订阅指南](https://bitbucket.agoralab.co/projects/AI/repos/agora-skills/browse/skills/static-spaces/references/subscriptions.md)
为准。

## 写入结果未知

上游没有持久幂等和终态查询，权限变更/删除/发布也可能部分完成。结果未知时，这个 Connection
的新写入暂停，可读取内容用于人工对账；不要换键、重新授权或重连后重发。其他 Connection
不因此暂停。Token 无效需要重新认证；单个内容/角色权限拒绝不等于 Token 失效。
