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
| `request` | Worker→Worker | `intent=help` 普通求助；`intent=review` 正式检查 |
| `reply` | Worker→Worker | 答复，必须带 `reply_to`；回复正式检查必须带 `outcome` |
| `notice` | 系统→Worker | 系统提示（超时、中断、协作者失败等） |

消息支持 `dedupe_key`：同组内重复提交相同键只落一条，用于安全重试。

**广播按接收者各投一条**：`to=group` 时程序为每个同组 Worker 插入一条独立消息（共享 `broadcastId`）。
消费状态因此天然按人隔离，一个人读完不影响其他人。

## 4. 完成判定

负责人调用 `submit_result` 时，程序逐项校验：

1. 任务未取消、未结束，调用者是负责人；
2. 每个产物都能在磁盘上找到，且 `sha256` 与登记一致；
3. 没有未处理的 `update` / `stop`；
4. 若任务声明 `requireReview`：**每一份被引用的产物**都要有一条满足下列全部条件的检查记录——
   `artifactId` 相同（精确到版本）、`artifactSha256` 相同（内容没被改写）、
   `epoch` 等于任务当前要求版本、`outcome = approved`。

任何一项不满足都返回结构化拒绝理由，任务保持 `active`。

### 检查（review）规则

- 只有 `intent=review` 的 request 才产生检查记录；`intent=help` 只是求助。
- 检查记录以「一次请求 × 一份产物」为粒度，一次请求检查多份产物会有多行，同一事务写入。
- 回复检查必须给 `outcome`：`approved` / `changes_required` / `inconclusive`。程序只认 `approved`，
  不解析自然语言里的"通过"。
- 检查旧版本、检查别的文件、结论不是通过、检查后又改了内容，都不能放行。
- 用户补充要求（Router 的 `update`）会让要求版本 `epoch` 加一，旧结论立即失效。
- 检查通过后如果没有再改产物，可以直接提交，不需要重复检查。

## 4.5 上下文管理

每个 Worker 的输入由四段拼成：

| 段 | 来源 | 是否常驻 | 上限 |
|---|---|---|---|
| 任务状态 | 程序（任务表） | 是 | 约 1 千字符 |
| 当前产物表 | 程序（产物 + 检查记录） | 是，每个名字只列最新版本 | 12 份，超出只提示 |
| 工作记录 | 整理模型输出（`worker_note`） | 有则注入 | `NOTE_MAX_CHARS`，默认 6000 |
| 近期历史 | `worker_turn` | 是，按字符预算 | `CONTEXT_WINDOW_CHARS`，默认 16000 |

### 窗口怎么取

从最新 turn 往前累计字符，直到超过预算。切分以「一次模型调用 + 它的全部工具结果」为最小单位，
所以窗口起点不会落在孤立的工具结果上。因保持配对而超出预算时，允许不超过
`CONTEXT_PAIRING_OVERSHOOT_CHARS` 的溢出；仍超出就丢弃最老的整组。

字符数是估算口径，不是 token 数，也不换算成费用。

### 工作记录

- **触发**：窗口之外、尚未被成功记录覆盖的历史，同时满足 `NOTE_TRIGGER_TURNS` 条和
  `NOTE_TRIGGER_CHARS` 字符才整理。历史整体装得下窗口时一律不整理——短任务不会因为 turn 多就被总结。
- **累计**：每次整理输入「上一份成功记录 + 本次新增片段 + 当前要求」，输出一份覆盖全部范围的新记录。
  旧记录里仍然有效的事实、决定、失败原因和来源都会被保留。
- **推进**：只有新记录成功保存，`covered_seq` 才前移到本次片段末尾。失败记录 `failed=1`，不参与注入、不推进覆盖。
- **失效**：记录带生成时的要求版本 `epoch`。用户补充要求后版本变化，注入时标注「上一份记录基于要求版本 N」，
  下一次整理按新要求重建，而不是无条件重扫全部历史。
- **长度**：记录有上限，放不下的细节只保留引用；原文永远可以用 `history_read` / `message_read` / `artifact_read` 查回。
- **失败处理**：失败写一条诊断记录，任务照常推进；连续失败达到 `NOTE_MAX_FAILURES` 或未到
  `NOTE_RETRY_MS` 间隔时不再重试，避免失败反而变成空转。
- **不删除原文**：`worker_turn`、消息、产物版本一条都不删。

### 查回

| 工具 | 用途 |
|---|---|
| `history_search` | 在自己的历史里按关键字检索，返回 `turn#N` 与摘要 |
| `history_read` | 按序号或区间读原文，支持 `offset` 续读 |
| `message_read` | 按 `msg_xxx` 读消息全文，支持续读 |
| `artifact_read` | 按名字 + 版本读产物 |
| `note_read` | 读自己的工作记录（含失败记录） |

范围限定：只能读自己的 `worker_turn`、自己收发的消息、本任务产物。跨 Worker 的过程信息只能通过消息或产物交换。

### 工具调用的三种状态

| 情形 | 历史中的记录 |
|---|---|
| 程序明确没有执行（批次被等待或提交打断） | `[未执行] <tool>：<原因>` |
| 有调用记录、没有结果记录（进程中断） | `[执行结果未知] <tool>：历史只记录了调用…` |
| 正常执行 | 工具结果原文 |

未知不等于未执行。程序不会因为缺结果就自动重做，工作记录也必须保留这个区别。

### 产物收敛

`artifact_save` 的内容与该名字最新版本完全一致时，直接复用该版本并告诉模型，不产生新版本。
内容变化仍创建新版本，旧版本不删除。复用**不会**自动获得检查通过：要求检查时仍要针对该版本取得结论。

## 5. 等待与并发

- Worker 状态：`queued`（该跑还没跑）→ `running`（执行中）→ `queued` / `waiting` / 终态。
- 一个 `run` = 连续若干 `step`（一次模型调用 + 其工具执行），直到等待、完成、失败或触及单轮上限。
- 单轮步数用完但整体预算还在时，Worker 转回 `queued` 并请求下一轮；运行期间收到的调度请求记在
  `rerunRequested`，本轮结束后再跑一次，因此既不会丢唤醒，也不会并发执行同一个 Worker。
- Worker 调 `wait_for` 时写 `wait_record`、状态转 `waiting`、**立刻让出并发槽，期间零模型调用**。
- 回复到达时程序匹配 `wait` 并把它放回队列；`update` / `stop` 会无视等待条件直接唤醒，保证互等时收件箱不被锁死。
- 同组全部 Worker 都在等待且互相等待时，程序给最早等待者注入提示，打破闭环。
- 提供方（模型服务）暂时不可用时，Worker 转 `waiting` 并写入 `wait_record(reason='provider')`，
  60 秒后由 `tick()` 自动恢复——这个等待点是持久化的，重启后照样生效。
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

## 6.5 产物与路径

- 产物版本各自落盘：`<taskId>/artifacts/v<n>/<name>`，保存 v2 不会覆盖 v1。
- 读取用 `artifact_read`（按名字 + 版本），并校验登记时的 `sha256`，文件被绕过改写会直接报错。
- `fs_write` 不能写 `artifacts/` 目录；`materials/` 只读。
- 路径统一规整：拒绝空路径、绝对路径、`..` 段，写入前再做一次 realpath 校验防符号链接逃逸。
- 文件写成功但登记失败时删除文件，不留下"看起来成功"的状态。

## 7. 工具

Worker：`fs_list` `fs_read`（支持 `offset`/`limit` 分段续读）`fs_search` `fs_write`（限定任务目录，禁写产物目录）、
`artifact_save` `artifact_read` `artifact_list`、`create_worker`、`message_send`、`wait_for`、
`submit_result`（仅负责人）、`report_to_router`。

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
pnpm typecheck                              # 类型检查
pnpm test                                   # 48 个测试，全部使用临时目录与模拟模型
pnpm smoke:mini                             # 真实模型最小链路
pnpm smoke:real                             # 真实模型综合协作场景
node scripts/verify-run.ts <db> [taskId]    # 对已有运行记录重新做严格判定，不调用模型
```

冒烟退出码：`0` 通过、`1` 未通过、`2` 超时、`3` 环境/配置问题。
每次冒烟使用独立数据库（`.data/<runId>.db`）与独立工作目录（`work/<runId>/`），
判定只认本次任务交付消息引用的产物版本。

## 11. 验证结果

### 正确性要求 → 对应案例

| 要求 | 证明它的案例 |
|---|---|
| 单轮步数用完仍能继续推进 | `调度：单轮步数用完仍能跨轮完成并自动交付`（`maxStepsPerRun=1`，5 步任务无新用户消息自动完成） |
| 运行中请求调度不丢、也不并发执行同一 Worker | `调度：运行中到达的调度请求不会丢` |
| 等待让出名额、不空转 | `等待：等待中的 Worker 不占用并发名额，也不反复调用模型` |
| 广播每个接收者独立消费 | `消息：广播按接收者各投一条，互不影响消费状态` |
| 回复归属不可冒充 | `消息：错误接收者不能冒充回复他人的请求` |
| 终态不被迟到消息复活 | `取消：任务结束后到达的回复被拒绝` |
| 产物路径不可逃逸 | `产物：越界路径与绝对路径被拒绝`（`../`、绝对路径、`a/../../b`） |
| 版本可追溯、旧版可读 | 同上（v1/v2 不同路径，读 v1 得到 v1） |
| 已登记产物不可被普通写入破坏 | `产物：fs_write 不能覆盖已登记的产物目录` |
| 一次检查多份产物 | `检查：一次请求覆盖多份产物`（两条 review、同一请求） |
| 未覆盖全部产物不能提交 | 同上（新增 `c.md` 后提交被拒） |
| 不通过 / 旧版 / 旧要求不能放行 | `检查：不通过、无法判断、旧版本、旧要求都不能放行` |
| 普通求助不产生检查 | `检查：普通求助不产生检查记录` |
| 协作全链路（创建、通信、检查、修订、交付） | `协作：自主创建协作者、直接沟通、检查引发修改、旧检查不能放行新版本` |
| 中断的工具调用有明确记录、调用与结果配对 | `对话：一批工具调用被等待打断时…` |
| 长文件续读 | `对话：fs_read 支持 offset 续读` |
| 恢复分类与幂等 | `恢复：按状态分类重建，重复调用不会重复安排` |
| 提供方等待可跨重启 | `恢复：提供方等待写入数据库，重启后按 deadline 自动重排` |
| 活跃额度与累计预算分离 | `配额：历史 Worker 不占活跃额度，组内累计创建仍有上限` |
| 旧库增量迁移不丢数据 | `数据库迁移：旧库缺少新列时补齐，不删除数据` |
| 长历史仍能用早期事实并追溯 | `窗口：按字符预算取历史…`、`累计记录：第二次整理带上第一份记录…` |
| 早期失败原因被保留 | `累计记录：第二次整理带上第一份记录…`（断言失败原因仍在） |
| 整理后要求变化，旧记录失效 | `累计记录：整理期间要求版本变化时结果作废`、`检查：不通过、无法判断、旧版本、旧要求都不能放行` |
| 按引用查回正确内容 | `检索：摘要之外的关键依据能通过原文读取取回`、`检索：按消息 id 读全文` |
| 工作记录跨重启 | `三态：…重启后仍然是未知`、`工具：note_read 能读回工作记录与失败记录` |
| Worker / 群组隔离 | `隔离：不同 Worker 的历史、记录与消息互相看不到` |
| 整理前后工具配对完整 | `窗口：按字符预算取历史，且不拆开工具调用与结果` |
| 相同内容复用版本 | `产物：相同内容复用版本，改内容才新建，复用不自动变成已检查` |
| 未知状态不被改写 | `三态：未执行与执行结果未知…都不混淆` |
| 整理失败不丢原文、不伪造 | `累计记录：第二次整理失败时…`、`整理失败：连续失败达到上限后不再反复调用` |
| 触发规则边界 | `触发：短任务即使 turn 多…`、`触发：条数够但字符不够不整理` |
| 预算控制 | `预算：产物变多、记录变大时…`、`提示词：长任务触发整理后…` |
| 整理期间的新消息不被误标 | `提示词：整理期间到达的新消息不会被算进已覆盖范围` |

其余为原有正常路径测试：状态机、单 Worker 交付、并行隔离、请求跳数、失败上报、停止任务、重启恢复、等待超时、消息去重。

模块 2 新增 17 个测试，集中在 `tests/regression/context.test.ts`。

### 真实模型（Ollama Cloud / deepseek-v4.1-flash / reasoning=max）

**最小链路：通过（退出码 0）。** `pnpm smoke:mini`

```
本次运行 mini-20261108100627-d4e5（独立数据库与工作目录）
Router 建任务 task_c50c5d0d → Worker w1_b8c2cc9d
中途遇到提供方 finish_reason=load，Worker 写入 provider 等待，约 110 秒后自动恢复
任务 completed，17 步，产物 summary.md 指纹一致
```

摘要内容（真实生成）：

> 2026年Q3合计营收5180万元。华东区2160万元，环比增9%，规模最大；华南区1740万元，环比降3%；
> 华北区1280万元，环比增12%，增速最高。华南为唯一负增长区域，建议重点关注。

同一次运行还暴露一个模型行为问题：它连续 `artifact_save` 了 11 个版本才提交。程序允许（每版独立落盘），
但这属于提示词层面待收敛的部分，记在已知限制里。

**模块 2 上下文整理：在真实模型下实际发生并验证。** `pnpm smoke:mini`（`CONTEXT_WINDOW_CHARS=800`）

```
本次运行 mini-20261108103834-9d48｜30 条 turn｜任务 completed，交付 summary.md v1
worker_note 4 条成功记录（全部 epoch=0，无失败）：
  turn#1–6   → 1089 字符
  turn#7–13  → 1953 字符
  turn#14–17 → 2442 字符
  turn#18–21 → 2953 字符
```

第四次记录里仍保留着第一次整理时的事实（材料路径、产物 id、sha256、提供方中断经过），
并如实记下「turn#14 再次读取同一文件，结果与 turn#3 一致」——重复读取被记录，而不是被抹平。

**综合协作场景（带整理）：本次未跑完，如实记录。**

`CONTEXT_WINDOW_CHARS=1500 pnpm smoke:real` → 退出码 2（等待超时）。
提供方长时间返回 `finish_reason: "load"`，600 秒内任务没有进入终态，Worker 停在 `waiting`。
这次运行仍然证明了整理机制在真实模型下工作：

```
37 条 turn，5 次整理全部成功（failed=0），覆盖到 turn#33
turn#1–8   → 1401 字符
turn#9–14  → 2032 字符
turn#15–21 → 2924 字符
turn#22–27 → 3107 字符
turn#28–33 → 3041 字符
产物：report.md v1 已保存；任务仍未交付（卡在提供方）
```

记录长度在最后两次停止增长（3107 → 3041），说明模型按 `NOTE_MAX_CHARS` 做了压缩而不是无限累加。
但它不能替代一次完整交付，所以这里不判定模块通过。

**综合协作场景（无整理）：通过。** `pnpm smoke:real`

```
本次运行 real-20261108100951-3b83（独立数据库与工作目录）
Router 建任务 task_96512eb1（requireReview=true）→ 负责人 w1_d8edcb59
真实发生的协作：负责人自主创建检查者 w2_d14697e0，发起 3 轮正式检查
  v1 → changes_required
  v2 → approved（但负责人又改了内容）
  v3 → approved
submit_result 只引用 v3；程序校验 v3 的 approved 后才写 completed
任务 completed，产物 report.md v3（7610 字节）指纹一致
```

检查记录（直接来自数据库）：

```
artifact_version | outcome          | epoch
1                | changes_required | 0
2                | approved         | 0
3                | approved         | 0
```

判据修复记录：第一次跑完时判定脚本仍按「所有历史版本都要 approved」检查，把中间版本 v1 也算进去，
于是误报未通过。判定改为只看**交付消息实际引用的产物 id**后，`scripts/verify-run.ts` 对同一份数据库
重新判定为通过。这属于验收脚本的判据错误，不是程序行为错误——DB 里 v3 的 approved 与 completed 都是真实产生的。

修复判据后又完整跑了一次，脚本自身判定通过（`real-20261108101716-0c8b`，退出码 0）：

```
任务 completed，交付引用 report.md v2
检查者 w2_7fd4ce28 回复 approved，并把检查意见另存为 review-report-v2.md
负责人 w1_8cf28148 交付的 result 消息明确写着「仅对 v2 有效」
```

## 12. 真实模型下的行为

Ollama Cloud 在模型未就绪或请求过密时会返回 `finish_reason: "load"`，此时响应里没有文本也没有工具调用。
处理方式：

- `MODEL_CONCURRENCY` 限制同时发往提供方的请求数（默认 2）；
- `MODEL_MIN_INTERVAL_MS` 保证请求之间有最小间隔（默认 1500ms）；
- 客户端对 `load` 做有限次短重试，仍失败则视为「提供方暂时不可用」，Worker 转回 `waiting` 并 60 秒后自动重排，任务不会因此被标成失败。

## 13. 已知限制

- 长任务仍会触及 `MAX_STEPS_PER_WORKER` 或 `MAX_STEPS_PER_GROUP`；整理只能省输入，不能突破步数上限。
- 单条工具结果超过 8000 字符会被截断并提示用 `offset` 续读；模型不一定照着做。
- 外部副作用不保证精确一次。写文件类工具用 `dedupe_key` 与版本号降低重复风险，但这不等于事务回滚。
- `requireReview` 需要 Router 在建任务时显式声明；程序不解析自然语言里的"要检查"。
- 跨群组协作需要 Router 在两边分别下指令，尚未实现自动的跨组协商。
- 真实模型容易反复保存新版本（最小冒烟里出现 11 个版本），版本号会快速膨胀；没有自动清理策略。
- 真实模型也容易在检查环节来回多轮；`MAX_STEPS_PER_WORKER` 是当前唯一的兜底。
- Ollama Cloud 会返回 `finish_reason: "load"`，长任务明显变慢；程序会持久化等待并自动重试，但单次长任务仍可能耗时十分钟以上。
- 没有长期记忆、外部平台接入、权限系统、图形界面。

## 14. 恢复范围（明确边界）

- `running`：上次进程正在执行被打断 → 转 `queued`，写中断说明，模型自行核对后继续。程序**不重放**工具调用。
- `queued`：已排队未执行 → 直接重新入队。
- `waiting` + `wait_record(reason=reply|user)`：保持等待，不重跑。
- `waiting` + `wait_record(reason=provider)`：等 `deadline` 到点由 `tick()` 重新入队，跨重启有效。
- `waiting` 但没有任何等待记录（旧数据）：转 `queued` 并写提示。
- 终态：忽略。
- `recover()` 幂等：重复调用不会重复入队。

未恢复的部分：进程崩溃时正在进行的工具调用不会重做，也不会假装成功；模型只能看到「中断」提示并自己核对文件与消息。
