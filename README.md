# Super-Agent

一个本地常驻的个人 Agent 系统。当前实现**模块 1：Router–Worker 双层运行骨架**。

系统的长期目标是既能做日常助手，也能持续推进长期任务；本模块只交付这个骨架——
多个 Worker 如何被分派、如何自主协作、如何互相检查、如何等待与恢复，以及怎样把结果统一交回给你。

---

## 1. 结构

```
                          你
                          │ 输入 / 查看
                   ┌──────▼───────────────────────────┐
                   │ CLI（REPL + 后台事件通知）         │
                   └──────┬───────────────────────────┘
                          │
                   ┌──────▼───────────────────────────┐
                   │ Router                            │
                   │ 理解 / 分派 / 汇总 / 统一回复       │
                   │ 工具：create_task·send·stop·list   │
                   └──────┬───────────────────────────┘
                          │ 程序落库并直接投递，不经模型转述
        ┌─────────────────┼─────────────────┬──────────────────┐
        ▼                 ▼                 ▼                  ▼
  ┌───────────┐     ┌───────────┐     ┌───────────┐      ┌───────────┐
  │ 群组 G1   │     │ 群组 G2   │     │ 群组 G3   │      │  ...      │
  │ owner W1  │     │ owner W4  │     │           │      │           │
  │  ├ W2核对 │◀───▶│           │     │           │      │           │
  │  └ W3检查 │ 直接 │           │     │           │      │           │
  └───────────┘ 消息 └───────────┘     └───────────┘      └───────────┘
   W1/W2/W3 同为 Worker 层；parentId 只记来源，不构成指挥链
   群组之间默认互不可见，消息不会串组

  ══════════════ 程序层（不参与对话，负责事实）══════════════
  调度队列 · 并发与配额 · 消息投递与唤醒 · 状态机 · SQLite · 工具执行 · 重启恢复
```

只有两层：Router 和 Worker。`groupId` 是数据上的协作标记，不是第三层。

## 2. 谁负责什么

| 角色 | 负责 | 不负责 |
|---|---|---|
| Router | 理解意图、建任务、改要求、停任务、汇总汇报；回答普通问题 | 不读文件、不做调查、不写产物 |
| Worker | 执行具体工作、调工具、产出文件、自主拉协作者、直接与同组通信、请求检查、向负责人交付 | 不直接跟你对话（统一由 Router 对外）；不得越过负责人宣告整体完成 |
| 运行程序 | 消息持久化与投递、等待与唤醒、每 Worker 串行执行、并发与配额、状态迁移、工具执行、重启恢复 | 不用规则冒充模型判断，不静默失败 |

**模型表达意图，程序决定事实。** `task.status = completed` 只能由程序校验后写入。

## 3. 数据（SQLite，单文件）

表：`task` `worker` `message` `artifact` `wait_record` `review` `worker_turn` `router_turn` `event`。

任务与群组 1:1：

```ts
Task   { id, groupId, title, goal, brief, doneCriteria, requireReview, ownerWorkerId, status, ... }
Worker { id, groupId, parentId?, role, brief, status, stepCount, model, lastError? }
Message{ id, groupId, taskId?, fromKind, fromId, toKind, toId, kind, body, payload?, replyTo?,
         refs?, dedupeKey?, status, createdAt, deliveredAt?, consumedAt? }
```

### 状态

```
Task:    pending → active ⇄ waiting → completed | failed | cancelled
Worker:  idle → running ⇄ waiting → done | failed | cancelled
Message: queued → delivered → consumed
                  ↘ failed / expired
```

- `delivered` 只表示进入收件箱，`consumed` 只表示模型读到。两者都不等于"事情做完了"。
- `Task.waiting` 是程序派生状态，不代表模型在空转。
- 终态不可逆。任务结束后到达的消息标为 `expired`，不会让任务复活。

### 消息类型（9 种）

| kind | 方向 | 用途 |
|---|---|---|
| `assign` | Router→Worker | 派活（建任务时自动产生） |
| `update` | Router→Worker | 补充要求、改变方向（同时写入任务 brief） |
| `stop` | Router→Worker | 停止 |
| `progress` / `fail` / `question` | Worker→Router | 进展、失败、需用户回答 |
| `result` | Worker→Router | 交付（程序在提交校验通过后生成） |
| `request` | Worker→Worker | 求助、核对、检查（`payload.intent` 区分） |
| `reply` | Worker→Worker | 答复，必须带 `reply_to`，一条请求只接受一条回复 |
| `notice` | 系统→Worker | 系统提示（超时、中断、协作者失败等） |

消息支持 `dedupe_key`：同组内重复提交相同键只落一条，用于安全重试。

## 4. 完成判定

负责人调用 `submit_result` 时，程序逐项校验：

1. 任务未取消、未结束；
2. 调用者是任务负责人；
3. 每个产物都能在磁盘上找到，且 `sha256` 与登记一致（防止检查旧版本、交付新版本）；
4. 没有未处理的 `update` / `stop`；
5. 若任务声明 `requireReview`：至少有一条检查请求，且没有未回复的检查，回复覆盖的版本不高于最终版本。

任一项不过 → 返回结构化拒绝理由，任务保持 `active`。全部通过 → 写 `completed`，自动生成 `result` 消息给 Router，并关闭群组。

## 5. 等待与并发

- 一个 `run` = 连续若干 `step`（一次模型调用 + 其工具执行），直到等待、完成、失败或触及步数上限。
- Worker 调 `wait_for` 时写 `wait_record`、状态转 `waiting`、**立刻让出并发槽，期间零模型调用**。
- 回复到达时程序匹配 `wait` 并把它放回队列；`update` / `stop` 会无视等待条件直接唤醒，保证互等时收件箱不被锁死。
- 同组全部 Worker 都在等待且互相等待时，程序给最早等待者注入提示，打破闭环。
- 每个 Worker 有独立的执行锁，同一 Worker 永远不会并发改上下文。

## 6. 配额（集中在 `.env.local`）

```
MAX_CONCURRENT_RUNS=3      全局同时执行的 Worker
MAX_WORKERS_PER_GROUP=6    单组 Worker 上限
MAX_TOTAL_WORKERS=12       全局 Worker 上限
MAX_STEPS_PER_RUN=8        单次运行的模型调用上限
MAX_STEPS_PER_WORKER=24
MAX_STEPS_PER_GROUP=160
MAX_REQUEST_HOPS=4         request→reply 链最大跳数
MESSAGE_TTL_MINUTES=30
WAIT_TIMEOUT_SECONDS=300
MODEL_RETRY=2              仅对超时/5xx 重试
```

超过配额时工具返回明确拒绝理由，不会静默失败。

## 7. 工具

Worker：`fs_list` `fs_read` `fs_search` `fs_write`（限定任务目录与只读 `materials/`）、
`artifact_save` `artifact_list`、`create_worker`、`message_send`、`wait_for`、`submit_result`（仅负责人）、`report_to_router`。

Router：`create_task` `send_to_worker` `stop_task` `list_tasks` `read_task`。

**没有开放 shell 工具**：本模块用读写与搜索已能完成真实任务，开放 shell 会让取消与幂等语义变复杂。

## 8. 目录

```
src/
  main.ts              启动与装配
  config.ts            环境变量读取（缺失即报错，不猜密钥）
  domain/              类型、ID、状态迁移规则
  storage/             SQLite schema 与仓储
  model/               OpenAI 兼容适配器、测试用 Mock
  tools/               文件、产物、协作工具与注册表
  runtime/             调度器、Worker 循环、Router、提示词
  ui/repl.ts           CLI 与斜杠命令
tests/
  unit/                状态机
  scenario/            综合流程、并行、配额、失败、恢复
scripts/smoke-real.ts  真实模型冒烟
```

## 9. 运行

```bash
cp .env.example .env.local     # 填入 OLLAMA_API_KEY
pnpm install
pnpm start
```

REPL 命令：

```
/tasks  /task <id>  /workers [taskId]  /messages <workerId>
/trace <taskId>  /artifacts <taskId>  /stop <taskId>  /help  /quit
```

直接输入文字即交给 Router。后台事件（Worker 建组、消息、任务状态）会以单行通知插入，不打断输入。

## 10. 验证

```bash
pnpm typecheck
pnpm test
pnpm smoke:real     # 真实模型综合场景，产出 work/<taskId>/artifacts/report.md
```

13 个测试覆盖：状态迁移、单 Worker 交付、自主创建协作者并继承群组、直接通信与回复匹配、
检查引发实际修改、提前提交被拒、并行隔离、等待让出并发槽、配额与请求跳数、模型失败上报、
停止与迟到消息、重启恢复、等待超时、消息去重。

## 11. 真实模型下的行为

Ollama Cloud 在模型未就绪或请求过密时会返回 `finish_reason: "load"`，此时响应里没有文本也没有工具调用。
处理方式：

- `MODEL_CONCURRENCY` 限制同时发往提供方的请求数（默认 2）；
- `MODEL_MIN_INTERVAL_MS` 保证请求之间有最小间隔（默认 1500ms）；
- 客户端对 `load` 做有限次短重试，仍失败则视为「提供方暂时不可用」，Worker 转回 `waiting` 并 60 秒后自动重排，任务不会因此被标成失败。

## 12. 已知限制

- 外部副作用不保证精确一次。写文件类工具用 `dedupe_key` 与版本号降低重复风险，但这不等于事务回滚。
- 上下文采用「最近 40 条 turn + 程序生成的任务背景」的滑动窗口，没有做摘要压缩，长任务会触及步数上限。
- `requireReview` 需要 Router 在建任务时显式声明；程序不解析自然语言里的"要检查"。
- 跨群组协作需要 Router 在两边分别下指令，尚未实现自动的跨组协商。
- Ollama Cloud 的 `load` 响应会让长任务变慢；真实运行中需要给足时间，或换用更稳定的端点。
- 没有长期记忆、外部平台接入、权限系统、图形界面。
