# 失效签名

[简体中文](FAILURE_MODES.md) | [English](FAILURE_MODES.en.md)

`run` 会对若干已知日志形态与产物条件分类。每条签名记录四件事：

- 在哪里检测；
- 命中说明什么；
- 未命中不能推出什么；
- 本机是否复现过。

签名是证据，本身不构成诊断。出处优先锚到上游 issue 编号，没有 issue 的标注本仓库的 `file:line`。

## 判定语义

- **`pass`** —— 被检验的性质确实观察到。
- **`fail`** —— 被检验的性质被违反。
- **`inconclusive`** —— 预演没有把该路径执行到足以判定的程度。既不算通过，也不算失败。

`MISSING_CREDENTIAL` 这一个字符串在两个阶段含义相反（见第三节），这也是判定必须来自产物、不能来自退出码的原因。

---

## 一、判定失败的签名

| id | 日志形态 | 检测位置 | 命中含义 | 出处 | 本机可复现 |
|---|---|---|---|---|---|
| `v4-producer-source-kind` | `format v4 message requires a producer-owned source kind` | `src/lib/drill.js:14-20`，写回合判 `fail`（`src/lib/drill.js:324`） | 会话中存在 v3 遗留 `source.kind:"plugin"` 行：读侧校验全部通过，每个写回合失败 | 上游 [`#1229`](https://github.com/anywhere-labs/dsh-desktop/issues/1229)，标题即此句 | 否。`0.2.0-rc.1` 起 `@deepseek-ai/dsh-session-format-v3-to-v4` 迁移包自带 `producerKind` 改写映射（rc.1 与 0.2.0-rc.2 的 `lib` 目录逐字节一致），本机数据在迁移时已被改写。检测保留，用于未来宿主或历史数据出现该形态时命中 |
| `SessionFormatError` | `SessionFormatError`（无 id，正则直接匹配） | `src/lib/drill.js:324`，写回合判 `fail` | 迁移后产物被宿主以格式原因拒绝 | 与上一行同族，形态更宽 | 否，同上一行 |
| `no v4 generation after write round` | 无日志匹配，判据为产物缺失：写回合后 `session.v4.jsonl.zstd` 不存在 | `src/lib/drill.js:312-314`，判 `fail` | 宿主拒绝写出该代，或迁移链在写路径上中断 | 本工具判据（退出不参与判定） | 否 |

## 二、启动阶段签名

| id | 日志形态 | 检测位置 | 命中含义 | 出处 | 本机可复现 |
|---|---|---|---|---|---|
| `patch-entry-not-found` | `patch: entry "<id>" not found` | `src/commands/run.js:21`，冷启动阶段归因 | `cordis.patch.yml` 中某行指向装载树上不存在的条目 | 上游 [`#1294`](https://github.com/anywhere-labs/dsh-desktop/issues/1294)：issue 正文第 30 行的真机日志为 `patch: entry "llm-commandcode" not found` 与 `patch: entry "mnemon" not found`，其后 120 秒无日志输出；第 31 行 Main 进程 RPC 超时并进入恢复模式 | 否，本机 profile 的 patch 行均可解析 |
| `port-in-use` | `EADDRINUSE` | `src/commands/run.js:22` | 端口占用，属环境问题，不构成兼容性结论 | 本工具判据 | 是 |
| `module-missing` | `Cannot find module` | `src/commands/run.js:23` | 候选安装不完整，或原生模块缺失（默认 `--ignore-scripts` 时更需留意） | 本工具判据 | 是，可构造 |

`#1294` 中还记录了第二类形态。它不作为签名，而是流程设计依据：插件批量升级后的首次冷启动出现 renderer 30 秒健康上报超时，相同配置第二次启动即正常。因此 `run` 固定执行两次冷启动（`src/commands/run.js:245`）——一次失败一次成功记为抖动，不记为不兼容。

## 三、不表示失败的形态

| 形态 | 出现位置 | 正确读法 |
|---|---|---|
| `MISSING_CREDENTIAL` | 冷启动（`src/commands/run.js:250,275`）；写回合（`src/lib/drill.js:325`） | 启动阶段：通过判据，说明进程存活至模型调用边界，无键运行本就应停在此处。写回合阶段：表示未被演练——replay 未拦截 provider 路由，写路径未完整执行，判 `inconclusive`，不判 `pass` |
| `no adapter registered`、`llm-replay:` | `src/lib/drill.js:325` | replay 挂载未生效，判 `inconclusive` |
| 工具结果行含 `not registered`、`unknown tool`、`not found` | `src/lib/drill.js:217-226`，计入 `unknownToolish` | 预期产物：写回合默认抑制全部工具提供方（`src/lib/shadow.js` 中 `writeReplayPatch` 的 `suppressToolRows`），被重放的调用只应返回该错误。不构成兼容性信号 |
| 工具结果行含 `"isError":true` | 同上，计入 `errorFlagged` | 历史中原本即报错的行，与本次升级无关 |
| `runs under agent preset … which the one-shot runner does not compose` | `src/lib/drill.js:22-25`，severity `warn` | one-shot runner 的采用检查未被中和。若在使用 `--preset-mode patch` 时仍出现，指向采样或打补丁环节的问题，而非宿主不兼容 |
| `was recorded in … not …` | `src/lib/drill.js:28-31`，severity `warn` | cwd 与录制值不一致，即沙箱重写未生效（`copySet` 的 header 重写与目录搬迁必须成对发生）。属工具自身缺陷信号 |
| 迁移"失败"且退出码为 1 | 全流程 | 无键迁移成功时同样以 `MISSING_CREDENTIAL` 退出 1；`--dump-config-schema` 按设计成功时也置 `exitCode=1`。判定只依据产物，不依据退出码 |
| `turn/end` 存在但 `reason.kind === "error"`，且无新增 `assistant/message` 行 | `src/lib/drill.js:323` | 骨架假阳性。`pass` 因此要求两项条件同时成立：turn 收口，且消息落盘 |

第三表中两条 `warn` 形态（`preset-not-composed`、`cwd-mismatch`）的措辞取自宿主自身的报错文本，在本机任何一次预演中均未出现——产物中可查到的相关证据只有 `assistant/attempt`（见第四节）。二者保留为哨兵：宿主改写这段文本意味着前提已变。它们不是"测过"的证据。`test/signatures.test.js` 中对应夹具同样按模板行标注，不作原文引用。

## 四、带预设会话的结构性不可判定

`--preset-mode patch` 中和的仅是那一项采用检查，预设组合不重建。实测（2026-10-02，2/2）：replay 不拦截带预设会话的 provider 路由，落 `MISSING_CREDENTIAL`，新增行形态为 `assistant/attempt` 而非 `assistant/message`。

因此预设会话的写回合执行并上报（`evidence[].preset`、`coverage.writeRounds.presetAttempts` / `presetPass`），但不单独决定阶段结论：`writeRoundVerdict()`（`src/lib/drill.js:101`）仅在非预设轮上取 pass/fail；样本中只有预设可试时整阶段判 `inconclusive`。

完整英文版见 [FAILURE_MODES.en.md](FAILURE_MODES.en.md)。两份的 `## ` 小节数与全部 `file:line` 引用由 `test/docs.test.js` 断言一致。

