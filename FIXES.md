# AUDIT.md 响应与修复记录

验收结论：审计 16 条代码级指控全部成立、P0/P1 判定接受（验收记录见会话报告）。本文档逐条记录处置与验证证据。日期：2026-10-02，基线提交见 git log。

## 第一批（关闭"不可接受项"）

| 审计项 | 处置 | 验证 |
|---|---|---|
| **P0-1 写回合同真实工作区重放历史工具** | 三层叠加修复：① `copySet` 把副本 header.cwd 重写进影子 `workspace/<n>`，且副本必须同时搬进 `encodeCwdDir(sandbox)` 命名的 workspace 目录（harness 由 header.cwd 派生物理路径，两者必须一致）；② replay patch 默认禁用全部 `tool-*` 行（`tools` 注册表保留），实测禁用 17 行；③ 预筛：replay 脚本只能发出该会话历史里出现过的工具（确定性），含写类工具的会话跳过并计入 coverage。`--allow-tools` 显式解除 ②③（①恒在），运行前打印横幅。`tool/result` 分桶取证（errorFlagged/unknownToolish/other） | 真机安全模式：迁移 9/9（沙箱内）、预筛跳过 7、2 个无工具历史写回合 PASS（其一 toolResults.errorFlagged=1 证明抑制生效）；测试：沙箱重写、encodeCwdDir 对照真实目录名、预筛、分桶 |
| 附带发现（修复过程中） | 官方校验"首帧必须恰好是 header 一行"→ 重压必须**一行一帧**；会话目录名由 header.cwd 编码派生（`~XXXX` 无闭合波浪号，空格=`~0020`）→ 已写成 `encodeCwdDir` 并用本机真实目录名做测试基准 | 错误信息反推 + 磁盘 ground truth 对照 |
| **P1-1 报告含消息正文** | `sanitizeStderr`：白名单只留 `dsh:`/错误类/堆栈，丢弃 `dsh: reasoning:` 标记行与全部正文并计数（`stderr.dropped`）；`errorName` 改用 `firstDiagnostic`（跳过 reasoning 标记）；`messageContentRead: false` 改为诚实声明 `messageContentInReports: false` + `stderrEvidence` 说明 | 单测：prose 必须消失、诊断必须保留、dropped 计数；真机报告 leak 扫描含 `reasoning/Calculator/Stop-Process` 关键词 = CLEAN；实测某写回合 dropped=6、summary 为空 |
| **P1-2 evidence 路径未脱敏** | `scrubStage` 改**结构化递归**（逐 string 叶子跑 `scrubText`，不再对 JSON.stringify 后的双反斜杠文本打补丁）；正则扩展到**任意盘符**（`D:\Any\path`、`link:D:/...` → `<abs-path>`）+ `/Users/`（mac）；coverage/target 一并脱敏；删除 HOMEISH 死代码（P3-4） | 单测：`finalize()` 后 `JSON.stringify(report)` 断言无用户名/路径中段/合成插件名/`/home/`/凭证；真机 check/run 报告结构化扫描 = CLEAN（修前同法命中 3 处） |
| `npm test` 本身是红的（§1） | `node --test test/` → `node --test`（自动发现） | `npm test` 42/42 绿 |
| P2-1（审计列入最小关闭集） | `detectCurrentDshVersion`（profile/镜像/Desktop 捆绑/npm prefix 四路探测）+ peers 严重度分级：仅"当前满足、候选不满足"= high/blocking；两边都不满足 = `peer-incompatible-pre-existing`/warn | 真机 check：current=0.2.0-rc.2 自动探测、9 条全判 pre-existing、verdict 从 `do-not-upgrade`(2) 变 `upgrade-with-conditions`(1)；单测覆盖三种分支 |

## 第二批（结论质量与健壮性）

| 审计项 | 处置 | 验证 |
|---|---|---|
| P2-2 turn 平衡单向 | 多余 `turn/end` 计为 stray issue（不再 clamp） | 单测：stray → ok=false |
| P2-3 insert 块行漏计 | ⚠️ **第三轮更正：第一版修法是错的**（接受了审计已撤回的“12 个嵌套 id”前提，any-indent 把 config 模型条目计入行数 14→26）。现按真实文件结构回退：0 列 `- id:` = 行；`- insert:` 块只计首个子项缩进（真机子项在 4 缩进、`- name:` 形式）；深层 `- id:` 是子 config 不计 | 真机 desktop countRows = **16**（14 行 + 2 insert）；单测含 config 深嵌套回归；`rowIds` 为死代码已删除 |
| P2-4 node_modules 当 profile | 排除 `node_modules` 与点前缀目录 | 单测 + 真机 profiles 列表干净 |
| P2-5 影子永不删除 | 非 `--keep`/`--shadow-dir` 时 F 阶段删影子（含明文 fixture）；README 写明 --keep 的敏感性 | 真机：run 后 tmp 残留=0（--keep 诊断遗留手工清理） |
| P2-6 env 副作用 | `shadowEnv` 返回**完整**子进程 env（`API_KEY/TOKEN/SECRET/CREDENTIAL/PASSWORD/PRIVATE_KEY/AUTH` 全剔除），run() 不再回填 process.env；剔除名单进报告 | 单测：父进程 env 不被改、子 env 无密钥、PATH 保留 |
| P2-7 YAML 注入 | provider/model id 一律 `JSON.stringify` | 代码审查 |
| P2-8 安装脚本 | 候选安装默认 `--ignore-scripts`，`--run-scripts` 显式解除 | 真机：`install scripts denied` 且无脚本安装下双冷启+迁移+写回合全通 |
| P2-9 GEN_RE 只认 .zstd | `(?:\.zstd)?` + `readHeader` 认裸 JSONL | 单测 |
| P2-10 memo key 溢出 | `start*2^32+end` → `` `${start}:${end}` ``（>2.1MB 文件精度并格消除） | 代码审查 + 多帧回归 |
| P2-11 采用闸补丁 | 保持；横幅已在 c-shadow details 披露 | 运行证据 |
| P2-12 sample 字符串 | `Number()` + 正整数校验，非法即抛 | 代码审查 |

## 第三批遗留（未做，如实声明）

- `.github/workflows/ci.yml` 三平台 CI
- `dsh-test-drive/v1` 兼容层（当前 schema 为 `dsh-rehearsal/v1`，阶段记录仅"风格相近"）
- HTML 报告格式（仅 json/md）
- 带 `agentPreset` 会话的 fixture 化单元测试（真机已由 `--preset-mode patch` 全量覆盖：15 个预设会话迁移 24/24，但无独立 fixture 单测）
- `--allow-tools` 路径未做真机回归（等价于上一会话验证过的旧行为 + 预筛旁路；真实历史含 `Stop-Process` 类命令，不值得为验证执行）

## 审计本身的两处更正（验收时发现）

1. §8 "`--preset-mode patch` 分支从未被真实数据走过、preset 命中 0" — **误读**：`skipped: preset=0` 是"跳过 0 个"，该 run 正是 patch 模式（drillable 9→24，15 个预设会话全部迁移成功）。成立的部分：写回合计数确实落在非预设会话上。
2. P2-8 修法细化：不能一刀切 `--ignore-scripts`（node-pty/koffi 为官方 allowBuilds 白名单放行项）——实现为默认拒绝+`--run-scripts` 逃生门，并用真机验证默认路径可用。

审计 §8 六条"未验证"中三条由验收方已有证据关闭（schema exit 1、0.2.0 行名改 `-api-key`、producerKind 两版一致）。

---

# 第三轮修复（评估方 2 的报告，2026-10-02）

| 主张 | 处置 | 验证 |
|---|---|---|
| **#2 AUDIT.md 含正文/路径/UUID 且已被提交** | 真——且是我 `git add -A` 造成的。处置：**脱敏保文档**（2 个回放正文引用块替换为占位、路径按报告同标准 → `~`/`<abs-path>`、UUID 截断、残留身份词清零），`git commit --amend` 重写原提交 + `reflog expire` + `gc --prune=now`，旧提交对象 `7c14a70` 已从对象库消失（`git cat-file -e` 报 not valid） | `git log --all -S"<正文短语>"` 无命中；树内用户名/`C:\Users`/完整 UUID 计数 = 0。**残留披露**：根提交 `80c9630` 的 `test/report.test.js` 含一句合成 scrub 夹具（裸用户名、无路径/正文/UUID）——工作树已改 Jane；如需历史零残留可 squash（未做，待决定） |
| **#3 预筛 denylist fail-open + 层 b 只认 tool-* + suppressToolRows 默认矛盾** | 机制真（mcp__*、job_kill、present 逐一探测全放行）；但“MCP 两道防线同时失守”的实弹场景不成立——影子是裸 headless 模板（实测 96 行 dump 无 MCP client 行、模板 MCP 配置为空 `[]`），且 job_kill/present/skill/workflow 的执行器行恰为 tool-* 已被层 b 拦截。**仍按其修法执行**：① 预筛翻**允许清单**（`READONLY_TOOLS` 16 个已证只读内置；`memory`（add 写跨会话记忆）/dtodo/compress/`mcp__*` 前缀/`__unnamed__` 全 fail-closed）；② 层 b 改 id+**包名前缀**双匹配（`dsh-tool-`/`dsh-mcp-`/`dsh-skill`/`dsh-browser`/`dsh-terminal`/`dsh-jobs` + `^terminal-`；`tools` 注册表永不禁、`dsh-tool-` 连字符边界保证不误伤 `dsh-tools`）；③ `suppressToolRows` 默认 true 对齐注释。**附带发现**：提取必须覆盖四种行形态——全库普查证实 run_code 的调用大量只出现在 `tool/ptc-dispatch`/`tool/code-dispatch` 行（1836 次），仅扫 `tool/call` 会漏 | 单测：36 名普查样本逐一过 allowlist、四形态提取、无名行 sentinel；上轮 PASS 的两 demo（`read_image`、无工具）在 allowlist 下仍可演练 |
| **#4 sanitizeStderr 两条泄露路径 + 规则不一致** | 真（拼接串 dropped=0 整条保留、`at ` 开头正文存活、另发现 `fail` 裸前缀同类漏）。修：抽共享 `isDiagnostic`（sanitizer 与 firstDiagnostic 同源）；`dsh: reasoning:` 去 `$` 锚前缀排除；`at ` 行仅在含 `file://`/`node:`/`:行:列` 时保留；删除裸 `fail`；firstDiagnostic 跳过栈帧取错误标题 | 三个泄露路径各一条单测 + 一致性断言；当前管线主形态（header 独立行）原本就安全（实测 dropped=2 正文不存活） |
| **#5 清理不在 finally** | 真（mkdtemp 后任何提前 return/抛出都会漏删含明文的影子）。重构：`cleanupShadow()` 幂等闭包，外层 try/finally 兜底所有退出路径（成功路径在写报告前清理并记 `report.shadowCleanup = removed\|kept\|failed`） | 失败路径验证：`run --to 9.9.9-bogus` → 安装失败 exit 3 → tmp 残留 = 0 |
| **#6 P2-3 过度修正（对方撤回自己上轮主张）** | 真——且我上轮验收未独立复核就接受了错误前提（我的验证漏洞）。回退见上表 P2-3 行 | 真机 countRows=16；`rowIds` 死代码删除 |
| **#7 小项** | check 双调探测 → 提升为单次 `current`；classify 真实 cwd 闸门（沙箱化后多余）→ 改为“header 须含 cwd 字段”，目录不存在的会话**转为可演练**（覆盖率正收益），无 cwd 字段仍进 cwdMissing；patch 注释含路径/端口：报告仍只存计数，写作侧脱敏为既定约束 | 单测更新（session-gone 转 drillable、session-nocwd 进 cwdMissing） |
| “preset 分支 0 命中没走过” | 证据错误（重复 §8 把 `skipped: preset=0` 误读为“命中 0”）；但其内核（修复后代码未走过预设数据）在我读到前已成立——**已用 `--full --preset-mode patch` 关闭**：drillable=24、gate 生效、**migrated=24/24 含 15 个预设**、2 写回合 PASS（该次运行结果记录于此；产物目录按惯例清理，最新保留产物为 sample-9 终验 run） | 运行输出见本行记录 |
| “三条仍未验证” | 过期——上轮验收已实测关闭（schema exit 1 / `-api-key` 行名 / producerKind 两版一致） | 见上文验收记录 |
