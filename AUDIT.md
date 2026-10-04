# 代码审计

[简体中文](AUDIT.md) | [English](AUDIT.en.md)

> **历史文档。** 本文描述的是审计基线 `7c374bc`（2026-10-02）上的代码。下列 P0/P1/P2 是**该基线的发现**，
> 不是当前 `main` 的漏洞清单；每条的处置与验证见文末[修复与验证](#修复与验证)。

- **日期**：2026-10-02
- **对象**：`<repo>/dsh_rehearsal`（git `7c374bc`，工作树干净）
- **规模**：1896 行（src 1611 / test 285，见下表），唯一运行时依赖 `semver@^7.7.3`
- **方式**：全量源码阅读 + 独立探针（直接 import 其模块断言）+ 真实 `~/.dsh` 数据取证 + 对已生成产物的事后审计
- **重要**：`run` 命令未被执行。原因见 P0-1。其余（`check`、单测、探针）均已实跑。

## 状态总览

| ID | 级别 | 状态 | 一句话 |
|---|---|---|---|
| P0-1 | 阻断 | 已修复 | 写回合会在真实工作区重放执行历史工具 |
| P1-1 | 高危 | 已修复 | 报告经 `stderr` 尾巴携带消息正文 |
| P1-2 | 高危 | 已修复 | evidence 对象中的绝对路径未脱敏 |
| P1-3 | 高危 | 分析记录 | 为什么当时 22 个测试全绿仍漏掉 P1-2 |
| P2-1 | 中危 | 已修复 | 既存 peer 失配被当成升级回归 |
| P2-2 | 中危 | 已修复 | turn 嵌套只单向校验 |
| P2-3 | 中危 | 已回退到正确修法 | 首轮修法接受了错误前提，现按真实结构重做（countRows=16） |
| P2-4 | 中危 | 已修复 | `node_modules` 被当作 profile |
| P2-5 | 中危 | 已修复 | 影子目录不在 `finally` 中清理 |
| P2-6 | 中危 | 已修复 | 子进程 env 构造有副作用 |
| P2-7 | 中危 | 已修复 | YAML 值未转义 |
| P2-8 | 中危 | 已修复并细化 | 候选安装默认执行生命周期脚本 |
| P2-9 | 中危 | 已修复 | `GEN_RE` 只认 `.zstd` 后缀 |
| P2-10 | 中危 | 已修复 | 多帧 memo key 数值溢出 |
| P2-11 | 中危 | 保留（已披露） | 采用闸门补丁修改被测对象自身代码 |
| P2-12 | 中危 | 已修复 | `--sample` 未做数值校验 |
| §7 P3（8 项） | 低 | 7 项已处置 | 其中 **P3-5（`--to latest`/`next` 与 Desktop app release 是两套坐标系）无处置记录** |
| §8 未验证（6 项） | — | 3 项已关闭 | 其余仍为未验证，保留原文 |


| 文件 | 行数 | 职责 |
|---|---|---|
| `src/cli.js` | 132 | 参数解析、4 命令分派、退出码 |
| `src/commands/check.js` | 95 | 只读静态体检（A 盘点 + B1 peer 图） |
| `src/commands/run.js` | 257 | 七阶段彩排流水线 |
| `src/lib/zfstd.js` | 92 | 多帧 zstd 解码器（核心技术资产） |
| `src/lib/sessions.js` | 151 | 会话发现/分类/复制集 |
| `src/lib/shadow.js` | 197 | 候选安装、llm-replay 挂载、patch 写入、adoption-gate 补丁 |
| `src/lib/drill.js` | 174 | 迁移触发、读侧完整性、无键写回合 |
| `src/lib/peers.js` | 146 | peer 图静态分析 |
| `src/lib/dshhome.js` | 129 | profile/层/workspace 策略解析 |
| `src/lib/report.js` | 107 | `dsh-rehearsal/v1` 组装、脱敏、MD 渲染 |
| `src/lib/util.js` `yaml-lite.js` | 78/53 | 子进程与 env、极简 YAML |
| `test/*.test.js` | 285 | 22 个测试 |

---

## 0. 总评

工程质量总体较高，但当前不可发布，未加固前不应再运行 `run`。

- **确认为真的部分**：多帧 zstd 解码（§4.1 已用真实数据复核，证据强于代码注释所述）、"产物驱动判定不看退出码"、"绝不用 PATH 上的桌面 shim"、`link:/file:` 不可复现披露。四项均来自真实事故，同类工具中少见。
- **不可接受的两条**：① 写回合会在真实工作区重放执行历史工具（P0-1）；② 报告与 shadow 产物携带消息原文与未脱敏路径，且 README 相关声明被本项目自身产物证伪（P1-1/P1-2）。
- README 披露与产物一致：其"实测 2 个会话写回合 PASS（+64/+20 行、9/2 个 assistant、turn 收口）"与 `.dsh-rehearsal/run-*/report.json` 逐项吻合，无夸大。

发布前最小关闭集：P0-1 + P1-1 + P1-2 + P2-1（合计约 60–90 行改动 + 4 条新测试）。

---

## 1. 测试执行结果

| # | 命令 | 实际结果 | 判定 |
|---|---|---|---|
| 1 | `npm test` | `Error: Cannot find module '<repo>/dsh_rehearsal\test'` → 1 fail | **失败**（文档命令本身不可用） |
| 2 | `node --test test/*.test.js` | `# tests 22 / # pass 22 / # fail 0` | 全绿 |
| 3 | `node src/cli.js check --candidate 0.2.0-rc.2` | 正常输出，`verdict: do-not-upgrade`，exit=2 | 可运行；结论见 P2-1 |
| 4 | `node src/cli.js check --candidate 0.2.0-rc.2 --current 0.2.0-rc.2` | `28 findings (9 high)`（不给 current 时 19 findings） | `--current` 只增加 info 副本，不改变结论 |
| 5 | `node src/cli.js report ../nonexistent` | exit=3 | 符合文档 |
| 6 | `node src/cli.js bogus` | exit=3 + usage | 符合文档 |
| 7 | `node src/cli.js clean` | 打印 `would remove: …\.dsh-rehearsal (rerun with --yes)` | 安全梯可用 |
| 8 | `node src/cli.js clean --yes` → 未测 | 代码为 `renameSync` 后 `rmSync`（cli.js:102-103），先改名再删 | 设计正确，未实跑（会删掉取证产物） |

**结论**：功能面可运行、退出码符合设计；但新克隆仓库直接执行 `npm test` 即失败。根因是 `package.json:11` 的 `node --test test/`（目录带尾斜杠 + 非 ASCII 路径下 Node 22 把它当模块解析）。改成 `node --test test/*.test.js` 即可。

缺失项：无 `.github/`（计划里的三平台 CI 未实现）、无 `LICENSE` 之外的文档、未发布 npm、无 git remote。

---

## 2. P0 阻断级：写回合在真实工作区重放执行历史工具

### 2.1 事实

`e2-write-round` 的产物证据（`.dsh-rehearsal/run-0.2.0-rc.2-1790929231260/report.json`）：

```json
{ "id": "session-0ce6f2aa…", "verdict": "pass", "newRows": 64,
  "newTypes": { "assistant/message": 9, "tool/call": 9, "tool/result": 9,
                "step/start": 9, "step/end": 9, "turn/start": 1, "turn/end": 1 } }
{ "id": "session-a1742519…", "verdict": "pass", "newRows": 20,
  "newTypes": { "assistant/message": 2, "tool/call": 1, "tool/result": 1 } }
```

用项目自带解码器读出这两个会话在真实库中的记录：

| 会话 | 记录的工具调用 | `header.cwd` | header `version` |
|---|---|---|---|
| `session-0ce6f2aa…` | `computer_script` × 7、`pwsh` × 2（共 9） | `~` | 0 |
| `session-a1742519…` | `browser_script` × 1 | `~` | 0 |

代码路径：

- `run.js:137` 与 `drill.js:133` 把子进程 `cwd` 设为 `session.header.cwd`（真实目录，非沙箱）。原因是打开会话要求 cwd 与记录一致，`drill.js:28-32` 内置 `cwd-mismatch` 签名（`was recorded in .* not`）。
- fixture 来源 `run.js:199-202`：该会话迁移后的完整 v4 日志，解压到 `<shadowHome>/fixture-<id>.jsonl`。
- llm-replay 只拦截 `llm/stream`（官方包描述），不拦截工具执行。
- headless 无人审批交互，工具调用倾向直接放行。

于是"无键彩排"的实际语义是：把用户历史会话里的 `computer_script` / `pwsh` / `browser_script` 调用，以其记录时的真实目录为工作区根再执行一遍。默认 `--writeRounds 3`（`run.js:215`），候选池 24 个会话，全程无人监督。

### 2.2 未证实边界

这 9 次 `tool/result` 未证实是真副作用还是"工具未注册"的 error-result（shadow 目录已被清理，无从回读）。stderrTail 里出现的 `<回放正文引用已移除>` 之类文本是回放的助手正文，不能单独作为执行证据。

判定不受影响：无论哪种结果，该阶段在设计上既无 cwd 沙箱、也无工具抑制、也无 `tool/result.isError` 检查，因此对任意会话历史都不安全。一次记录了 `Remove-Item` / `str_replace` 到云盘目录的会话即足以造成真实损害。

### 2.3 修复选项（建议 ①+② 同时做）

1. **cwd 沙箱**：`copySet` 之后重写副本里的 `header.cwd`（以及日志内所有出现该 cwd 的 header 行）指向 `<shadowHome>/workspace/<n>`。副本本就是可改的，seq/type/turn 完整性检查不受影响。
2. **工具抑制**：`writeReplayPatch` 里对 `bash/pwsh/fs/str-replace/computer/browser` 行一并写 `disabled: true`；此时若 turn 不再收口，把 verdict 记为 `inconclusive(tools-disabled)` 而非 `pass`。
3. **显式授权门**：新增 `--allow-tools`，默认关闭；报告与 stdout 里写明"本阶段会执行历史工具调用"。
4. **预筛**：从 fixture 里先统计工具名与写类工具计数，含写类工具的会话默认跳过并计入 coverage。
5. **取证补强**：`writeRound` 解析 `tool/result` 的 `isError`，把"执行成功 / 执行报错 / 未注册"区分开写进 evidence —— 这条顺便能提升 verdict 的信息量。

---

## 3. P1 高危：两条 README 安全声明被本项目产物证伪

### P1-1 报告含消息正文（README「报告零消息正文」为假）

`report.json` / `report.md` 的 `stderrTail` 字段实测内容：

> （回放正文引用已移除：审计原文引用了回放出的助手正文，按与 P1-1 同等标准脱敏）
> （回放正文引用已移除：审计原文引用了回放出的助手正文，按与 P1-1 同等标准脱敏）

- **根因**：headless 把推理与正文写到 stderr，`drill.js:168-170 tail()` 原样截取末 3 行进 evidence，而 `report.js:24` 固定声明 `messageContentRead: false`。
- **修法**：`tail()` 改为只回传命中签名的行 + 首行错误名；或把 stderr 先过一遍"已知非正文前缀"白名单（`dsh:`/`Error:`/`patch:`），其余丢弃并记 `stderrDropped:n`。
- **严重性缓和**：`.dsh-rehearsal/` 在 `.gitignore` 中，`git ls-files` 确认未提交 → 当前是本机泄露面，非仓库泄露面。

### P1-2 Windows 路径脱敏对 evidence 完全失效

探针结果（`node probe.mjs` §2）：

| 输入 | 位置 | 输出 |
|---|---|---|
| `~\.dsh` | `details`（裸串） | `~\.dsh` ✅ |
| `~\.dsh\profiles\desktop` | `evidence[0].dir` | 原样保留 ❌ |
| `~\AppData\Local\Temp\dsh-rehearsal-home-abc` | `evidence[0].tmp` | 原样保留 ❌ |
| `<abs-path> coding\proj` | `evidence[0].other` | 原样保留 ❌ |

- **根因**：`report.js:64` 对 `JSON.stringify` 之后的文本调用 `scrubText`，此时 Windows 路径已变成双反斜杠 `<abs-path>`；`report.js:52` 的正则 `[A-Za-z]:\\Users\\` 匹配单反斜杠，永不命中。
- **真实产物实证**（结构化遍历 `check-1790923403064/report.json`，命中 3 处未脱敏绝对路径）：

  | JSON 路径 | 值 |
  |---|---|
  | `.stages[0].evidence[0].marketFacts.path` | `~\.dsh\profiles\desktop\.dsh-market\discovery-compatibility-v1.json` ← 含用户名 |
  | `.stages[1].evidence[16].source` | `link:<abs-path>` |
  | `.stages[1].evidence[18].source` | `file:<abs-path>` |

  同一份报告里 `stages[*].details` 是正确的（`home=~\.dsh`）—— 证明缺陷只发生在 evidence 对象这条序列化路径上，与根因判断吻合。`run` 报告因不含 `marketFacts` 而无用户名泄露（`grep -c user` = 0）。
- **正则覆盖不足**：只认 `\Users\`（Windows）与 `/home/`（Linux）。本机的 `<driveA>`、`<driveB>` 不在规则内 —— 上表第 2、3 两条即因此漏出。
- **修法**：改成结构化递归脱敏（遍历对象/数组，对每个 string 值调 `scrubText`），而不是对整个 JSON 文本打补丁；并补一条 `scrubStage` 的测试。

### P1-3 为什么 22 个测试全绿却漏掉 P1-2

`test/report.test.js:8-14` 只测 `scrubText(裸字符串)`，不测 `scrubStage` 与 evidence 对象；断言用的是 `user`/`alice` 这类必然出现在 details 路径的名字，测试形状与缺陷形状错开。结论：脱敏必须有覆盖真实序列化路径的用例（`finalize()` 之后 grep 报告全文）。

---

## 4. 独立复核为真的部分

### 4.1 多帧 zstd 静默截断：成立，比代码注释所述更严重

真实文件 `~/.dsh/sessions/<workspace-dir>/<session-id>/session.v4.jsonl.zstd` 的实测：

| | 字节 | 行 | magic/帧数 |
|---|---|---|---|
| 源文件 | 1,669,223 | — | 2 |
| `zstdDecompressSync(buf)`（Node 内置） | **195** | **1** | — |
| 项目 `decodeAll` | **9,405,244** | **1,698** | — |

Node 的 zlib **不报错、静默只解第一帧**，且首帧只占 195 B。任何用裸 zlib 读 dsh 会话的工具都会得出"会话只有一行/已损坏"的错误结论。`zfstd.js` 的带回溯分帧算法在真实数据上工作正常。建议把该结论写入 README 顶部，并配一条大文件回归测试。

### 4.2 隔离未污染真实 home（取证）

| 检查 | 结果 |
|---|---|
| 真实库 `session.v4.jsonl.zstd` 总数 | 28，mtime 全在 **9/25–9/28**（宿主自己写的） |
| 彩排发生时刻 | 10-02 16:20 本地 |
| 10-02 之后真实库新增迁移产物 | **无** |
| `alreadyV4=28` vs 磁盘 28 | 一致 |
| `profiles/desktop` 16:15 的变动 | `.plugin-manager/logs`、`pnpm-lock.yaml`、`node_modules/.modules.yaml`，早于 run，属宿主自身行为 |
| `%TEMP%/dsh-rehearsal-home-*` 残留 | 0（但见 P2-5：代码中没有删除路径） |
| 真实会话非 `.zstd` 文件 | 0（见 P2-9） |

README 红线 #1（"只用自己 npm 装的候选二进制"）已被执行。

### 4.3 gen 映射正确（前一轮怀疑已被实测推翻）

`sessions.js:23` 把无版本后缀的 `session.jsonl.zstd` 记为 gen 0。该处曾疑其代表"当前代"；实测两个无后缀会话的 header 首行 `version` 为 0，映射正确，`maxGen`/`alreadyV4` 分类可信。

### 4.4 其余披露项核对

`link:`/`file:` 标记不可复现、npm 影子 ≠ Desktop 安装体、附件旁路不校验、`--preset-mode patch` 是修改被测对象自身代码（composition 不重建）—— 以上均已写入 README/usage。

---

## 5. P2 中危：结论质量与工程健壮性

| # | 位置 | 问题 | 证据 / 修法 |
|---|---|---|---|
| **P2-1** | `run.js:80` | `run` 从不传 `current`，"今天就已不满足"与"升级才会新坏"合并为同一个 blocking fail；对已经是 0.2.0-rc.2 的机器报 `do-not-upgrade`（exit 2），必然产生误报 | 实测同一输入传 `current` 会多出 `peer-incompatible/info`。修：只有 `satisfies(current) && !satisfies(candidate)` 才 high；两边都不满足 → `pre-existing`/warn。9 条 high 全来自 `@deepseek-ai/dsh-browser-use*` 三个官方包把 peer 精确钉在 `0.1.7-rc.1`（真实不兼容，见 §6） |
| **P2-2** | `drill.js:76` | `openTurns = Math.max(0, openTurns-1)` 吞掉多余的 turn/end | 探针：stray `turn/end` → `ok: true`；未闭合 `turn/start` → `ok: false`。"turn 边界闭合"只查单向。修：负值单独计数并报 issue |
| **P2-3** | `yaml-lite.js:9,18` | `countRows`/`rowIds` 只认 0 列 `- id:`，不进入 `insert:` 块 | 真实 desktop patch：`countRows=14`，另有 `- insert:`×1 内含 12 个嵌套 id 未被纳入。这类插件行易改名或消失，属 S1 需要的信号。修：递归收集并标注 `scope: top\|insert` |
| **P2-4** | `dshhome.js:16-20` | `listProfiles` 把 `node_modules` 当 profile | 实测 `profiles=[desktop, headless, node_modules, web, zcode-test]`。当前因 `profiles/node_modules/package.json` 不存在（`exists:false`）而未被选中。修：排除 `node_modules` 与 `.` 前缀 |
| **P2-5** | `run.js:95,248-250` | `shadowHome` 无任何删除路径，只删 `prefixDir` | shadow 内有整份会话副本 + `fixture-<id>.jsonl`（明文全量正文）。`clean` 只覆盖 `.dsh-rehearsal/`。修：非 `--keep` 时在 `finally` 里删；删之前在报告里记下路径与"含明文副本"提示 |
| **P2-6** | `util.js:58` | `delete process.env.DEEPSEEK_API_KEY` 改的是父进程 env（靠副作用生效），且只删这一个名字 | 修：构造 child env 时按 `/API_KEY\|TOKEN\|SECRET\|CREDENTIAL/` 过滤；在报告里记录被剔除的变量名（不记录值） |
| **P2-7** | `shadow.js:136-141` | 从用户会话提取的 provider/model id 不加引号拼进 YAML | 含 `:` `#` `{` 的 id 会产出坏 YAML，导致 activation 失败被误判成不兼容。修：`JSON.stringify(v)` |
| **P2-8** | `shadow.js:76` | 候选安装未加 `--ignore-scripts` | ~500 个包的 postinstall 在用户机上直接跑（`allowBuilds` 在真实 profile 里是显式白名单，这里等于绕过该策略）。修：默认 `--ignore-scripts`，需要构建时显式开 |
| **P2-9** | `sessions.js:23` | `GEN_RE` 只认 `.zstd` | 本机 0 个非压缩会话文件（实测），但官方 `generationLogFilename(version, compression)` 说明两种形态并存 → 潜在漏检。修：`(?:\.zstd)?` |
| **P2-10** | `zfstd.js:61` | memo key `start*4294967296+end` 超过 `MAX_SAFE_INTEGER` | 实测 3.78 MB（3,776,880 B）→ `1.59e16 > 9.007e15`；阈值约 2.1 MB。注释里引用的 3,776,880 B 文件已在阈值之上 → `failed` 集合开始丢精度、相邻键并格，回溯判定可能失真。修：`` `${start}:${end}` `` 或 Map-of-Sets |
| **P2-11** | `shadow.js:171-188` | `patchAdoptionGate` 修改被测对象自身代码（`dsh-headless/lib/index.js` 注入 `return void 0`） | 已标注为格式级结论，可接受。备份 `*.rehearsal-orig` 留在 prefix 内；prefix 非 `--keep` 时随整目录删除，无残留 —— 已核。建议把该事实从 README 提升到 `check`/`run` 的 stdout 横幅，避免被当作原生候选运行 |
| **P2-12** | `run.js:47` | `sample: opts.sample ?? 20` 中 `opts.sample` 是字符串 | 当前依赖 `slice(0,'20')` 的隐式转换才得到正确结果。修：`Number(...)` 并校验为正整数 |

---

## 6. 附带产出的一条发现（推翻上一轮评审结论）

上一轮对该计划的评审结论为："本机 desktop 的 7 个第三方插件 peer 已全部覆盖 0.2.0 → 验收标准（至少找出一类真实不兼容）平凡或为空"。该判断不成立，已被本项目的代码与实测证伪。

`check --candidate 0.2.0-rc.2` 的 9 条 high 全部来自上一轮未覆盖的官方实验包：

```
@deepseek-ai/dsh-browser-use                                 → dsh-brand                       0.1.7-rc.1
@deepseek-ai/dsh-experimental-browser-use-chrome-devtools-mcp → dsh-browser-use / -agent /
                                                                -tools / -system-prompt       0.1.7-rc.1
@deepseek-ai/dsh-experimental-browser-use-playwright-mcp      → dsh-browser-use / -agent /
                                                                -tools / -system-prompt       0.1.7-rc.1
```

profile 里这三个包停在 `0.1.7-rc.1`、peer 精确钉死该版本，而 desktop 运行时已经是 `0.2.0-rc.2` —— 一个真实存在、当前即生效的版本错配（靠官方 `allow-version` 豁免或桌面端未校验才未暴露）。这正是 peer 图检查应产出的结果。

上一轮的另一处遗漏："零依赖读 v4 会话可行"这一结论不完整。当时只核到"官方也用 `node:zlib`"，未覆盖多帧静默截断（§4.1）；裸 zlib 会把 1698 行读成 1 行。

---

## 7. P3 文档 / 发布

1. `README.md:69` 写"20 个测试"，实测 22；且 `npm test` 命令本身失败（§1）。
2. `README.md:39` 红线 #1 目前只说"会污染真实 home"，未说明原因（桌面 shim 无视 `DSH_HOME`）。建议把 §4.2 的取证方法写进文档，作为验证未污染的步骤。
3. `README.md:49` 与 §2 冲突：正文只说"附件旁路数据不复制、不校验"，未说明写回合会执行工具。此项必须补齐。
4. `report.js:47` 的 `HOMEISH` 是死代码（导出后无人引用），其正则同样只认单反斜杠 → 删除。
5. `--to latest` 与 `--to next` 当前语义等价（npm `dist-tags`：`latest = next = 0.2.0-rc.2`）；Desktop 用户的真实升级单位是 app release（v2.0.17 / NEXT / Beta），文档需区分两套坐标系。
6. 无 CI：计划要求 Windows/macOS/Linux 三平台，`platform` 相关代码里有 `where.exe`/`which` 双路径（`shadow.js:23-46`）但没有测试覆盖非 Windows 分支。
7. 未发布：`dsh-rehearsal` 这个名在 npm/GitHub 仍空闲（已核，404/无仓），社区有先占名惯例（`dsh-testnet`）。
8. 计划中承诺的 `html` 报告格式未实现（仅 json/md）。

---

## 8. 未验证项

| 声明 | 为何未验 |
|---|---|
| `--dump-config-schema` 成功也返回 exit 1 | 需跑候选二进制，即 P0-1 的风险面 |
| 0.2.0 把行名从 `dsh-llm-deepseek` 改为 `-api-key`/`-account` 变体 | `npm pack` 已取到 `dsh-llm-deepseek@0.1.7-rc.2 / 0.2.0-rc.2`，但未解出 patch 行名；需重做 |
| "rc.1 起迁移包自带 `producerKind` 改写映射，rc.1 与 0.2.0 逐字节一致" → #1229 本机无法复现 | 需跑 `run` 或直接 diff 两个迁移包 |
| 9 次 `tool/result` 是真执行还是 error-result | shadow 已清除，无法回读（→ 用 P2-5/P0-1 修法 ⑤ 未来可判） |
| 冷启动 2 次足以区分抖动 | 上游 #1294 只有单例证据 |
| `--preset-mode patch` 在中性化 adoption-gate 后的 verdict 可信度 | 本机 52 个会话里 preset 命中 0，该分支未被真实数据覆盖 —— 需造一个带 preset 的 fixture 专门测试 |

---

## 9. 建议修复顺序（可直接执行）

**第一批（关闭不可接受项，约 60–90 行）**
1. `run.js` / `drill.js`：cwd 沙箱（重写副本 `header.cwd`）+ `--allow-tools` 门 + `tool/result.isError` 取证
2. `shadow.js:writeReplayPatch`：工具行 `disabled` 选项 + 值 `JSON.stringify`
3. `drill.js:tail` → 只保留签名命中行；`report.js:24` 的 `messageContentRead` 改为按实际能力声明
4. `report.js:scrubStage` → 结构化递归脱敏；扩正则覆盖非 `Users` 盘路径
5. `test/report.test.js` → 加"`finalize()` 后全文 grep 不得含 `Users\\`/路径中段/正文"用例
6. `package.json:11` → `node --test test/*.test.js`

**第二批（结论可信度）**
7. `run.js:80` 传 `current` + peers 严重度分级（pre-existing vs newly-broken）
8. `drill.js:76` 双向 turn 平衡；`yaml-lite.js` 进入 `insert:` 块
9. `dshhome.js:16` 排除 `node_modules`/点开头目录
10. `run.js` `finally` 删 shadowHome；`util.js` env 全量剔除；`shadow.js` `--ignore-scripts`；`zfstd.js` memo key 改字符串

**第三批（发布）**
11. `.github/workflows/ci.yml` 三平台 CI（前提是 `npm test` 已修好）
12. README 补"写回合执行工具"与"如何验证未污染真实 home"
13. 造一个带 `agentPreset` 的会话 fixture，覆盖 `--preset-mode patch` 分支
14. `dsh-test-drive/v1` 兼容层（计划承诺的下游互通，README 仅提到"风格兼容"，代码未实现）

---

## 附录 A —— 复现命令

> 发布版说明：涉及本机库路径处已换成 `<workspace-dir>` / `<session-id>` 占位符（原为真实目录名，会泄露用户目录结构）。其余命令在 2026-10-02 全部实跑验证过；占位符需替换为本地 `~/.dsh/sessions` 下的实际名字。

```bash
cd "<repo-root>"

# 1 测试：文档命令失败 vs 逐文件全绿
npm test
node --test test/*.test.js            # # tests 22 / pass 22

# 2 check 与退出码
node src/cli.js check --candidate 0.2.0-rc.2; echo "exit=$?"        # 2
node src/cli.js check --candidate 0.2.0-rc.2 --current 0.2.0-rc.2   # 28 findings (9 high)
node src/cli.js bogus >/dev/null 2>&1; echo "exit=$?"               # 3

# 3 消息正文与脱敏失效（对已有产物，命令均已实跑）
grep -c "reasoning\|Calculator\|screenshot" .dsh-rehearsal/run-0.2.0-rc.2-*/report.json   # 2
grep -n "user" .dsh-rehearsal/check-*/report.json      # 第 76 行 marketFacts.path

# 结构化定位未脱敏字段（比 grep 更可靠，实测命中 3 处）
node -e 'const j=require(process.cwd()+"/.dsh-rehearsal/check-1790923403064/report.json");
const hits=[];const walk=(o,p)=>{if(typeof o==="string"){if(/Users|[A-Za-z]:[\\\\/]/.test(o))hits.push(p+" = "+o.slice(0,70))}
else if(o&&typeof o==="object"){for(const k of Object.keys(o))walk(o[k],p+"."+k)}};walk(j,"");
console.log(hits.length+" 处未脱敏:");hits.forEach(h=>console.log(" "+h))'

# 4 多帧 zstd 静默截断（真实数据）
node --input-type=module -e '
import {zstdDecompressSync} from "node:zlib"; import fs from "node:fs";
const p="~/.dsh/sessions/<workspace-dir>/<session-id>/session.v4.jsonl.zstd";
const b=fs.readFileSync(p); const n=zstdDecompressSync(b);
console.log("src",b.length,"naive bytes",n.length,"naive lines",String(n).split("\n").filter(Boolean).length);'
#   src 1669223  naive bytes 195  naive lines 1     ← 对比 decodeAll: 9405244 B / 1698 行

# 5 隔离取证：真实库有没有被彩排写过
find ~/.dsh/sessions -name "session.v4.jsonl.zstd" -printf "%TY-%Tm-%Td %TH:%TM %p\n" | sort | tail -3
#   全部 9/25–9/28 → 10-02 的 run 未触碰真实会话
ls -d /c/Users/user/AppData/Local/Temp/dsh-rehearsal-home-* 2>/dev/null | wc -l   # 0
```

## 附录 B —— 本机取证快照

| 项 | 值 |
|---|---|
| 真实 DSH_HOME | `~\.dsh`（`DSH_HOME` 环境变量未设置，走默认值）|
| profiles 目录实际内容 | `desktop`(11 bundles / 198 行 patch / `countRows`=14 / 嵌套 id 12 / `- insert:` 1)、`headless`(01:29 建，非本次 run)、`web`(4/4)、`zcode-test`(9-23 遗留)、`node_modules`(249 项) |
| 会话库 | 52 个会话目录；文件构成 28×`session.v4.jsonl.zstd` + 23×`session.jsonl.zstd` + 22×`session.v3.jsonl.zstd`；非 `.zstd` 会话文件 0 |
| out-of-tree 依赖 | 7 个，其中 3 个不可复现：`link:<abs-path>`、`file:<abs-path>`、`github:csyangwen/dsh-memory-evolve#e6f6b84` |
| pnpm-workspace 策略 | `nodeLinker: hoisted`、`autoInstallPeers: false`、`allowBuilds: {node-pty: true}`、`minimumReleaseAgeExclude: dsh-better-sidebar@0.16.1 / 0.21.1 / dshmarket@1.61.0`（`simpleListAfter` 解析正确 ✅）|
| 版本锚点 | 真实运行时 = Desktop 自带 **0.2.0-rc.2**；PATH 上 npm CLI = **0.1.1-rc.2** |
| DSH Desktop | 运行中（8 进程），全程未被 `dsh` 子命令触碰 |

---

## 修复与验证

逐条处置与验证证据。基线为上文元数据中的提交；"验证"一列给出的是实际执行过的命令或测试，不是计划。

### 第一批（关闭"不可接受项"）

| 审计项 | 处置 | 验证 |
|---|---|---|
| **P0-1 写回合同真实工作区重放历史工具** | 三层叠加修复：① `copySet` 把副本 header.cwd 重写进影子 `workspace/<n>`，且副本必须同时搬进 `encodeCwdDir(sandbox)` 命名的 workspace 目录（harness 由 header.cwd 派生物理路径，两者必须一致）；② replay patch 默认禁用全部 `tool-*` 行（`tools` 注册表保留），实测禁用 17 行；③ 预筛：replay 脚本只能发出该会话历史里出现过的工具（确定性），含写类工具的会话跳过并计入 coverage。`--allow-tools` 显式解除 ②③（①恒在），运行前打印横幅。`tool/result` 分桶取证（errorFlagged/unknownToolish/other） | 真机安全模式：迁移 9/9（沙箱内）、预筛跳过 7、2 个无工具历史写回合 PASS（其一 toolResults.errorFlagged=1 证明抑制生效）；测试：沙箱重写、encodeCwdDir 对照真实目录名、预筛、分桶 |
| 附带发现（修复过程中） | 官方校验"首帧必须恰好是 header 一行"→ 重压必须**一行一帧**；会话目录名由 header.cwd 编码派生（`~XXXX` 无闭合波浪号，空格=`~0020`）→ 已写成 `encodeCwdDir` 并用本机真实目录名做测试基准 | 错误信息反推 + 磁盘 ground truth 对照 |
| **P1-1 报告含消息正文** | `sanitizeStderr`：白名单只留 `dsh:`/错误类/堆栈，丢弃 `dsh: reasoning:` 标记行与全部正文并计数（`stderr.dropped`）；`errorName` 改用 `firstDiagnostic`（跳过 reasoning 标记）；`messageContentRead: false` 改为诚实声明 `messageContentInReports: false` + `stderrEvidence` 说明 | 单测：prose 必须消失、诊断必须保留、dropped 计数；真机报告 leak 扫描含 `reasoning/Calculator/Stop-Process` 关键词 = CLEAN；实测某写回合 dropped=6、summary 为空 |
| **P1-2 evidence 路径未脱敏** | `scrubStage` 改**结构化递归**（逐 string 叶子跑 `scrubText`，不再对 JSON.stringify 后的双反斜杠文本打补丁）；正则扩展到任意盘符（`D:\Any\path`、`link:D:/...` → `<abs-path>`）+ `/Users/`（mac）；coverage/target 一并脱敏；删除 HOMEISH 死代码（P3-4） | 单测：`finalize()` 后 `JSON.stringify(report)` 断言无用户名/路径中段/合成插件名/`/home/`/凭证；真机 check/run 报告结构化扫描 = CLEAN（修前同法命中 3 处） |
| `npm test` 命令失败（§1） | `node --test test/` → `node --test`（自动发现） | `npm test` 42/42 通过 |
| P2-1（审计列入最小关闭集） | `detectCurrentDshVersion`（profile/镜像/Desktop 捆绑/npm prefix 四路探测）+ peers 严重度分级：仅"当前满足、候选不满足"= high/blocking；两边都不满足 = `peer-incompatible-pre-existing`/warn | 真机 check：current=0.2.0-rc.2 自动探测、9 条全判 pre-existing、verdict 从 `do-not-upgrade`(2) 变 `upgrade-with-conditions`(1)；单测覆盖三种分支 |

### 第二批（结论质量与健壮性）

| 审计项 | 处置 | 验证 |
|---|---|---|
| P2-2 turn 平衡单向 | 多余 `turn/end` 计为 stray issue（不再 clamp） | 单测：stray → ok=false |
| P2-3 insert 块行漏计 | ⚠️ 第三轮更正：第一版修法是错的（接受了审计已撤回的“12 个嵌套 id”前提，any-indent 把 config 模型条目计入行数 14→26）。现按真实文件结构回退：0 列 `- id:` = 行；`- insert:` 块只计首个子项缩进（真机子项在 4 缩进、`- name:` 形式）；深层 `- id:` 是子 config 不计 | 真机 desktop countRows = 16（14 行 + 2 insert）；单测含 config 深嵌套回归；`rowIds` 为死代码已删除 |
| P2-4 node_modules 当 profile | 排除 `node_modules` 与点前缀目录 | 单测 + 真机 profiles 列表干净 |
| P2-5 影子永不删除 | 非 `--keep`/`--shadow-dir` 时 F 阶段删影子（含明文 fixture）；README 写明 --keep 的敏感性 | 真机：run 后 tmp 残留=0（--keep 诊断遗留手工清理） |
| P2-6 env 副作用 | `shadowEnv` 返回**完整**子进程 env（`API_KEY/TOKEN/SECRET/CREDENTIAL/PASSWORD/PRIVATE_KEY/AUTH` 全剔除），run() 不再回填 process.env；剔除名单进报告 | 单测：父进程 env 不被改、子 env 无密钥、PATH 保留 |
| P2-7 YAML 注入 | provider/model id 一律 `JSON.stringify` | 代码审查 |
| P2-8 安装脚本 | 候选安装默认 `--ignore-scripts`，`--run-scripts` 显式解除 | 真机：`install scripts denied` 且无脚本安装下双冷启+迁移+写回合全通 |
| P2-9 GEN_RE 只认 .zstd | `(?:\.zstd)?` + `readHeader` 认裸 JSONL | 单测 |
| P2-10 memo key 溢出 | `start*2^32+end` → `` `${start}:${end}` ``（>2.1MB 文件精度并格消除） | 代码审查 + 多帧回归 |
| P2-11 采用闸补丁 | 保持；横幅已在 c-shadow details 披露 | 运行证据 |
| P2-12 sample 字符串 | `Number()` + 正整数校验，非法即抛 | 代码审查 |

### 第三批遗留（截至 2026-10-02 验收时的未做项；此后部分项已另行落地，见 CHANGELOG）

- `.github/workflows/ci.yml` 三平台 CI
- `dsh-test-drive/v1` 兼容层（当前 schema 为 `dsh-rehearsal/v1`，阶段记录仅"风格相近"）
- HTML 报告格式（仅 json/md）
- 带 `agentPreset` 会话的 fixture 化单元测试（真机已由 `--preset-mode patch` 全量覆盖：15 个预设会话迁移 24/24，但无独立 fixture 单测）
- `--allow-tools` 路径未做真机回归（等价于上一会话验证过的旧行为 + 预筛旁路；真实历史含 `Stop-Process` 类命令，不宜为验证而执行）

### 审计本身的两处更正（验收时发现）

1. §8 "`--preset-mode patch` 分支从未被真实数据走过、preset 命中 0" — **误读**：`skipped: preset=0` 是"跳过 0 个"，该 run 正是 patch 模式（drillable 9→24，15 个预设会话全部迁移成功）。成立的部分：写回合计数确实落在非预设会话上。
2. P2-8 修法细化：不能一刀切 `--ignore-scripts`（node-pty/koffi 为官方 allowBuilds 白名单放行项）——实现为默认拒绝+`--run-scripts` 逃生门，并用真机验证默认路径可用。

审计 §8 六条"未验证"中三条由验收方已有证据关闭（schema exit 1、0.2.0 行名改 `-api-key`、producerKind 两版一致）。

---

## 第三轮修复（评估方 2 的报告，2026-10-02）

| 主张 | 处置 | 验证 |
|---|---|---|
| **#2 AUDIT.md 含正文/路径/UUID 且已被提交** | 成立；成因是 `git add -A` 将未脱敏的文档一并提交。处置：**脱敏保文档**（2 个回放正文引用块替换为占位、路径按报告同标准 → `~`/`<abs-path>`、UUID 截断、残留身份词清零），`git commit --amend` 重写原提交 + `reflog expire` + `gc --prune=now`，旧提交对象 `7c14a70` 已从对象库消失（`git cat-file -e` 报 not valid） | `git log --all -S"<正文短语>"` 无命中；树内用户名/`C:\Users`/完整 UUID 计数 = 0。**残留披露**：根提交 `80c9630` 的 `test/report.test.js` 含一句合成 scrub 夹具（裸用户名、无路径/正文/UUID）——工作树已改 Jane；如需历史零残留可 squash（未做，待决定） |
| **#3 预筛 denylist fail-open + 层 b 只认 tool-* + suppressToolRows 默认矛盾** | 机制真（mcp__*、job_kill、present 逐一探测全放行）；但“MCP 两道防线同时失守”的实弹场景不成立——影子是裸 headless 模板（实测 96 行 dump 无 MCP client 行、模板 MCP 配置为空 `[]`），且 job_kill/present/skill/workflow 的执行器行恰为 tool-* 已被层 b 拦截。**仍按其修法执行**：① 预筛翻**允许清单**（`READONLY_TOOLS` 16 个已证只读内置；`memory`（add 写跨会话记忆）/dtodo/compress/`mcp__*` 前缀/`__unnamed__` 全 fail-closed）；② 层 b 改 id+**包名前缀**双匹配（`dsh-tool-`/`dsh-mcp-`/`dsh-skill`/`dsh-browser`/`dsh-terminal`/`dsh-jobs` + `^terminal-`；`tools` 注册表永不禁、`dsh-tool-` 连字符边界保证不误伤 `dsh-tools`）；③ `suppressToolRows` 默认 true 对齐注释。**附带发现**：提取必须覆盖四种行形态——全库普查证实 run_code 的调用大量只出现在 `tool/ptc-dispatch`/`tool/code-dispatch` 行（1836 次），仅扫 `tool/call` 会漏 | 单测：36 名普查样本逐一过 allowlist、四形态提取、无名行 sentinel；上轮 PASS 的两 demo（`read_image`、无工具）在 allowlist 下仍可演练 |
| **#4 sanitizeStderr 两条泄露路径 + 规则不一致** | 真（拼接串 dropped=0 整条保留、`at ` 开头正文存活、另发现 `fail` 裸前缀同类漏）。修：抽共享 `isDiagnostic`（sanitizer 与 firstDiagnostic 同源）；`dsh: reasoning:` 去 `$` 锚前缀排除；`at ` 行仅在含 `file://`/`node:`/`:行:列` 时保留；删除裸 `fail`；firstDiagnostic 跳过栈帧取错误标题 | 三个泄露路径各一条单测 + 一致性断言；当前管线主形态（header 独立行）原本就安全（实测 dropped=2 正文不存活） |
| **#5 清理不在 finally** | 真（mkdtemp 后任何提前 return/抛出都会漏删含明文的影子）。重构：`cleanupShadow()` 幂等闭包，外层 try/finally 兜底所有退出路径（成功路径在写报告前清理并记 `report.shadowCleanup = removed\|kept\|failed`） | 失败路径验证：`run --to 9.9.9-bogus` → 安装失败 exit 3 → tmp 残留 = 0 |
| **#6 P2-3 过度修正（对方撤回自己上轮主张）** | 成立；上一轮验收未做独立复核即接受了该错误前提，属验收侧漏洞。回退见上表 P2-3 行 | 真机 countRows=16；`rowIds` 死代码删除 |
| **#7 小项** | check 双调探测 → 提升为单次 `current`；classify 真实 cwd 闸门（沙箱化后多余）→ 改为“header 须含 cwd 字段”，目录不存在的会话**转为可演练**（覆盖率正收益），无 cwd 字段仍进 cwdMissing；patch 注释含路径/端口：报告仍只存计数，写作侧脱敏为既定约束 | 单测更新（session-gone 转 drillable、session-nocwd 进 cwdMissing） |
| “preset 分支 0 命中没走过” | 证据错误（重复 §8 把 `skipped: preset=0` 误读为“命中 0”）；但其内核（修复后代码未走过预设数据）在被指出前已成立——**已用 `--full --preset-mode patch` 关闭**：drillable=24、gate 生效、**migrated=24/24 含 15 个预设**、2 写回合 PASS（该次运行结果记录于此；产物目录按惯例清理，最新保留产物为 sample-9 终验 run） | 运行输出见本行记录 |
| “三条仍未验证” | 过期——上轮验收已实测关闭（schema exit 1 / `-api-key` 行名 / producerKind 两版一致） | 见上文验收记录 |
