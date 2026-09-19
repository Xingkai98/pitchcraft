import json, math, statistics as st, collections
PITCH_L=105.0; PITCH_W=68.0
def q(a,p):
    a=sorted(a); h=(len(a)-1)*p; lo=math.floor(h); hi=math.ceil(h)
    return a[lo]+(h-lo)*(a[hi]-a[lo])
D=json.load(open('/tmp/p38/beat-probe.json'))
# Row: 4,5=raw(formation_target)  6,7=tgt(post-repulsion)  2,3=from(actual)  10,11=cand(mover to_)
rep=[]; repx=[]  # raw→tgt = repulsion
fault_t=[]; fault_a=[]; seq_t=[]; seq_a=[]
gapcd=[]; gapcd_t=[]
for g in D:
    beats=collections.defaultdict(lambda: collections.defaultdict(list))
    for r in g['rows']:
        if r[9]!=0: continue
        beats[r[0]][0 if r[1]<=10 else 1].append(r)
    for t,teams in beats.items():
        for team,rs in teams.items():
            if len(rs)<8: continue
            sign = -1 if team==1 else 1
            def X(r,i): 
                v=r[i]*PITCH_L
                return PITCH_L-v if team==1 else v
            def Y(r,i): return r[i]*PITCH_W
            raw=[(X(r,4),Y(r,5)) for r in rs]
            tgt=[(X(r,6),Y(r,7)) for r in rs]
            act=[(X(r,2),Y(r,3)) for r in rs]
            for p1,p2 in zip(raw,tgt):
                rep.append(abs(p2[1]-p1[1])); repx.append(abs(p2[0]-p1[0]))
            # 次序间距（断层）
            def order_gaps(pts):
                xs=sorted(p[0] for p in pts)
                return [xs[i+1]-xs[i] for i in range(len(xs)-1)]
            gt=order_gaps(tgt); ga=order_gaps(act)
            if gt: fault_t.append(max(gt)); seq_t.append(gt)
            if ga: fault_a.append(max(ga)); seq_a.append(ga)
            # 两队重心间距
            def cent(pts): return (sum(p[0] for p in pts)/len(pts), sum(p[1] for p in pts)/len(pts))
            c_t=cent(tgt); c_a=cent(act)
            gapcd_t.append(c_t)
            gapcd.append(c_a)
# 重心间距需要两队同拍——改用逐拍配对
gapT=[]; gapA=[]
for g in D:
    beats=collections.defaultdict(dict)
    for r in g['rows']:
        if r[9]!=0: continue
        beats[r[0]][0 if r[1]<=10 else 1]=r  # 不够，需要全队
    pass
print("=== repulsion（raw→tgt）推移量，仅 formation 目标球员 ===")
print(f"  |Δy| mean={st.mean(rep):.4f}m p90={q(rep,.9):.4f} p99={q(rep,.99):.3f} max={max(rep):.3f}")
print(f"  |Δx| mean={st.mean(repx):.4f}m p90={q(repx,.9):.4f} p99={q(repx,.99):.3f} max={max(repx):.3f}")
print("\n=== 断层（相邻次序间距最大值，单位 m）===")
print(f"  目标位置 n={len(fault_t)} mean={st.mean(fault_t):.2f} p50={q(fault_t,.5):.2f} p90={q(fault_t,.9):.2f} max={max(fault_t):.2f}")
print(f"  实际位置 n={len(fault_a)} mean={st.mean(fault_a):.2f} p50={q(fault_a,.5):.2f} p90={q(fault_a,.9):.2f} max={max(fault_a):.2f}")
mt=[st.mean(s) for s in seq_t]; ma=[st.mean(s) for s in seq_a]
print(f"\n  平均间距序列（目标）: {' / '.join(f'{v:.1f}' for v in mt)}")
print(f"  平均间距序列（实际）: {' / '.join(f'{v:.1f}' for v in ma)}")
print(f"\n  最大间距（断层）均值：目标 {st.mean([max(s) for s in seq_t]):.1f}m  实际 {st.mean([max(s) for s in seq_a]):.1f}m")
