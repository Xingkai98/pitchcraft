#!/usr/bin/env python3
"""SkillCorner 接入侦察（第二轮）：单调时间轴 + is_detected 口径 + 窗口数。

一次性分析，不入库。产出 design 需要的数字。
"""
import json, statistics, collections

BASE = '/tmp/sc-probe'
MID = 1874553

match = json.load(open(f'{BASE}/opendata-master/data/matches/{MID}/{MID}_match.json'))
L, W = match['pitch_length'], match['pitch_width']
sides = match['home_team_side']
HOME, AWAY = match['home_team']['id'], match['away_team']['id']
byid = {p['id']: p for p in match['players']}


def clk(s):
    if not isinstance(s, str):
        return None
    p = s.split(':')
    if len(p) != 3:
        return None
    try:
        return int(p[0]) * 3600 + int(p[1]) * 60 + float(p[2])
    except ValueError:
        return None


def team_of(pid):
    p = byid.get(pid)
    return None if not p else ('home' if p['team_id'] == HOME else 'away' if p['team_id'] == AWAY else None)


def is_gk(pid):
    p = byid.get(pid)
    if not p:
        return False
    r = p['player_role']
    return r['name'] == 'Goalkeeper' or 'Goalkeeper' in (r['position_group'] or '')


raw = []
for line in open(f'{BASE}/tracking/{MID}_tracking.jsonl'):
    line = line.strip()
    if not line:
        continue
    d = json.loads(line)
    if not (d.get('player_data') or []):
        continue
    raw.append(d)

# ── 单调时间轴：P1 原样；P2 平移到 P1 末之后 ──────────────────────────────
periods = {}
for d in raw:
    periods.setdefault(d['period'], []).append(d)
p1 = periods.get(1, [])
p2 = periods.get(2, [])
p1_end = max(clk(d['timestamp']) for d in p1)
p2_start = min(clk(d['timestamp']) for d in p2)
shift = p1_end - p2_start  # P2 加这个偏移
print('== 时间轴拼接 ==')
print('P1 末 %.2fs, P2 起 %.2fs (回跳 %.2fs) → P2 平移 +%.2fs' % (p1_end, p2_start, p2_start - p1_end, shift))
prev = None
gaps = []
for d in raw:
    t = clk(d['timestamp']); t = t + shift if d['period'] == 2 else t
    if prev is not None and t < prev - 0.15:
        gaps.append(('BACK', t - prev))
    if prev is not None and t > prev + 0.15:
        gaps.append(('GAP', t - prev))
    prev = t
gaplist = [g for k, g in gaps if k == 'GAP']
print('拼接后回跳数:', sum(1 for k, _ in gaps if k == 'BACK'))
print('正向间隙数: %d, 最大 %.1fs, 合计 %.1fs' % (len(gaplist), max(gaplist), sum(gaplist)))


def make_t(d):
    t = clk(d['timestamp'])
    return t + shift if d['period'] == 2 else t


for d in raw:
    d['t'] = make_t(d)

# ── 归一 + 指标 ─────────────────────────────────────────────────────────
PITCH_M_X, PITCH_M_Y = 105.0, 68.0


def norm(x, y, period):
    x01 = x / L + 0.5
    side = sides[period - 1] if 0 <= period - 1 < len(sides) else 'left_to_right'
    if side == 'right_to_left':
        x01 = 1.0 - x01
    return (x01, y / W + 0.5)  # y 先归一；下面 y' = 1-y


def trim1(pts):
    if len(pts) < 7:
        return None
    xs = sorted(p[0] for p in pts)
    depth = xs[-2] - xs[1]
    cx = sum(p[0] for p in pts) / len(pts)
    cy = sum(p[1] for p in pts) / len(pts)
    spread = sum(((p[0] - cx) ** 2 + (p[1] - cy) ** 2) ** 0.5 for p in pts) / len(pts)
    return depth, spread, cx, cy


def frame_metrics(f, mode):
    per = f['period']
    if per not in (1, 2):
        return None
    pts = {'home': [], 'away': []}
    seen = set()
    for p in f['player_data']:
        pid = p['player_id']
        if pid in seen or is_gk(pid):
            continue
        t = team_of(pid)
        if t is None or p.get('x') is None:
            continue
        if mode == 'detected' and not p.get('is_detected'):
            continue
        c = norm(p['x'], p['y'], per)
        seen.add(pid)
        pts[t].append((c[0] * PITCH_M_X, (1 - c[1]) * PITCH_M_Y))
    h, a = trim1(pts['home']), trim1(pts['away'])
    if not h or not a:
        return None
    return {'hd': h[0], 'ad': a[0], 'spread': h[1],
            'gap': ((h[2] - a[2]) ** 2 + (h[3] - a[3]) ** 2) ** 0.5}


kf = raw[::2]  # 10fps -> 5Hz
T = kf[-1]['t']
print()
print('== 窗口数（拼接后总时长 %.1fs）==' % T)
for step, size in ((900, 300), (300, 300), (450, 300)):
    n = 0
    s = 0
    while s + size <= T + 1:
        n += 1
        s += step
    print('  步长 %ds / 窗宽 %ds → 每场 %d 窗；20 场 = %d 窗' % (step, size, n, n * 20))


def windows(step=900, size=300):
    out = []
    s = 0
    while s + size <= T + 1:
        out.append((s, [f for f in kf if s <= f['t'] < s + size]))
        s += step
    return out


print()
print('== 逐窗指标（步长 900s）==')


def mean(xs, k):
    return sum(x[k] for x in xs) / len(xs) if xs else float('nan')


print('%-7s %-6s %-8s %-8s | %-21s | %-21s' % ('start', 'kf', 'ok_all', 'ok_det', 'ALL', 'DETECTED'))
print('%-7s %-6s %-8s %-8s | %-6s %-7s %-6s | %-6s %-7s %-6s' % ('', '', '', '', 'hd', 'spread', 'gap', 'hd', 'spread', 'gap'))
for s, w in windows():
    a = [m for m in (frame_metrics(f, 'all') for f in w) if m]
    d = [m for m in (frame_metrics(f, 'detected') for f in w) if m]
    print('%-7d %-6d %-8d %-8d | %-6.1f %-7.1f %-6.1f | %-6.1f %-7.1f %-6.1f' % (
        s, len(w), len(a), len(d), mean(a, 'hd'), mean(a, 'spread'), mean(a, 'gap'),
        mean(d, 'hd'), mean(d, 'spread'), mean(d, 'gap')))

tot = len(kf)
ok_all = sum(1 for f in kf if frame_metrics(f, 'all'))
ok_det = sum(1 for f in kf if frame_metrics(f, 'detected'))
print()
print('== 全片 ==')
print('5Hz 帧 %d；全点可用 %d (%.1f%%)；仅真检测可用 %d (%.1f%%)' % (tot, ok_all, 100 * ok_all / tot, ok_det, 100 * ok_det / tot))
