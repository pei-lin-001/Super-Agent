import { createInterface } from 'node:readline';
import type { Message, Task, Worker } from '../domain/types.ts';
import type { Runtime } from '../runtime/runtime.ts';
import type { Router } from '../runtime/router.ts';
import { formatTaskUsage } from './usage.ts';

export interface ReplOptions {
  runtime: Runtime;
  router: Router;
}

const HELP = `可用命令：
  /tasks                 列出任务
  /task <taskId>         查看任务详情与最近消息
  /workers [taskId]      查看任务下的 Worker
  /messages <workerId>   查看某个 Worker 的收发消息
  /trace <taskId>        查看任务完整消息链与事件
  /artifacts <taskId>    查看产物
  /usage <taskId>        查看任务相关模型调用与 token 用量
  /stop <taskId> [原因]   取消任务
  /help                  显示本帮助
  /quit                  退出
其他输入会作为消息交给 Router。`;

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

export async function startRepl(options: ReplOptions): Promise<void> {
  const { runtime, router } = options;
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '你> ' });
  let outputOpen = false;

  const write = (text: string): void => {
    if (outputOpen) process.stdout.write(`\r\x1b[2K${text}\n`);
    else process.stdout.write(`${text}\n`);
    rl.prompt(true);
  };

  const unsubscribe = runtime.on((event) => {
    switch (event.type) {
      case 'router.start':
        write('（Router 正在思考…）');
        break;
      case 'router.reply':
        write(`Router：${event.text}`);
        break;
      case 'router.notice':
        write(`[提示] ${event.text}`);
        break;
      case 'task.created':
        write(`[任务] 已建立 ${event.taskId}：${event.title}`);
        break;
      case 'task.status':
        write(`[任务] ${event.taskId} → ${event.status}${event.reason ? `（${event.reason.slice(0, 80)}）` : ''}`);
        break;
      case 'worker.created':
        write(`[Worker] ${event.workerId} 加入协作（职责：${event.role}${event.parentId ? `，由 ${event.parentId} 创建` : ''}）`);
        break;
      case 'message.sent':
        write(`[消息] ${event.from} → ${event.to}（${event.kind}）`);
        break;
      case 'error':
        write(`[错误] ${event.text}`);
        break;
      default:
        break;
    }
  });

  const printTask = (task: Task): void => {
    const workers = runtime.listTaskWorkers(task);
    write(
      [
        `任务 ${task.id}｜${task.title}`,
        `状态：${task.status}　负责人：${task.ownerWorkerId ?? '-'}　要求检查：${task.requireReview ? '是' : '否'}`,
        `目标：${task.goal}`,
        `完成条件：${task.doneCriteria || '（未设置）'}`,
        `Worker（${workers.length}）：`,
        ...workers.map(
          (worker) => `  ${pad(worker.id, 16)} ${pad(worker.role, 14)} ${pad(worker.status, 10)} 步数 ${worker.stepCount}`,
        ),
      ].join('\n'),
    );
  };

  const printMessages = (messages: Message[], title: string): void => {
    if (messages.length === 0) {
      write(`${title}：（无）`);
      return;
    }
    const lines = messages.map((message) => {
      const refs = message.refs?.artifacts?.length
        ? ` 产物=${message.refs.artifacts.map((item) => `${item.name}v${item.version}`).join(',')}`
        : '';
      return `  [${message.id}] ${message.kind} ${message.fromId}→${message.toId} ${message.status}${message.replyTo ? ` replyTo=${message.replyTo}` : ''}${refs}\n      ${message.body.replace(/\n/g, ' ⏎ ').slice(0, 160)}`;
    });
    write([`${title}（${messages.length} 条）：`, ...lines].join('\n'));
  };

  const handleCommand = async (line: string): Promise<boolean> => {
    const [command, ...rest] = line.slice(1).trim().split(/\s+/);
    const argument = rest[0] ?? '';

    switch (command) {
      case 'help':
        write(HELP);
        return true;
      case 'tasks': {
        const tasks = runtime.store.listTasks();
        if (tasks.length === 0) write('（暂无任务）');
        else {
          write(
            tasks
              .map((task) => {
                const workers = runtime.listTaskWorkers(task);
                return `${pad(task.id, 14)} ${pad(task.status, 10)} 负责人=${task.ownerWorkerId ?? '-'} Worker=${workers.length}  ${task.title}`;
              })
              .join('\n'),
          );
        }
        return true;
      }
      case 'task': {
        const task = runtime.store.getTask(argument);
        if (!task) {
          write(`任务不存在：${argument}`);
          return true;
        }
        printTask(task);
        printMessages(runtime.store.listTaskMessages(task.id, 200).slice(-8), '最近消息');
        return true;
      }
      case 'workers': {
        const task = argument ? runtime.store.getTask(argument) : null;
        const workers: Worker[] = task
          ? runtime.listTaskWorkers(task)
          : runtime.store.listWorkers();
        if (workers.length === 0) {
          write('（暂无 Worker）');
          return true;
        }
        write(
          workers
            .map(
              (worker) =>
                `${pad(worker.id, 16)} ${pad(worker.groupId, 18)} ${pad(worker.status, 10)} 步数=${worker.stepCount} 来源=${worker.parentId ?? '-'} 职责=${worker.role}`,
            )
            .join('\n'),
        );
        return true;
      }
      case 'messages': {
        if (!argument) {
          write('用法：/messages <workerId>');
          return true;
        }
        printMessages(runtime.store.listMessagesForWorker(argument, 100), `Worker ${argument} 的消息`);
        return true;
      }
      case 'trace': {
        const task = runtime.store.getTask(argument);
        if (!task) {
          write(`任务不存在：${argument}`);
          return true;
        }
        printTask(task);
        printMessages(runtime.store.listTaskMessages(task.id, 500), '完整消息链');
        const events = runtime.store.listEvents(task.id, 200);
        write(
          ['事件时间线：', ...events.map((event) => `  ${event.createdAt} ${pad(event.type, 18)} ${event.detail ?? ''}`)].join('\n'),
        );
        return true;
      }
      case 'artifacts': {
        const artifacts = runtime.store.listArtifacts(argument);
        if (artifacts.length === 0) write('（暂无产物）');
        else {
          write(
            artifacts
              .map(
                (artifact) =>
                  `  ${artifact.name} v${artifact.version}  ${artifact.bytes} 字节  ${artifact.path}  sha256=${artifact.sha256.slice(0, 12)}…`,
              )
              .join('\n'),
          );
        }
        return true;
      }
      case 'usage': {
        if (!argument) {
          write('用法：/usage <taskId>');
          return true;
        }
        const usage = runtime.store.taskUsage(argument);
        write(usage ? formatTaskUsage(usage) : `任务不存在：${argument}`);
        return true;
      }
      case 'stop': {
        const reason = rest.slice(1).join(' ') || '用户要求停止';
        const ok = await runtime.stopTask(argument, reason);
        write(ok ? `已取消任务 ${argument}` : `任务不存在或已结束：${argument}`);
        return true;
      }
      case 'quit':
      case 'exit':
        rl.close();
        return true;
      default:
        write(`未知命令：/${command}，输入 /help 查看帮助`);
        return true;
    }
  };

  write(`Super-Agent 已启动（Node ${process.version}）。输入 /help 查看命令，直接输入内容交给 Router。`);
  rl.prompt();

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (line === '') {
      rl.prompt();
      continue;
    }
    outputOpen = true;
    try {
      if (line.startsWith('/')) await handleCommand(line);
      else await router.handleUserMessage(line);
    } catch (error) {
      write(`[错误] ${(error as Error).message}`);
    } finally {
      outputOpen = false;
    }
    rl.prompt();
  }

  unsubscribe();
  await runtime.stop();
}
