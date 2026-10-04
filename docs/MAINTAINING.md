# 维护者手册

面向维护者的低频知识：文档治理、仓库资产、生态调查、本机环境。发布操作步骤在 [PUBLISHING.md](../PUBLISHING.md)。

本文件不进入双语对断言（`test/docs.test.js` 只覆盖 README / CHANGELOG / SECURITY / PUBLISHING / AUDIT / architecture / FAILURE_MODES 七对），因此没有英文半边；事实纪律不变——引用要可点，状态要带日期。

## 目录投稿

- `awesome-dsh-plugin` 拒收外部 CLI：其 `scripts/check-submission.mjs:258-264` 要求某个 `package.json` 声明 `dsh.bundle`，只声明 `dsh.client` 亦被拒。同为外部 CLI 的 `dsh-plugin-reducer`、`dsh-canary` 在该目录 4,412 条中 0 命中。
- 投稿状态（2026-10-04）：`Dominic789654/awesome-deepseek-harness#579`（359★，条目在 Session & Memory Management）**已合并**；`0xsline/awesome-deepseek-harness#679`（1,133★，Runtime & Operations）与 `Zhiyuan-Fan/Awesome-DeepSeek-Harness-Plugins#85`（569★，Sessions & Storage 表格）在审。三个 PR 均为双语条目同一 PR，收到审核意见需按各清单 contributing 规则跟进。收录目录的可选 `tarball` 键要求 https、GitHub Release 托管、`.tgz` 结尾——Release 附件（tarball + `.sha256`）已是这个形状。
- 徽章：已加（2026-10-04）——npm 版本徽章，与 `listed in awesome-deepseek-harness`（锚到 Session & Memory Management 小节；`Dominic789654/awesome-deepseek-harness#579` 已合并）。其余两处在审目录（`0xsline#679`、`Zhiyuan-Fan#85`）合并后再决定是否换指向。`dsh-doctor` 的门禁徽章不适用（其 R/K/D 门评分 `dsh.bundle` 包）。

## 仓库图片与社交预览

- `assets/poster.jpg`（1774×887，233 KB）是两份 README 顶部的海报，写法沿用 `wuwaka/dsh-clipboard-menu`：`<div align="center">` 内第一行 `<img src="assets/poster.jpg" width="620" alt="…">`，alt 写成一句可核对的描述。邻居 `dsh-plugin-gating-hub` 用 `width="1170"`；620 之下海报上的中文副标题偏小，要放大改这一个数字。
- `assets/social-preview.jpg`（1280×640，153 KB）用于仓库社交预览图，在 Settings → General → Social preview 手动上传。这一步没有接口：2026-10-03 核过 REST 的 repo 对象没有 social preview 字段。它决定仓库链接被分享或展开时显示的图，不影响 GitHub 搜索结果列表。
- 两个文件从同一张源图再生（源图 1.88 MB，不入库）：

  ```sh
  python - <<'PY'
  from PIL import Image
  src = Image.open('poster-source.png').convert('RGB')          # 1774x887, 2:1
  src.save('assets/poster.jpg', quality=88, optimize=True, progressive=True)
  src.resize((1280, 640), Image.LANCZOS).save(
      'assets/social-preview.jpg', quality=90, optimize=True, progressive=True)
  PY
  ```

- 相对路径图片在 npm 包页面通常解析不了，海报预期只在 GitHub 生效。此点未实测（包尚未发布），发布后需复核。

## 文档治理

- 每份对外文档都是双语对：`README`、`CHANGELOG`、`SECURITY`、`PUBLISHING`、`AUDIT`、`docs/architecture`、`docs/FAILURE_MODES`。`test/docs.test.js` 在对开缺失、`## ` 小节数不一致、`file:line` 引用集合不同、issue 号或提交哈希不同、语言切换行指向不存在的文件、或文档退回第一人称时失败。
- 行文为陈述式且无第一人称，主张与出处相邻。用 `grep -c` 统计第一人称标记与 `——` 数量来验证，不靠目测。
- README 不硬编码会过期的数字：测试数已两次过期（写 20 实测 22、写 80 实测 81），不再写；其他统计数字要么加断言，要么带 as-of 日期。
- 三处结论依赖测量，会自行过期：兼容性表（分列 Tested 与声明，注明日期，每次发版重测）、覆盖率表（单机数字，重新发布要重测，不跨用户取平均）、`docs/architecture.md` 里的同类工具分工表（描述的是别人的仓库，重复任何一格前先重读对方源码）。

## 本机环境

- `~/.npmrc` 默认 registry 是只读镜像，对 `npm whoami` 返回 404 且不接受发布：发布走 CI，或显式加 `--registry https://registry.npmjs.org`。

## npm registry 状态

- `dsh-rehearsal@0.2.1` 于 2026-10-03 由 CI 首发（`NPM_TOKEN` 已配置，`gh workflow run publish.yml` 手动触发；tag 推送本身不会自动发布）。
- dist-tags 遗留 `tmp-write-verify`（写入探测时创建）：granular token 被 GAT 政策禁止 DELETE（403），需在 npm 网页端手动删除。
- `package.json` 的 `keywords` 仍含过时的 `dsh-plugin`（GitHub topics 刻意不含——生态反爬虫清单会剔除蹭标签的非插件）：已定在下次发版把它换成 `dsh`；keywords 只在 publish 时生效。

## 新增一条失效签名

1. 在 `src/lib/drill.js` 的 `WRITE_FAIL_SIGNATURES` 或 `src/commands/run.js` 的 `BOOT_SIGNATURES` 中加 `{id, pattern, note, severity}`，`note` 写明出处：优先锚上游 issue 编号，没有 issue 的锚本仓库 `file:line`。
2. 在 `test/signatures.test.js` 加一对断言：真实日志行必须命中，健康日志行必须不命中。断言中的日志须取自 issue 正文或真实产物原文，不得为通过正则而编造。
3. 在 `docs/FAILURE_MODES.md` 对应表中新增一行，如实标注本机是否可复现。不可复现须写明原因，否则读者会误认为已验证。
