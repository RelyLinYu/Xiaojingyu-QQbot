#!/usr/bin/env python3
"""sheet.py —— 从成片里抽若干帧拼成一张对照图（改画面时用它一眼看几处）。

    python sheet.py 0.9,3.4,6.75,14.4,20.1,26.3          # 用默认成片 promo/bigfish-promo.mp4
    python sheet.py 0.9,3.4  ../bigfish-promo.mp4        # 指定片子
"""
import subprocess, io, os, sys
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
VID = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, "..", "bigfish-promo.mp4")
TIMES = [2.5, 3.4, 4.2, 6.3, 6.75, 7.9, 10.2, 11.7, 13.6, 14.4, 15.6, 17.2,
         18.4, 20.1, 20.4, 22.2, 24.3, 26.3, 27.0, 29.6, 31.0]
if len(sys.argv) > 1:
    TIMES = [float(x) for x in sys.argv[1].split(",")]
COLS, W, H = min(7, len(TIMES)), 640, 360

tiles = []
for t in TIMES:
    r = subprocess.run(["ffmpeg", "-v", "error", "-ss", str(t), "-i", VID, "-frames:v", "1",
                        "-f", "image2", "-"], capture_output=True)
    im = Image.open(io.BytesIO(r.stdout)).convert("RGB").resize((W, H))
    ImageDraw.Draw(im).text((8, 8), f"t={t}", fill=(255, 80, 80))
    tiles.append(im)

rows = (len(tiles) + COLS - 1) // COLS
sheet = Image.new("RGB", (W * COLS, H * rows), (10, 10, 12))
for i, im in enumerate(tiles):
    sheet.paste(im, ((i % COLS) * W, (i // COLS) * H))
out = os.path.join(HERE, "_cs.png")
sheet.save(out)
print("wrote", out, sheet.size)
