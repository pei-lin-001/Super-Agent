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
| Router | 理解意图、建任务、改要求、停任务；将 Worker 的技术信息转成用户易理解的结论、进展、影响和待决问题；回答普通问题 | 不读文件、不做调查、不写产物 |
| Worker | 执行具体工作、调工具、产出文件、自主拉协作者、直接与同组通信、请求检查、向负责人交付 | 不直接跟你对话（统一由 Router 对外）；不得越过负责人宣告整体完成 |
| 运行程序 | 消息持久化与投递、等待与唤醒、每 Worker 串行执行、并发与配额、状态迁移、工具执行、重启恢复 | 不用规则冒充模型判断，不静默失败 |

**模型表达意图，程序决定事实。** `task.status = completed` 只能由程序校验后写入。

内置角色提示词统一维护在 `src/runtime/prompts.ts`，只规定角色职责、协作方式和事实边界，不预设用户个人画像或特定领域。
具体目标、背景、环境和限制由对话及任务输入提供。Worker 保留可核对的依据、产物引用和未完成项；Router 可以重组信息、解释术语，
但必须保留事实、不确定性和关键限制。常规进展简洁，复杂交付按需展开，不直接堆叠内部对话和工具流水。

提示词指导模型行为，不能代替程序校验，也不会增加尚未提供的工具能力。正式检查区分必须修改的问题与可选建议；
必要产物满足完成条件和有效检查要求后及时提交，避免为了可选润色反复改版。CLI 的后台事件通知仍由程序单独输出。

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

正式检查请求在投递前就会被校验：`intent=review` 必须带 `refs.artifacts`，且每条都必须是**本任务**已登记的产物 id。
只写 `refs.files: ["report.md"]` 这种路径不算检查对象，请求当场拒绝、不投递、不产生空检查记录。
错误信息会直接告诉模型先用 `artifact_save` 保存，再把 `art_xxx` 放进 `refs`。

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

## 7.5 Worker 工具

全部工具都在 `src/tools/` 下，通过 `ToolRegistry` 注册给 Worker。Router 不持有这些工具。

### 文件

| 工具 | 做什么 | 关键限制 |
|---|---|---|
| `fs_list` | 列目录 | 只读范围内 |
| `fs_stat` | 文件类型、大小、mtime、sha256 | 只读范围内 |
| `fs_glob` | 按 `**/*.py` 这类模式找文件 | 任务目录内，跳过 node_modules/.git |
| `fs_search` | 按内容搜索，带行号与上下文 | 任务目录内 |
| `fs_read` | 分段读取，尾部给下一次 offset | 单次上限 2MB |
| `fs_write` | 创建或整体覆盖 | 任务目录内 |
| `fs_edit` | 按原文精确替换 | 见下 |

`fs_edit` 的语义是确定的：

- 原文找不到 → 失败，不做任何改动；
- 匹配到多处且没写 `replace_all` → 失败，指出歧义；
- 传 `edits` 数组改多处时**先整体校验**，任何一处不合法都不写盘；
- 传 `expected_sha256`（来自 `fs_read` / `fs_stat`）可在文件被别人改过时拒绝覆盖；
- 成功后返回字符数、行数变化、移出的行和新指纹，便于核对。

路径规则：`materials/` 前缀指向只读材料目录，其余落在 `work/<taskId>/`。符号链接指向目录外会被拒绝。

### 命令与作业

| 工具 | 做什么 |
|---|---|
| `proc_run` | 启动命令，返回作业 ID；`wait=true` 时直接等结果 |
| `proc_read` | 按 offset 读 stdout/stderr，运行中也能读 |
| `proc_wait` | 挂起等待作业结束，期间让出执行槽 |
| `proc_stop` | 终止作业及其进程树 |
| `proc_list` | 列出本任务的全部作业 |

参数语义：`command` 是程序名，`args` 是参数数组，**不经过 shell**，所以文件名不会被当成命令语法。需要 shell 语义时自行调用 `bash -lc`，并清楚这意味着什么。

- 标准输入：`stdin` 写入后关闭。
- 执行超时：`timeout_seconds`，到时终止并记录 `timeout`。
- 等待超时：`proc_wait` 的 `timeout_seconds` 只结束本次等待，作业继续跑。
- 环境变量：子进程只继承 `PATH`/`HOME`/`LANG`/`TMPDIR` 等基础变量，**不传模型密钥与搜索凭据**。
- 日志：落在 `work/.jobs/<taskId>/<jobId>.out|.err`，进程结束后仍可分段读取。
- 重启：上次运行遗留的 `running` 作业一律标为 `unknown`（结果未知），不重放、不按 PID 误杀。

### 联网与资料

| 工具 | 做什么 | 依赖 |
|---|---|---|
| `net_fetch` | 抓取已知 URL：状态码、最终 URL、内容类型、正文；HTML 提正文，二进制落盘 | 无 |
| `net_search` | 联网搜索，返回标题/URL/摘要 | `SEARCH_API_KEY`（未配置则报错，不伪造） |
| `doc_pdf` | PDF 按页提取文字 | 系统 `pdftotext` |
| `doc_notebook` | 读 .ipynb 的单元格与文本输出 | 无 |
| `env_capabilities` | 报告当前可用能力（不输出密钥） | 无 |

搜索摘要不等于网页正文，拿到线索后仍要用 `net_fetch` 打开来源。

### 产物

| 工具 | 做什么 |
|---|---|
| `artifact_save` | 文本内容存为产物（原有用法定持） |
| `artifact_import` | 把任务目录里的真实文件按字节登记为产物 |
| `artifact_read` / `artifact_list` | 读版本、列清单 |

`artifact_import` 登记的是**快照**：源文件之后再改，也不会改变已登记的版本；检查与交付绑定的始终是这个快照的指纹。

### 工具链的真实端到端验收

`pnpm smoke:toolkit`（`scripts/smoke-toolkit.ts`，场景 A：小型代码维护）会造一个带失败测试的小项目，
让真实模型自己跑测试、定位、改文件、复跑、拉协作者检查、登记真实文件、提交。

实际一次通过运行（`toolkit-20261108130415-9917`，验收配置 `MAX_STEPS_PER_WORKER=44`）：

```
任务 task_079c76b7 → completed，验收脚本退出码 0
负责人 w1_843106d7（38 步，done）｜检查者 w2 撞 44 步上限失败，w3 接手完成
产物：calc.py v1（485B，82587695baac…）、test_calc.py v1（639B）、FIX_NOTES.md v1（4888B）
交付引用：三份产物全部 approved（要求版本 0）
作业：62 个，61 个 exited、1 个 failed（真实失败被读到并处理）
工具使用：proc_run 71｜fs_read 36｜fs_stat 28｜fs_list 9｜fs_glob 5｜fs_edit 2｜
          artifact_import 3｜create_worker 2｜wait_for 3｜env_capabilities 1｜submit_result 1
交付代码复跑：cd work/toolkit-…/artifacts/v1 && python3 -m pytest → 4 passed
```

**默认配置（`MAX_STEPS_PER_WORKER=24`）下两次都没跑完**：第一次负责人 23 步后卡在等待（系统通知没唤醒等待者，
已修）；第二次负责人 24 步耗尽。工具变多以后，这条链路本身就在 30–40 步量级。
这次通过用的是 44 步的验收配置，**不是默认值**，提高上限这件事没有进默认配置。

### 执行权限的真实边界

- 文件工具被限制在任务目录与只读材料目录内，这是**应用层**检查。
- `proc_run` 的工作目录只是进程的起始目录，**不是操作系统级隔离**。命令仍能访问运行用户可读写的其他路径。
- 没有实现容器、沙箱或 seccomp。需要强隔离时请把整个程序放进容器运行。
- 能做但没做的：命令字符串黑名单（不可靠，故意不做）。

## 7.8 Watchdog（主系统之外的维护 Agent）

Watchdog 不是 Runtime 里的一个定时函数，它是**独立进程**：有自己的会话历史、自己的问题台账和动作记录，
主系统退出后它仍在运行。

```bash
pnpm start                 # 交互模式（REPL）
pnpm start -- --daemon     # 后台常驻：不依赖标准输入，调度持续运行
pnpm watchdog              # 只启动 Watchdog
pnpm watchdog --ask "为什么这个任务停住了？"   # 维护者提问（写持久队列，由唯一维护者处理）
pnpm watchdog --answer <问题ID>                # 查询之前提交的问题
```

### 一次真实巡检的结果（不是演示）

对一次真实的工具链运行（检查者已 87 步仍在跑）执行 `WATCHDOG_ONCE=1 pnpm watchdog`：

- 7 次模型调用后给出结论：**「不是任务偏离，而是复核环节在原地空转」**
- 依据：检查者写了约 19 个 `review_checks_*.py`，反复复验同一批已确定事实（同一指纹、多次 `pytest -q` 都是 2 passed），
  始终没有提交正式检查结论，任务停在 `approved 0 / pending 2`
- 动作：`nudge_worker` 要求本轮内二选一（提交 rejected 带最小修正 / 提交 approved 附口径限定），并禁止再新增校验脚本
- 记录：事件 `wdi_0741eb29`，10 分钟后复查，并写明「未改善则升级为 `pause_task`」
- 隔离：同一时间主系统的 89 个作业状态没有发生变化

控制命令写入 `control_command` 后由主系统的调度循环执行；那次运行是验收脚本（没有常驻 tick），
所以命令停在 `pending` 没有被执行——这是真实限制，不是被隐藏的。

### 它怎么独立

| 关注点 | 做法 |
|---|---|
| 进程 | `src/watchdog/main.ts`，独立入口、独立 pid 文件 `work/.runtime/watchdog.json` |
| 状态 | 自己的表 `wd_turn` / `wd_issue` / `wd_action`，与业务表分开 |
| 主系统状态 | 只读观察：任务、Worker、消息、作业、产物、检查；**不构造 Runtime**，因此不会恢复作业、不会调度 Worker |
| 主系统存活 | 读 `work/.runtime/instance.json` 的 pid 并探测；重启前用命令行特征确认进程确实属于本项目 |
| 定时 | 自己的 `setInterval`，不依赖主 Runtime 的 tick |
| 调度隔离 | 不占 Worker 并发槽，主系统卡死也不影响它 |

主系统退出、事件循环阻塞、Router 无响应时，Watchdog 仍能读库诊断、写问题台账、按策略拉起主系统。

### 闭环

```
定时消息 → 观察（摘要 + 引用）→ 模型判断 → 维护动作 → 记录预期 → 复查 → 关闭或继续
```

- **观察**：每轮只给摘要（任务状态、Worker 分布、产物与检查、运行中作业、可疑信号、最近事件），
  细节由 Watchdog 自己用 `inspect_task` / `read_history` 按 id 读取，不把全部历史塞进每次请求。
- **判断**：模型结合目标与证据判断是否在推进、是否偏离、是否只是正常等待（作业/服务/用户）。
  程序只提供信号（多个 Worker 同时等待、作业连续失败、有产物但无 approved），不替模型下结论。
- **维护**：`pause_task` `resume_task` `nudge_worker` `set_override` `rollback_override` `restart_main`。
  全部通过主系统的控制命令队列执行，走既有不变量，**不直接改业务数据**。
- **复查**：每条动作写清做了什么、为什么、预期、判断标准、下次检查时间；问题进 `wd_issue` 台账，
  没恢复就继续跟，恢复才置 `closed`。

### 挂起在执行边界生效

`pause_task` 会推进群组的**运行代次**（`worker.run_epoch`）。每次模型请求返回、每个工具调用之前都会核对代次：

- 挂起之后返回的响应 → 不执行任何工具，留一条「结果未知」记录（不冒充未执行，也不冒充成功）；
- 排队中的 Worker 受 `maintenance` 约束；
- 暂停→恢复后，暂停前发出的响应已经失去执行资格，不会重新执行；
- 已在运行的后台作业保留（这与「禁止启动新操作」是两件事）。

`resume_task` 只解除 `maintenance` 等待。`provider` / `job` / `reply` / `user` 等待保持原义，
恢复时若有这类等待，记录 `task.resume_keep_wait` 并跳过该 Worker，不强行入队。

### 通知不再顺手解除等待

`pushSystemNotice` 默认只投递、不唤醒：

| 场景 | 行为 |
|---|---|
| provider 退避通知 | 保留退避，到期由 tick 恢复 |
| 作业结束 | 只唤醒等待该作业的 Worker |
| 协作者失败（依赖消失） | 显式 `wake: 'force'` |
| 等待超时 | 显式 `wake: 'force'` |
| 普通进展通知 | 不解除任何等待 |

### 在线调整

维护者可以让 Watchdog 改提示词里的工作方式（例如「检查时区分必须修改项与可选建议」）：

```bash
# 通过控制命令（Watchdog 的 maintain 工具最终也是写这个队列）
set_override     key=worker.check_rules  content=...  reason=...
rollback_override key=worker.check_rules version=1
```

- 每次修改生成新版本，旧的保留，`active` 只有一行；
- Worker 构建 system prompt 时读取当前生效版本，**下一次请求就生效**，不需要重启；
- system prompt 里会标注 `# 维护者调整（vN，仅调整工作方式，不改变程序约束）`；
- 覆盖项不能改用户目标、要求版本、正式检查规则或提交门槛。

### 后台模式与受控恢复

- `--daemon` 复用同一个 Runtime，不复制内核；不读标准输入，靠 SIGTERM 或停机标记退出。
- 实例文件里 `pid: null` + `stopped: true` 表示已停机（不再写 `0`；`0` 会被当成有效进程）。
- 心跳文件 `work/.runtime/heartbeat.json` 每 5 秒更新，用来区分「进程活着但主循环无响应」。
- Watchdog 判断主系统状态：`absent` / `exited` / `unverified`（PID 复用或命令行不符）/ `alive` / `unresponsive`。
- 拉起有 120 秒冷却和 `work/.runtime/restart.json` 记录；启动失败保留 `work/.runtime/main.log`。
- 停机标记在**动作执行前**重新检查，维护者明确停机时不会被自动拉起。

### 调用统计

`model_call` 表按**每次 chat 调用**记账，不用对话条数反推：

| 字段 | 含义 |
|---|---|
| `purpose` | router / worker / note / watchdog / context |
| `status` | running / ok / failed / cancelled / interrupted |
| `usage_known` | 0 表示提供方没给 usage（**未知，不是 0**） |
| `http_attempts` | 与重试次数分开计数 |

```ts
store.modelCallStats()  // 按用途聚合：调用数、成功、失败、有 usage 的条数
```

### 维护者作业与业务作业

`process_job.scope` 区分 `biz` 与 `watchdog`：

- Watchdog 用自己 `ProcessService(scope='watchdog')`，日志在 `.jobs/watchdog/`
- `recover()` 只处理自己这一份——启动维护者不会把主系统 running 作业标成 unknown
- 工具：`run_command`（程序+参数数组，cwd 限工作目录，超时上限 60 秒）、`job_output`

### 巡检频率由证据决定

`dueForReview()`：有到期事件 → 必须审视；有活跃任务 → 按间隔周期性审视；否则跳过并记录原因。
巡检间隔可用 `watchdog.interval` 在线调整。

### 累计调用不再是失败条件

| 原来 | 现在 |
|---|---|
| Worker 24 步失败 | `MAX_STEPS_PER_WORKER` 默认 0；>0 时只写 `budget.worker` 事件 |
| 群组 160 步失败 | 同上，只写 `budget.group` |
| Router 6 轮直接结束 | `MAX_ROUTER_ROUNDS` 是**调度额度**：用完保存协调进度，下次 tick 自动续接 |
| 连续无工具文本 3 次失败 | 仍会提醒，但不再把 Worker 判死 |

旧环境变量继续被读取，含义已改为提醒阈值，不会被当成上限。

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
pnpm test                                   # 89 个测试，全部使用临时目录与模拟模型
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

模块 2 新增 18 个测试，集中在 `tests/regression/context.test.ts`。

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

**一次验收运行里观测到的实际浪费（`real-20261108114205-ec16`）**

这条链不是「检查者步数偏紧」这么简单，数据库里有明确的返工：

| 现象 | 证据 | 代价 |
|---|---|---|
| 检查请求只写了文件路径 | `msg_1d5d5797` 的 `refs.artifacts=[]`，只有 `files:[report.md, materials/…]` | 检查记录为空，直到提交被拒才发现 |
| 补发一次才登记成功 | `msg_b035bfdd` 才带上 `art_3f38cd88` | 多一轮请求与回复 |
| 检查对象版本漂移 | 请求引用 `review-notes.md v1`（`art_52b86978`），实际最终是 v3（`art_d3f14b3d`） | v1 那次检查作废，要重新检查 v3 |
| 检查记录本身反复改版 | `review-notes.md` v1 4945B → v2 6517B → v3 8671B | 每改一次，被引用版本就变一次 |
| 最终有效组合只剩一条 | 5 条 review 记录里，只有 `msg_38256d61` 同时覆盖交付的两个版本 | 前 4 条都是过程记录 |

所以本轮先修入口校验，不去动步数上限。检查者 `w2` 撞上 24 步，是在承担这些返工之后才发生的；
在入口校验生效前，用提高预算来「解决」它只会掩盖原因。

**统计口径**：`83 条请求`指**请求体转储数**（每次 `chat()` 调用一次），不是 HTTP 请求数。
`load` 等待与 5xx 重试都会在内部产生额外的 HTTP 尝试，脚本现在分别打印
`worker/router 的 httpAttempts`。两者不能混用。

**模块 2 完整协作验收：通过。** `real-20261108114205-ec16`

配置（压力测试调整项，非默认值）：`CONTEXT_WINDOW_CHARS=16000`（默认值）、
`NOTE_TRIGGER_TURNS=6`、`NOTE_TRIGGER_CHARS=800`（默认 10 / 3000，为确定性触发而收紧）、
`MODEL_CONCURRENCY=1`、`MODEL_MIN_INTERVAL_MS=800`、等待上限 1500 秒。

```
任务 task_cd9d3274｜requireReview=1｜要求版本 0｜status=completed
负责人 w1_41b9e9c8（19 步，done）自主创建 w2_a38e8b7c、w3_f996049d，parent_id = w1
产物 report.md v1（6389 字节，sha256 0387bcee…）→ 检查 approved（版本 1、epoch 0、指纹一致）
交付引用：{"artifacts":[{"artifactId":"art_3f38cd88","name":"report.md","version":1},
          {"artifactId":"art_d3f14b3d","name":"review-notes.md","version":3}]}
submit_result 后任务 completed，验收脚本退出码 0
工作记录：w1 4 次、w2 5 次、w3 5 次，全部成功（failed=0）
83 条请求全部含 user 轮次；其中 42 条的 system 里实际注入了工作记录
```

压力测试对照（同一天，同一任务）：

| 窗口 | 请求数 | `finish=load` | 结果 |
|---|---:|---:|---|
| 3000 字符 | — | 0 | 两个 Worker 均撞 24 步上限失败；检查者把同一份材料读了 10 次 |
| 16000 字符（默认） | 83 | 0 | 任务 completed，交付 v1 通过 |

3000 字符那次是明确的反面证据：窗口小到装不下材料，整理做得再多也挡不住重复读取。
所以不能把"整理"当成重复读写的解法，它只是把退出窗口的内容换成可查回的引用。

请求结构修复（本轮）：历史裁剪可能把所有 `user` 轮次挤出窗口，导致请求里只剩
`system + assistant + tool`。现在每次调用都额外附带一条程序生成的稳定执行请求
（`renderExecutionDirective`），保证请求结构里始终有 `user`。
修复前后对比：同一任务在修复前出现 44 次 `finish_reason=load`，修复后三次运行均为 0 次。
这是单次对照，不能直接断言因果，但请求结构缺口本身已经消除。

Router 对外汇报（对同一份运行记录追问「现在进展如何」）：

> **结论：任务已完成（程序状态为 completed）**……`report.md` v1（6389 字节，指纹前缀 `0387bcee…`）……
> 同组独立核对人两轮实读三份材料原文逐条比对，结论为 **approved**……结论仅对上述两个版本有效，
> 任一文件改动需重新核对。……第一位核对人完成核对后因步数达上限中断……撰写人因此补做了第二轮独立核对。
> **未完成部分**：交付层面没有。剩下的是材料本身的信息缺口，报告里已如实列为「待确认」……
> **需要你决定的**：口径可比性、币种与含税、统计口径一致性、华南下滑的客户级证据、财务指标缺失。

`node scripts/router-check.ts <db>` 可以对任意运行记录复跑这一步：它先把数据库复制到临时目录，
Router 以只读模式运行（不提供 `create_task` / `send_to_worker`），结束后比对原库的 sha256 与 mtime，
确认未被修改；拿不到本轮回复就以退出码 1 结束。

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
