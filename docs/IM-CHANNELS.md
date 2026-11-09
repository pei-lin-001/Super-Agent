# 渠道层：Telegram 与个人微信

把手机聊天接到现有 Router 上。渠道只负责**可靠收、按会话交接、可靠发**；解释、拆活、收尾仍然由 Router 和 Worker 做。渠道层不规定模型怎么工作，也不改变原有的多模型、配额、检查、恢复行为。

未启用任何渠道时，`createChannelService()` 返回 `null`，CLI 与多模型行为与之前完全一致。

---

## 1. 为什么这么做

三条硬要求决定了结构：

1. **两条聊天不能串**。会话键是 `渠道|账号|对端[|话题]` 的结构化编码，不是昵称、不是手机号、不是模型记的"上次那个人"。历史、待续接会话、待汇报材料、回信目标全部按会话键隔离。
2. **消息不能丢，也不能重复派工**。入站先事务性落库、再前移游标；交接完成后才把入站记录标成 `handed`。进程在任一点崩溃，重启后要么重试、要么续接，都不会把同一条平台消息当成新需求再派一次工。
3. **发送结果必须如实**。每条要发的内容按分段持久化，逐段记录 `sent|failed|unknown`。已确认的不重发；结果未知的记 `unknown`，不当成功也不整条重来。

---

## 2. 数据

新增 4 张表，都在同一个 SQLite 里：

| 表 | 作用 | 关键约束 |
| --- | --- | --- |
| `channel_inbound` | 入站消息 | `(channel, account_id, event_id)` 唯一，平台重送只留一条 |
| `channel_cursor` | 每账号游标 | 主键 `(channel, account_id)`；写库成功后才前移 |
| `channel_outbound` | 待发内容 | 分段与每段状态存 JSON；`pending/partial` 才会被继续推进 |
| `channel_session` | 渠道会话 | 保存微信回复上下文 `context_token`、最近收发时间 |

`task` 表新增 `source_channel / source_account_id / source_peer_id / source_session_key`。回信目标只从任务来源推导，**不让模型生成 chat id**。

`router_turn`、`router_session` 新增 `session_key`：CLI 会话为 `NULL`，聊天会话为具体键。收件箱查询按会话键过滤，`NULL` 只包含 CLI 建的任务。

---

## 3. 流程

### 收

```
adapter.poll(游标)
  → store.recordInboundBatch()   # 事务：去重 + 身份校验 + 落库 + 前移游标
  → drainInbound()               # 按会话键分组，同会话串行
  → router.handleUserMessage(text, { sessionKey, onAccepted })
        onAccepted: 入站记录标 handed + 更新渠道会话
```

- 身份校验在落库时做：`ownerIds` 为空或发送者不在其中 → 状态记 `rejected`，**不调用模型**，也不占用队列。
- 交接失败保留 `pending`，重启后重试；交接成功但进程随即崩溃，重启走 `resume()` 续接原会话，不再派工。
- 事件身份用平台字段：Telegram `update_id`，微信 `message_id`。不用文本哈希——两条相同内容的消息是两件事。

### 发

```
Router 回复 / send_file
  → channel.outbound 事件
  → store.enqueueOutbound()      # 按平台上限切段，文件单独成段
  → drainOutbound()              # 同账号串行，逐段发送
  → updateOutbound()             # 每段真实结果
```

- 文本按码点切段，优先落在段落/换行/句子边界，不切坏代理对，不丢内容。Telegram 4000、微信 2000。
- 文件段只能取**本任务已登记**的产物版本：名字要存在、路径在 `workDir` 内、`sha256` 与字节数都要与登记一致，否则拒绝发送并写明原因。
- 段级重试：已 `sent` 跳过；`failed` 可重试的继续；`unknown` 不再重发。整条状态取 `sent | partial | unknown | failed | pending`。
- 退避：失败后可重试的段写 `next_attempt_at`——平台给了 `retry_after`（Telegram 429）就按它等，否则 2s 起翻倍、最多 60s。未到时间的记录不进待发队列，不会对着限速接口空转。鉴权失败直接判死，不进入重试。

### 断与恢复

- 长轮询被 `AbortSignal` 取消，停机时先停渠道再停 Runtime。
- 网络错误按指数退避重试（上限 30s），业务状态不受影响。
- 鉴权失效（Telegram 401/403、微信 `errcode -14`）→ 该账号进入 `blocked`，停止轮询，等人工重新登录；已产出的内容仍在库里。

---

## 4. 会话与授权

- 会话键格式：`encodeURIComponent(channel)|encodeURIComponent(accountId)|encodeURIComponent(peerId)[|thread:<id>]`。
- 主人身份：`TELEGRAM_OWNER_IDS` / `WEIXIN_OWNER_IDS`；微信未显式配置时用扫码返回的 `ilink_user_id`。两者都没有 = 未绑定，任何消息都不执行。
- 跨会话权限：`read_task` / `send_file` 只能操作本会话任务。跨会话只允许同一主人用明确任务号查询，模型改不了归属。
- 群聊、频道消息、编辑消息不在本轮范围：消息仍落库留痕（`channel_inbound` 里可查原因），但不进执行流程，**也不在群里回话**。Telegram 适配器把非私聊标记为 `silent`，回信环节直接跳过。

---

## 5. 配置

```bash
# 公共
CHANNEL_STATE_DIR=.data/channels     # 微信凭据目录（0600）
CHANNEL_POLL_TIMEOUT_MS=35000        # 长轮询超时
CHANNEL_MAX_INBOUND_BYTES=26214400   # 单文件上限（25MB）

# Telegram（长轮询，不用 webhook，不需要公网入口）
TELEGRAM_ENABLED=1
TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_OWNER_IDS=100000001         # 逗号分隔的稳定 user id
TELEGRAM_API_BASE=https://api.telegram.org

# 个人微信（腾讯 iLink，扫码登录）
WEIXIN_ENABLED=1
WEIXIN_OWNER_IDS=                   # 留空则用扫码确认的用户
WEIXIN_API_BASE=https://ilinkai.weixin.qq.com
WEIXIN_CDN_BASE=https://novac2c.cdn.weixin.qq.com/c2c
```

`TELEGRAM_OWNER_IDS` 必须是数字 user id（不是 @username）；用户名可以改，id 不能。

---

## 6. 运行

```bash
pnpm channel:weixin-login   # 扫码登录，凭据写入 CHANNEL_STATE_DIR/weixin/*.json（0600）
pnpm channel:status         # 账号、绑定、游标、待收发、回复上下文是否已保存
pnpm start                  # 或 pnpm daemon
```

启动日志会打印接上了哪些账号、哪些平台因为缺条件没接上，例如：

```
渠道：telegram 账号 bot_424242：主人 100000001
渠道提示：微信已启用但还没有登录凭据；先运行 pnpm channel:weixin-login 扫码（凭据目录 ...）
```

微信扫码：终端会打印一段二维码内容。用任意二维码工具把它转成图形再扫——本仓库**不引入**二维码渲染依赖，避免为了一行输出加第三方宿主。服务器无桌面时把这串内容复制到手机上转即可。

---

## 7. 验证

### 单元与回归

```bash
pnpm test
```

渠道相关的确定性测试（220 项里的一部分）：

| 案例 | 断言的事实 |
| --- | --- |
| 平台重送同一事件 | 只交接一次，只建一个任务 |
| 内容相同、事件 id 不同 | 两条都保留 |
| 写库失败 | 游标不前移，重试后前移 |
| 交接后立即崩溃 | 重启续接原会话，不重复派工 |
| 未绑定主人 / 陌生发送者 | 不调用模型，记录为 rejected |
| 同账号重复注册 | 直接报错，不悄悄抢收 |
| 两条聊天交错 | 历史、汇报材料、回信目标互不串 |
| A 任务完成时用户在 B | 回信只发 A |
| 跨会话读任务 | 被拒绝 |
| 超长回复 | 分段顺序保持、内容拼接回原文 |
| 中间段失败 | 已确认段不重发，从未确认处继续 |
| 429 / 业务码非 0 / 结果未知 | 分别记 failed(可重试)、failed、unknown |
| 重启 | 已确认段不重发 |
| 文件收发 | 指纹与大小一致才发；越界路径与未登记名字拒绝 |
| uint64 message_id | 不丢精度 |
| 登录失效 | 停止轮询、保留结果、不忙重试 |
| 群聊消息 | 只留痕：不调模型、不回话，游标照常前移 |
| 等待重试期间 | 未到 `next_attempt_at` 的记录不重发 |
| 聊天发文件 → 建任务 | 材料复制进 `materials/`，任务说明写明路径与指纹，且只被认领一次 |
| 未启用 IM | 装配返回 null，行为不变 |

### 进程级验收（本地假平台，不是真实联调）

```bash
pnpm accept:channel
```

真实启动 `src/main.ts --daemon`，对着本地假平台跑完整链路：

```
✓ 主进程已启动（--daemon）
✓ 回信已发到来源聊天
✓ 回信只发给发起人
✓ 交付文件已发送 / 文件名正确 / 文件也发给发起人
✓ 入站记录一条（event_id = update:5000001，status = handed）
✓ 游标已前移到下一条
✓ 任务完成，来源渠道/会话/会话键正确
✓ 全部发件状态为 sent
✓ 主进程已停止，准备重启
✓ 重启后仍能收消息并回信
✓ 重启后第一条没有被重复处理
✓ 产物已登记，大小与登记一致
```

### 真实平台联调前的自检

```bash
pnpm channel:doctor
```

只读检查，不发消息也不消费消息：Telegram 用 `getMe`/`getChat` 验证令牌与主人 id（并确认是私聊），微信读本地凭据用 `getconfig` 验证令牌仍有效。缺什么会直接写出补法：

```
✗ Telegram 已启用：TELEGRAM_ENABLED 不是 1
    怎么补：在 .env.local 设 TELEGRAM_ENABLED=1
✗ 微信凭据：凭据目录里没有账号（.data/channels/weixin）
    怎么补：pnpm channel:weixin-login 扫码登录
```

它证明的是「凭据有效、目标正确」，**不证明消息能收发**——收发只能靠手机实测。

### 真实平台联调（需要你提供条件）

以下三项由模拟测试**无法**证明，必须用真实账号跑：

1. **Telegram**：需要一个 BotFather 机器人令牌，和你的数字 user id（`TELEGRAM_OWNER_IDS`）。
2. **微信**：需要你用手机扫码确认登录，凭据由程序保存在 `CHANNEL_STATE_DIR`，不经过模型。
3. **手机实测**：双向文字、发文件、任务跑完回文件、断网恢复各一次。

顺序：`pnpm channel:doctor` 全绿 → 启动 daemon → 手机上发一条消息 → 发一个文件 → 等任务回文件。

缺这些条件时，上面所有测试仍然只能证明"协议形状与状态机正确"，不能声称"真实平台已通过"。

---

## 8. 明确不做

- 群聊、频道、多人协作会话。
- 语音/视频内容识别；图片只保存附件并如实告诉模型"没有视觉输入"。
- 模型直接产出 `chat_id` 或自行决定发给谁。
- 无限主动推送：微信 `context_token` 是回复上下文，不是长期推送凭据；缺失或过期时记录状态，等用户再来消息。
- 渠道故障改变业务状态：IM 发不出去不会把已完成任务改回 `active` 或 `failed`。
