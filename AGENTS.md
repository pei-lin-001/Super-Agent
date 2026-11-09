# 本仓库的工作约定

## 测试节奏

全量测试很慢，不要每改一处就跑一遍。

- 改的过程中：`pnpm typecheck` + 只跑相关的单个测试文件（`node --test tests/regression/xxx.test.ts`）。
- 收尾时：集中跑一次 `pnpm test` 和 `pnpm accept:channel`，把结果贴出来。

## 待办清单

每完成一项就立刻把待办标成 completed，不要积着 pending 或留着 in_progress 的残影——
清单干净与否会被当成"事情做没做完"的证据。
