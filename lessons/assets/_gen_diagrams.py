#!/usr/bin/env python3
"""Generate harness-engineering lesson diagrams (style-1 flat icon)."""
from __future__ import annotations

from pathlib import Path

OUT = Path(__file__).resolve().parent
FONT = "'Helvetica Neue', Helvetica, Arial, 'PingFang SC', 'Microsoft YaHei', 'Microsoft JhengHei', 'SimHei', sans-serif"


def esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def markers() -> list[str]:
    colors = {
        "blue": "#2563eb",
        "gray": "#6b7280",
        "green": "#16a34a",
        "red": "#dc2626",
        "orange": "#ea580c",
        "purple": "#7c3aed",
        "slate": "#334155",
    }
    lines = []
    for name, fill in colors.items():
        lines.append(
            f'<marker id="arrow-{name}" viewBox="0 0 10 10" refX="9" refY="5" '
            f'markerWidth="9" markerHeight="9" orient="auto">'
            f'<path d="M 0 0 L 10 5 L 0 10 z" fill="{fill}"/></marker>'
        )
    return lines


def style_block() -> str:
    return f"<style>text {{ font-family: {FONT}; }}</style>"


def t(
    x: float,
    y: float,
    s: str,
    *,
    size: int = 14,
    fill: str = "#111827",
    anchor: str = "middle",
    weight: int = 400,
) -> str:
    w = f' font-weight="{weight}"' if weight != 400 else ""
    return (
        f'<text x="{x}" y="{y}" fill="{fill}" font-size="{size}" '
        f'text-anchor="{anchor}"{w}>{esc(s)}</text>'
    )


def rect(
    x: float,
    y: float,
    w: float,
    h: float,
    fill: str,
    stroke: str,
    *,
    sw: float = 1.5,
    rx: float = 8,
) -> str:
    return (
        f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" '
        f'fill="{fill}" stroke="{stroke}" stroke-width="{sw}"/>'
    )


def diamond(cx: float, cy: float, w: float, h: float, fill: str, stroke: str, sw: float = 1.8) -> str:
    pts = f"{cx},{cy - h / 2} {cx + w / 2},{cy} {cx},{cy + h / 2} {cx - w / 2},{cy}"
    return f'<polygon points="{pts}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"/>'


def path(d: str, color: str, *, sw: float = 1.6, dash: str | None = None, marker: str | None = None) -> str:
    extra = ""
    if dash:
        extra += f' stroke-dasharray="{dash}"'
    if marker:
        extra += f' marker-end="url(#{marker})"'
    return f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{sw}"{extra}/>'


def card(x, y, w, h, fill, stroke, title, sub=None, title_fill="#111827", sub_fill="#6b7280", sw=1.5):
    lines = [rect(x, y, w, h, fill, stroke, sw=sw)]
    if sub:
        lines.append(t(x + w / 2, y + h / 2 - 6, title, size=14, fill=title_fill, weight=600))
        lines.append(t(x + w / 2, y + h / 2 + 14, sub, size=12, fill=sub_fill))
    else:
        lines.append(t(x + w / 2, y + h / 2 + 5, title, size=14, fill=title_fill, weight=600))
    return lines


def write_svg(name: str, vb_w: int, vb_h: int, body: list[str]) -> Path:
    lines = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {vb_w} {vb_h}" width="{vb_w}" height="{vb_h}">',
        style_block(),
        "<defs>",
        *markers(),
        "</defs>",
        f'<rect width="{vb_w}" height="{vb_h}" fill="#ffffff"/>',
        *body,
        "</svg>",
    ]
    dest = OUT / name
    dest.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"wrote {dest}")
    return dest


def panorama() -> None:
    W, H = 1720, 1460
    b: list[str] = []
    b.append(t(860, 36, "Agent Loop 运行时全景", size=24, weight=700))
    b.append(t(860, 60, "最外层是循环；机制是守卫、分流与外套。虚线在循环外。", size=13, fill="#6b7280"))

    # triggers
    b.append(rect(48, 78, 1624, 86, "#eff6ff", "#93c5fd", sw=1.5, rx=10))
    b.append(t(64, 100, "循环外 · 触发源", size=12, fill="#1d4ed8", anchor="start", weight=600))
    trig = [
        (80, "用户消息", "一次请求"),
        (480, "cron", "新开白纸线程"),
        (880, "heartbeat", "追加回同一线程"),
        (1280, "子循环", "干净 input"),
    ]
    for x, title, sub in trig:
        b.extend(card(x, 108, 340, 46, "#ffffff", "#bfdbfe", title, sub, title_fill="#1e3a8f"))

    b.append(path("M 860 154 L 860 184", "#2563eb", sw=1.8, marker="arrow-blue"))

    # loop frame
    b.append(rect(48, 184, 1624, 1128, "#f8fafc", "#1e40af", sw=2.5, rx=14))
    b.append(rect(68, 172, 168, 28, "#1e40af", "#1e40af", rx=6))
    b.append(t(152, 191, "Agent Loop", size=14, fill="#ffffff", weight=700))

    # --- band 1 budget + model ---
    b.extend(card(80, 228, 210, 72, "#eff6ff", "#93c5fd", "① 预算检查", "估算 thread token"))
    b.append(diamond(400, 264, 150, 78, "#fffbeb", "#f59e0b"))
    b.append(t(400, 260, "超预算?", size=13, weight=600, fill="#92400e"))
    b.append(t(400, 276, "是 / 否", size=11, fill="#b45309"))
    b.extend(card(510, 228, 250, 72, "#fff7ed", "#fdba74", "compact", "摘要替换旧历史"))
    b.extend(
        card(
            800,
            218,
            280,
            92,
            "#111827",
            "#111827",
            "② 调用模型",
            "可恢复的尝试",
            title_fill="#ffffff",
            sub_fill="#93c5fd",
            sw=2,
        )
    )

    b.append(path("M 290 264 L 325 264", "#2563eb", marker="arrow-blue"))
    b.append(path("M 475 264 L 510 264", "#ea580c", marker="arrow-orange"))  # yes
    b.append(path("M 760 264 L 800 264", "#2563eb", marker="arrow-blue"))
    # no: down then right into callModel bottom-left
    b.append(
        path(
            "M 400 303 L 400 330 L 780 330 L 780 310",
            "#6b7280",
            marker="arrow-gray",
        )
    )
    b.append(t(590, 324, "未超，直接调用", size=11, fill="#6b7280"))

    # recovery panel
    b.append(rect(1120, 218, 528, 200, "#ffffff", "#e5e7eb", rx=10))
    b.append(t(1140, 240, "失败分类（abort 离开循环；其余回到 ②）", size=12, fill="#6b7280", anchor="start", weight=600))
    recs = [
        (252, "#fef2f2", "#fecaca", "#991b1b", "abort", "立刻停 turn，会话保留"),
        (292, "#faf5ff", "#e9d5ff", "#6b21a8", "rate_limit", "抖动退避后重试"),
        (332, "#fff7ed", "#fed7aa", "#9a3412", "overflow", "compact 后再试一次"),
        (372, "#f3f4f6", "#d1d5db", "#374151", "unknown", "少量重试后放弃"),
    ]
    for y, fill, stroke, tf, k, desc in recs:
        b.append(rect(1136, y, 120, 32, fill, stroke, rx=6))
        b.append(t(1196, y + 21, k, size=12, fill=tf, weight=600))
        b.append(t(1270, y + 21, desc, size=12, fill="#374151", anchor="start"))

    b.append(path("M 1080 264 L 1120 264", "#dc2626", dash="5,3", marker="arrow-red"))
    b.append(t(1100, 254, "抛错", size=11, fill="#dc2626"))

    # --- band 3 persist ---
    b.extend(card(200, 448, 260, 68, "#f0fdf4", "#86efac", "③ 追加进线程", "reasoning 也原样保留"))
    b.extend(card(520, 448, 280, 68, "#f0fdf4", "#86efac", "write-through JSONL", "item 一产生就落盘"))
    b.append(path("M 940 310 L 940 430 L 480 430 L 480 448", "#16a34a", marker="arrow-green"))
    b.append(path("M 460 482 L 520 482", "#16a34a", marker="arrow-green"))

    # --- band 4 decision ---
    b.append(diamond(860, 620, 240, 110, "#eff6ff", "#2563eb", sw=2))
    b.append(t(860, 612, "有 function_call?", size=14, weight=700, fill="#1e3a8f"))
    b.append(t(860, 634, "只看结构信号", size=12, fill="#3b82f6"))
    b.append(path("M 660 482 L 860 482 L 860 565", "#2563eb", marker="arrow-blue"))

    b.extend(card(80, 590, 250, 72, "#ecfdf5", "#16a34a", "无 · 终态文本", "抽出 message，结束本 turn", sw=2))
    b.append(path("M 740 620 L 330 620", "#16a34a", marker="arrow-green"))
    b.append(t(520, 608, "否", size=12, fill="#16a34a", weight=600))
    b.append(rect(80, 670, 250, 28, "#dcfce7", "#16a34a", rx=6, sw=1.2))
    b.append(t(205, 689, "退出循环 · session 仍在", size=12, fill="#166534", weight=600))

    b.append(t(980, 668, "是", size=12, fill="#2563eb", weight=600))
    b.append(path("M 860 675 L 860 718", "#2563eb", marker="arrow-blue"))

    # --- band 5 dispatch ---
    b.append(t(80, 742, "⑤ 按工具身份分流（注册表内侧）", size=13, fill="#1e40af", anchor="start", weight=600))
    tools = [
        (80, "计划 / 技能", "改状态或注入正文"),
        (340, "await 子循环", "干净上下文，只回结论"),
        (600, "spawn 并行", "立刻返回，信箱交接"),
        (860, "yield 执行", "窗口到点交 session_id"),
        (1120, "MCP 桥", "tools/call 用原名"),
        (1380, "落地执行", "再过审批 × 沙箱"),
    ]
    for x, title, sub in tools:
        fill, stroke = ("#fff7ed", "#fb923c") if title == "落地执行" else ("#ffffff", "#d1d5db")
        b.extend(card(x, 754, 244, 64, fill, stroke, title, sub, sw=1.6 if title == "落地执行" else 1.4))

    b.append(path("M 860 718 L 860 754", "#2563eb"))
    # fan-out rail
    b.append(path("M 202 754 L 1502 754", "#93c5fd", sw=1.2))

    # --- band 6 landing pipeline ---
    b.append(t(80, 848, "⑥ 落地管线（dispatch 外套）· 非落地工具跳过，直接产出结果", size=13, fill="#9a3412", anchor="start", weight=600))
    b.extend(card(80, 862, 200, 64, "#fff7ed", "#fdba74", "分类风险", "harness 判定，不信模型"))
    b.append(diamond(390, 894, 140, 72, "#fffbeb", "#f59e0b"))
    b.append(t(390, 890, "要问人?", size=13, weight=600, fill="#92400e"))
    b.extend(card(500, 862, 190, 64, "#fef2f2", "#fca5a5", "审批", "拒绝 → 错误 item"))
    b.extend(card(740, 862, 190, 64, "#faf5ff", "#d8b4fe", "沙箱", "越界 → 错误 item"))
    b.extend(card(980, 862, 200, 64, "#eff6ff", "#93c5fd", "handler", "真正碰世界"))
    b.extend(card(1240, 862, 360, 64, "#f3f4f6", "#d1d5db", "拒绝 / 越界也 continue", "function_call_output 喂回"))

    b.append(path("M 280 894 L 320 894", "#ea580c", marker="arrow-orange"))
    b.append(path("M 460 894 L 500 894", "#ea580c", marker="arrow-orange"))
    b.append(path("M 690 894 L 740 894", "#7c3aed", marker="arrow-purple"))
    b.append(path("M 930 894 L 980 894", "#2563eb", marker="arrow-blue"))
    b.append(path("M 1180 894 L 1240 894", "#6b7280", dash="5,3", marker="arrow-gray"))
    # 落地执行 already labeled; do not draw a full-width rail through the section title.

    # --- band 7 feedback ---
    b.extend(
        card(560, 968, 360, 70, "#eef2ff", "#818cf8", "⑦ 结果喂回线程", "然后回到 ①", title_fill="#312e81")
    )
    # from handler and from tool row
    b.append(path("M 1080 926 L 1080 1003 L 920 1003", "#2563eb", marker="arrow-blue"))
    b.append(path("M 1240 894 L 1240 948 L 920 948 L 920 968", "#6b7280", dash="4,3"))

    # left rail back to budget
    b.append(
        path(
            "M 560 1003 L 64 1003 L 64 264 L 80 264",
            "#7c3aed",
            sw=1.8,
            marker="arrow-purple",
        )
    )
    b.append(t(76, 980, "下一轮", size=12, fill="#7c3aed", weight=600, anchor="start"))

    # notes inside loop bottom
    b.append(rect(80, 1070, 1568, 88, "#ffffff", "#e5e7eb", rx=8))
    notes = [
        (200, "计划工具走内部状态，不进沙箱"),
        (630, "spawn 立刻返回，await 才阻塞父循环"),
        (1080, "yield 窗口内结束 = 一次普通结果"),
        (1480, "MCP 对上是普通 function tool"),
    ]
    b.append(t(96, 1096, "分流时不要混层", size=13, fill="#111827", anchor="start", weight=600))
    for x, s in notes:
        b.append(t(x, 1128, s, size=12, fill="#4b5563"))

    # legend
    b.append(t(80, 1190, "图例", size=13, fill="#111827", anchor="start", weight=600))
    legend = [
        (80, 1210, "#2563eb", "arrow-blue", None, "主路径"),
        (250, 1210, "#16a34a", "arrow-green", None, "成功收尾 / 落盘"),
        (490, 1210, "#dc2626", "arrow-red", "5,3", "模型调用失败"),
        (730, 1210, "#7c3aed", "arrow-purple", None, "循环反馈"),
        (950, 1210, "#ea580c", "arrow-orange", "4,3", "落地才走的管线"),
        (1210, 1210, "#6b7280", "arrow-gray", "5,3", "拒绝仍 continue"),
    ]
    for x, y, color, mk, dash, label in legend:
        b.append(path(f"M {x} {y} L {x + 36} {y}", color, sw=1.6, dash=dash, marker=mk))
        b.append(t(x + 44, y + 4, label, size=12, fill="#4b5563", anchor="start"))

    b.append(t(80, 1254, "用户中止与 abort 同类：停当前 turn，不重试，session 还在。", size=12, fill="#6b7280", anchor="start"))
    b.append(t(80, 1276, "生产里命令先在当前沙箱试跑，需要提权且策略允许再问人、批准后重跑。", size=12, fill="#6b7280", anchor="start"))

    # outside footer
    b.append(rect(48, 1332, 800, 88, "#fffbeb", "#fcd34d", rx=10))
    b.append(t(68, 1360, "循环外 · 调度器", size=14, fill="#92400e", anchor="start", weight=700))
    b.append(t(68, 1384, "到期只入队。cron 交白纸线程，heartbeat 追加旧线程。", size=13, fill="#78350f", anchor="start"))
    b.append(t(68, 1404, "循环不看表。CLI 通常只有无头入口。", size=13, fill="#78350f", anchor="start"))

    b.append(rect(872, 1332, 800, 88, "#f5f3ff", "#c4b5fd", rx=10))
    b.append(t(892, 1360, "循环外 · 客户端事件流", size=14, fill="#5b21b6", anchor="start", weight=700))
    b.append(t(892, 1384, "ExecBegin / Delta / End 只刷 TUI。", size=13, fill="#6b21a8", anchor="start"))
    b.append(t(892, 1404, "不自动灌进模型上下文，空闲退出也不自动再开一轮。", size=13, fill="#6b21a8", anchor="start"))

    write_svg("agent-loop-panorama.svg", W, H, b)


def seams() -> None:
    W, H = 1280, 720
    b: list[str] = []
    b.append(t(640, 36, "三道接缝：机制挂在循环上，不改循环", size=22, weight=700))
    b.append(t(640, 60, "加能力先问属于哪一层。挂错层就会去改 for (;;) 或把策略写进提示词。", size=13, fill="#6b7280"))

    # outer loop
    b.append(rect(40, 84, 1200, 560, "#eff6ff", "#1e40af", sw=2.5, rx=14))
    b.append(t(60, 112, "Agent Loop（最外层运行时）", size=16, fill="#1e3a8f", anchor="start", weight=700))
    b.append(t(60, 134, "结构信号：有 function_call 则派发，没有则收尾", size=13, fill="#3b82f6", anchor="start"))

    # model wrap
    b.append(rect(64, 152, 1152, 460, "#f0fdf4", "#16a34a", sw=2, rx=12))
    b.append(t(84, 178, "模型调用外套", size=15, fill="#166534", anchor="start", weight=700))
    wraps = [
        (84, "compact", "超预算则摘要替换旧历史"),
        (430, "recovery", "失败分类后再试或停"),
        (776, "rollout", "item 立刻追加进 JSONL"),
    ]
    for x, title, sub in wraps:
        b.extend(card(x, 192, 320, 56, "#ffffff", "#86efac", title, sub, title_fill="#14532d"))

    # dispatch wrap
    b.append(rect(88, 268, 1104, 316, "#fff7ed", "#ea580c", sw=2, rx=12))
    b.append(t(108, 294, "dispatch 外套", size=15, fill="#9a3412", anchor="start", weight=700))
    b.extend(card(108, 308, 500, 56, "#ffffff", "#fdba74", "审批 approval_policy", "要不要问人 · 拒绝即错误 item"))
    b.extend(card(640, 308, 516, 56, "#ffffff", "#d8b4fe", "沙箱 sandbox_mode", "碰得到什么 · 内核强制"))

    # registry
    b.append(rect(112, 384, 1056, 172, "#111827", "#111827", sw=2, rx=12))
    b.append(t(132, 412, "注册表内侧 · 按名字分发", size=15, fill="#93c5fd", anchor="start", weight=700))
    tools = [
        (132, "shell / patch"),
        (340, "update_plan"),
        (548, "load_skill"),
        (756, "spawn / task"),
        (964, "mcp__*"),
    ]
    for x, name in tools:
        b.append(rect(x, 432, 188, 44, "#1f2937", "#374151", rx=8))
        b.append(t(x + 94, 460, name, size=13, fill="#e5e7eb", weight=600))
    b.append(t(640, 502, "查不到名字：返回错误字符串，不崩溃。循环这一行永远是 dispatch。", size=13, fill="#9ca3af"))

    b.append(t(640, 668, "一次落地：外套包住调用 → 循环看见结构信号 → 外套包住分发 → 注册表执行。", size=13, fill="#6b7280"))
    write_svg("harness-seams.svg", W, H, b)


def trust() -> None:
    W, H = 1280, 760
    b: list[str] = []
    b.append(t(640, 36, "信任边界：审批与沙箱正交", size=22, weight=700))
    b.append(t(640, 60, "一问「要不要问人」，一问「碰得到什么」。焊成一道闸会同时失去两种调节能力。", size=13, fill="#6b7280"))

    # two columns
    b.append(rect(40, 88, 580, 400, "#fff7ed", "#fdba74", rx=12, sw=1.8))
    b.append(t(330, 118, "审批 · 问不问", size=18, fill="#9a3412", weight=700))
    modes = [
        ("never", "从不问", "无人值守常用"),
        ("on-failure", "先跑，失败再问", "失败常是沙箱拦住"),
        ("on-request", "只拦危险动作", "屋里 rm 仍要问"),
        ("untrusted", "非纯读都拦", "最多疑"),
    ]
    for i, (k, title, sub) in enumerate(modes):
        y = 140 + i * 80
        b.append(rect(64, y, 532, 68, "#ffffff", "#fed7aa", rx=8))
        b.append(t(84, y + 30, k, size=14, fill="#c2410c", anchor="start", weight=700))
        b.append(t(250, y + 28, title, size=14, fill="#111827", anchor="start", weight=600))
        b.append(t(250, y + 50, sub, size=12, fill="#6b7280", anchor="start"))

    b.append(rect(660, 88, 580, 400, "#faf5ff", "#d8b4fe", rx=12, sw=1.8))
    b.append(t(950, 118, "沙箱 · 碰得到什么", size=18, fill="#6b21a8", weight=700))
    sm = [
        ("read-only", "一切写入拒绝", "评审、只读问答"),
        ("workspace-write", "可写根 = 启动目录", "日常开发默认档"),
        ("danger-full-access", "关掉笼子", "一次性容器里才用"),
    ]
    for i, (k, title, sub) in enumerate(sm):
        y = 156 + i * 100
        b.append(rect(684, y, 532, 84, "#ffffff", "#e9d5ff", rx=8))
        b.append(t(704, y + 34, k, size=14, fill="#7c3aed", anchor="start", weight=700))
        b.append(t(704, y + 58, f"{title}  ·  {sub}", size=13, fill="#4b5563", anchor="start"))

    # bottom callouts
    b.append(rect(40, 512, 380, 120, "#fef2f2", "#fca5a5", rx=10))
    b.append(t(230, 546, "屋里的危险", size=15, fill="#991b1b", weight=700))
    b.append(t(230, 572, "路径仍在可写根里，", size=13, fill="#7f1d1d"))
    b.append(t(230, 594, "沙箱拦不住 rm -rf 。靠审批。", size=13, fill="#7f1d1d"))

    b.append(rect(450, 512, 380, 120, "#eff6ff", "#93c5fd", rx=10))
    b.append(t(640, 546, "出界", size=15, fill="#1e3a8f", weight=700))
    b.append(t(640, 572, "不靠人一条条点路径。", size=13, fill="#1e40af"))
    b.append(t(640, 594, "硬边界来自内核，不是字符串。", size=13, fill="#1e40af"))

    b.append(rect(860, 512, 380, 120, "#f0fdf4", "#86efac", rx=10))
    b.append(t(1050, 546, "拒绝是数据", size=15, fill="#166534", weight=700))
    b.append(t(1050, 572, "错误 item 喂回模型，", size=13, fill="#14532d"))
    b.append(t(1050, 594, "循环 continue，turn 不崩。", size=13, fill="#14532d"))

    b.append(t(640, 666, "生产顺序：先在当前沙箱试跑 → 需要提权且策略允许再问人 → 批准后提权重跑。", size=13, fill="#6b7280"))
    b.append(t(640, 690, "分类由 harness 做。模型可以提议任何事，能不能执行由策略说了算。", size=13, fill="#6b7280"))
    write_svg("trust-axes.svg", W, H, b)


def attention() -> None:
    W, H = 1280, 700
    b: list[str] = []
    b.append(t(640, 36, "注意力预算：四种挤占，四条路径", size=22, weight=700))
    b.append(t(640, 60, "不要用「更大的系统提示」同时解决计划、支线、规范和历史膨胀。", size=13, fill="#6b7280"))

    cols = [
        (40, "#eff6ff", "#93c5fd", "#1e3a8f", "常驻", "每轮都带，必须短", ["内置 base", "AGENTS.md", "技能目录 name+desc", "config 不进 prompt"]),
        (350, "#f0fdf4", "#86efac", "#166534", "按需", "用到才付 token", ["load_skill 正文", "工具结果", "MCP 返回", "进历史，随对话携带"]),
        (660, "#fff7ed", "#fdba74", "#9a3412", "有损压缩", "换窗口，提前压", ["切在最后一条 user 前", "保住目标 / 文件 / 未完成", "总结本身也要额度", "爆了再压会发不出请求"]),
        (970, "#faf5ff", "#d8b4fe", "#6b21a8", "持久化", "不占窗口", ["JSONL write-through", "resume = replay", "fork = 复制新 id", "精确，和摘要互补"]),
    ]
    for x, fill, stroke, accent, title, sub, items in cols:
        b.append(rect(x, 88, 270, 480, fill, stroke, sw=1.8, rx=12))
        b.append(t(x + 135, 120, title, size=18, fill=accent, weight=700))
        b.append(t(x + 135, 146, sub, size=12, fill="#4b5563"))
        for i, item in enumerate(items):
            iy = 180 + i * 88
            b.append(rect(x + 18, iy, 234, 72, "#ffffff", stroke, rx=8))
            b.append(t(x + 135, iy + 42, item, size=13, fill="#111827"))

    b.append(t(640, 604, "计划工具只换能见度：harness 看得见步骤，拦不住跳步。强制顺序是另一层拒绝权。", size=13, fill="#6b7280"))
    b.append(t(640, 628, "子循环丢掉的是对话历史，不是文件系统副作用。主线只应看到一条结论。", size=13, fill="#6b7280"))
    b.append(t(640, 668, "常驻层保持短；贵的知识按需进历史；长会话在硬上限之前腾地方；磁盘上保留精确日志。", size=13, fill="#374151", weight=600))
    write_svg("attention-budget.svg", W, H, b)


def multi() -> None:
    W, H = 1280, 780
    b: list[str] = []
    b.append(t(640, 36, "多执行者：四层边界不要画进同一个框", size=22, weight=700))
    b.append(t(640, 60, "共享的是信息、规则和地盘，不是窗口。产品能力与教程加强分开标注。", size=13, fill="#6b7280"))

    layers = [
        (88, "#eff6ff", "#60a5fa", "1  注意力 / 窗口", "Codex 有", "同一循环 + 新 input + 收窄工具。await 子循环只回结论；spawn 立刻返回，信箱传信息。"),
        (228, "#f0fdf4", "#4ade80", "2  通信 / 信箱", "Codex 有", "进程内队列 + 唤醒。send 默认不新开一轮；终态由 harness 投给父。UI 事件不是这层。"),
        (368, "#fff7ed", "#fb923c", "3  规则 / 拒绝权", "教程加强", "依赖未完成则不许认领；并发派活才需要 replyTo 账本；工人自领必须原子 claim。"),
        (508, "#faf5ff", "#c084fc", "4  地盘 / 目录", "本机 worktree", "session 启动时定 cwd，模型无创建工具。冲突推迟到交回。Cloud 容器是另一条隔离轴。"),
    ]
    for y, fill, stroke, title, tag, body in layers:
        b.append(rect(40, y, 1200, 120, fill, stroke, sw=1.8, rx=12))
        b.append(t(64, y + 36, title, size=18, fill="#111827", anchor="start", weight=700))
        # tag
        tw = 96 if tag == "Codex 有" else (108 if tag == "教程加强" else 132)
        tag_fill = "#dcfce7" if "Codex" in tag else ("#ffedd5" if "教程" in tag else "#ede9fe")
        tag_text = "#166534" if "Codex" in tag else ("#9a3412" if "教程" in tag else "#6b21a8")
        b.append(rect(64, y + 52, tw, 24, tag_fill, "none", rx=4, sw=0))
        b.append(t(64 + tw / 2, y + 69, tag, size=12, fill=tag_text, weight=600))
        b.append(t(64, y + 100, body, size=14, fill="#374151", anchor="start"))

    b.append(t(640, 660, "能见度（计划清单）≠ 拒绝权（认领检查）。信箱传的是说出来的字，不是对方的上下文。", size=13, fill="#6b7280"))
    b.append(t(640, 684, "worktree 共享 .git；sandbox 锁当前 cwd；Cloud 才是整台可丢弃环境。", size=13, fill="#6b7280"))
    b.append(t(640, 724, "验收：主线看不到支线中间过程；过境必须显式发送；并行写入 disjoint；冲突在交回时可见。", size=13, fill="#374151", weight=600))
    write_svg("multi-agent-boundaries.svg", W, H, b)


if __name__ == "__main__":
    panorama()
    seams()
    trust()
    attention()
    multi()
