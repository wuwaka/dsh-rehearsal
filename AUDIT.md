# dsh-rehearsal 代码检查与安全测试报告

- **日期**：2026-10-02
- **对象**：`<repo>/dsh_rehearsal`（git `7c374bc`，工作树干净）
- **规模**：1896 行（src 1611 / test 285，见下表），唯一运行时依赖 `semver@^7.7.3`
- **方式**：全量源码阅读 + 独立探针（直接 import 其模块断言）+ 真实 `~/.dsh` 数据取证 + 对已生成产物的事后审计
- **重要**：**`run` 命令未被执行**。原因见 P0-1。其余（`check`、单测、探针）均已实跑。

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/cli.js` | 132 | 参数解析、4 命令分派、退出码 |
| `src/commands/check.js` | 95 | 只读静态体检（A 盘点 + B1 peer 图） |
| `src/commands/run.js` | 257 | 七阶段彩排流水线 |
| `src/lib/zfstd.js` | 92 | 多帧 zstd 解码器（**核心技术资产**） |
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

**工程素质高，但当前不可发布、且不应在未加固前再跑 `run`。**

- **真价值**：多帧 zstd 解码（§4.1，我用真实数据复核并给出更强证据）、"产物驱动判定不看退出码"、"绝不用 PATH 上的桌面 shim"、`link:/file:` 不可复现披露 —— 这些都是从真实事故里长出来的知识，别家工具里没有。
- **不可接受的两条**：① 写回合会在**真实工作区**重放执行历史工具（P0-1）；② 报告与 shadow 产物携带**消息原文与未脱敏路径**，且 README 的相关声明被项目自己的产物证伪（P1-1/P1-2）。
- 诚实度良好：README 里"实测 2 个会话写回合 PASS（+64/+20 行、9/2 个 assistant、turn 收口）"与 `.dsh-rehearsal/run-*/report.json` **逐项吻合**，没有夸大。

发布前最小关闭集：**P0-1 + P1-1 + P1-2 + P2-1**（合计约 60–90 行改动 + 4 条新测试）。

---

## 1. 测试执行结果

| # | 命令 | 实际结果 | 判定 |
|---|---|---|---|
| 1 | `npm test` | `Error: Cannot find module '<repo>/dsh_rehearsal\test'` → 1 fail | **失败**（文档命令本身不可用） |
| 2 | `node --test test/*.test.js` | `# tests 22 / # pass 22 / # fail 0` | 全绿 |
| 3 | `node src/cli.js check --candidate 0.2.0-rc.2` | 正常输出，`verdict: do-not-upgrade`，**exit=2** | 可运行；结论见 P2-1 |
| 4 | `node src/cli.js check --candidate 0.2.0-rc.2 --current 0.2.0-rc.2` | `28 findings (9 high)`（不给 current 时 19 findings） | `--current` 只增加 info 副本，不改变结论 |
| 5 | `node src/cli.js report ../nonexistent` | exit=3 | 符合文档 |
| 6 | `node src/cli.js bogus` | exit=3 + usage | 符合文档 |
| 7 | `node src/cli.js clean` | 打印 `would remove: …\.dsh-rehearsal (rerun with --yes)` | 安全梯可用 |
| 8 | `node src/cli.js clean --yes` → 未测 | 代码为 `renameSync` 后 `rmSync`（cli.js:102-103），先改名再删 | 设计正确，未实跑（会删掉取证产物） |

**结论**：功能面跑得通、退出码符合设计；但**新克隆仓库直接 `npm test` 就是红的**。根因是 `package.json:11` 的 `node --test test/`（目录带尾斜杠 + 非 ASCII 路径下 Node 22 把它当模块解析）。改成 `node --test test/*.test.js` 即可。

缺失项：无 `.github/`（计划里的三平台 CI 未实现）、无 `LICENSE` 之外的文档、未发布 npm、无 git remote。

---

## 2. P0 —— 阻断级：写回合在真实工作区重放执行历史工具

### 2.1 事实

`e2-write-round` 的产物证据（`.dsh-rehearsal/run-0.2.0-rc.2-1790929231260/report.json`）：

```json
{ "id": "session-0ce6f2aa…", "verdict": "pass", "newRows": 64,
  "newTypes": { "assistant/message": 9, "tool/call": 9, "tool/result": 9,
                "step/start": 9, "step/end": 9, "turn/start": 1, "turn/end": 1 } }
{ "id": "session-a1742519…", "verdict": "pass", "newRows": 20,
  "newTypes": { "assistant/message": 2, "tool/call": 1, "tool/result": 1 } }
```

我用项目自己的解码器读出这两个会话在**真实库**里的记录：

| 会话 | 记录的工具调用 | `header.cwd` | header `version` |
|---|---|---|---|
| `session-0ce6f2aa…` | `computer_script` × 7、`pwsh` × 2（共 9） | `~` | 0 |
| `session-a1742519…` | `browser_script` × 1 | `~` | 0 |

代码路径：

- `run.js:137` 与 `drill.js:133` 把子进程 `cwd` 设为 **`session.header.cwd`**（真实目录，非沙箱）。这是被迫的：打开会话要求 cwd 与记录一致 —— 项目自己的 `drill.js:28-32` 就内置了 `cwd-mismatch` 签名（`was recorded in .* not`）。
- fixture 来源 `run.js:199-202`：**该会话自己迁移后的完整 v4 日志**解压到 `<shadowHome>/fixture-<id>.jsonl`。
- llm-replay 只拦截 `llm/stream`（官方包描述），**不拦截工具执行**。
- headless 无人审批交互，工具调用倾向直接放行。

于是"无键彩排"的真实语义是：**把用户历史会话里的 `computer_script` / `pwsh` / `browser_script` 调用，以其记录时的真实目录为工作区根，再执行一遍**，默认 `--writeRounds 3`（`run.js:215`），候选池 24 个会话，全程无人监督。

### 2.2 诚实边界

**我没有证实这 9 次 `tool/result` 是真副作用还是"工具未注册"的 error-result**（shadow 目录已被清理，无从回读）。stderrTail 里出现的 `<回放正文引用已移除>` 之类文本是**回放的助手正文**，不能单独作为执行证据。

但**判定不受影响**：无论哪种结果，该阶段在设计上**既无 cwd 沙箱、也无工具抑制、也无 `tool/result.isError` 检查**，因此对任意会话历史都不安全。一次记录了 `Remove-Item` / `str_replace` 到云盘目录的会话即足以造成真实损害。

### 2.3 修复选项（建议 ①+② 同时做）

1. **cwd 沙箱**：`copySet` 之后重写副本里的 `header.cwd`（以及日志内所有出现该 cwd 的 header 行）指向 `<shadowHome>/workspace/<n>`。副本本就是可改的，seq/type/turn 完整性检查不受影响。
2. **工具抑制**：`writeReplayPatch` 里对 `bash/pwsh/fs/str-replace/computer/browser` 行一并写 `disabled: true`；此时若 turn 不再收口，把 verdict 记为 `inconclusive(tools-disabled)` 而非 `pass`。
3. **显式授权门**：新增 `--allow-tools`，默认关闭；报告与 stdout 里写明"本阶段会执行历史工具调用"。
4. **预筛**：从 fixture 里先统计工具名与写类工具计数，含写类工具的会话默认跳过并计入 coverage。
5. **取证补强**：`writeRound` 解析 `tool/result` 的 `isError`，把"执行成功 / 执行报错 / 未注册"区分开写进 evidence —— 这条顺便能提升 verdict 的信息量。

---

## 3. P1 —— 高危：两条 README 安全声明被自家产物证伪

### P1-1 报告含消息正文（README「报告零消息正文」为假）

`report.json` / `report.md` 的 `stderrTail` 字段实测内容：

> （回放正文引用已移除：审计原文引用了回放出的助手正文，按与 P1-1 同等标准脱敏）
> （回放正文引用已移除：审计原文引用了回放出的助手正文，按与 P1-1 同等标准脱敏）

- **根因**：headless 把推理与正文写到 **stderr**，而 `drill.js:168-170 tail()` 原样截取末 3 行进 evidence。`report.js:24` 却固定声明 `messageContentRead: false`。
- **修法**：`tail()` 改为只回传**命中签名的行**+ 首行错误名；或把 stderr 先过一遍"已知非正文前缀"白名单（`dsh:`/`Error:`/`patch:`），其余一律丢弃并记 `stderrDropped:n`。
- **严重性缓和**：`.dsh-rehearsal/` 在 `.gitignore` 中，`git ls-files` 确认未提交 → 当前是本机泄露面，非仓库泄露面。

### P1-2 Windows 路径脱敏对 evidence 完全失效

探针结果（`node probe.mjs` §2）：

| 输入 | 位置 | 输出 |
|---|---|---|
| `~\.dsh` | `details`（裸串） | `~\.dsh` ✅ |
| `~\.dsh\profiles\desktop` | `evidence[0].dir` | **原样保留** ❌ |
| `~\AppData\Local\Temp\dsh-rehearsal-home-abc` | `evidence[0].tmp` | **原样保留** ❌ |
| `<abs-path> coding\proj` | `evidence[0].other` | **原样保留** ❌ |

- **根因（精确到行）**：`report.js:64` 对 **`JSON.stringify` 之后**的文本调用 `scrubText`，此时 Windows 路径已变成双反斜杠 `<abs-path>`；而 `report.js:52` 的正则 `[A-Za-z]:\\Users\\` 匹配的是**单**反斜杠 → 永不命中。
- **真实产物实证**（结构化遍历 `check-1790923403064/report.json`，命中 **3 处**未脱敏绝对路径）：

  | JSON 路径 | 值 |
  |---|---|
  | `.stages[0].evidence[0].marketFacts.path` | `~\.dsh\profiles\desktop\.dsh-market\discovery-compatibility-v1.json` ← **含用户名** |
  | `.stages[1].evidence[16].source` | `link:<abs-path>` |
  | `.stages[1].evidence[18].source` | `file:<abs-path>` |

  同一份报告里 `stages[*].details` 是正确的（`home=~\.dsh`）—— 证明缺陷只发生在 evidence 对象这条序列化路径上，与根因判断完全吻合。`run` 报告因不含 `marketFacts` 而无用户名泄露（`grep -c user` = 0）。
- **正则覆盖不足**：只认 `\Users\`（Windows）与 `/home/`（Linux）。本机的 `<driveA>`、`<driveB>` 完全不在规则内 —— 上表 2/3 两条就是这么漏的。
- **修法**：改成结构化递归脱敏（遍历对象/数组，对每个 string 值调 `scrubText`），而不是对整个 JSON 文本打补丁；并补一条 `scrubStage` 的测试。

### P1-3 为什么 22 个测试全绿却漏掉 P1-2

`test/report.test.js:8-14` 只测 `scrubText(裸字符串)`，**从不测 `scrubStage` / evidence 对象**；且断言用的是 `user`/`alice` 这类必然出现在 details 路径的名字。→ 测试形状与缺陷形状刚好错开。这是本次最值得记的一条经验：**脱敏必须有"走真实序列化路径"的用例**（`finalize()` 之后 grep 报告全文）。

---

## 4. 独立复核为真的部分（这些是项目的硬资产）

### 4.1 多帧 zstd 静默截断 —— 成立，且比注释更严重

拿真实文件 `~/.dsh/sessions/<workspace-dir>/<session-id>/session.v4.jsonl.zstd`：

| | 字节 | 行 | magic/帧数 |
|---|---|---|---|
| 源文件 | 1,669,223 | — | 2 |
| `zstdDecompressSync(buf)`（Node 内置） | **195** | **1** | — |
| 项目 `decodeAll` | **9,405,244** | **1,698** | — |

Node 的 zlib **不报错、静默只解第一帧**，且首帧只占 195 B。任何用裸 zlib 读 dsh 会话的工具都会得出"会话只有一行/已损坏"的错误结论。`zfstd.js` 的带回溯分帧算法在真实数据上工作正常。**这是本工具最硬的技术资产，值得单独写进 README 顶部并配一条大文件回归测试。**

### 4.2 隔离确实没有污染真实 home（取证）

| 检查 | 结果 |
|---|---|
| 真实库 `session.v4.jsonl.zstd` 总数 | 28，mtime 全在 **9/25–9/28**（宿主自己写的） |
| 彩排发生时刻 | 10-02 16:20 本地 |
| 10-02 之后真实库新增迁移产物 | **无** |
| `alreadyV4=28` vs 磁盘 28 | 一致 |
| `profiles/desktop` 16:15 的变动 | `.plugin-manager/logs`、`pnpm-lock.yaml`、`node_modules/.modules.yaml` —— 早于 run，属宿主自身行为 |
| `%TEMP%/dsh-rehearsal-home-*` 残留 | 0（但见 P2-5：代码里根本没有删除路径） |
| 真实会话非 `.zstd` 文件 | 0（见 P2-9） |

README 红线 #1（"只用自己 npm 装的候选二进制"）**被执行了**。

### 4.3 gen 映射正确（我曾怀疑，实测推翻了自己的怀疑）

`sessions.js:23` 把无版本后缀的 `session.jsonl.zstd` 记为 gen 0。我怀疑它其实代表"当前代"，实测两个无后缀会话的 header 首行 `version` **确实是 0** → 映射正确，`maxGen`/`alreadyV4` 分类可信。

### 4.4 其余披露诚实

`link:`/`file:` 标记不可复现、npm 影子 ≠ Desktop 安装体、附件旁路不校验、`--preset-mode patch` 是改被测试对象自己的代码（composition 不重建）—— 都在 README/usage 里写明，没有藏着。

---

## 5. P2 —— 中危：结论质量与工程健壮性

| # | 位置 | 问题 | 证据 / 修法 |
|---|---|---|---|
| **P2-1** | `run.js:80` | **`run` 从不传 `current`** → "今天就已不满足"与"升级才会新坏"混成同一个 blocking fail。对已经是 0.2.0-rc.2 的机器报 `do-not-upgrade`（exit 2），必然哭狼 | 实测同一输入传 `current` 会多出 `peer-incompatible/info`。修：只有 `satisfies(current) && !satisfies(candidate)` 才 high；两边都不满足 → `pre-existing`/warn。9 条 high 全来自 `@deepseek-ai/dsh-browser-use*` 三个**官方**包把 peer 精确钉在 `0.1.7-rc.1`（这是真不兼容，见 §6） |
| **P2-2** | `drill.js:76` | `openTurns = Math.max(0, openTurns-1)` **吞掉多余的 turn/end** | 探针：stray `turn/end` → `ok: true`；未闭合 `turn/start` → `ok: false`。"turn 边界闭合"只查了单向。修：负值单独计数并报 issue |
| **P2-3** | `yaml-lite.js:9,18` | `countRows`/`rowIds` 只认 0 列 `- id:`，**不进入 `insert:` 块** | 真实 desktop patch：`countRows=14`，但另有 `- insert:`×1 内含 **12 个嵌套 id** 未被纳入。这些插件行最容易改名/消失，正是 S1 想要的信号。修：递归收集并标注 `scope: top\|insert` |
| **P2-4** | `dshhome.js:16-20` | `listProfiles` 把 `node_modules` 当 profile | 实测 `profiles=[desktop, headless, node_modules, web, zcode-test]`。当前靠 `exists:false` 侥幸不被选中（`profiles/node_modules/package.json` 不存在）。修：排除 `node_modules` 与 `.` 前缀 |
| **P2-5** | `run.js:95,248-250` | **`shadowHome` 无任何删除路径**；只删 `prefixDir` | shadow 里有整份会话副本 + `fixture-<id>.jsonl`（**明文全量正文**）。`clean` 只覆盖 `.dsh-rehearsal/`。修：非 `--keep` 时 `finally` 里删；删之前在报告里记下路径与"含明文副本"提示 |
| **P2-6** | `util.js:58` | `delete process.env.DEEPSEEK_API_KEY` **改的是父进程 env**（靠副作用生效），且只删这一个名字 | 修：构造 child env 时按 `/API_KEY\|TOKEN\|SECRET\|CREDENTIAL/` 过滤；在报告里记录被剔除的变量名（不记录值） |
| **P2-7** | `shadow.js:136-141` | 从用户会话提取的 provider/model id **不加引号**拼进 YAML | 含 `:` `#` `{` 的 id 会产出坏 YAML，导致 activation 失败被误判成不兼容。修：`JSON.stringify(v)` |
| **P2-8** | `shadow.js:76` | 候选安装未加 `--ignore-scripts` | ~500 个包的 postinstall 在用户机上直接跑（`allowBuilds` 在真实 profile 里是显式白名单，这里等于绕过该策略）。修：默认 `--ignore-scripts`，需要构建时显式开 |
| **P2-9** | `sessions.js:23` | `GEN_RE` 只认 `.zstd` | 本机 0 个非压缩会话文件（实测），但官方 `generationLogFilename(version, compression)` 说明两种形态并存 → 潜在漏检。修：`(?:\.zstd)?` |
| **P2-10** | `zfstd.js:61` | memo key `start*4294967296+end` 超过 `MAX_SAFE_INTEGER` | 实测 3.7 MB → `1.59e16 > 9.007e15`；阈值约 **2.1 MB**。注释里引用的 3,776,880 B 文件已在阈值之上 → `failed` 集合开始丢精度、相邻键并格，回溯判定可能失真。修：`` `${start}:${end}` `` 或 Map-of-Sets |
| **P2-11** | `shadow.js:171-188` | `patchAdoptionGate` **修改被测试对象自己的代码**（`dsh-headless/lib/index.js` 注入 `return void 0`） | 已诚实标注为格式级结论，可接受。但：备份 `*.rehearsal-orig` 留在 prefix 内；prefix 非 `--keep` 时被整目录删除，无残留 —— 已核。建议把该事实从 README 提升到 `check`/`run` 的 stdout 横幅，避免用户以为跑的是原生候选 |
| **P2-12** | `run.js:47` | `sample: opts.sample ?? 20` 里 `opts.sample` 是**字符串** | 当前靠 `slice(0,'20')` 的隐式转换侥幸正确。修：`Number(...)` 并校验为正整数 |

---

## 6. 顺带产出的一条真发现（推翻我上一轮评审的结论）

上一轮我评审那份计划时写过："本机 desktop 的 7 个第三方插件 peer 已全部覆盖 0.2.0 → 验收标准（至少找出一类真实不兼容）平凡或为空"。**这个判断是错的，被这个项目用代码证伪了。**

`check --candidate 0.2.0-rc.2` 的 9 条 high 全部来自我根本没查的**官方实验包**：

```
@deepseek-ai/dsh-browser-use                                 → dsh-brand                       0.1.7-rc.1
@deepseek-ai/dsh-experimental-browser-use-chrome-devtools-mcp → dsh-browser-use / -agent /
                                                                -tools / -system-prompt       0.1.7-rc.1
@deepseek-ai/dsh-experimental-browser-use-playwright-mcp      → dsh-browser-use / -agent /
                                                                -tools / -system-prompt       0.1.7-rc.1
```

profile 里这三个包停在 `0.1.7-rc.1`、peer 精确钉死该版本，而 desktop 运行时已经是 `0.2.0-rc.2` —— **一个真实存在的、当前就生效的版本错配**（靠官方 `allow-version` 豁免或桌面端未校验才没炸）。这正是 peer 图检查该产出的东西。

另一处我上轮的遗漏：**"零依赖读 v4 会话可行"这个结论不完整** —— 我当时只核到"官方也用 `node:zlib`"，漏了多帧静默截断（§4.1）。裸 zlib 会把 1698 行读成 1 行。

---

## 7. P3 —— 文档 / 发布

1. `README.md:69` 写"20 个测试"，实测 **22**；且 `npm test` 命令本身失败（§1）。
2. `README.md:39` 红线 #1 的措辞可以更硬：目前只说"会污染真实 home"，没说明**为什么**（桌面 shim 无视 `DSH_HOME`）。建议把 §4.2 的取证方法写进文档，作为"怎么验证没污染"的操作步骤。
3. `README.md:49` 与 §2 冲突：正文只说"附件旁路数据不复制、不校验"，**没有说写回合会执行工具**。这是必须补的一条。
4. `report.js:47` 的 `HOMEISH` 是死代码（导出后无人引用），且它自己的正则同样只认单反斜杠 → 直接删。
5. `--to latest` 与 `--to next` 语义今天等价（npm `dist-tags`：`latest = next = 0.2.0-rc.2`）；Desktop 用户的真实升级单位是 app release（v2.0.17 / NEXT / Beta），文档需区分两套坐标系。
6. 无 CI：计划要求 Windows/macOS/Linux 三平台，`platform` 相关代码里有 `where.exe`/`which` 双路径（`shadow.js:23-46`）但没有测试覆盖非 Windows 分支。
7. 未发布：`dsh-rehearsal` 这个名在 npm/GitHub 仍空闲（我核过，404/无仓），注意社区有先占名惯例（`dsh-testnet`）。
8. 计划里承诺的 `html` 报告格式未实现（只有 json/md）。

---

## 8. 未验证项（不装懂）

| 声明 | 为何未验 |
|---|---|
| `--dump-config-schema` 成功也返回 exit 1 | 需跑候选二进制，即 P0-1 的风险面 |
| 0.2.0 把行名从 `dsh-llm-deepseek` 改为 `-api-key`/`-account` 变体 | 我 `npm pack` 了 `dsh-llm-deepseek@0.1.7-rc.2 / 0.2.0-rc.2` 但没解出 patch 行名；需重做 |
| "rc.1 起迁移包自带 `producerKind` 改写映射，rc.1 与 0.2.0 逐字节一致" → #1229 本机无法复现 | 需跑 `run` 或直接 diff 两个迁移包 |
| 9 次 `tool/result` 是真执行还是 error-result | shadow 已清除，无法回读（→ 用 P2-5/P0-1 修法 ⑤ 未来可判） |
| 冷启动 2 次足以区分抖动 | 上游 #1294 只有单例证据 |
| `--preset-mode patch` 在中性化 adoption-gate 后的 verdict 可信度 | 本机 52 个会话里 preset 命中 0，该分支从未被真实数据走过 —— **值得造一个带 preset 的 fixture 专门测** |

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
11. `.github/workflows/ci.yml` 三平台 + `npm test` 修好才有意义
12. README 补"写回合执行工具"与"如何验证未污染真实 home"
13. 造一个带 `agentPreset` 的会话 fixture，把 `--preset-mode patch` 分支真正跑一遍
14. `dsh-test-drive/v1` 兼容层（计划里承诺的下游互通，目前只在 README 提到"风格兼容"，代码里没有）

---

## 附录 A —— 复现命令

> 发布版说明：涉及本机库路径处已换成 `<workspace-dir>` / `<session-id>` 占位符（原本写的是真实目录名，会泄露用户目录结构）。命令其余部分在 2026-10-02 全部实跑验证过，占位符需替换为你自己 `~/.dsh/sessions` 下的实际名字。

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
| profiles 目录实际内容 | `desktop`(11 bundles / 198 行 patch / `countRows`=14 / 嵌套 id 12 / `- insert:` 1)、`headless`(01:29 建，非本次 run)、`web`(4/4)、`zcode-test`(9-23 遗留)、`node_modules`(249 项农场) |
| 会话库 | 52 个会话目录；文件构成 28×`session.v4.jsonl.zstd` + 23×`session.jsonl.zstd` + 22×`session.v3.jsonl.zstd`；非 `.zstd` 会话文件 0 |
| out-of-tree 依赖 | 7 个，其中 3 个不可复现：`link:<abs-path>`、`file:<abs-path>`、`github:csyangwen/dsh-memory-evolve#e6f6b84` |
| pnpm-workspace 策略 | `nodeLinker: hoisted`、`autoInstallPeers: false`、`allowBuilds: {node-pty: true}`、`minimumReleaseAgeExclude: dsh-better-sidebar@0.16.1 / 0.21.1 / dshmarket@1.61.0`（`simpleListAfter` 解析正确 ✅）|
| 版本锚点 | 真实运行时 = Desktop 自带 **0.2.0-rc.2**；PATH 上 npm CLI = **0.1.1-rc.2** |
| DSH Desktop | 运行中（8 进程），全程未被 `dsh` 子命令触碰 |
