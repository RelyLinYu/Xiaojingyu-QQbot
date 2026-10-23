#!/usr/bin/env python3
# ============================================================
#  score.py —— 蓝色大肥鱼宣传片的声音：一条 BGM + 全部音效，一个房间。
#
#  · BGM 是**合成**的（不是下载的素材）⇒ 没有授权问题，也不会有"别人的音乐"。
#    低音区 Am–F–C–G 四和弦的 pad，每个和弦留出约 25% 的空隙 ——
#    这既是"让重音落地"的留白，也正好让 verify 的 audio leg（要求 ≥15% 的
#    1/12 秒帧是安静的）通过。
#  · 事件表按 comp 里真实的节拍手写：每个动作对应一个声音，不是"每个事件一个蜂鸣"。
#  · 全部进同一个卷积混响（Score 里那把），峰值 −8 dBFS，音乐压在音效下面。
#
#  用法： python score.py out.wav
# ============================================================
import sys, os
sys.path.insert(0, r"C:\Users\Baiks\.dsh\skills\onetake\scripts")
from sfx_palette import *          # noqa: F401,F403  (SR/np/signal/_t/_rng/lp/hp/bp/sat + 材料 + Score)

DUR = 32.0
BEAT = 0.7143                      # 84 BPM
_t = lambda n: np.arange(n) / SR   # 「import *」不带下划线开头的名字，自己来

# 和弦（低音区，A 小调，深水感）
CH = {
    'Am': [110.0, 130.81, 164.81, 220.0],
    'F':  [87.31, 110.0, 130.81, 174.61],
    'C':  [130.81, 164.81, 196.0, 261.63],
    'G':  [98.0,  123.47, 146.83, 196.0],
}
PROG = ['Am', 'F', 'C', 'G']


def _detune_saw(f, n, seed):
    r = np.random.default_rng(seed)
    t = _t(n)
    x = np.zeros(n)
    for det, w in ((-0.0045, .55), (0.0, .8), (0.0055, .5), (0.011, .28)):
        x += w * signal.sawtooth(2 * np.pi * f * (1 + det) * t + r.uniform(0, 6.283))
    return x


def pad(freqs, dur=1.35, atk=0.34, rel=1.05, seed=1):
    """一个和弦的 pad：两层滤波的锯齿堆 + 慢起音 + 长释放。dur 之后开始 release，
    所以每个和弦后面天然留出空白。"""
    n = int(SR * (dur + rel)); t = _t(n)
    x = np.zeros(n)
    for i, f in enumerate(freqs):
        x += _detune_saw(f, n, seed + i * 17)
    x = lp(x, 760, 2) * 0.8 + lp(x, 220, 1) * 0.9
    trem = 1 + 0.10 * np.sin(2 * np.pi * 0.19 * t + seed)
    env = np.clip(t / atk, 0, 1) ** 1.6 * np.where(t < dur, 1.0, np.exp(-(t - dur) * 3.2))
    return (x / (freqs.__len__() * 2.1)) * env * trem


def swell(f, dur=1.1, seed=3):
    """一层更低的、只用来托底的低频垫"""
    n = int(SR * (dur + 1.2)); t = _t(n)
    x = np.sin(2 * np.pi * f * t) + 0.35 * np.sin(2 * np.pi * f * 2.005 * t)
    env = np.clip(t / 0.5, 0, 1) * np.where(t < dur, 1.0, np.exp(-(t - dur) * 2.6))
    return x * env * 0.5


def tick(f=320, dur=0.09):
    return wood(f, dur)


def music(s, t0, t1, gain=0.085, seed=1):
    """一段 BGM：和弦槽 1.8 s，和弦本身 1.35 s —— 槽间留白。"""
    slot = 1.8
    k = 0
    t = t0
    while t < t1 - 0.2:
        name = PROG[k % 4]
        s.place(pad(CH[name], seed=seed + k), t, gain, pan=0.0, send=0.42)
        if k % 2 == 0:
            s.place(swell(CH[name][0] / 2), t, gain * 2.0, send=0.30)
        k += 1
        t += slot


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "sfx.wav"
    s = Score(dur=DUR, T60=1.25)

    # ── 开场：三个词，一路潜下去 ──
    for i, (tt, f) in enumerate(zip([0.20, 0.46, 0.72], [523.25, 659.26, 783.99])):
        s.place(glass(f, 0.9, 0.55), tt, 0.16 + i * 0.02, pan=-0.25 + i * 0.25, send=0.55)
    s.place(air(0.9, 180, 2400, 1.3, 0.5), 0.95, 0.34, pan=0.35, send=0.5, pan_to=-0.3)
    s.place(sub(58, 1.0), 1.02, 0.50, send=0.35)
    s.place(air(1.0, 700, 4200, 1.5, 0.42), 1.12, 0.26, pan=-0.4, send=0.5, pan_to=0.2)

    # ── 聊天：手在敲，鱼在回 ──
    music(s, 2.20, 8.90, 0.085, seed=1)
    for i, tt in enumerate([2.36, 2.50, 2.64, 2.78, 2.92, 3.06]):
        s.place(tick(280 + i * 14, 0.06), tt, 0.085, pan=-0.2, send=0.18)
    s.place(wood(150, 0.14), 3.20, 0.34, pan=-0.1, send=0.3); s.place(bubble(430), 3.26, 0.30, send=0.35)
    s.place(bubble(620), 4.02, 0.26, pan=-0.25, send=0.40)
    for i, tt in enumerate([5.64, 5.76, 5.88]): s.place(tick(300 + i * 16, 0.06), tt, 0.075, pan=-0.2, send=0.18)
    s.place(wood(150, 0.14), 6.02, 0.32, pan=-0.1, send=0.3); s.place(bubble(410), 6.08, 0.30, send=0.35)
    # 踩雷：这一下是整个片子的重音
    s.place(sub(46, 1.3), 6.66, 0.72, send=0.45)
    s.place(glass(196.0, 1.6, 1.0), 6.68, 0.30, send=0.6)
    s.place(air(0.45, 300, 900, 1.2, 0.35), 6.68, 0.30, pan=0.5, send=0.45, pan_to=-0.5)
    for i, tt in enumerate([7.31, 7.43, 7.55]): s.place(tick(310 + i * 14, 0.06), tt, 0.07, pan=-0.2, send=0.18)
    s.place(wood(150, 0.14), 7.72, 0.30, pan=-0.1, send=0.3); s.place(bubble(400), 7.78, 0.28, send=0.35)
    s.place(glass(880.0, 0.7, 0.9), 8.30, 0.16, pan=0.15, send=0.5)

    # ── 链接与卡片 ──
    for i, tt in enumerate([9.36, 9.46, 9.56, 9.66, 9.76, 9.86]): s.place(tick(340 + i * 12, 0.05), tt, 0.06, pan=-0.15, send=0.15)
    s.place(wood(160, 0.14), 10.04, 0.32, pan=-0.1, send=0.3); s.place(bubble(460), 10.10, 0.30, send=0.35)
    s.place(tick(520, 0.07), 11.00, 0.10, pan=0.1, send=0.25)
    s.place(glass(392.0, 1.4, 0.85), 11.55, 0.22, send=0.55)
    music(s, 10.20, 13.10, 0.075, seed=21)

    # ── 封面撑满全屏：整段最响的一次"下潜" ──
    s.place(air(1.4, 120, 3200, 1.1, 0.55), 13.18, 0.52, pan=0.0, send=0.55)
    s.place(sub(50, 1.4), 13.30, 0.46, send=0.40)
    for i, tt in enumerate([14.34, 14.50, 14.66, 14.82]):
        s.place(glass(587.33 * (1 + i * 0.12), 0.8, 0.8), tt, 0.17, pan=-0.35 + i * 0.23, send=0.55)
    s.place(glass(1046.5, 1.0, 0.7), 15.60, 0.12, pan=0.0, send=0.6)
    music(s, 14.40, 16.40, 0.070, seed=41)

    # ── 收回来 ──
    s.place(air(1.2, 2600, 200, 1.2, 0.45), 16.58, 0.40, pan=0.0, send=0.5)
    s.place(wood(190, 0.12), 17.70, 0.22, send=0.35)

    # ── 人设抽屉 + 换人设 ──
    music(s, 18.06, 21.30, 0.080, seed=61)
    s.place(wood(210, 0.14), 18.00, 0.26, send=0.35); s.place(wobble(170, 0.7), 18.06, 0.20, send=0.4)
    for i, tt in enumerate([18.30, 18.42, 18.54]): s.place(tick(330 + i * 16, 0.06), tt, 0.07, pan=-0.2, send=0.18)
    s.place(wood(160, 0.14), 18.66, 0.30, pan=-0.1, send=0.3); s.place(bubble(430), 18.72, 0.28, send=0.35)
    s.place(bubble(560), 19.18, 0.24, pan=-0.2, send=0.4)
    # 换人设：一个上滑的音，加一声闷响
    s.place(wood(240, 0.10), 19.98, 0.30, pan=0.35, send=0.35)
    s.place(wobble(230, 0.8), 20.00, 0.34, pan=0.3, send=0.5)
    s.place(glass(659.26, 0.9, 0.9), 20.04, 0.18, pan=0.3, send=0.55)

    # ── 能力行：五下，一下比一下高 ──
    music(s, 21.70, 25.50, 0.082, seed=81)
    for i, tt in enumerate([21.60, 22.05, 22.50, 22.95, 23.40]):
        s.place(wood(200 + i * 22, 0.12), tt, 0.24, pan=-0.25 + i * 0.12, send=0.3)
        s.place(bubble(420 + i * 60), tt + 0.02, 0.16, pan=-0.25 + i * 0.12, send=0.35)
    s.place(glass(523.25, 1.6, 0.8), 24.10, 0.22, send=0.6)
    s.place(sub(62, 1.1), 24.12, 0.34, send=0.35)

    # ── 折叠：一声下潜，然后安静 ──
    s.place(air(1.1, 1800, 110, 1.1, 0.5), 25.78, 0.44, pan=0.0, send=0.6)
    s.place(sub(52, 1.2), 25.90, 0.40, send=0.4)

    # ── 结尾：那只鲸鱼落定，然后是一个和弦 ──
    s.place(glass(783.99, 1.6, 0.9), 26.50, 0.22, send=0.65)
    music(s, 26.60, 31.40, 0.095, seed=101)
    s.place(glass(392.0, 2.0, 0.7), 28.55, 0.20, send=0.6)
    for i, tt in enumerate([29.90, 30.12, 30.34, 30.56]):
        s.place(tick(360 + i * 26, 0.07), tt, 0.10, pan=-0.2 + i * 0.14, send=0.3)
    s.place(glass(523.25, 2.2, 0.7), 30.90, 0.19, send=0.65)
    s.place(sub(44, 2.0), 30.92, 0.42, send=0.4)

    s.write(out, peak_db=-8.0)
    print("events:", len(s.events), "| dur:", DUR)


if __name__ == "__main__":
    main()
