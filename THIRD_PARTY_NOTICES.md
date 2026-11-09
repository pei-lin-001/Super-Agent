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
