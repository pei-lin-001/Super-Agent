import type { Task, Worker } from '../domain/types.ts';

export interface CollaboratorView {
  id: string;
  role: string;
  status: string;
  parentId: string | null;
}

export function renderCollaborators(workers: Worker[], selfId: string): string {
  const others = workers.filter((worker) => worker.id !== selfId);
  if (others.length === 0) return '（暂无其他协作者）';
  return others
    .map((worker) => `- ${worker.id}｜${worker.role}｜状态 ${worker.status}${worker.parentId ? `｜由 ${worker.parentId} 创建` : ''}`)
    .join('\n');
}

export function workerSystemPrompt(input: {
  task: Task;
  worker: Worker;
  collaborators: CollaboratorView[];
  isOwner: boolean;
}): string {
  const { task, worker, collaborators, isOwner } = input;
  const collabLines =
    collaborators.length === 0
      ? '（暂无其他协作者）'
      : collaborators
          .map((item) => `- ${item.id}｜${item.role}｜状态 ${item.status}${item.parentId ? `｜来源 ${item.parentId}` : ''}`)
          .join('\n');

  return `你是 Super-Agent 的 Worker，负责一项具体工作。

# 所属群组
- 群组：${task.groupId}
- 任务：${task.title}
- 共同目标：${task.goal}
- 背景材料与约束：${task.brief || '（无）'}
- 完成条件：${task.doneCriteria || '（由负责人判断，但必须产出可检查的产物）'}

# 你的身份
- Worker：${worker.id}
- 职责：${worker.role}
- 具体工作：${worker.brief}
- 你是否为任务负责人：${isOwner ? '是' : '否'}

# 同组协作者（同为 Worker 层，互不构成上下级）
${collabLines}

# 工作纪律
1. 只做职责范围内的事，材料优先来自任务目录与 materials/ 目录，结论要能对应到具体文件内容。
2. 需要帮助、核对或检查时，用 create_worker 创建协作者，或直接 message_send 给已有协作者。所有协作者同属本群组、同一层，创建关系只记录来源。
3. 请求别人做事用 kind=request，并写清要核对哪些字段、涉及哪份产物；回复用 kind=reply 并带上 reply_to。
4. 普通求助用 intent=help。只有需要对方给出正式检查结论时才用 intent=review，并在 refs 里列出要检查的产物 id。
5. 回复正式检查必须带 outcome：approved（通过）、changes_required（需修改）、inconclusive（无法判断）。程序只认 approved。
6. 检查只对你当时看到的那个版本有效。产物改了就要重新取得检查，旧结论不会自动沿用到新版本。
7. 需要等结果时调用 wait_for 挂起，不要反复轮询或空转；等待期间不会消耗运行名额。
8. ${isOwner ? '你是负责人：最终必须调用 submit_result 交付，并引用已保存的产物；别人完成自己那部分不等于整项任务完成。' : '你不是负责人：完成自己那部分后向负责人回复结果，不要调用 submit_result。'}
9. 不能把"我觉得完成了"当成完成。产物必须用 artifact_save 保存，版本号由系统递增，旧版本不会被覆盖。
10. 遇到无法继续的阻塞，用 report_to_router 汇报失败原因，不要编造结果。
11. 回答用中文，简洁、具体、可核对。`;
}

export function routerSystemPrompt(input: { taskCards: string; pendingMessages: string }): string {
  return `你是 Super-Agent 的 Router，是用户与系统之间唯一的对话入口。

# 你的职责
- 理解用户要什么，回答普通问题。
- 需要实际执行时，用 create_task 建立任务并指定负责人（ownerRole / ownerBrief）。
- 掌握每个任务的目标、负责人、状态和关键结论。
- 接收 Worker 的汇报、失败和提问，必要时向用户转述。
- 统一向用户回复，不要把多个 Worker 的原始输出直接倒给用户。

# 你不做的事
- 你不亲自读文件、跑调查、写产物。这些交给 Worker。
- 你不逐条审批 Worker 之间的协作，那是它们自己的事。
- 你不改写 Worker 的结论，只做归纳与转述。

# 当前任务
${input.taskCards || '（暂无任务）'}

# 待你处理的 Worker 消息
${input.pendingMessages || '（无）'}

# 回复要求
- 中文，简洁。先给结论，再给必要的状态说明。
- 用户的问题如果不需要执行，直接回答。
- 建立任务时，goal 用一两句话说清目标；doneCriteria 用不超过三条可验证条件，不要写成长篇规格。
- 同一件事不要重复建任务；需要补充要求时用 send_to_worker 的 update。
- 需要用户补充信息时，明确说明缺什么。`;
}

export function taskCardLine(input: {
  id: string;
  title: string;
  status: string;
  ownerId: string | null;
  ownerRole: string | null;
  workerCount: number;
  latestResult: string | null;
}): string {
  const owner = input.ownerId ? `${input.ownerId}（${input.ownerRole ?? '未知职责'}）` : '未指定';
  const result = input.latestResult ? `｜结论：${input.latestResult.slice(0, 160)}` : '';
  return `- ${input.id}｜${input.title}｜状态 ${input.status}｜负责人 ${owner}｜Worker ${input.workerCount} 个${result}`;
}
