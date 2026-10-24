"""生成几何风格封面图 —— 小红书 1张 + 抖音 N张幻灯片。
用法: 修改 POSTS 列表，然后 python3 cover_geometric.py
输出: /tmp/xhs_cover.png, /tmp/dy_slide_0.png ... /tmp/dy_slide_N.png
"""
from PIL import Image, ImageDraw, ImageFont
import os

W, H = 1080, 1440  # 3:4 竖版

# 颜色方案 —— 深色底 + 青绿主色 + 白色
BG = (26, 26, 46)
ACCENT = (100, 220, 180)
WHITE = (255, 255, 255)
GRAY = (140, 140, 160)
LIGHT_ACCENT = (80, 100, 120)

# 字体
FONT_BOLD = "/System/Library/Fonts/STHeiti Medium.ttc"
FONT_LIGHT = "/System/Library/Fonts/PingFang.ttc"

def get_font(size, bold=True):
    path = FONT_BOLD if bold else FONT_LIGHT
    if not os.path.exists(path):
        path = "/System/Library/Fonts/Helvetica.ttc"
    return ImageFont.truetype(path, size)

def draw_geometric_bg(draw, w, h):
    """画几何装饰：圆角矩形 + 线条 + 网格"""
    # 大圆角矩形
    draw.rounded_rectangle([60, 60, w-60, h-60], radius=40, outline=ACCENT, width=3)
    # 内层矩形
    draw.rounded_rectangle([100, 100, w-100, h-100], radius=30, outline=LIGHT_ACCENT, width=1)
    # 水平线
    for y in [h//3, h//2, h*2//3]:
        draw.line([(120, y), (w-120, y)], fill=LIGHT_ACCENT, width=1)
    # 竖线
    draw.line([(w//3, 120), (w//3, h-120)], fill=LIGHT_ACCENT, width=1)
    draw.line([(w*2//3, 120), (w*2//3, h-120)], fill=LIGHT_ACCENT, width=1)
    # 小圆点
    for x, y in [(w//6, h//6), (w*5//6, h//6), (w//6, h*5//6), (w*5//6, h*5//6)]:
        draw.ellipse([x-6, y-6, x+6, y+6], fill=ACCENT)

def draw_centered_text(draw, text, y, font, color, max_width=900):
    """居中文字，自动换行"""
    lines = []
    words = list(text)
    current_line = ""
    for char in words:
        test_line = current_line + char
        bbox = draw.textbbox((0, 0), test_line, font=font)
        if bbox[2] - bbox[0] > max_width:
            lines.append(current_line)
            current_line = char
        else:
            current_line = test_line
    if current_line:
        lines.append(current_line)

    line_h = draw.textbbox((0, 0), "啊", font=font)[3] - draw.textbbox((0, 0), "啊", font=font)[1]
    for i, line in enumerate(lines):
        bbox = draw.textbbox((0, 0), line, font=font)
        tw = bbox[2] - bbox[0]
        draw.text(((w - tw) / 2, y + i * (line_h + 8)), line, font=font, fill=color)

def make_xhs_cover(title, desc_lines):
    """小红书：1张封面图"""
    img = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(img)
    draw_geometric_bg(draw, W, H)

    title_font = get_font(72, bold=True)
    draw_centered_text(draw, title, H//3 - 20, title_font, ACCENT)

    body_font = get_font(36, bold=False)
    body_text = "\n".join(desc_lines)
    draw_centered_text(draw, body_text, H//2 + 60, body_font, WHITE)

    img.save("/tmp/xhs_cover.png", "PNG")
    print("Saved /tmp/xhs_cover.png")

def make_dy_slides(title, slides):
    """抖音：N张幻灯片"""
    for i, (subtitle, detail) in enumerate(slides):
        img = Image.new("RGB", (W, H), BG)
        draw = ImageDraw.Draw(img)
        draw_geometric_bg(draw, W, H)

        # 标题
        title_font = get_font(56, bold=True)
        draw_centered_text(draw, title, 80, title_font, ACCENT)

        # 分隔线
        draw.line([(200, 200), (W-200, 200)], fill=ACCENT, width=2)

        # 副标题
        sub_font = get_font(48, bold=True)
        draw_centered_text(draw, subtitle, 280, sub_font, WHITE)

        # 详情
        detail_font = get_font(32, bold=False)
        draw_centered_text(draw, detail, 420, detail_font, GRAY)

        # 页码
        page_font = get_font(24, bold=False)
        page_text = f"0{i+1} / 0{len(slides)}"
        bbox = draw.textbbox((0, 0), page_text, font=page_font)
        draw.text((W-200, H-80), page_text, font=page_font, fill=GRAY)

        path = f"/tmp/dy_slide_{i}.png"
        img.save(path, "PNG")
        print(f"Saved {path}")

# ============================================================
# 修改下面的 POSTS 内容即可复用
# ⚠️ dy_slides 条目数必须等于功能数量（每个功能一张幻灯片）
#    如果用户反馈"最后一个功能没体现"或"少了一个"，
#    先检查这里是不是漏了条目。
# ============================================================
POSTS = {
    "title": "AI语音助手Charlie",
    "xhs_desc": [
        "做了个AI语音助手Charlie",
        "能记住对话，越用越懂你",
        "到时间自己判断该做什么",
        "晚安、早安、出门自动执行",
    ],
    "dy_slides": [
        ("叙事性记忆", "能记住对话，越用越懂你"),
        ("自主决策", "到时间自己判断该做什么"),
        ("场景自动化", "晚安、早安、出门自动执行"),
        ("自进化", "用得越多越聪明"),
    ],
}

if __name__ == "__main__":
    # 验证：dy_slides 条目数必须合理
    p = POSTS
    expected = len(p["dy_slides"])
    print(f"正在生成 {expected} 张幻灯片（封面 + {expected} 个功能页）")
    make_xhs_cover(p["title"], p["xhs_desc"])
    make_dy_slides(p["title"], p["dy_slides"])
    print("Done.")