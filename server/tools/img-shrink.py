#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
img-shrink.py —— 用 Pillow 把图**压小**（2026-10-16 用户：「返图还是大图」「用户上传大图自动压缩成小图」）

为什么需要它（Node 那边的 `imgcompress.js` 只管 PNG）：
  · 群里出现过 **99 帧的 GIF、7.7MB**，发一次要 36 秒（实测）
  · 图库里还有 JPEG/WebP，纯 Node 没有解码器压不动
  · 服务器上**已经有 Pillow 12.3**（在 `/opt/meme-api/.venv/bin/python` 里，`meme-frames.py`
    本来就用这个解释器）⇒ 直接拿它当**离线工具**用，**不往 Node 里加任何依赖**（项目铁律）
    ⚠️ 系统自带的 `/usr/bin/python3` **没有** Pillow —— 必须显式用 venv 里那个

它做什么（按格式分别处理，**动图永远保持动图**）：
  · GIF ：画布按长边缩放；帧数太多就**均匀抽帧**（保住"在动"，不是抽成静帧）；
          调色板重新量化（默认 128 色，GIF 本来就 256 色上限）
  · PNG ：长边缩放（可选按调色板量化 —— 但 PNG 我更喜欢走 Node 那条零依赖实现，这里只做缩放）
  · JPEG/WebP：长边缩放 + 质量（默认 82）
  · 其它：原样退出（返回非 0，调用方保留原图）

用法：
  python3 img-shrink.py --in a.gif --out b.gif [--max-edge 512] [--max-bytes 400000]
                        [--max-frames 40] [--quality 82] [--max-colors 128]
  · 压完**不比原来小**时：不写 out、退出码 3（调用方保留原文件）
  · `--probe`：只打印信息（尺寸/帧数/体积），不写文件
"""
import argparse
import os
import sys

try:
    from PIL import Image
except Exception as e:  # pragma: no cover
    print('没有 Pillow：%s' % e, file=sys.stderr)
    sys.exit(9)

def human(n):
    return '%.0fKB' % (n / 1024.0) if n < 1024 * 1024 else '%.1fMB' % (n / 1048576.0)

def probe(path):
    im = Image.open(path)
    frames = getattr(im, 'n_frames', 1)
    print('格式=%s 尺寸=%dx%d 帧数=%d 体积=%s'
          % (im.format, im.width, im.height, frames, human(os.path.getsize(path))))
    return im, frames

def shrink_gif(im, out, max_edge, max_frames, max_colors, max_bytes):
    """动图：缩画布 + 必要时抽帧；**绝不变成静帧**（除非本来就只有 1 帧）"""
    n = getattr(im, 'n_frames', 1)
    # ① 先定抽帧：帧太多时均匀抽（保住首尾与"在动"）
    keep = list(range(n))
    if max_frames and n > max_frames:
        step = n / float(max_frames)
        keep = sorted({int(round(i * step)) for i in range(max_frames)})
        keep = [k for k in keep if k < n]
        if len(keep) < 2 and n >= 2:
            keep = [0, n - 1]
    # ② 画布缩放
    scale = min(1.0, max_edge / float(max(im.width, im.height))) if max_edge else 1.0
    w = max(1, int(round(im.width * scale)))
    h = max(1, int(round(im.height * scale)))

    frames = []
    durations = []
    for i in keep:
        im.seek(i)
        fr = im.convert('RGBA')
        if scale < 1.0:
            fr = fr.resize((w, h), Image.LANCZOS)
        # GIF 只能存调色板图：用自适应调色板（透明保留）
        pal = fr.convert('P', palette=Image.ADAPTIVE, colors=max_colors)
        frames.append(pal)
        durations.append(im.info.get('duration', 100) or 100)

    if len(frames) < 2:
        frames[0].save(out, format='GIF', optimize=True)
        return
    frames[0].save(out, format='GIF', save_all=True, append_images=frames[1:],
                   duration=durations, loop=0, optimize=True, disposal=2)

def shrink_still(im, out, max_edge, quality, max_colors, fmt):
    scale = min(1.0, max_edge / float(max(im.width, im.height))) if max_edge else 1.0
    if scale < 1.0:
        im = im.resize((max(1, int(round(im.width * scale))), max(1, int(round(im.height * scale)))), Image.LANCZOS)
    if fmt == 'GIF':
        im.convert('P', palette=Image.ADAPTIVE, colors=max_colors).save(out, format='GIF', optimize=True)
    elif fmt in ('JPEG', 'JPG'):
        im.convert('RGB').save(out, format='JPEG', quality=quality, optimize=True, progressive=True)
    elif fmt == 'WEBP':
        im.save(out, format='WEBP', quality=quality, method=5)
    elif fmt == 'PNG':
        # PNG 的量化交给 Node 那条零依赖实现；这里只做"缩放 + 最大压缩"
        im.save(out, format='PNG', optimize=True, compress_level=9)
    else:
        raise SystemExit('不支持的格式 %s' % fmt)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--in', dest='src', required=True)
    ap.add_argument('--out', dest='dst')
    ap.add_argument('--max-edge', type=int, default=512)
    ap.add_argument('--max-frames', type=int, default=40)
    ap.add_argument('--max-colors', type=int, default=128)
    ap.add_argument('--quality', type=int, default=82)
    ap.add_argument('--max-bytes', type=int, default=0, help='目标体积上限（只用来决定要不要更狠，0=不管）')
    ap.add_argument('--probe', action='store_true')
    a = ap.parse_args()

    im, frames = probe(a.src)
    if a.probe:
        return 0
    if not a.dst:
        print('--out 必填（或用 --probe）', file=sys.stderr)
        return 2

    before = os.path.getsize(a.src)
    fmt = im.format
    if fmt == 'GIF' and frames > 1:
        shrink_gif(im, a.dst, a.max_edge, a.max_frames, a.max_colors, a.max_bytes)
    else:
        shrink_still(im.convert('RGBA') if fmt == 'GIF' else im, a.dst, a.max_edge, a.quality, a.max_colors, fmt)

    after = os.path.getsize(a.dst)
    if after >= before:
        os.unlink(a.dst)
        print('压不动（%s → %s），保留原图' % (human(before), human(after)), file=sys.stderr)
        return 3
    out_im = Image.open(a.dst)
    print('OK %s → %s（%s → %s，%d 帧 → %d 帧）'
          % (fmt, out_im.format, human(before), human(after), frames, getattr(out_im, 'n_frames', 1)))
    return 0

if __name__ == '__main__':
    sys.exit(main())
