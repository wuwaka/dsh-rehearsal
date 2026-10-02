# 失效签名表 · failure signatures

本文件把 `run` 各阶段识别的日志形态列全，每条都锚到一个**具体出处**：上游 issue 编号、或本仓的 `file:line`。

为什么要有这张表：一个"能不能升"的结论工具，最容易出的事故不是崩，是**把没演练过的事说成演练过了**。所以每条签名都写清三件事 —— 它命中时说明什么、它**不**命中时不能推出什么、本机能不能复现。

同类工具普遍用散文写"已知限制"，把签名做成正文条目的只有 `sweetory1320/dsh-plugin-lab`（`references/failure-modes.md` + `src/signatures.js`，并用真崩溃日志做回归锁）。**据 2026-10-02 检索，生态里没有任何项目把签名锚到上游 issue 编号** —— 这张表的差异化就在这条上。

---

## 一、判定为失败的签名

| id | 日志形态 | 检测点 | 命中说明什么 | 出处 | 本机可复现 |
|---|---|---|---|---|---|
| `v4-producer-source-kind` | `format v4 message requires a producer-owned source kind` | `src/lib/drill.js:14-20` → 写回合判 `fail`（`src/lib/drill.js:324`） | 会话里存在 v3 遗留 `source.kind:"plugin"` 行：**读侧全过，每个写回合必炸** | 上游 [`#1229`](https://github.com/anywhere-labs/dsh-desktop/issues/1229)，标题原文即此句 | **否**。`0.2.0-rc.1` 起 `@deepseek-ai/dsh-session-format-v3-to-v4` 迁移包自带 `producerKind` 改写映射（rc.1 与 0.2.0-rc.2 的 `lib` 逐字节一致），本机数据在迁移时已被改写。检测保留：未来宿主或历史数据出现该形态即命中 |
| `SessionFormatError` | `SessionFormatError`（无 id，直接正则） | `src/lib/drill.js:324` → 写回合判 `fail` | 迁移后产物被宿主按格式原因拒绝 | 与上一行同族，形态更宽 | 否（同上） |
| `no v4 generation after write round` | 无 —— 判据是**产物缺失**：写回合后 `session.v4.jsonl.zstd` 不存在 | `src/lib/drill.js:311-313` → `fail` | 宿主拒绝写出该代，或迁移在写路径上断裂 | 本工具自定判据（退出码不参与判定） | 否 |

## 二、启动阶段签名

| id | 日志形态 | 检测点 | 命中说明什么 | 出处 | 本机可复现 |
|---|---|---|---|---|---|
| `patch-entry-not-found` | `patch: entry "<id>" not found` | `src/commands/run.js:21` → 冷启动阶段归因 | `cordis.patch.yml` 某行指向装载树上不存在的条目 | 上游 [`#1294`](https://github.com/anywhere-labs/dsh-desktop/issues/1294)：issue 正文第 30 行的真机日志就是 `patch: entry "llm-commandcode" not found` / `patch: entry "mnemon" not found`，**其后 120 秒零日志**，第 31 行 Main 进程 RPC 超时并进入恢复模式 | 否（本机 profile 的 patch 行都能解析） |
| `port-in-use` | `EADDRINUSE` | `src/commands/run.js:22` | 端口占用 —— 属环境问题，**不是兼容性结论** | 本工具自定 | 是 |
| `module-missing` | `Cannot find module` | `src/commands/run.js:23` | 候选安装不完整，或原生模块缺失（默认 `--ignore-scripts` 时更要注意） | 本工具自定 | 是（可造） |

`#1294` 里还有第二类形态，它不是签名而是**流程设计依据**：插件批量升级后**首次**冷启动 renderer 30 秒超时、**完全相同配置第二次启动即正常**。所以 `run` 固定跑两次冷启动（`src/commands/run.js:164`）—— 一次失败一次成功记为抖动，不记为不兼容。

## 三、"不是失败"的形态（最容易被误读的一节）

| 形态 | 出现处 | 正确读法 |
|---|---|---|
| `MISSING_CREDENTIAL` | 冷启动（`src/commands/run.js:169,178`）；写回合（`src/lib/drill.js:325`） | **启动阶段：这是通过判据** —— 说明进程活着走到了模型调用边界，而那里正是无键该停的地方。**写回合阶段：这是"没演练到"** —— replay 没拦住 provider 路由，写路径未被 exercising，判 `inconclusive`，绝不判 `pass` |
| `no adapter registered` / `llm-replay:` | `src/lib/drill.js:325` | replay 挂载没生效 → `inconclusive` |
| 工具结果行含 `not registered` / `unknown tool` / `not found` | `src/lib/drill.js:217-226` → `unknownToolish` 计数 | **预期产物**：写回合默认抑制全部工具提供方（`src/lib/shadow.js` `writeReplayPatch` 的 `suppressToolRows`），被重放的调用只该拿到这个错误。它不是兼容性信号 |
| 工具结果行含 `"isError":true` | 同上 → `errorFlagged` 计数 | 历史里本来就报错的行，与本次升级无关 |
| `runs under agent preset … which the one-shot runner does not compose` | `src/lib/drill.js:22-25`，severity `warn` | one-shot runner 的采用检查未被中和 —— 若在使用 `--preset-mode patch` 时仍出现，说明**采样或打补丁环节出了问题**，不是宿主不兼容 |
| `was recorded in … not …` | `src/lib/drill.js:28-31`，severity `warn` | cwd 与录制值不符 —— 即沙箱重写没生效（`copySet` 的 header 重写 + 目录搬迁必须**成对**发生）；是工具自身的缺陷信号 |
| 迁移"失败"但退出码为 1 | 全流程 | 无键迁移**成功**也会以 `MISSING_CREDENTIAL` 退出 1。`--dump-config-schema` 设计上成功也置 `exitCode=1`。**判定只认产物，绝不认退出码** |
| `turn/end` 存在但 `reason.kind === "error"`，且无新 `assistant/message` 行 | `src/lib/drill.js:323` | 骨架假阳性 —— 这就是 `pass` 为什么要求两个条件同时成立（turn 收口 **且** 消息落盘） |

## 四、预设会话的结构性不可判定

`--preset-mode patch` 中和的只是那**一个**采用检查，预设组合不会重建。实测（2026-10-02，2/2）：replay 不拦截带预设会话的 provider 路由 → 落 `MISSING_CREDENTIAL`，新行形态是 `assistant/attempt` 而非 `assistant/message`。

结论：预设会话的写回合**照跑、照报**（`evidence[].preset`、`coverage.writeRounds.presetAttempts/presetPass`），但**不单独决定阶段结论** —— `writeRoundVerdict()`（`src/lib/drill.js:101`）只在非预设轮上取 pass/fail；只有预设可试时整阶段判 `inconclusive`。这不是保守，是那一轮确实没演练到写路径。

## 五、怎么加一条签名

> 上表两条 `warn` 形态（`preset-not-composed`、`cwd-mismatch`）的措辞取自宿主自己的报错文本，**在本机的任何一次彩排里都没有真的出现过** —— 报告产物里能查到的只有 `assistant/attempt`（见第四节）。它们列在这里是"如果宿主改了这段文本就说明我们的前提变了"的哨兵，不是"测过"的证据。`test/signatures.test.js` 里对应的夹具也按模板行标注，不做原文引用。


沿用 `dsh-plugin-lab` 的做法，但把锚点换成 issue 编号：

1. 在 `src/lib/drill.js` 的 `WRITE_FAIL_SIGNATURES` 或 `src/commands/run.js` 的 `BOOT_SIGNATURES` 加 `{id, pattern, note, severity}`，`note` 里写清出处（issue 号或 `file:line`）；
2. 在 `test/signatures.test.js` 加**一对**断言：真日志行必须命中、健康日志行必须不命中。断言里的日志必须是**从 issue 正文或真机产物抄来的原文**，不能是为了让正则过而编的；
3. 在本文件的上表加一行，如实标"本机可复现 / 不可复现"。不可复现要写清为什么，否则读的人会以为测过。

---

### English summary

- Every log pattern `run` recognizes is listed with its detection site (`file:line`) and its origin — an **upstream issue number** where one exists, otherwise a locally defined criterion. No project in this ecosystem appears to key failure signatures to upstream issues.
- `v4-producer-source-kind` (#1229) and `patch-entry-not-found` (#1294) are both **unreproducible on the development machine** — the detection is kept anyway, and the table says so instead of implying coverage.
- `MISSING_CREDENTIAL` means *pass* during boot and *not exercised* during a write round; the same string carrying opposite meanings is the reason verdicts are artifact-driven and never exit-code driven.
- Preset-bearing sessions cannot produce a decisive write round at all, so `writeRoundVerdict()` aggregates only over non-preset rounds.
- Adding a signature requires a matched pair of assertions: the real log line must hit, a healthy line must not.
