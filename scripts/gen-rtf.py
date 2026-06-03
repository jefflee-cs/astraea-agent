#!/usr/bin/env python3
"""Generate wechat-function-upgrade.rtf with proper RTF Unicode encoding."""
import sys

OUT = '/Users/ronghuizhong/Documents/project/astraea/Astraea Development/v1.0/Unique Feature/wechat-function-upgrade.rtf'

def r(text: str) -> str:
    """Convert text to RTF Unicode escape sequences."""
    out = []
    for ch in text:
        cp = ord(ch)
        if cp > 127:
            out.append(f'\\uc0\\u{cp} ')
        elif ch == '\\':
            out.append('\\\\')
        elif ch == '{':
            out.append('\\{')
        elif ch == '}':
            out.append('\\}')
        elif ch == '\n':
            out.append('\\\n')
        else:
            out.append(ch)
    return ''.join(out)

parts = []

def title(s): parts.append(f'\\f0\\fs32\\b \\cf0 {r(s)}\\b0\\\n')
def sub(s):   parts.append(f'\\f0\\fs20 \\cf3 {r(s)}\\cf0\\\n')
def h1(s):    parts.append(f'\\\n\\f0\\fs26\\b \\cf0 {r(s)}\\b0\\\n')
def h2(s):    parts.append(f'\\f0\\fs24\\b \\cf2 {r(s)}\\b0\\\n')
def body(s):  parts.append(f'\\f0\\fs22 \\cf0 {r(s)}\\\n')
def bullet(s):parts.append(f'\\f0\\fs22 \\cf0    {r("• " + s)}\\\n')
def code(s):  parts.append(f'\\f1\\fs20 \\cf3 {r(s)}\\f0\\cf0\\\n')
def blank():  parts.append('\\\n')

title('微信聊天整理功能 — 重大升级记录 (v2.0)')
sub('更新日期：2026-06-01　|　文档路径：Astraea Development/v1.0/Unique Feature/')
blank()

h1('一、原始需求')
body('用户通过 /vigil 或 /wechat 命令，自动整理指定联系人的微信聊天记录，提取重要内容和待办事项，生成结构化摘要文件。用户不需要手动描述"该总结什么"，由 settings.json 配置和固定 Prompt 驱动。')
blank()

h1('二、已实现功能')
blank()

h2('2.1  settings.json 配置（~/.astraea/settings.json）')
code('{\n  "wechat": {\n    "scope": { "type": "contacts", "names": ["李嘉俊", "哲舅舅"] },\n    "days": 30,\n    "outputDir": "~/Documents/astraea-weekly",\n    "organize": ["contacts"]\n  }\n}')
blank()
body('scope 三选一：')
bullet('contacts  — 指定联系人：{ "type": "contacts", "names": ["妈妈"] }')
bullet('top       — 最近 K 个：{ "type": "top", "k": 5 }')
bullet('all       — 所有联系人（上限 50）：{ "type": "all", "limit": 20 }')
blank()
body('organize 六种整理模式（可多选，默认 timeline + tasks）：')
bullet('timeline  — 按日期排列，每天一个小节')
bullet('contacts  — 按联系人/群聊分组，每人单独一块')
bullet('topics    — LLM 自动识别主题（工作安排、家庭事务…）并归类')
bullet('tasks     — 只提取需要用户行动的待办事项')
bullet('decisions — 只提取已拍板的决定（谁决定、何时）')
bullet('promises  — 承诺追踪（谁承诺了什么，是否已兑现）')
blank()
body('days：往前读取天数，上限 30，填 200 自动截断为 30。默认 30。')
blank()

h2('2.2  两个入口')
body('/wechat — 立即执行')
bullet('读取 settings.json → 收集聊天记录 → LLM 生成摘要 → 写入 outputDir')
bullet('配置缺失/非法时弹出错误提示和配置模板，不执行任何操作')
blank()
body('/vigil → wechat — 定时执行')
bullet('在 /vigil 面板选择 wechat，输入时间（如"每天晚上 10 点"）')
bullet('系统自动从 settings.json 读取配置，注册 vigil 定时任务')
bullet('时间不明确则创建失败，不注册任务')
blank()

h2('2.3  摘要生成 Prompt')
body('三个固定章节（每次必出）：')
bullet('重要内容提取 — 过滤寒暄，保留有实质意义的内容，标注联系人和时间')
bullet('待办事项 — 需要用户行动的事（- [ ] 格式），含提出人和时间')
bullet('待回复/跟进 — 对方问了未回复的问题或未明确答复的请求')
blank()
body('可选章节由 organize 字段决定（timeline / contacts / topics / decisions / promises）。')
blank()
body('过滤规则：')
bullet('忽略：单独的"好的"/"嗯"/"谢谢"等无实质内容回复；纯寒暄；重复信息')
bullet('保留：时间安排、具体事项、决定、请求、重要信息、未来计划、承诺')
blank()

h2('2.4  安全停止（Ctrl+C）')
body('Ctrl+C 同时触发两个动作：')
bullet('REPL 的 AbortController 停止 LLM 流式输出')
bullet('abortWechatRead() 写入 /tmp/.wechat_read_abort，Python 脚本在下次滚动前检测并退出')
blank()

h1('三、技术实现要点')
blank()

h2('3.1  截图 + OCR（非 MCP）')
body('WechatReadTool 是 Astraea 原生工具，不使用 MCP 协议。')
body('微信 4.x 的 Accessibility 树为空（只有 3 个 Button，内容完全不可见），无法使用 Accessibility API，改用全屏截图 + Apple Vision OCR（macOS 内置，免费，离线，中文识别准确）。')
body('依赖：pyobjc。首次调用自动安装，用户无需手动运行 setup。')
blank()

h2('3.2  滚动读取策略（本次修复的核心）')
body('每次滚动 600px（原 300px 加倍）。30 天配置 → 最多 90 次滚动（span × 3，上限 150）。')
blank()
body('停止条件（按优先级）：')
bullet('A — 累积内容最旧 150 行出现 target_date 以前的日期 → 达到目标，停止')
bullet('B — 当前截图可见的最新日期早于 target_date → 达到目标，停止')
bullet('C — 内容指纹连续 3 次 Jaccard > 0.9 → 已到对话顶部，停止')
bullet('D — 达到 max_scrolls 安全上限 → 停止')
blank()
body('已删除的错误条件：date_drought（8 屏无日期就停）')
bullet('根本原因：最新消息区域没有日期分隔符，该条件在读取开始时就会误触发')
bullet('表现：只滚动几次就停，远达不到配置的 30 天')
blank()

h2('3.3  联系人名字保护')
body('LLM 在构建 vigil task prompt 时会将中文名翻译为拼音（如"李嘉俊"→"Li Jiajun"），导致微信搜索找不到人。')
body('已在三处强制要求原语言：')
bullet('WechatReadTool description')
bullet('VigilOnceTool / VigilScheduleTool 的 prompt 字段说明')
bullet('system prompt 的 toolRules 段落')
blank()

h1('四、权限要求（一次性）')
body('运行 bun run setup:wechat，脚本自动打开系统设置：')
bullet('辅助功能 → Terminal → 开启（用于模拟鼠标点击和键盘输入）')
bullet('屏幕录制与系统录音 → Terminal → 开启（用于截取微信窗口画面）')
body('macOS TCC 机制强制用户本人手动授权（程序无法代替）。仅需操作一次，永久有效。')
blank()

h1('五、已知限制')
bullet('微信后台时自动唤起（最多等 8 秒）；未安装微信则报错退出')
bullet('top / all scope 依赖侧边栏可见性，contacts scope 最稳定')
bullet('OCR 偶有识别错误，LLM 整理时会自动过滤明显乱码')
bullet('仅支持 macOS（依赖 Apple Vision、Quartz、CGEvent）')

header = (
    r'{\rtf1\ansi\ansicpg936\cocoartf2870' + '\n'
    r'\cocoatextscaling0\cocoaplatform0{\fonttbl\f0\fswiss\fcharset0 Helvetica;\f1\fnil\fcharset0 Menlo-Regular;}' + '\n'
    r'{\colortbl;\red255\green255\blue255;\red0\green0\blue0;\red30\green100\blue200;\red100\green100\blue100;}' + '\n'
    r'\paperw11900\paperh16840\margl1440\margr1440\vieww11520\viewh8400\viewkind0' + '\n'
    r'\pard\tx720\tx1440\tx2160\tx2880\tx3600\tx4320\tx5040\tx5760\tx6480\tx7200\tx7920\tx8640\pardirnatural\partightenfactor0' + '\n\n'
)

content = header + ''.join(parts) + '}'

with open(OUT, 'w', encoding='utf-8') as f:
    f.write(content)

print('OK — written to', OUT)
