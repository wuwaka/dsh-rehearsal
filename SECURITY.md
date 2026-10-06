[简体中文](SECURITY.md) | [English](SECURITY.en.md)

# 安全策略

本工具不是安全边界。

## 代码保证

以下属性由代码实现并有测试覆盖。任何一条失效都属于漏洞，请按下文方式上报。

| 保证 | 位置 |
|---|---|
| 真实 home 与桌面宿主安装目录只读：home 发现、会话发现与版本探测只做文件解析；全部写入只落在影子 home 与 `.dsh-rehearsal` 产物目录 | `src/lib/dshhome.js`、`src/lib/desktops.js` |
| 删除与写入带 ownership 边界：`clean` 只删带本工具标记的产物目录（HOME、工作目录、文件系统根一律拒绝）；`--shadow-dir`/`--prefix-dir` 非空且无标记时拒绝写入 | `src/lib/util.js`、`src/cli.js` |
| 预演不向活动 profile 安装任何内容；候选版本装入私有 npm 前缀，`DSH_HOME` 指向别处 | `src/lib/shadow.js` `installCandidate` |
| 会话副本的 `cwd` 被重写进影子目录，同时迁入对应的编码工作区目录 | `src/lib/sessions.js` `copySet` |
| 凭据形状的环境变量按名剥离（候选运行与候选安装的 npm 生命周期脚本同等处理）；保留变量的 URL 值再剥掉内嵌的 userinfo 凭据（代理与 registry 地址是常见载体）。名字过滤可能误删无害变量（如匹配 `AUTH` 的 `XAUTHORITY`）——方向是少给，不是多给。报告只记录被剔除的变量名 | `src/lib/util.js:69-130` |
| 遥测强制关闭（`DSH_TELEMETRY_MODE=DISABLED`） | `src/lib/util.js:130` |
| 报告不含消息正文与用户路径：`stderr` 只保留诊断行，evidence 对象逐字符串脱敏，`finalize()` 清理每个阶段、coverage、target 与 warnings；`privacy.scrubbed` 不为真时 `writeReport()` 拒绝写盘 | `src/lib/report.js:225`；另有测试对最终报告 grep 家目录与推理标记 |
| 默认同时按行 id 与包名前缀抑制工具提供方；仅当会话历史中的全部工具都在只读允许清单内时才演练（fail-closed） | `src/lib/shadow.js`、`src/lib/drill.js` |
| 影子 home 内含明文会话副本：正常退出路径都会删除并记录为 `shadowCleanup`；SIGINT/SIGTERM/SIGBREAK/SIGHUP 触发尽力删除（阻塞型 spawn 期间收到信号时，在该 spawn 返回后执行）；被强杀或崩溃遗留下来的影子目录，由下一次 `run` 启动时按 ownership 标记清扫（只清带本工具标记的目录） | `src/commands/run.js`、`src/lib/util.js:258` |

关于工具抑制名单（`src/lib/shadow.js:149`）的失效方向：名单缺了新出现的工具家族时，对应行不会被禁用，但这不构成放行路径——写回合回放的调用集合限于会话录制中出现过的调用，且历史里带未知或写类工具的会话在预检就被整体跳过（fail-closed）。名单过期只会让抑制不完整，不会让未预期的工具执行；`--allow-tools` 默认关闭仍是最外层的显式闸门。名单本身还有一道前置闸门：写回合启动前会运行候选的 `--dump-config` 并解析全部执行器行——dump 命令失败、解析不出任何行、或请求了抑制却得到 0 行抑制结果，写路径直接中止，而不是带着未经校验的执行器继续。

## 显式危险选项

**`--allow-tools` 不是沙箱能力，而是显式要求执行历史工具调用。**

| 旗标 | 后果 |
|---|---|
| `--allow-tools` | 执行会话历史中记录的工具调用。沙箱 `cwd` 仍然生效，但 `pwsh`、`bash` 或任意绝对路径可以越出该目录。执行前会打印横幅 |
| `--keep` | 把会话的明文副本留在影子 home 与安装前缀中。不受控制的机器上不要使用，事后执行 `dsh-rehearsal clean --yes`（`--shadow-dir` 与 `--prefix-dir` 指定的目录同样不会自动清理，也不归 `clean` 管——它只处理默认产物目录） |
| `--run-scripts` | 让候选安装执行第三方生命周期脚本。默认 `--ignore-scripts`，与官方 pnpm 配置中很短的构建脚本白名单一致；即使开启，脚本也在剥除凭据的环境变量下运行 |

## 报告是敏感数据

`report.json` 与 `report.md` 派生自本地会话数据。脱敏是过滤器，不是证明：不要把报告文件或 `run` 输出粘贴到公开 issue。两份文件只留在磁盘上，本工具不上传任何内容。

过滤器覆盖的形状：`C:\Users\<n>`、`/home/<n>`、`/Users/<n>` 归一为 `~`（home 字段含空格时整段升级为 `<abs-path>`，不留尾巴）；任意盘符路径、任意 POSIX 绝对路径（含 `/root/.dsh`、`/var/lib/<服务名>`、`/srv/<团队>`、`/tmp/<影子目录>`，以及单段的 `/tmp`、`/etc`）、UNC 共享 `\\server\share\…`、以及 `../` 形式的上级相对路径，一律归一为 `<abs-path>` / `<unc-path>` / `<rel-path>`。仓库相对文本（`src/lib/drill.js:217`、`sessions/<ws>/…`）与 URL 有意保留，各有测试锁定。

两道结构性保障，而不是继续加正则：

- **能不写路径就不写**。DSH_HOME 这类字段只写形状或来源（`home=default|custom|desktop:<host-id>|unknown`），路径根本不进入字符串。
- **漏网即拒写**。`finalize()` 用同一套形状检测器扫一遍完整报告，任何未被遮住的 path-shaped 文本都会写入 `warnings[]`（`redaction gap: …`），并由该结果决定 `privacy.scrubbed` 的取值——这个字段不再在构造时宣称。落盘只允许经过 `writeReport()`，它每次落盘都重新 `finalize()` 且 fail-closed：`scrubbed` 不是 `true` 时**拒绝写盘**（抛错退出），而不是把未脱敏的原值写进磁盘——一条和泄漏数据并排的警告不是闸门。将来某个新阶段拼出未覆盖的路径形状时，工具会拒绝出报告并指出缺口数量，修好过滤规则再重新运行。

仍要说清的是：这依然是尽力而为的过滤，不是证明。

## 范围之外

- 不防御恶意的候选 `dsh`。预演运行的是待评估 harness 的一个构建；一旦该构建本身有害，文件层面的约束并不适用。
- 不防御已安装的插件。预演会加载钉定的插件集合，会外传数据的插件在预演中同样会外传。
- 附件旁路数据（`~/.dsh/attachments`、`cache/attachments`）不复制也不校验，附件引用完整性声明为范围之外。

## 自查真实 home 未被写入

三条互相独立的检查：

```sh
# 1) 真实库中所有迁移产物的 mtime 必须早于预演时刻
find ~/.dsh/sessions -name 'session.v4.jsonl.zstd' -printf '%TY-%Tm-%Td %TH:%TM %p\n' | sort | tail -3
# 2) 不留影子目录（除非使用 --keep 或 --shadow-dir；中断运行遗留的带标记目录会在下一次 run 启动时被自动清扫）
ls -d "${TMPDIR:-/tmp}"/dsh-rehearsal-home-* 2>/dev/null | wc -l
# 3) 报告中不含家目录与正文；<TOKENS> 替换为使用方自己的用户名与盘符关键词
node -e "const fs=require('fs');const d=fs.readdirSync('.dsh-rehearsal').sort().pop();\
const t=fs.readFileSync('.dsh-rehearsal/'+d+'/report.json','utf8');\
console.log(['<TOKENS>','reasoning:'].filter(k=>t.includes(k)).length?'LEAK':'CLEAN')"
```

第 3 条里的 `<TOKENS>` 由使用方自己填：文档预填不了关键词——把真实用户名或盘符写进公开文档等于发布它们，而且带关键词的 grep 会在文档自己身上命中。

## 上报方式

使用[私有安全通告](https://github.com/wuwaka/dsh-rehearsal/security/advisories/new)，附上候选 `dsh` 版本、操作系统、Node 版本与工具版本（`dsh-rehearsal --version`）。
