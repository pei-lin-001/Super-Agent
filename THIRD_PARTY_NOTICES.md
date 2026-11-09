# 第三方代码与许可

## 微信（腾讯 iLink）协议与媒体处理

`src/channels/weixin.ts` 中的协议流程、二维码登录状态机、CDN 上传/下载与 AES-128-ECB 处理，
改写自腾讯官方发布的 `@tencent-weixin/openclaw-weixin@2.4.10`（MIT）：

- 原仓库：`openclaw-weixin`（Tencent）
- 参考源码：`src/api/api.ts`、`src/api/types.ts`、`src/cdn/*`、`src/auth/login-qr.ts`、`src/messaging/inbound.ts`
- 协议文档：`docs/protocol_zh_CN.md`（同仓库）
- 许可：MIT

改写范围：去掉 OpenClaw 插件宿主依赖（配置、日志、路由、通道注册、重试策略），只保留
HTTP 形状、二维码状态机、uint64 无损解析、媒体加解密与上传下载流程；存储、会话、去重、
发送结果判定全部改由本仓库实现。

有意的行为差异：

| 场景 | 上游 | 本仓库 |
| --- | --- | --- |
| 游标 | 先保存新游标再处理消息 | 先落库成功、再前移游标 |
| 主人身份 | 空 allowFrom 仍可能放行 | 未绑定主人时任何消息都不执行 |
| 回复上下文 | 存在插件状态里 | 存进 `channel_session.context_token`，不进入模型提示词 |
| 失败判定 | 部分接口不检查业务码 | 逐接口检查 `ret`/`errcode`，业务拒绝记 `failed` |

MIT 许可原文：

```
MIT License

Copyright (c) Tencent

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 设计参考（未复制代码）

- OpenClaw 的持久入站与游标顺序思路（先落库、再前移）。
- Hermes 的渠道抽象与微信恢复状态机。

## pi（@earendil-works/pi-coding-agent）

`src/vendor/pi/` 下 5 个文件、`src/runtime/pi-worker.ts` 的宿主接口，以及
`src/runtime/window.ts` 的 token 估算与窗口切点，移植/参照自
`@earendil-works/pi-coding-agent@1.5.0`：

- 包名与版本：`@earendil-works/pi-coding-agent`，`1.5.0`
- 上游许可：**MIT**（依据：该包 `package.json` 的 `license: "MIT"` 字段，与
  `README.md` 的 License 小节；上游 npm 包内未附带 LICENSE 文件）
- 参考源码：上游为 monorepo 结构，移植文件头部逐条写明来源，例如
  `packages/agent-core/dist/agent-loop.js`、`packages/ai/dist/utils/event-stream.js`、
  `packages/ai/dist/utils/transcript.js`、`packages/ai/dist/types.d.ts`、
  `packages/coding-agent/dist/core/tools/truncate.js`

| 本仓库文件 | 上游来源 | 方式 |
| --- | --- | --- |
| `src/vendor/pi/agent-loop.ts` | `packages/agent-core/dist/agent-loop.js` | 原样搬运，删减见下 |
| `src/vendor/pi/event-stream.ts` | `packages/ai/dist/utils/event-stream.js` | 原样搬运，补类型 |
| `src/vendor/pi/transcript.ts` | `packages/ai/dist/utils/transcript.js` | 原样搬运，只保留用到的函数 |
| `src/vendor/pi/truncate.ts` | `packages/coding-agent/dist/core/tools/truncate.js` | 原样搬运 |
| `src/vendor/pi/types.ts` | `packages/ai/dist/types.d.ts` | 原样搬运，裁剪到用到的子集 |
| `src/runtime/pi-worker.ts` | 上游宿主接口（`StreamFn`、`AgentLoopConfig` 等） | 本地新写的衔接层，非搬运 |
| `src/runtime/window.ts` | token 估算与窗口切点逻辑 | 改名适配 |

`agent-loop.ts` 相对上游的删减：provider 身份归因字段、并行工具执行
（改为逐个顺序执行）、`beforeToolCall`/`afterToolCall` 钩子、工具参数 schema
校验。控制流（内外双层循环、steering/follow-up 队列、输出被上限截断时整批工具
作废）保留。

有意的行为差异：

| 场景 | 上游 | 本仓库 |
| --- | --- | --- |
| 上下文压缩 | 由 `prepareNextTurn` 钩子驱动 compaction | 该钩子未接，改由 `note.ts` + `context.ts` 的字符预算负责 |
| 工具结果失败标记 | `isError` 随消息流转 | 落库到 `worker_turn.is_error`，回放时同时进 `isError` 与模型可见文本 |
| 工具声明变更 | 支持运行期增删 | 工具集合在一次运行内恒定，相关机制不启用 |
| 事件流 | 逐事件驱动 UI | 事件回调未接，状态仍以 `worker_turn` 为唯一事实源 |

MIT 许可要求保留版权声明与许可声明；本仓库以本文件承担该声明义务。
