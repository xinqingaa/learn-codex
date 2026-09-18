#!/usr/bin/env python3
"""生成 harness-engineering.md 的全部配图（SVG，中文标签）。

运行： python3 _gen.py
"""
from pathlib import Path

OUT = Path(__file__).parent

FONT = "'PingFang SC','Hiragino Sans GB','Heiti SC','Microsoft YaHei',sans-serif"
MONO = "'SF Mono','Menlo','Consolas',monospace"

# 调色板
INK = "#0f172a"
MUTED = "#64748b"
LINE = "#94a3b8"

PALETTE = {
    "core":  ("#eff6ff", "#2563eb", "#1e3a8a"),   # 循环内核 蓝
    "gate":  ("#fef2f2", "#dc2626", "#7f1d1d"),   # 门/拒绝 红
    "attn":  ("#fffbeb", "#d97706", "#78350f"),   # 注意力 琥珀
    "ok":    ("#ecfdf5", "#059669", "#064e3b"),   # 放行/成功 绿
    "out":   ("#f8fafc", "#94a3b8", "#475569"),   # 循环之外 灰
    "tool":  ("#f5f3ff", "#7c3aed", "#4c1d95"),   # 能力 紫
    "store": ("#f0fdfa", "#0d9488", "#134e4a"),   # 存储 青
}


def esc(s):
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def header(w, h, title=None, subtitle=None):
    s = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" '
        f'viewBox="0 0 {w} {h}" font-family="{FONT}">',
        f'<rect width="{w}" height="{h}" fill="#ffffff"/>',
        '<defs>',
        '<marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" '
        f'markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="{LINE}"/></marker>',
        '<marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" '
        'markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#dc2626"/></marker>',
        '<marker id="ag" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" '
        'markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#059669"/></marker>',
        '</defs>',
    ]
    if title:
        s.append(txt(36, 40, title, 21, INK, weight="600"))
    if subtitle:
        s.append(txt(36, 66, subtitle, 13, MUTED))
    return s


def txt(x, y, s, size=13, fill=INK, anchor="start", weight="400", mono=False, opacity=None):
    f = f' font-family="{MONO}"' if mono else ""
    o = f' opacity="{opacity}"' if opacity else ""
    return (f'<text x="{x}" y="{y}" font-size="{size}" fill="{fill}" '
            f'text-anchor="{anchor}" font-weight="{weight}"{f}{o}>{esc(s)}</text>')


def box(x, y, w, h, style="core", rx=8, dashed=False, fill=None, stroke=None, sw=1.6):
    bg, st, _ = PALETTE[style]
    d = ' stroke-dasharray="6 4"' if dashed else ""
    return (f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" '
            f'fill="{fill or bg}" stroke="{stroke or st}" stroke-width="{sw}"{d}/>')


def labelled_box(x, y, w, h, title, lines=(), style="core", dashed=False,
                 title_size=14, line_size=11.5, rx=8, align="center"):
    bg, st, tc = PALETTE[style]
    out = [box(x, y, w, h, style, rx=rx, dashed=dashed)]
    n = 1 + len(lines)
    total = title_size + 2 + len(lines) * (line_size + 4)
    top = y + (h - total) / 2 + title_size
    if align == "center":
        cx, anchor = x + w / 2, "middle"
    else:
        cx, anchor = x + 12, "start"
    out.append(txt(cx, top, title, title_size, tc, anchor=anchor, weight="600"))
    yy = top
    for ln in lines:
        yy += line_size + 4
        out.append(txt(cx, yy, ln, line_size, MUTED, anchor=anchor))
    return out


def arrow(x1, y1, x2, y2, color=None, marker="a", dashed=False, sw=1.5):
    d = ' stroke-dasharray="5 4"' if dashed else ""
    return (f'<path d="M{x1},{y1} L{x2},{y2}" fill="none" stroke="{color or LINE}" '
            f'stroke-width="{sw}" marker-end="url(#{marker})"{d}/>')


def poly(points, color=None, marker="a", dashed=False, sw=1.5):
    d = ' stroke-dasharray="5 4"' if dashed else ""
    p = " ".join(f"{x},{y}" for x, y in points)
    return (f'<polyline points="{p}" fill="none" stroke="{color or LINE}" '
            f'stroke-width="{sw}" marker-end="url(#{marker})"{d}/>')


def write(name, parts):
    parts.append("</svg>")
    (OUT / name).write_text("\n".join(parts) + "\n", encoding="utf-8")
    print("wrote", name)


def icon(name, cx, cy, r, color, sw=1.8):
    """极简线条图标，居中在 (cx,cy)，外接半径约 r。不依赖字体/emoji，跨平台一致。"""
    import math
    o = []
    ln = lambda x1, y1, x2, y2, w=sw, cap="round": o.append(
        f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" '
        f'stroke="{color}" stroke-width="{w}" stroke-linecap="{cap}"/>')
    circ = lambda x, y, rr, fill="none", w=sw: o.append(
        f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{rr:.1f}" fill="{fill}" stroke="{color}" '
        f'stroke-width="{w}"/>' if fill == "none" else
        f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{rr:.1f}" fill="{color}"/>')
    if name == "eye":  # 感知
        o.append(f'<ellipse cx="{cx}" cy="{cy}" rx="{r}" ry="{r*0.58}" fill="none" '
                  f'stroke="{color}" stroke-width="{sw}"/>')
        circ(cx, cy, r * 0.3, fill=color)
    elif name == "wrench":  # 行动/工具
        ln(cx - r * 0.7, cy + r * 0.7, cx + r * 0.35, cy - r * 0.35, w=sw * 1.8)
        circ(cx - r * 0.75, cy + r * 0.75, r * 0.32)
        circ(cx + r * 0.55, cy - r * 0.55, r * 0.3)
    elif name == "gear":  # 执行/循环
        circ(cx, cy, r * 0.52)
        for i in range(8):
            a = i * math.pi / 4
            ln(cx + math.cos(a) * r * 0.56, cy + math.sin(a) * r * 0.56,
               cx + math.cos(a) * r * 0.95, cy + math.sin(a) * r * 0.95, w=sw * 1.3)
    elif name == "shield":  # 验证
        o.append(f'<path d="M{cx},{cy-r} L{cx+r*0.82},{cy-r*0.5} L{cx+r*0.82},{cy+r*0.15} '
                  f'Q{cx+r*0.82},{cy+r*0.85} {cx},{cy+r} Q{cx-r*0.82},{cy+r*0.85} '
                  f'{cx-r*0.82},{cy+r*0.15} L{cx-r*0.82},{cy-r*0.5} Z" fill="none" '
                  f'stroke="{color}" stroke-width="{sw}" stroke-linejoin="round"/>')
        o.append(f'<path d="M{cx-r*0.34},{cy} L{cx-r*0.04},{cy+r*0.3} L{cx+r*0.4},{cy-r*0.28}" '
                  f'fill="none" stroke="{color}" stroke-width="{sw*1.2}" stroke-linecap="round" '
                  f'stroke-linejoin="round"/>')
    elif name == "lock":  # 约束
        o.append(f'<rect x="{cx-r*0.62}" y="{cy-r*0.05}" width="{r*1.24}" height="{r*0.85}" '
                  f'rx="3" fill="none" stroke="{color}" stroke-width="{sw}"/>')
        o.append(f'<path d="M{cx-r*0.34},{cy-r*0.05} L{cx-r*0.34},{cy-r*0.4} '
                  f'Q{cx-r*0.34},{cy-r*0.8} {cx},{cy-r*0.8} Q{cx+r*0.34},{cy-r*0.8} '
                  f'{cx+r*0.34},{cy-r*0.4} L{cx+r*0.34},{cy-r*0.05}" fill="none" '
                  f'stroke="{color}" stroke-width="{sw}"/>')
        circ(cx, cy + r * 0.32, r * 0.09, fill=color)
    elif name == "mailbox":  # 信箱/消息隔离
        o.append(f'<rect x="{cx-r*0.7}" y="{cy-r*0.2}" width="{r*1.4}" height="{r*0.85}" '
                  f'rx="2" fill="none" stroke="{color}" stroke-width="{sw}"/>')
        o.append(f'<path d="M{cx-r*0.7},{cy-r*0.2} Q{cx},{cy-r*0.85} {cx+r*0.7},{cy-r*0.2}" '
                  f'fill="none" stroke="{color}" stroke-width="{sw}"/>')
        circ(cx + r * 0.85, cy - r * 0.02, r * 0.09, fill=color)
    elif name == "layers":  # 分层
        for dy in (-0.36, 0, 0.36):
            o.append(f'<rect x="{cx-r*0.72}" y="{cy+r*dy-r*0.14}" width="{r*1.44}" '
                      f'height="{r*0.28}" rx="2" fill="none" stroke="{color}" stroke-width="{sw}"/>')
    elif name == "compress":  # 压缩
        for dx, dy in ((-1, -1), (1, -1), (-1, 1), (1, 1)):
            ln(cx + dx * r * 0.85, cy + dy * r * 0.5, cx + dx * r * 0.22, cy + dy * r * 0.12)
    elif name == "branch":  # 分叉/独立执行
        circ(cx - r * 0.5, cy - r * 0.55, r * 0.15, fill=color)
        circ(cx - r * 0.5, cy + r * 0.55, r * 0.15, fill=color)
        circ(cx + r * 0.5, cy - r * 0.05, r * 0.15, fill=color)
        ln(cx - r * 0.5, cy - r * 0.42, cx - r * 0.5, cy + r * 0.42)
        o.append(f'<path d="M{cx-r*0.5},{cy-r*0.05} Q{cx-r*0.1},{cy-r*0.05} '
                  f'{cx+r*0.5},{cy-r*0.05}" fill="none" stroke="{color}" stroke-width="{sw}"/>')
    elif name == "id":  # id / 并发对账
        for dx in (-0.28, 0.06):
            ln(cx + dx * r, cy - r * 0.8, cx + dx * r - r * 0.16, cy + r * 0.8, w=sw * 1.3)
        for dx in (-0.06, 0.28):
            ln(cx + dx * r, cy - r * 0.8, cx + dx * r + r * 0.16, cy + r * 0.8, w=sw * 1.3)
    elif name == "folder":  # 工作目录/地盘
        o.append(f'<path d="M{cx-r*0.85},{cy+r*0.6} L{cx-r*0.85},{cy-r*0.35} '
                  f'L{cx-r*0.2},{cy-r*0.35} L{cx},{cy-r*0.1} L{cx+r*0.85},{cy-r*0.1} '
                  f'L{cx+r*0.85},{cy+r*0.6} Z" fill="none" stroke="{color}" '
                  f'stroke-width="{sw}" stroke-linejoin="round"/>')
    elif name == "cycle":  # 闭环箭头
        o.append(f'<path d="M{cx-r*0.75},{cy} A{r*0.75},{r*0.75} 0 1 1 {cx+r*0.2},{cy+r*0.72}" '
                  f'fill="none" stroke="{color}" stroke-width="{sw*1.3}"/>')
        a2 = math.atan2(r * 0.72, r * 0.2) if False else 0.9
        tx, ty = cx + r * 0.2, cy + r * 0.72
        o.append(f'<path d="M{tx-r*0.28},{ty-r*0.05} L{tx+r*0.05},{ty+r*0.28} '
                  f'L{tx+r*0.32},{ty-r*0.1} Z" fill="{color}"/>')
    elif name == "box3d":  # 共享资源/仓库
        o.append(f'<path d="M{cx-r*0.8},{cy-r*0.3} L{cx},{cy-r*0.75} L{cx+r*0.8},{cy-r*0.3} '
                  f'L{cx+r*0.8},{cy*0+cy+r*0.45} L{cx},{cy+r*0.9} L{cx-r*0.8},{cy+r*0.45} Z" '
                  f'fill="none" stroke="{color}" stroke-width="{sw}" stroke-linejoin="round"/>')
        ln(cx - r * 0.8, cy - r * 0.3, cx, cy + r * 0.15)
        ln(cx + r * 0.8, cy - r * 0.3, cx, cy + r * 0.15)
        ln(cx, cy + r * 0.15, cx, cy + r * 0.9)
    return o


# ---------------------------------------------------------------- 0 五个环节
def five_elements():
    W, H = 1150, 360
    s = header(W, H, "一个动作生命周期里的五个环节",
               "agent = model + harness；model 只负责生成决定，剩下的感知、行动、执行、验证、约束全部是 harness 的工作")

    stages = [
        ("感知", "context", "eye", "这一轮该看见什么", "core"),
        ("行动", "tools", "wrench", "意图如何变成可判定的请求", "tool"),
        ("执行", "恢复", "gear", "请求如何在会失败的现实里跑完", "store"),
        ("验证", "判断力", "shield", "这个动作该不该发生", "attn"),
        ("约束", "硬边界", "lock", "验证出错时损失被限制在哪", "gate"),
    ]
    bw, gap = 190, 30
    x0 = (W - (bw * 5 + gap * 4)) / 2
    top = 106
    for i, (stage, mech, ic, q, st) in enumerate(stages):
        x = x0 + i * (bw + gap)
        bg, stc, tc = PALETTE[st]
        s.append(box(x, top, bw, 176, st, rx=10))
        s += icon(ic, x + bw / 2, top + 34, 18, stc)
        s.append(txt(x + bw / 2, top + 74, stage, 21, tc, anchor="middle", weight="700"))
        s.append(txt(x + bw / 2, top + 98, mech, 13, tc, anchor="middle", weight="600"))
        s.append(f'<line x1="{x+24}" y1="{top+112}" x2="{x+bw-24}" y2="{top+112}" '
                  f'stroke="{stc}" stroke-width="1" opacity="0.35"/>')
        mid = len(q) // 2
        l1, l2 = q[:mid], q[mid:]
        s.append(txt(x + bw / 2, top + 134, l1, 11.5, MUTED, anchor="middle"))
        s.append(txt(x + bw / 2, top + 152, l2, 11.5, MUTED, anchor="middle"))
        s.append(txt(x + bw / 2, top + 170 - 4, f"第{'一二三四五'[i]}部分", 11.5, tc,
                     anchor="middle", weight="600"))
        if i > 0:
            px = x0 + (i - 1) * (bw + gap) + bw
            s.append(arrow(px + 4, top + 34, x - 4, top + 34, sw=2))
    # 闭环：从最后一环画一条弧线绕回第一环，强调这是循环不是流水线终点
    loop_y = top + 176 + 34
    s.append(poly([(x0 + 4 * (bw + gap) + bw / 2, top + 176), (x0 + 4 * (bw + gap) + bw / 2, loop_y),
                   (x0 + bw / 2, loop_y), (x0 + bw / 2, top + 176 + 4)],
                  color="#94a3b8", dashed=True, sw=1.6))
    s.append(txt((x0 + bw / 2 + x0 + 4 * (bw + gap) + bw / 2) / 2, loop_y + 18,
                 "约束验证之后，回到下一轮的感知——五环首尾相接，不是一条走到头的流水线",
                 12, MUTED, anchor="middle"))
    write("five-elements.svg", s)


# ---------------------------------------------------------------- 1 全景图
def panorama():
    W, H = 1160, 950
    s = header(W, H, "Agent Loop 运行时全景",
               "所有机制只挂在三个位置上：模型调用外套、分发外套、注册表内侧；虚线框完全在循环之外")

    # 入口
    ent = ["人敲一句话", "定时器 · 开新线程", "定时器 · 续旧线程", "上游派生的干净输入", "远程前端驱动"]
    ex = [40, 266, 492, 718, 944]
    for x, t in zip(ex, ent):
        s += labelled_box(x, 92, 176, 40, t, style="out", dashed=True, title_size=12.5)
        s.append(arrow(x + 88, 132, x + 88, 172))
    s.append(txt(W - 40, 84, "入口：循环不关心自己被谁叫醒", 12, MUTED, anchor="end"))

    # 循环容器
    s.append(box(40, 172, 1080, 614, "core", rx=14, dashed=False, fill="#fdfeff",
                 stroke="#2563eb", sw=2.2))
    s.append(txt(60, 198, "Agent Loop", 15, "#1e3a8a", weight="700"))
    s.append(txt(60, 216, "状态源：一条只增不改的输入序列", 11.5, MUTED))

    # 左列主流程
    col_x, col_w = 90, 268
    steps = [
        (238, "① 预算闸门", ["估当前 token 余量", "逼近上限 → 先压缩历史"], "attn"),
        (318, "② 组装指令", ["内置 base + 逐层项目约定", "配置项不进这段文本"], "core"),
        (398, "③ 调用模型", ["外套：错误分类与退避", "限流／超长／中止各走一条"], "core"),
        (478, "④ 追加 + 落盘", ["整段原样追加", "逐项写只追加日志"], "store"),
        (558, "⑤ 有工具调用吗", ["唯一分支判据", "只看结构，不读语义"], "core"),
    ]
    for y, t, ls, st in steps:
        s += labelled_box(col_x, y, col_w, 62, t, ls, style=st, title_size=13.5)
    for i in range(len(steps) - 1):
        y = steps[i][0] + 62
        s.append(arrow(col_x + col_w / 2, y, col_x + col_w / 2, steps[i + 1][0] - 4))

    # 收尾
    s += labelled_box(col_x, 668, col_w, 48, "收尾退出", ["抽出最终文本；会话留在磁盘上"], style="ok",
                      title_size=13)
    s.append(arrow(col_x + col_w / 2, 620, col_x + col_w / 2, 664, color="#059669", marker="ag"))
    s.append(txt(col_x + col_w / 2 + 10, 646, "无", 12, "#059669", weight="600"))

    # 分发
    s += labelled_box(400, 558, 168, 62, "分发", ["按名字查表", "不判断能不能做"], style="tool",
                      title_size=13.5)
    s.append(arrow(358, 589, 396, 589, color="#7c3aed"))
    s.append(txt(374, 580, "有", 12, "#7c3aed", weight="600"))

    # 五条通道
    lanes = [
        (262, "内部状态工具（计划）", "只改 harness 状态，直接返回", "core"),
        (322, "派生子循环", "干净上下文，只回收一条结论", "tool"),
        (382, "慢命令", "yield 窗口 → 句柄 → 后续收割", "tool"),
        (442, "协议桥", "翻回原始工具名，打给外部进程", "tool"),
        (502, "会落地的动作", "命令／补丁 → 必须先过判定链", "gate"),
    ]
    lx, lw = 600, 452
    bus_x = lx - 24
    ys = [y + 23 for y, *_ in lanes] + [589]
    s.append(f'<line x1="{bus_x}" y1="{min(ys)}" x2="{bus_x}" y2="{max(ys)}" '
              f'stroke="{LINE}" stroke-width="1.6"/>')
    s.append(f'<line x1="568" y1="589" x2="{bus_x}" y2="589" stroke="{LINE}" stroke-width="1.6"/>')
    for y, t, sub, st in lanes:
        s += labelled_box(lx, y, lw, 46, t, [sub], style=st, title_size=12.5, line_size=11,
                          align="left")
        s.append(arrow(bus_x, y + 23, lx - 4, y + 23, sw=1.6))

    # 判定链
    s.append(box(lx, 560, lw, 96, "gate", rx=8))
    s.append(txt(lx + 14, 582, "判定链（按固定顺序）", 13, "#7f1d1d", weight="600"))
    s.append(txt(lx + 14, 604, "钩子信任 → 能力开关 → 总旁路 → 沙箱 → 审批与项目信任", 11.5, MUTED))
    s.append(txt(lx + 14, 624, "末尾两枚保险丝只能把「放行」扳回「询问」，不能反向放松", 11.5, MUTED))
    s.append(txt(lx + 14, 645, "输出三值：放行 / 询问 / 拒绝", 12, "#7f1d1d", weight="600"))
    s.append(arrow(lx + lw / 2, 548, lx + lw / 2, 556, color="#dc2626", marker="ar"))

    # 结果回写
    s += labelled_box(400, 700, 652, 56, "结果回写：成功、拒绝、越界、超时、找不到工具，全写成一条工具结果",
                      ["失败不是异常出口，是数据 · 只有用户主动中止是一等出口"],
                      style="store", title_size=13, align="left")
    s.append(arrow(lx + lw / 2, 656, lx + lw / 2, 696, color="#0d9488"))
    for y, *_ in lanes[:4]:
        s.append(poly([(lx + lw, y + 23), (1084, y + 23), (1084, 728), (1056, 728)],
                      color=LINE))

    # 回到开头
    s.append(poly([(400, 728), (62, 728), (62, 269), (86, 269)], color="#2563eb", sw=1.8))
    s.append(txt(70, 750, "回到开头", 12, "#2563eb", weight="600"))

    # 循环之外
    s.append(box(40, 816, 1080, 104, "out", rx=12, dashed=True))
    s.append(txt(60, 842, "循环之外", 14, "#475569", weight="700"))
    outs = [
        ("调度器", "到期入队，从不亲自执行"),
        ("配置解析", "决定这次调用的参数取值"),
        ("会话日志", "比进程长寿，生命周期靠文件操作"),
        ("前端与传输", "同一引擎，多个入口"),
    ]
    for i, (t, sub) in enumerate(outs):
        x = 180 + i * 236
        s.append(txt(x, 864, t, 13, "#475569", weight="600"))
        s.append(txt(x, 884, sub, 11.5, MUTED))
    write("panorama.svg", s)


# ---------------------------------------------------------------- 2 工具注册表
def tool_registry():
    W, H = 1060, 560
    s = header(W, H, "同一张注册表，三种执行位置",
               "对模型来说它们长得一模一样；真正的差别是副作用落在哪、哪道门管得住它")

    s += labelled_box(40, 110, 236, 300, "模型看到的清单",
                      ["每个工具 = 一个名字", "+ 一份带类型的参数 schema", "",
                       "读文件 / 写文件 / 打补丁", "跑命令 / 联网搜索", "看图 / 生成图 / 驱动浏览器", "",
                       "形状完全一致"], style="core", title_size=14, line_size=12)
    s.append(arrow(280, 260, 320, 260))
    s += labelled_box(324, 190, 196, 140, "分发表",
                      ["按名字 → 处理函数", "查不到就返回错误", "", "只回答「调哪个」", "不回答「能不能」"],
                      style="tool", title_size=14, line_size=12)
    s.append(arrow(524, 260, 564, 260))

    rows = [
        (110, "本机执行", "跑命令、读写文件、读本地图片",
         "副作用落在你的文件系统与进程上", "完整走审批与沙箱", "tool"),
        (214, "服务端托管", "联网搜索、图片生成",
         "不消耗你机器上的任何东西", "无需逐次审批；风险在读进来的内容可能是恶意的", "ok"),
        (318, "驱动外部目标", "控制浏览器、控制桌面 GUI",
         "副作用落在被驱动的那个目标上", "文件沙箱完全管不到，需要独立的来源／权限策略", "gate"),
    ]
    for y, t, ex, where, policy, st in rows:
        bg, stc, tc = PALETTE[st]
        s.append(box(568, y, 452, 92, st, rx=8))
        s.append(txt(584, y + 24, t, 13.5, tc, weight="600"))
        s.append(txt(584, y + 44, ex, 11.5, MUTED))
        s.append(txt(584, y + 62, where, 11.5, MUTED))
        s.append(txt(584, y + 80, "策略： " + policy, 11.5, tc))
        s.append(poly([(542, 260), (556, 260), (556, y + 46), (564, y + 46)], color=LINE))

    s.append(txt(40, 452, "加一个工具的代价是常数：清单加一条 schema，分发表加一行。循环一动不动。", 13, INK))
    s.append(txt(40, 476, "加能力时要问的不是「这个工具好不好用」，而是「它的副作用落在哪、现有的哪道门管得住它」。",
                 13, INK))
    s.append(txt(40, 500, "管不住，就说明需要新开一条策略维度，而不是把它硬塞进已有的档位里。", 13, "#b45309"))
    s.append(txt(40, 528, "哪些工具被注册进表里，通常由启动时的一组特性开关决定——能力装配是配置驱动的，不是写死的。",
                 12, MUTED))
    write("tool-registry.svg", s)


# ---------------------------------------------------------------- 3 信任两轴
def trust_axes():
    W, H = 1040, 600
    s = header(W, H, "审批与沙箱是两道正交的门",
               "「要不要先问人」和「物理上碰得到什么」是两个问题；焊成一道闸会同时失去两种调节能力")

    ox, oy = 150, 460          # 原点
    aw, ah = 560, 340
    s.append(f'<line x1="{ox}" y1="{oy}" x2="{ox+aw}" y2="{oy}" stroke="{LINE}" stroke-width="1.6" marker-end="url(#a)"/>')
    s.append(f'<line x1="{ox}" y1="{oy}" x2="{ox}" y2="{oy-ah}" stroke="{LINE}" stroke-width="1.6" marker-end="url(#a)"/>')
    s.append(txt(ox + aw / 2, oy + 44, "审批：什么时候停下来问人", 13, INK, anchor="middle", weight="600"))
    s.append(f'<text transform="translate(66 {oy - ah / 2}) rotate(-90)" x="0" y="0" '
             f'font-size="13" fill="{INK}" text-anchor="middle" font-weight="600">'
             f'沙箱：笼子有多小</text>')

    for i, t in enumerate(["从不问", "危险才问", "按需问", "除只读都问"]):
        x = ox + 70 + i * 145
        s.append(txt(x, oy + 22, t, 12, MUTED, anchor="middle"))
        s.append(f'<line x1="{x}" y1="{oy-4}" x2="{x}" y2="{oy+4}" stroke="{LINE}"/>')
    for i, t in enumerate(["完全放开", "工作区可写", "只读"]):
        y = oy - 60 - i * 110
        s.append(txt(ox - 14, y + 4, t, 12, MUTED, anchor="end"))
        s.append(f'<line x1="{ox-4}" y1="{y}" x2="{ox+4}" y2="{y}" stroke="{LINE}"/>')

    zones = [
        (ox + 16, oy - 96, 220, 78, "gate", "无人监管的全权限",
         ["门都没关，人也不在", "只该在环境本身已隔离时用"]),
        (ox + 300, oy - 330, 244, 78, "gate", "事事确认 + 只读",
         ["安全但不可用", "第五十次弹窗时人会下意识回车"]),
        (ox + 150, oy - 212, 250, 82, "ok", "日常工作区",
         ["写在笼子里，危险动作问人", "两个旋钮各自可调"]),
    ]
    for x, y, w, h, st, t, ls in zones:
        s += labelled_box(x, y, w, h, t, ls, style=st, title_size=13, line_size=11.5)

    s += labelled_box(748, 108, 262, 132, "只做审批，不做沙箱",
                      ["批准 = 无限授权", "一个被批准的删除命令", "照样能清空磁盘", "",
                       "边界押在人的注意力上", "= 没有边界"], style="gate", title_size=13.5,
                      line_size=11.5)
    s += labelled_box(748, 256, 262, 132, "只做沙箱，不做审批",
                      ["笼内的危险动作全放行", "删掉整个构建目录、强制推送", "路径都在可写范围内", "",
                       "沙箱回答「能碰到哪」", "不回答「该不该碰」"], style="gate", title_size=13.5,
                      line_size=11.5)
    s += labelled_box(748, 404, 262, 96, "落地顺序",
                      ["先按沙箱档位关进笼子", "因权限不足而失败时", "才弹审批、批准后提权重跑", "",
                       "不是「区内审批、区外沙箱」"], style="core", title_size=13.5, line_size=11.5)
    s.append(txt(40, 552, "强制力一旦依赖「harness 记得去检查」，它就不是硬边界。真正的沙箱由操作系统内核执行。",
                 13, INK))
    write("trust-axes.svg", s)


# ---------------------------------------------------------------- 4 判定链
def safety_gates():
    W, H = 1180, 570
    s = header(W, H, "一个动作的安全判定链",
               "自治不是开关，是刻度盘；刻度盘的实现是一条有固定顺序的判定链，顺序本身比每道闸的内容更重要")

    s += labelled_box(30, 150, 100, 110, "一个动作", ["命令 / 补丁", "/ 外部调用"], style="core",
                      title_size=13, line_size=11)
    gates = [
        (144, "0", "钩子信任", ["配置里的代码", "先问可不可信"]),
        (308, "1", "能力开关", ["特性关着", "轮不到谈沙箱"]),
        (472, "2", "总旁路", ["设了就短路", "后面全部"]),
        (636, "3", "沙箱", ["物理边界，越界", "连问都不必问"]),
        (800, "4", "审批与信任", ["决定要不要", "升级给人"]),
    ]
    for x, n, t, subs in gates:
        st = "ok" if n == "2" else "gate"
        bg, stc, tc = PALETTE[st]
        s.append(box(x, 150, 150, 110, st, rx=8))
        s.append(txt(x + 14, 176, f"闸 {n}", 11.5, tc, weight="700"))
        s.append(txt(x + 14, 202, t, 14.5, tc, weight="600"))
        for i, sub in enumerate(subs):
            s.append(txt(x + 14, 226 + i * 18, sub, 11, MUTED))
    for i in range(len(gates) - 1):
        s.append(arrow(gates[i][0] + 150, 205, gates[i + 1][0] - 4, 205))
    s.append(arrow(130, 205, 140, 205))

    # 保险丝
    s.append(box(964, 150, 160, 110, "gate", rx=8))
    s.append(txt(978, 176, "保险丝", 14.5, "#7f1d1d", weight="700"))
    for i, sub in enumerate(["额外的独立复审层", "「这个项目不可信」", "这个事实", "",
                             "只能把放行扳回询问"]):
        s.append(txt(978, 198 + i * 15, sub, 10.5,
                     "#7f1d1d" if i == 4 else MUTED))
    s.append(arrow(950, 205, 960, 205))

    # 三种结局
    s += labelled_box(144, 340, 280, 70, "拒绝", ["连问都不必问"], style="gate", title_size=15)
    s += labelled_box(620, 340, 200, 70, "询问", ["升级给人"], style="attn", title_size=15)
    s += labelled_box(880, 340, 240, 70, "放行", ["直接执行"], style="ok", title_size=15)

    # 拒绝汇入
    s.append(arrow(219, 260, 219, 336, color="#dc2626", marker="ar"))
    s.append(txt(227, 300, "拒绝", 11.5, "#dc2626", weight="600"))
    s.append(poly([(383, 260), (383, 300), (300, 300), (300, 336)], color="#dc2626", marker="ar"))
    s.append(poly([(711, 260), (711, 312), (400, 312), (400, 336)], color="#dc2626", marker="ar"))

    # 总旁路短路
    s.append(poly([(547, 150), (547, 112), (1152, 112), (1152, 375), (1124, 375)],
                  color="#059669", marker="ag", dashed=True, sw=1.8))
    s.append(txt(600, 106, "显式的危险开关：设了直接放行，短路后面全部，语义干净", 12, "#059669"))

    # 保险丝 → 结局
    s.append(poly([(1044, 260), (1044, 296), (720, 296), (720, 336)], color=LINE))
    s.append(arrow(1000, 260, 1000, 336, color="#059669", marker="ag"))

    s.append(txt(40, 452, "顺序为什么关键：能力没开，根本轮不到谈沙箱；总旁路存在的意义就是短路，"
                 "所以必须排在被短路的东西前面；", 13, INK))
    s.append(txt(40, 476, "物理边界比「问不问人」更硬，越界的写连问都不必问；审批垫底，"
                 "决定一个本来能跑的动作要不要再升级给人。", 13, INK))
    s.append(txt(40, 510, "三值比两值好在哪：物理上越界和策略上需要确认，对用户是两种完全不同的信息——"
                 "前者说「这条路走不通，换个思路」，后者说「要不要让它这么干」。", 12.5, MUTED))
    s.append(txt(40, 536, "安全机制的叠加必须单调收紧。任何一个能放松其他机制的开关，都会让整条链的行为无法推理。",
                 12.5, "#b45309"))
    write("safety-gates.svg", s)


# ---------------------------------------------------------------- 5 注意力预算
def attention():
    W, H = 1120, 620
    s = header(W, H, "注意力预算的四条路径",
               "四件事看起来都是「上下文不够用」，但成本结构完全不同，所以不能用同一招去解")

    # 中心：共享的稀缺资源
    cx, cy = W / 2, 168
    s.append(f'<circle cx="{cx}" cy="{cy}" r="76" fill="#f8fafc" stroke="{LINE}" '
              f'stroke-width="2"/>')
    s += icon("compress", cx, cy - 22, 20, "#475569")
    s.append(txt(cx, cy + 14, "上下文窗口", 14.5, "#334155", anchor="middle", weight="700"))
    s.append(txt(cx, cy + 34, "容量有限、只读一次", 11, MUTED, anchor="middle"))

    cols = [
        ("计划只在模型脑子里", "外化计划", "layers",
         ("把步骤表整体交给 harness 持有", "同一时刻只有一步在进行中"),
         "换来能见度", "换不来约束力：照样能跳步", "attn"),
        ("支线淹没主线", "干净上下文", "branch",
         ("同一循环换一份全新输入", "工具表收窄，只有结论穿回主线"),
         "换来主线清洁度", "多烧一份 token；短任务纯亏", "tool"),
        ("规范每轮都在烧钱", "知识分层", "id",
         ("目录层常驻：名字+一句话", "正文层按名字查表、按需注入"),
         "把每轮必付变成用到才付", "正文进历史后仍一路携带", "core"),
        ("历史只增不减", "有损压缩", "gear",
         ("硬上限前把旧历史无工具总结", "切在最后一条用户消息之前"),
         "换来无上限的会话长度", "信息会丢；压多次就什么都不剩", "store"),
    ]
    n = len(cols)
    cw, gap = 244, 22
    x0 = (W - (cw * n + gap * (n - 1))) / 2
    top = 300
    for i, (sym, name, ic, how, gain, cost, st) in enumerate(cols):
        x = x0 + i * (cw + gap)
        bg, stc, tc = PALETTE[st]
        # 从中心资源引出的连接线（先各自水平错开，再垂直下降，避免斜线交叉）
        midx = x + cw / 2
        s.append(poly([(cx, cy + 76), (cx, 264), (midx, 264), (midx, top - 4)], color=LINE))
        s.append(txt(midx, 282, sym, 11.5, "#dc2626", anchor="middle", weight="600"))

        s.append(box(x, top, cw, 218, st, rx=10))
        s += icon(ic, x + 30, top + 32, 16, stc)
        s.append(txt(x + 54, top + 22, name, 15, tc, weight="700"))
        s.append(txt(x + 14, top + 60, how[0], 11.5, MUTED))
        s.append(txt(x + 14, top + 80, how[1], 11.5, MUTED))
        # 换来 / 换不来：用一对色块小标签而不是整句话堆叠
        s.append(box(x + 14, top + 148, cw - 28, 28, "ok", rx=6, fill="#ecfdf5", stroke="none"))
        s.append(txt(x + 24, top + 166, "✓ " + gain, 11, "#065f46", weight="600"))
        s.append(box(x + 14, top + 182, cw - 28, 28, "gate", rx=6, fill="#fff7ed", stroke="none"))
        s.append(txt(x + 24, top + 200, "✗ " + cost, 11, "#9a3412", weight="600"))

    s.append(txt(40, 556, "共同前提：模型没有任何持久状态。它每一轮看到的「记忆」，就是 harness 这次递过去的那段输入。",
                 13, INK))
    s.append(txt(40, 580, "所以「它忘了最初要干什么」和「它塞不进下一轮」是同一个问题的两面，都不是模型的缺陷。",
                 13, INK))
    s.append(txt(40, 610, "压缩换的是空间（有损，活在内存里）；持久化换的是寿命（无损，但不解决窗口问题）。两层都需要。",
                 13, "#0d9488"))
    write("attention.svg", s)


# ---------------------------------------------------------------- 6 压缩切分点
def compaction_cut():
    W, H = 1100, 500
    s = header(W, H, "压缩从哪里切",
               "上下文是有序序列，工具调用与它的结果成对出现；切分点落在两者之间，故障会在十几轮之后才显形")

    items = [
        ("用户", "core"), ("调用", "tool"), ("结果", "store"), ("回复", "core"),
        ("用户", "core"), ("调用", "tool"), ("结果", "store"), ("调用", "tool"),
        ("结果", "store"), ("用户", "core"), ("调用", "tool"), ("结果", "store"),
    ]
    x0, bw, gap = 60, 70, 10
    y = 140
    for i, (t, st) in enumerate(items):
        x = x0 + i * (bw + gap)
        s.append(box(x, y, bw, 46, st, rx=6))
        bg, stc, tc = PALETTE[st]
        s.append(txt(x + bw / 2, y + 29, t, 12.5, tc, anchor="middle", weight="600"))
    s.append(txt(60, 124, "时间 →", 11.5, MUTED))

    # 坏切点：第 7 个之后（调用 与 结果 之间 → items[5]调用 items[6]结果，切在 index 6 之前）
    bad_x = x0 + 6 * (bw + gap) - gap / 2
    s.append(f'<line x1="{bad_x}" y1="{y-18}" x2="{bad_x}" y2="{y+64}" stroke="#dc2626" '
             f'stroke-width="2.4" stroke-dasharray="5 4"/>')
    s.append(txt(bad_x - 6, y - 26, "坏切点", 12.5, "#dc2626", anchor="end", weight="700"))

    good_x = x0 + 9 * (bw + gap) - gap / 2
    s.append(f'<line x1="{good_x}" y1="{y-18}" x2="{good_x}" y2="{y+64}" stroke="#059669" '
             f'stroke-width="2.4"/>')
    s.append(txt(good_x + 6, y - 26, "好切点：最后一条用户消息之前", 12.5, "#059669", weight="700"))

    s += labelled_box(60, 236, 470, 132, "坏切点的故障链（症状离病因很远）",
                      ["压缩发生在第 30 轮，切散了第 12 轮的一对调用与结果",
                       "压缩本身不报错，摘要也生成得好好的",
                       "下一次请求返回「某个输出项找不到对应调用」",
                       "错误信息里不会提到压缩，你看到的是第 31 轮挂了",
                       "若归进「未知错误重试几次」，每次重试都带着同一份坏序列"],
                      style="gate", title_size=13.5, line_size=11.5, align="left")
    s += labelled_box(560, 236, 500, 132, "好切点为什么安全",
                      ["用户消息一定处在轮次边界上",
                       "——一轮的定义就是从用户消息开始、到模型不再调工具为止",
                       "所以在它之前切，绝不会拆散任何一对调用与结果",
                       "当前这一轮原样保留，因为它正在被使用",
                       "被切掉的那段整体交给一次「无工具」的模型调用总结"],
                      style="ok", title_size=13.5, line_size=11.5, align="left")

    s.append(txt(60, 412, "闸门放在「调模型之前」而不是「收到超长错误之后」：总结本身也是一次模型调用，"
                 "它的输入是那一大段旧历史，", 12.5, INK))
    s.append(txt(60, 434, "也要装进同一个窗口。等窗口满了再压，这次总结请求也发不出去——agent 彻底卡死。"
                 "这才是「提前压」的真正原因。", 12.5, INK))
    s.append(txt(60, 466, "判断阈值用精确 token 用量而不是估算，差别不在精度本身，而在于它允许你把安全边际压到多小。",
                 12.5, MUTED))
    write("compaction-cut.svg", s)


# ---------------------------------------------------------------- 7 提示词 vs 配置
def prompt_vs_config():
    W, H = 1060, 560
    s = header(W, H, "文本合并与配置解析是两条独立的路",
               "一条决定模型读到什么，一条决定这次调用是什么参数；混成一件事，硬约束就会被降级成建议")

    # 左：文本
    s.append(box(40, 104, 470, 300, "core", rx=12, fill="#fdfeff"))
    s.append(txt(60, 132, "文本合并 → 指令字符串", 15, "#1e3a8a", weight="700"))
    layers = [
        (152, "内置基础指令", "永远在最前：身份、工具用法", "core"),
        (218, "项目约定（逐目录收集）", "从项目根一路走到当前工作目录", "attn"),
        (284, "拼接顺序 = 覆盖顺序", "越靠近当前目录的出现在越后面，因此赢", "attn"),
    ]
    for y, t, sub, st in layers:
        bg, stc, tc = PALETTE[st]
        s.append(box(62, y, 426, 54, st, rx=7))
        s.append(txt(78, y + 23, t, 13, tc, weight="600"))
        s.append(txt(78, y + 42, sub, 11.5, MUTED))
    s.append(arrow(275, 206, 275, 214))
    s.append(arrow(275, 272, 275, 280))
    s.append(txt(62, 360, "monorepo 例：根写「全部用 TypeScript」，子包写「这个包是 Python」——后者赢。",
                 11.5, MUTED))
    s.append(txt(62, 380, "整份拼接有字节上限，超了就停止追加。", 11.5, MUTED))

    # 右：配置
    s.append(box(540, 104, 480, 300, "out", rx=12, fill="#fbfcfd"))
    s.append(txt(560, 132, "配置解析 → 一组取值", 15, "#475569", weight="700"))
    chain = [
        ("命令行参数与显式覆盖", "最高", "gate"),
        ("项目级配置（需项目可信 · 越近越优先）", "", "attn"),
        ("选中的预设文件", "", "core"),
        ("用户级配置", "", "core"),
        ("系统级配置", "", "out"),
        ("内置默认值", "最低", "out"),
    ]
    for i, (t, tag, st) in enumerate(chain):
        y = 152 + i * 40
        bg, stc, tc = PALETTE[st]
        s.append(box(562, y, 436, 32, st, rx=6))
        s.append(txt(576, y + 21, t, 12, tc, weight="600"))
        if tag:
            s.append(txt(986, y + 21, tag, 11, MUTED, anchor="end"))
    s.append(f'<line x1="550" y1="152" x2="550" y2="384" stroke="{LINE}" stroke-width="1.6" '
             f'marker-end="url(#a)" stroke-dasharray="4 3"/>')
    s.append(txt(546, 268, "覆", 10.5, MUTED, anchor="end"))

    s += labelled_box(40, 424, 470, 100, "配置不进提示词",
                      ["把「当前沙箱是只读，请不要写文件」拼进系统提示是错的：",
                       "它把一个硬约束降级成了一句建议。",
                       "沙箱该拦的不需要告诉模型；模型该知道的边界，从被拒绝时的错误信息里学。"],
                      style="gate", title_size=13.5, line_size=11.5, align="left")
    s += labelled_box(540, 424, 480, 100, "两条必须显式设计的边界",
                      ["项目级配置需要项目被标记为可信才生效——否则克隆一个仓库就能改沙箱；",
                       "即使可信，也有一组机器级键不接受下层覆盖（模型后端、认证、遥测）。",
                       "调试这类系统最有用的能力：对每个键报告它最终取值来自哪一层。"],
                      style="ok", title_size=13.5, line_size=11.5, align="left")
    write("prompt-vs-config.svg", s)


# ---------------------------------------------------------------- 8 会话生命周期
def session_lifecycle():
    W, H = 1060, 570
    s = header(W, H, "会话的一生，全都是文件操作",
               "存储形态选对了，生命周期管理就自动变成一组文件操作；如果它需要在循环里加逻辑，说明形态选错了")

    s.append(box(390, 120, 280, 176, "store", rx=10))
    s.append(txt(530, 148, "只追加的行分隔日志", 14.5, "#134e4a", anchor="middle", weight="700"))
    rows = ["头：会话 id / 工作目录 / 启动时间", "用户消息", "工具调用", "工具输出", "模型回复", "…"]
    for i, r in enumerate(rows):
        y = 170 + i * 21
        s.append(txt(406, y + 8, r, 11, MUTED, mono=(i > 0)))
    s.append(txt(530, 284, "项一产生就落盘，不等这一轮结束", 11, "#0d9488", anchor="middle"))

    ops = [
        (40, 120, "继续", ["读日志，跳过头", "按行解析成序列，接着跑", "文件本身不动"], "ok"),
        (40, 236, "分叉", ["复制成新 id 的文件", "头里记下从哪条岔出来的", "原会话一个字节都不动"], "core"),
        (730, 120, "归档", ["挪进隐藏目录", "或翻一个可见性标志位", "什么都没删"], "attn"),
        (730, 236, "取消归档", ["挪回来", "重新出现在选择器里"], "attn"),
        (730, 348, "删除", ["唯一不可逆的操作", "所以是唯一需要显式确认的"], "gate"),
    ]
    for x, y, t, ls, st in ops:
        s += labelled_box(x, y, 290, 100, t, ls, style=st, title_size=14, line_size=11.5,
                          align="left")
        if x < 300:
            s.append(arrow(334, y + 50, 386, y + 50))
        elif y < 300:
            s.append(arrow(674, y + 50, 726, y + 50))
        else:
            s.append(poly([(670, 288), (702, 288), (702, y + 50), (726, y + 50)], color=LINE))

    s += labelled_box(40, 352, 290, 96, "为什么不是大 JSON 数组",
                      ["写到一半崩溃 → 整份文件解析失败", "你丢的不是最后一条，是全部",
                       "新增一项要重写整个文件"], style="gate", title_size=13.5, line_size=11.5,
                      align="left")
    s.append(txt(390, 336, "形态是被访问模式决定的，", 12.5, INK))
    s.append(txt(390, 356, "不是被「哪个技术更先进」决定的：", 12.5, INK))
    s.append(txt(390, 380, "追加一行、顺序读回、复制、移动、删除，", 11.5, MUTED))
    s.append(txt(390, 398, "全是文件系统的原生操作。", 11.5, MUTED))
    s.append(txt(390, 416, "事务、并发写、按任意字段检索、跨用户", 11.5, MUTED))
    s.append(txt(390, 434, "关联，这个场景一个都没用到。", 11.5, MUTED))
    s.append(txt(390, 462, "什么时候该换数据库？当访问模式变了：", 11.5, "#b45309"))
    s.append(txt(390, 480, "多租户、跨机共享、按人／按时间检索。", 11.5, "#b45309"))
    s.append(txt(40, 530, "归档和删除必须在语义上和界面上都严格分开：归档却删了数据是背叛预期，"
                 "删除却只藏起来是安全问题。", 13, INK))
    write("session-lifecycle.svg", s)


# ---------------------------------------------------------------- 9 错误恢复
def error_recovery():
    W, H = 1080, 520
    s = header(W, H, "失败是分类后的下一步，不是终点",
               "生产环境里 API 报错是常态不是意外；四种情况的正确反应完全不同，走同一条路就像碰到减速带就熄火")

    s += labelled_box(40, 168, 130, 120, "一次失败", ["异常 / 非 2xx", "/ 取消信号"], style="gate",
                      title_size=13.5)
    s += labelled_box(196, 168, 120, 120, "分类器", ["看信号", "不看语义"], style="core",
                      title_size=13.5)
    s.append(arrow(170, 228, 192, 228))

    buckets = [
        (108, "限流 / 过载", "429、529 或对应关键词",
         "带抖动的指数退避，重试有上限", "不立刻放弃，也不无上限重试", "attn"),
        (198, "上下文超长", "413 或「超过最大上下文长度」",
         "压缩之后只再试一次", "不陷入「压缩、失败、再压缩」死循环", "attn"),
        (288, "用户中止", "取消信号",
         "立刻停当前轮，会话保留", "不当成错误去重试", "ok"),
        (378, "未知", "其余一切",
         "少量重试后放弃", "不和限流走同一条路径", "out"),
    ]
    for y, t, sig, act, never, st in buckets:
        bg, stc, tc = PALETTE[st]
        s.append(box(344, y, 700, 78, st, rx=8))
        s.append(txt(360, y + 24, t, 13.5, tc, weight="600"))
        s.append(txt(360, y + 44, sig, 11, MUTED))
        s.append(txt(560, y + 28, "恢复： " + act, 12, tc))
        s.append(txt(560, y + 50, "明确不做： " + never, 11.5, "#b45309"))
        s.append(poly([(316, 228), (330, 228), (330, y + 39), (340, y + 39)], color=LINE))

    s.append(txt(40, 336, "抖动为什么必要：", 12.5, INK, weight="600"))
    s.append(txt(40, 356, "纯指数退避会让一群", 11.5, MUTED))
    s.append(txt(40, 374, "被同时限流的请求在同", 11.5, MUTED))
    s.append(txt(40, 392, "一时刻一起重试，形成", 11.5, MUTED))
    s.append(txt(40, 410, "同步的重试风暴。", 11.5, MUTED))

    s.append(txt(40, 486, "两层分工：瞬时 HTTP 错误的退避放在模型客户端层（对上层透明）；超长与中止必须放在轮次层"
                 "（它们要动上下文或会话状态）。", 12.5, INK))
    s.append(txt(40, 508, "工具执行失败走另一条路：写成一条工具结果喂回去，循环继续。混在一起，一条失败的 shell "
                 "命令会触发退避重试。", 12.5, "#b45309"))
    write("error-recovery.svg", s)


# ---------------------------------------------------------------- 10 yield 时序
def yield_timeline():
    W, H = 1060, 500
    s = header(W, H, "慢命令不阻塞：yield 窗口与收割",
               "要解耦的不是「同步 vs 异步」，而是「这一次工具调用最多等多久」和「这个进程要跑多久」")

    ax, ay, aw = 60, 130, 940
    s.append(f'<line x1="{ax}" y1="{ay}" x2="{ax+aw}" y2="{ay}" stroke="{LINE}" stroke-width="1.4" marker-end="url(#a)"/>')
    s.append(txt(ax + aw, ay - 10, "时间", 11.5, MUTED, anchor="end"))

    # 快命令
    s.append(box(ax + 20, ay + 20, 120, 34, "ok", rx=6))
    s.append(txt(ax + 80, ay + 42, "快命令", 12, "#064e3b", anchor="middle", weight="600"))
    s.append(f'<line x1="{ax+180}" y1="{ay+14}" x2="{ax+180}" y2="{ay+62}" stroke="#059669" stroke-dasharray="4 3"/>')
    s.append(txt(ax + 188, ay + 44, "窗口内就结束了 → 返回完整输出 + 退出码，和同步执行没有任何区别",
                 11.5, "#059669"))

    # 慢命令
    y2 = ay + 96
    s.append(box(ax + 20, y2, 560, 34, "attn", rx=6))
    s.append(txt(ax + 300, y2 + 22, "慢命令（装依赖 / 跑构建）", 12, "#78350f", anchor="middle",
                 weight="600"))
    s.append(f'<line x1="{ax+180}" y1="{y2-8}" x2="{ax+180}" y2="{y2+44}" stroke="#d97706" stroke-width="2"/>')
    s.append(txt(ax + 186, y2 - 14, "窗口到期", 11.5, "#d97706", weight="600"))
    s.append(arrow(ax + 180, y2 + 52, ax + 180, y2 + 76, color="#d97706"))
    s += labelled_box(ax + 76, y2 + 80, 250, 48, "返回：会话句柄 + 目前输出 + 仍在运行",
                      [], style="attn", title_size=11.5)

    s += labelled_box(ax + 350, y2 + 80, 190, 48, "模型去干别的事", [], style="core",
                      title_size=12.5)
    s.append(arrow(ax + 330, y2 + 104, ax + 346, y2 + 104))

    s.append(f'<line x1="{ax+580}" y1="{y2-8}" x2="{ax+580}" y2="{y2+44}" stroke="#059669" stroke-width="2"/>')
    s += labelled_box(ax + 566, y2 + 80, 300, 48, "后续某一轮收割：只取上次切面之后的增量", [],
                      style="store", title_size=11.5)
    s.append(arrow(ax + 546, y2 + 104, ax + 562, y2 + 104))

    # 事件流通道
    y3 = ay + 250
    s.append(box(ax, y3, 470, 92, "out", rx=10, dashed=True))
    s.append(txt(ax + 16, y3 + 26, "给界面的事件流", 13.5, "#475569", weight="700"))
    s.append(txt(ax + 16, y3 + 48, "命令开始了 / 有新输出了 / 命令结束了", 11.5, MUTED))
    s.append(txt(ax + 16, y3 + 68, "终端靠它刷进度条", 11.5, MUTED))
    s.append(box(ax + 520, y3, 480, 92, "gate", rx=10))
    s.append(txt(ax + 536, y3 + 26, "它不能自动灌进模型上下文", 13.5, "#7f1d1d", weight="700"))
    s.append(txt(ax + 536, y3 + 48, "量：一次构建几万行，会瞬间吃掉整个窗口", 11.5, MUTED))
    s.append(txt(ax + 536, y3 + 68, "控制权：模型该主动去看进度，而不是被进度淹没", 11.5, MUTED))
    s.append(f'<line x1="{ax+490}" y1="{y3+46}" x2="{ax+514}" y2="{y3+46}" stroke="#dc2626" stroke-width="2"/>')
    s.append(f'<line x1="{ax+496}" y1="{y3+36}" x2="{ax+508}" y2="{y3+56}" stroke="#dc2626" stroke-width="2"/>')

    s.append(txt(60, 466, "要维护「已经给模型看过多少」的偏移量，每次收割只返回增量——否则模型会困惑于"
                 "「这条日志怎么出现了三次」。", 12.5, INK))
    write("yield-timeline.svg", s)


# ---------------------------------------------------------------- 11 触发源与出口
def triggers_outlets():
    W, H = 1060, 500
    s = header(W, H, "同一个循环，换驱动方与出口",
               "无人值守不改变循环，改变的是三样东西：谁驱动它、它指向什么、结果怎么回来")

    trig = [("人", "终端里敲提示词"), ("定时器", "系统定时器 / 应用调度"),
            ("CI", "在某个 runner 上跑一次"), ("云端", "托管环境里的一个任务"),
            ("另一个 agent", "把「跑一个任务」当成一次工具调用")]
    for i, (t, sub) in enumerate(trig):
        y = 110 + i * 66
        s += labelled_box(40, y, 250, 54, t, [sub], style="out", dashed=True, title_size=13,
                          line_size=11, align="left")
        s.append(arrow(294, y + 27, 356, y + 27))

    s.append(box(360, 130, 250, 258, "core", rx=12, fill="#fdfeff", sw=2.2))
    s.append(txt(485, 176, "同一个循环", 17, "#1e3a8a", anchor="middle", weight="700"))
    s.append(txt(485, 206, "一行不改", 12.5, MUTED, anchor="middle"))
    s.append(txt(378, 248, "指向什么：", 12.5, INK, weight="600"))
    for i, t in enumerate(["一段对话", "一个 diff", "一个被委派的任务"]):
        s.append(txt(378, 272 + i * 22, "· " + t, 11.5, MUTED))
    s.append(txt(378, 356, "换一份系统提示 + 换指向 = 换一个产品", 11, "#7c3aed"))

    outs = [("终端文本", "对人友好，对脚本是灾难", "out"),
            ("结构化事件流", "每行一个 JSON：会话/轮次/项/用量/失败", "ok"),
            ("受 schema 约束的结果", "在生成阶段约束，不是事后校验重试", "ok"),
            ("行内评论", "挂在 diff 的具体行上，绝不改文件", "attn"),
            ("一份 diff 或一个 PR", "云端任务的产物", "store")]
    for i, (t, sub, st) in enumerate(outs):
        y = 110 + i * 66
        s += labelled_box(680, y, 340, 54, t, [sub], style=st, title_size=13, line_size=11,
                          align="left")
        s.append(arrow(614, y + 27, 676, y + 27))

    s.append(txt(40, 442, "机器可读的输出走标准输出，人读的进度走标准错误——CI 里一条重定向就能把事件流存成文件，"
                 "而人在终端看时两者都在。", 12.5, INK))
    s.append(txt(40, 470, "「只报告不修改」如果只写在提示词里，它就会在某些时候被违反。正确做法是配上只读沙箱，"
                 "让它物理上改不了。", 12.5, "#b45309"))
    write("triggers-outlets.svg", s)


# ---------------------------------------------------------------- 12 多执行者四层边界
def multi_agent():
    W, H = 700, 660
    s = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" '
        f'viewBox="0 0 {W} {H}" font-family="{FONT}">',
        f'<rect width="{W}" height="{H}" fill="#ffffff"/>',
        '<defs>',
        f'<marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" '
        f'markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="{LINE}"/></marker>',
        '</defs>',
        txt(32, 40, "「多执行者」其实是四件互相独立的事", 21, INK, weight="600"),
        txt(32, 64, "注意力怎么隔离、信息怎么传递、顺序怎么保证、", 13, MUTED),
        txt(32, 82, "文件在哪写——混在一起想，会设计出一团乱麻", 13, MUTED),
    ]

    cw, ch, gap = 288, 186, 24
    x_l, x_r = 32, 32 + cw + gap
    y_t, y_b = 118, 118 + ch + gap
    cx, cy = (x_l + x_r + cw) / 2, (y_t + y_b + ch) / 2

    # 中心：共享资源
    s.append(f'<circle cx="{cx}" cy="{cy}" r="58" fill="#f8fafc" stroke="{LINE}" stroke-width="2"/>')
    s += icon("box3d", cx, cy - 14, 16, "#475569")
    s.append(txt(cx, cy + 18, "共享资源", 12.5, "#334155", anchor="middle", weight="700"))
    s.append(txt(cx, cy + 34, "任务队列/仓库/上下文", 9.5, MUTED, anchor="middle"))

    quads = [
        (x_l, y_t, "mailbox", "① 注意力边界", "tool",
         ("各带私有上下文；信箱传消息，", "过境内容必须显式说出"),
         "没有它：支线几十轮细节淹没主线"),
        (x_r, y_t, "shield", "② 规则边界", "gate",
         ("任务带依赖集合；认领时检查，", "不满足就拒绝"),
         "没有它：全局顺序被悄悄破坏"),
        (x_l, y_b, "id", "③ 并发正确性", "attn",
         ("请求带 id 对账；认领的复查", "与置位必须原子"),
         "没有它：两个执行者抢到同一份活"),
        (x_r, y_b, "folder", "④ 地盘边界", "store",
         ("各自一份工作目录；冲突推迟到", "交回那一刻由 git 暴露"),
         "没有它：并行写入互相覆盖"),
    ]
    for x, y, ic, t, st, how, bad in quads:
        bg, stc, tc = PALETTE[st]
        s.append(box(x, y, cw, ch, st, rx=10))
        s += icon(ic, x + 28, y + 30, 15, stc)
        s.append(txt(x + 50, y + 22, t, 13.5, tc, weight="700"))
        s.append(txt(x + 16, y + 58, how[0], 11, MUTED))
        s.append(txt(x + 16, y + 76, how[1], 11, MUTED))
        s.append(box(x + 16, y + ch - 42, cw - 32, 26, "gate", rx=6, fill="#fff7ed", stroke="none"))
        s.append(txt(x + 24, y + ch - 24, bad, 10, "#9a3412", weight="600"))

    s.append(txt(32, 542, "前提：多执行者默认是亏的", 13.5, "#7f1d1d", weight="700"))
    s.append(txt(32, 564, "每个执行者独立烧 token，总成本高于单个；只在任务确实能拆、", 12, MUTED))
    s.append(txt(32, 584, "且每部分都有大量中间过程时才划算。", 12, MUTED))
    s.append(txt(32, 616, "主流产品默认只在用户明确要求并行时才派生——这个保守默认是对的。", 12, "#0d9488"))
    write("multi-agent-boundaries.svg", s)


# ---------------------------------------------------------------- 13 隔离级别
def isolation_levels():
    W, H = 1080, 560
    s = header(W, H, "隔离的三个级别，是包含关系不是并列选项",
               "用目录隔离去解决「不信任这段代码」是错配；用容器去解决「别互相覆盖」是过度设计")

    # 左侧：三层同心矩形，直观表达「一层比一层大」的包含关系
    cx = 280
    rings = [
        (110, 90, 340, 300, "store", "环境隔离", "容器 / 微型虚拟机"),
        (150, 130, 260, 220, "gate", "沙箱", "落地执行上的笼子"),
        (190, 170, 180, 140, "core", "工作目录隔离", "同一仓库另一份目录"),
    ]
    for y, x, w, h, st, t, sub in rings:
        bg, stc, tc = PALETTE[st]
        s.append(box(x, y, w, h, st, rx=14, fill=bg, sw=2))
    # 最内层单独写标题在圈内，外两层标题写在各自圆环的顶部空隙里
    y, x, w, h, st, t, sub = rings[2]
    bg, stc, tc = PALETTE[st]
    s.append(txt(x + w / 2, y + h / 2 - 6, t, 13.5, tc, anchor="middle", weight="700"))
    s.append(txt(x + w / 2, y + h / 2 + 14, sub, 10.5, MUTED, anchor="middle"))
    for y, x, w, h, st, t, sub in rings[:2]:
        bg, stc, tc = PALETTE[st]
        s.append(txt(x + 16, y + 18, t, 13.5, tc, weight="700"))
        s.append(txt(x + 16, y + 34, sub, 10.5, MUTED))

    # 右侧：与三层一一对应的属性表，用引导线连接，避免图内塞满文字
    rows = [
        (rings[2], "工作目录隔离",
         ["隔： 工作区目录", "共享： 同一台机器、内核、对象库",
          "适用： 本机并行会话",
          "不适用： 约束不可信代码——它还在你机器上跑"]),
        (rings[1], "沙箱",
         ["隔： 当前目录之外的一切（含网络）", "共享： 同一台机器、同一个文件系统",
          "适用： 限制单个执行者的破坏半径",
          "不适用： 提供并行能力——它只管边界"]),
        (rings[0], "环境隔离",
         ["隔： 文件系统、进程、网络", "共享： 只共享宿主的硬件",
          "适用： 云端任务、不可信代码",
          "不适用： 日常本机——启动调试成本高一档"]),
    ]
    rx0, ry0 = 640, 108
    for i, (ring, t, lines) in enumerate(rows):
        ry = ry0 + i * 148
        yy0, xx0, ww, hh, st, _, _ = ring
        bg, stc, tc = PALETTE[st]
        s.append(box(rx0, ry, 400, 128, st, rx=10, fill="#ffffff"))
        s.append(txt(rx0 + 16, ry + 26, t, 14, tc, weight="700"))
        yy = ry + 48
        for ln in lines:
            s.append(txt(rx0 + 16, yy, ln, 11, MUTED)); yy += 20
        # 引导线：从圆环右边缘连到对应说明卡片左边缘
        edge_x = xx0 + ww
        edge_y = yy0 + hh * 0.22 if i < 2 else yy0 + hh / 2
        s.append(poly([(edge_x, edge_y), (edge_x + 24, edge_y), (edge_x + 24, ry + 64),
                       (rx0 - 4, ry + 64)], color=stc, sw=1.4, dashed=True))

    s.append(txt(40, 486, "目录隔离的关键性质：真正的冲突不会消失，只是被推迟到交回那一刻由 git 诚实地暴露——", 13, INK))
    s.append(txt(40, 508, "这是特性不是缺陷，而不是以「文件被静默覆盖」的形式消失。", 13, INK))
    s.append(txt(40, 538, "工作目录由 harness 在会话启动时定，模型没有「创建工作目录」这个工具——目录归属属于编排层的决定。",
                 12.5, MUTED))
    write("isolation-levels.svg", s)


# ---------------------------------------------------------------- 14 一个引擎多前端
def engine_frontends():
    W, H = 1020, 520
    s = header(W, H, "一个引擎，许多前端",
               "复杂度几乎全在传输与协议侧；关键抽象是会话标识——一个前端开的会话，另一个前端能接着跑")

    cx, cy = 510, 280
    s.append(f'<circle cx="{cx}" cy="{cy}" r="112" fill="#eff6ff" stroke="#2563eb" stroke-width="2.4"/>')
    s.append(txt(cx, cy - 34, "引擎", 19, "#1e3a8a", anchor="middle", weight="700"))
    s.append(txt(cx, cy - 8, "循环 + 会话存储", 12.5, MUTED, anchor="middle"))
    s.append(txt(cx, cy + 18, "每条会话一个 id", 12, "#2563eb", anchor="middle", weight="600"))
    s.append(txt(cx, cy + 42, "开新会话 / 在某条会话上跑一轮", 10.5, MUTED, anchor="middle"))
    s.append(txt(cx, cy + 62, "= 同一个方法，不同参数", 10.5, MUTED, anchor="middle"))

    fronts = [
        (40, 110, "终端", "进程内直连，无传输", "core"),
        (40, 210, "编辑器扩展", "RPC 协议", "core"),
        (40, 310, "桌面应用", "RPC 协议", "core"),
        (700, 110, "远程终端", "WebSocket / Unix socket", "attn"),
        (700, 210, "被当作外部工具", "外部工具协议（另一个 agent 调它）", "tool"),
        (700, 310, "托管云服务", "网络 / 云边界", "store"),
    ]
    for x, y, t, tr, st in fronts:
        bg, stc, tc = PALETTE[st]
        s.append(box(x, y, 280, 66, st, rx=8))
        s.append(txt(x + 16, y + 28, t, 13.5, tc, weight="600"))
        s.append(txt(x + 16, y + 50, tr, 11.5, MUTED))
        if x < 300:
            s.append(arrow(x + 284, y + 33, cx - 118, cy - 60 + (y - 110) * 0.55))
        else:
            s.append(arrow(cx + 118, cy - 60 + (y - 110) * 0.55, x - 4, y + 33))

    s.append(txt(40, 424, "如果每种形态重写一套 agent，那是维护灾难，而且行为会不一致。", 13, INK))
    s.append(txt(40, 450, "安全提醒：本机终端里人在现场；远程驱动下没有人在现场——审批弹给谁、"
                 "沙箱按谁的策略配，都要重新想一遍。", 13, "#b45309"))
    write("engine-frontends.svg", s)


# ---------------------------------------------------------------- 15 一次执行的旅程
def journey():
    W, H = 1100, 740
    s = header(W, H, "一次落地执行的完整旅程",
               "一条「改一个文件」的请求，从进来到结束——包括两次失败与重试")

    # 颜色按「三道接缝」分类，而不是随意轮换——一眼看出每一步挂在循环的哪个位置
    seam_names = {"core": "模型调用外套", "gate": "分发外套（判定链）", "tool": "注册表内侧"}
    steps = [
        ("① 进入", "消息追加进序列，同时落盘", "core"),
        ("② 预算闸门", "超了预算 → 切在最后一条用户消息之前，把旧历史压成摘要", "core"),
        ("③ 组装指令", "内置 base + 逐层项目约定；配置项走另一条链，不进这段文本", "core"),
        ("④ 调用模型", "返回 429 → 带抖动退避 → 第二次通了", "core"),
        ("⑤ 追加 + 落盘", "整段原样追加，一个字节都不改写", "core"),
        ("⑥ 结构判据", "有工具调用 → 不收尾，进入分发", "core"),
        ("⑦ 分发", "按名字查表，命中补丁工具；工具的身份决定它走哪条路", "gate"),
        ("⑧ 判定链", "钩子信任 → 能力 → 旁路 → 沙箱（路径在工作区内，放行）→ 审批（弹出 diff，人批准）", "gate"),
        ("⑨ 执行", "先在内存里算出每个文件的最终形态；一个文件上下文没匹配上 → 整个补丁被拒绝，磁盘一字节未动", "tool"),
        ("⑩ 结果回写", "返回一条精确到文件与位置的错误，作为普通工具结果追加进序列并落盘", "core"),
        ("⑪ 模型修正", "下一轮读到那条错误 → 重新读文件 → 产出修正过的补丁 → 这次落盘成功", "core"),
        ("⑫ 收尾", "再下一轮不再调用任何工具 → 抽出最终文本，退出；会话仍躺在磁盘上", "core"),
    ]
    legend_x = 700
    for i, (key, name) in enumerate(seam_names.items()):
        bg, stc, tc = PALETTE[key]
        s.append(f'<circle cx="{legend_x + i*170}" cy="80" r="5" fill="{stc}"/>')
        s.append(txt(legend_x + i * 170 + 12, 84, name, 11, MUTED))
    for i, (t, sub, st) in enumerate(steps):
        y = 104 + i * 44
        bg, stc, tc = PALETTE[st]
        s.append(box(120, y, 900, 36, st, rx=6))
        s.append(txt(134, y + 24, t, 13, tc, weight="700"))
        s.append(txt(258, y + 24, sub, 11.5, MUTED))
        if i < len(steps) - 1:
            s.append(arrow(570, y + 36, 570, y + 42, sw=1.2))

    # 两处重试回边
    s.append(poly([(1024, 104 + 3 * 44 + 18), (1064, 104 + 3 * 44 + 18),
                   (1064, 104 + 3 * 44 + 4), (1024, 104 + 3 * 44 + 4)], color="#dc2626",
                  marker="ar"))
    s.append(txt(1072, 104 + 3 * 44 + 4, "退避重试", 10.5, "#dc2626"))
    s.append(poly([(112, 104 + 9 * 44 + 18), (76, 104 + 9 * 44 + 18), (76, 104 + 10 * 44 + 18),
                   (112, 104 + 10 * 44 + 18)], color="#059669", marker="ag"))
    s.append(txt(40, 104 + 10 * 44 + 40, "模型自己纠错", 10.5, "#059669"))

    s.append(txt(40, 674, "贯穿整条路的一个性质：每一层说「不」的方式都是一样的——写一条结果喂回去。", 13.5, INK,
                 weight="600"))
    s.append(txt(40, 702, "审批拒绝、沙箱越界、补丁不匹配、工具名不存在、依赖未满足、能力未开启，全都走这一条路。"
                 "这个统一性不是巧合，它让循环只需要处理一种失败形态。", 12.5, MUTED))
    write("journey.svg", s)


# ---------------------------------------------------------------- 16 三道接缝
def seams():
    W, H = 1040, 540
    s = header(W, H, "三道接缝加一个外部",
               "加一个新机制时先回答它属于哪一类；归不进任何一类，通常意味着你要改循环——那就是设计错了")

    rows = [
        ("模型调用外套", "发请求的前后",
         "预算压缩 · 错误分类恢复 · 日志落盘 · 指令组装",
         "不关心模型要做什么，只关心这次调用本身", "core"),
        ("分发外套", "真正执行之前",
         "判定链：钩子信任 · 能力开关 · 总旁路 · 沙箱 · 审批与项目信任",
         "关心这个动作会对世界做什么", "gate"),
        ("注册表内侧", "按名字找到的那个处理函数",
         "跑命令 · 打补丁 · 计划 · 知识加载 · 派生子循环 · 协议桥",
         "就是能力本身", "tool"),
        ("循环之外", "完全在外面",
         "调度器 · 外部触发源 · 前端与传输 · 配置解析",
         "它们把工作交进来或决定参数，但不在循环里", "out"),
    ]
    for i, (t, where, what, feat, st) in enumerate(rows):
        y = 104 + i * 98
        bg, stc, tc = PALETTE[st]
        s.append(box(40, y, 960, 82, st, rx=9, dashed=(st == "out")))
        s.append(txt(60, y + 30, t, 15.5, tc, weight="700"))
        s.append(txt(60, y + 52, where, 11.5, MUTED))
        s.append(txt(300, y + 30, what, 12.5, tc))
        s.append(txt(300, y + 52, feat, 11.5, MUTED))

    s.append(txt(40, 512, "挂错位置的典型症状：把策略写进提示词 · 让模型自己声明安全性 · 在循环里加条件分支 · "
                 "把调度器塞进循环 · 把界面事件流灌进模型上下文。", 12.5, "#b45309"))
    write("seams.svg", s)


if __name__ == "__main__":
    five_elements()
    panorama()
    tool_registry()
    trust_axes()
    safety_gates()
    attention()
    compaction_cut()
    prompt_vs_config()
    session_lifecycle()
    error_recovery()
    yield_timeline()
    triggers_outlets()
    multi_agent()
    isolation_levels()
    engine_frontends()
    journey()
    seams()
    print("done")
