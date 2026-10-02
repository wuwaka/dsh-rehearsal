[简体中文](SECURITY.md) | [English](SECURITY.en.md)

# 安全策略

本工具不是安全边界。有两个旗标在显式开启后会对主机执行真实动作，见[由使用方承担的风险](#由使用方承担的风险)。把这类既定行为当作漏洞的报告，应提交为普通 issue。

## 由代码保证的承诺

下表中每一行都在代码中实现并有测试覆盖，因此以下任何一条失效都属于真实的漏洞报告：

| 承诺 | 位置 |
|---|---|
| 预演不向活动 profile 安装任何内容；候选版本装入私有 npm 前缀，`DSH_HOME` 指向别处 | `src/lib/shadow.js` `installCandidate` |
| 会话副本的 `cwd` 被重写进影子目录，同时迁入对应的编码工作区目录 | `src/lib/sessions.js` `copySet` |
| 任何形如凭据的环境变量都不会传入子进程；报告只记录被剔除的变量名（`redactedEnvNames`） | `src/lib/util.js:56-75` |
| 遥测强制关闭（`DSH_TELEMETRY_MODE=DISABLED`） | `src/lib/util.js:75` |
| 报告不含消息正文与用户路径：`stderr` 只保留诊断行，evidence 对象逐字符串脱敏，`finalize()` 会清理每个阶段、coverage 块、target 与 warnings | `src/lib/report.js:136`；另有测试对最终报告 grep 家目录与推理标记 |
| 默认同时按行 id 与包名前缀抑制工具提供方；仅当会话历史中出现的全部工具都在只读允许清单内时才演练（fail-closed） | `src/lib/shadow.js`、`src/lib/drill.js` |
| 影子 home 内含明文会话副本，所有退出路径都会删除，结果记录为 `shadowCleanup` | `src/commands/run.js` |

## 由使用方承担的风险

1. `--allow-tools` 会执行会话历史中记录的工具调用。沙箱 `cwd` 仍然生效，但 `pwsh`、`bash`
   或任意绝对路径都可以越出该目录。保留该旗标是因为全部抑制工具会让写回合失去意义；
   它需要显式开启，执行前会打印横幅。
2. `--keep` 会把会话的明文副本留在影子 home 与安装前缀中，用于调试。不应在不受控制的
   机器上使用，事后需清理（`dsh-rehearsal clean --yes`）。

相关但属范围限制而非风险：候选版本安装默认 `--ignore-scripts`，与官方 pnpm 配置中很短的
构建脚本白名单一致。`--run-scripts` 会执行第三方生命周期脚本。

## 范围之外

- 不防御恶意的候选 `dsh`。预演运行的是待评估 harness 的一个构建；一旦该构建本身有害，
  文件层面的约束并不适用。
- 不防御已安装的插件。预演会加载钉定的插件集合，会外传数据的插件在预演中同样会外传。
- 附件旁路数据（`~/.dsh/attachments`、`cache/attachments`）不复制也不校验；附件引用完整性
  明确声明为范围之外，而非默认已覆盖。
- 脱敏是过滤器，不是证明。报告中出现真实消息正文或真实用户路径属于缺陷，值得上报；
  无论如何都应把报告文件视为敏感内容。

## 上报方式

使用[私有安全通告](https://github.com/wuwaka/dsh-rehearsal/security/advisories/new)。
附上候选 `dsh` 版本、操作系统、Node 版本与工具版本（`dsh-rehearsal --version`）。

不要将报告文件或 `run` 输出粘贴到公开 issue：脱敏属尽力而为，而这些文件派生自本地会话历史。
`report.json` 与 `report.md` 只留在磁盘上，本工具不上传任何内容。
