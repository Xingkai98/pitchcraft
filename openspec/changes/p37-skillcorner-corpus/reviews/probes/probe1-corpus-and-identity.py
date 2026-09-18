#!/usr/bin/env python3
"""SkillCorner 接入前的定量侦察（一次性分析，不入库）。

目的：量化 is_detected 口径（全点 vs 仅真检测）对「可用帧数」与「三项指标」的影响，
作为 design 决策依据。同时核对时间轴连续性、球场尺寸、朝向。
"""
import json, statistics, collections

BASE = '/tmp/sc-probe'
MID = 1874553


def parse_clock(s):
    if not isinstance(s, str):
        return None
    p = s.split(':')
    if len(p) != 3:
        return None
    try:
        return int(p[0]) * 3600 + int(p[1]) * 60 + float(p[2])
    except ValueError:
        return None


match = json.load(open(f'{BASE}/opendata-master/data/matches/{MID}/{MID}_match.json'))
L = match['pitch_length']
W = match['pitch_width']
sides = match['home_team_side']
HOME = match['home_team']['id']
AWAY = match['away_team']['id']
byid = {p['id']: p for p in match['players']}


def team_of(pid):
    p = byid.get(pid)
    if not p:
        return None
    if p['team_id'] == HOME:
        return 'home'
    if p['team_id'] == AWAY:
        return 'away'
    return None


def is_gk(pid):
    p = byid.get(pid)
    if not p:
        return False
    r = p['player_role']
    return r['name'] == 'Goalkeeper' or 'Goalkeeper' in (r['position_group'] or '')


# ── 读帧 ────────────────────────────────────────────────────────────────
raw = []
for line in open(f'{BASE}/tracking/{MID}_tracking.jsonl'):
    line = line.strip()
    if not line:
        continue
    d = json.loads(line)
    pd = d.get('player_data') or []
    if not pd:
        continue
    raw.append({
        'frame': d['frame'],
        'period': d.get('period'),
        't': parse_clock(d.get('timestamp')),
        'pd': pd,
        'ball': d.get('ball_data') or {},
    })

print('== 时间轴 / 帧数 ==')
print('有 player_data 的帧:', len(raw), '/ 60301')
print('t 范围: %.2f .. %.2f' % (raw[0]['t'], raw[-1]['t']))
deltas = collections.Counter()
for a, b in zip(raw, raw[1:]):
    if a['t'] is None or b['t'] is None:
        continue
    deltas[round(b['t'] - a['t'], 3)] += 1
print('相邻 t 差(前5):', deltas.most_common(5))

# 半场边界
for per in (1, 2):
    seg = [f for f in raw if f['period'] == per]
    if seg:
        print('  P%d: %d 帧, t %.1f..%.1f' % (per, len(seg), seg[0]['t'], seg[-1]['t']))

# ── 坐标归一 + 指标 ─────────────────────────────────────────────────────
PITCH_M_X, PITCH_M_Y = 105.0, 68.0


def norm(pid, x, y, period):
    if x is None or y is None:
        return None
    x01 = x / L + 0.5
    side = sides[period - 1] if 0 <= period - 1 < len(sides) else 'left_to_right'
    if side == 'right_to_left':
        x01 = 1.0 - x01
    y01 = 1.0 - (y / W + 0.5)
    return (x01, y01)


def trim1(pts):
    """pts: [(x_m, y_m)]  非门将。返回 (depth, spread, cx, cy)"""
    if len(pts) < 7:
        return None
    xs = sorted(p[0] for p in pts)
    depth = xs[-2] - xs[1]
    cx = sum(p[0] for p in pts) / len(pts)
    cy = sum(p[1] for p in pts) / len(pts)
    spread = sum(((p[0] - cx) ** 2 + (p[1] - cy) ** 2) ** 0.5 for p in pts) / len(pts)
    return depth, spread, cx, cy


def frame_metrics(f, mode):
    """mode: 'all' | 'detected'"""
    per = f['period']
    if per not in (1, 2):
        return None
    sides_pts = {'home': [], 'away': []}
    seen = set()
    for p in f['pd']:
        pid = p['player_id']
        if pid in seen or is_gk(pid):
            continue
        t = team_of(pid)
        if t is None:
            continue
        if mode == 'detected' and not p.get('is_detected'):
            continue
        c = norm(pid, p.get('x'), p.get('y'), per)
        if c is None:
            continue
        seen.add(pid)
        sides_pts[t].append((c[0] * PITCH_M_X, c[1] * PITCH_M_Y))
    h = trim1(sides_pts['home'])
    a = trim1(sides_pts['away'])
    if not h or not a:
        return None
    gap = ((h[2] - a[2]) ** 2 + (h[3] - a[3]) ** 2) ** 0.5
    return {'hd': h[0], 'ad': a[0], 'spread': h[1], 'gap': gap}


# 5Hz 抽样（stride 2）
kf = raw[::2]


def cut_windows(frames):
    out = []
    T = frames[-1]['t']
    s = 0
    while s + 300 <= T + 1:
        w = [f for f in frames if s <= f['t'] < s + 300]
        out.append((s, w))
        s += 900
    return out


wins = cut_windows(kf)
print()
print('== 窗口（5Hz 抽样后 %d 帧，300s 窗 / 步长 900s）==' % len(kf))
print('窗口数:', len(wins))

print()
print('%-7s %-9s %-9s %-9s | %-8s %-8s %-8s %-8s' % (
    'start', 'kf', 'ok_all', 'ok_det', 'hd', 'spread', 'gap', 'hd_det'))
for s, w in wins:
    m_all = [frame_metrics(f, 'all') for f in w]
    m_det = [frame_metrics(f, 'detected') for f in w]
    a = [m for m in m_all if m]
    d = [m for m in m_det if m]
    def mean(xs, k):
        return sum(x[k] for x in xs) / len(xs) if xs else float('nan')
    print('%-7d %-9d %-9d %-9d | %-8.1f %-8.1f %-8.1f %-8.1f' % (
        s, len(w), len(a), len(d),
        mean(a, 'hd'), mean(a, 'spread'), mean(a, 'gap'), mean(d, 'hd')))

# 全量：可用帧占比
tot = len(kf)
ok_all = sum(1 for f in kf if frame_metrics(f, 'all'))
ok_det = sum(1 for f in kf if frame_metrics(f, 'detected'))
print()
print('== 全片可用帧 ==')
print('5Hz 帧总数 %d；全点口径可用 %d (%.1f%%)；仅真检测口径可用 %d (%.1f%%)'
      % (tot, ok_all, 100 * ok_all / tot, ok_det, 100 * ok_det / tot))

# 球
btot = sum(1 for f in kf if f['ball'].get('x') is not None)
bdet = sum(1 for f in kf if f['ball'].get('x') is not None and f['ball'].get('is_detected'))
print('球坐标帧 %d (%.1f%%)；其中真检测 %d (%.1f%% of 有坐标, %.1f%% of 全帧)'
      % (btot, 100 * btot / tot, bdet, 100 * bdet / btot, 100 * bdet / tot))
