# Changelog

本文件记录 Astraea 的版本变更，遵循 [Keep a Changelog](https://keepachangelog.com/) 与
[语义化版本 SemVer](https://semver.org/lang/zh-CN/)。

版本号的权威来源是 `package.json` 的 `version` 字段；UI 显示（`src/ui/App.tsx` 的 `VERSION`）
直接读取它，请勿在别处硬编码版本号。

> **1.0.0 发布门槛**（达成后才从 0.x 升到 1.0 并打首个 `git tag v1.0.0`）：

## [0.9.4] - 2026-06-21

### 新增
- **`/rewind` 会话回滚**：对话历史与文件双轨回退。`/rewind` 开方向键选择器（琥珀色，
  区别于 `/resume` 的靛蓝）、`/rewind N` 直接回到第 N 回合之前。回滚窗口内取最早的
  改动前态还原 Write/Edit 改过的文件（当时新建的文件会被删除）。检查点单例做对话长度
  记录 + 文件 copy-on-write 快照；transcript 新增 `rewind` 行类型，`loadSessionMessages`
  改为折叠式重放，正确处理 `compact` 与 `rewind` 标记的任意交错。
  - v1 边界：仅捕获 Write/Edit；Bash 的 `rm`/`mv`/重定向不在范围（需 P3 shadow-git）。
- **Kimi（Moonshot AI）provider**：OpenAI 兼容接入，`PROVIDER=kimi`（或 `moonshot`）启用，
  `/login` 可选。默认 `kimi-k2-0905-preview`、`https://api.moonshot.cn/v1`（海外用
  `KIMI_BASE_URL` 切 `api.moonshot.ai/v1`）。usage 缓存拆分、价目、tracing、transcript 全打通。
- **`/reload-plugins` 热重载**：无需重启即可让新加的 skill / 插件生效——重扫 user/project/plugin
  三来源 skill 目录并清命令表缓存，下一条消息即生效。（插件 MCP server 连接仍需重启）

### 修复
- **skill 资源路径解析**：skill 多为全局安装（`~/.astraea/skills/<name>`），与 cwd 无关，
  Windows 上甚至跨盘符。此前注入 SKILL.md 正文时既不展开 `<SKILL_ROOT>` 占位符、也不告知
  skill 绝对目录，导致模型把 `references/x.md` 等相对资源错按 cwd 解析 → 文件找不到。现于
  `getPrompt()` 展开 `<SKILL_ROOT>` 为绝对路径并在顶部声明 skill 目录，要求相对资源按它解析。

## [0.9.0] - 2026-06-19

首个对外标定版本，纠正长期占位的 `0.1.0`（该值从未随功能更新）。v1.0 的 RC 高度：
设计 ~85% 已实现，但项目仍 private、内部接口仍在演进，故停留在 0.x。

### 已具备
- 40+ 内置工具：文件 / Shell / Web / Task / MCP / 子 agent 协调
- 完整 ReAct 查询循环（多轮流式 + /goal 自驱 Stop-hook）
- 多 Provider：Anthropic / OpenAI / DeepSeek / Ollama + 自适应重试
- 四层上下文压缩：snipping / microcompact / eclipse 折叠 / autocompact
- 文件级持久记忆系统：抽取 / 召回 / 注入
- 5 模式 × 行为权限矩阵 + 红线 + AI 命令分类器
- Skills / Plugins(本地市场) / MCP(stdio·http·sse) 三套体系
- Phoenix 可观测性（span 生命周期 + 离线 eval）
- 196 个测试文件
