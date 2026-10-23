#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""img-phash.py —— 输出每张图的 dHash（64 位十六进制），用来判断"两张封面是不是同一张"

背景（2026-10-19 用户）：「B站卡片解析仅凭标题经常发错短标题视频，能不能加封面锁定原视频」
  · 卡片里只有 title + preview(封面)；短标题很容易同名 ⇒ 同名多条时只能猜（按播放量），会发错。
  · 用 dHash 比封面：同一张封面即使被 QQ 重新转码/缩放，哈希也基本一致（64 位里差几位）。
  · 需要 Pillow —— 用服务器现成的 `/opt/meme-api/.venv/bin/python`（不往 Node 加依赖）。

用法：
  python3 img-phash.py a.jpg b.jpg c.jpg
  → 每行一个 16 位 hex（按参数顺序）；某张图坏了就输出 ERR。
"""
import sys

try:
    from PIL import Image
except Exception:  # pragma: no cover - 没装 Pillow 时让调用方 fail-open
    print('NO_PIL', file=sys.stderr)
    sys.exit(2)


def dhash(path, size=8):
    im = Image.open(path).convert('L')
    im = im.resize((size + 1, size), Image.LANCZOS)
    px = list(im.getdata())
    bits = 0
    for row in range(size):
        base = row * (size + 1)
        for col in range(size):
            left = px[base + col]
            right = px[base + col + 1]
            bits = (bits << 1) | (1 if left > right else 0)
    return f'{bits:016x}'


for p in sys.argv[1:]:
    try:
        print(dhash(p))
    except Exception:
        print('ERR')
