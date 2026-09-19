import json, math, statistics as st, collections
PITCH_L=105.0; PITCH_W=68.0
def q(a,p):
    a=sorted(a); h=(len(a)-1)*p; lo=math.floor(h); hi=math.ceil(h)
    return a[lo]+(h-lo)*(a[hi]-a[lo])
D=json.load(open('/tmp/p38/beat-probe.json'))
# 只在「本拍产了 mover」时比较 raw→tgt（同拍，无 stale 问题）
py=[]; px=[]; pm=[]
# 每拍每人的 y 位移：目标 vs 实际（同拍，open）
rawY=[]; actY=[]; tgtY=[]
ty_byid=collections.defaultdict(list); ay_byid=collections.defaultdict(list)
for g in D:
    seq=collections.defaultdict(list)
    for r in g['rows']:
        if r[9]!=0: continue
        seq[r[1]].append(r)
    for pid,rs in seq.items():
        rs.sort(key=lambda r:r[0])
        for r in rs:
            ty_byid[pid].append(r[5]*PITCH_W); ay_byid[pid].append(r[3]*PITCH_W)
            if r[12]!=0: continue
            if r[8]:
                py.append(abs(r[7]-r[11])*PITCH_W); px.append(abs(r[6]-r[10])*PITCH_L)
                pm.append(math.hypot((r[6]-r[10])*PITCH_L,(r[7]-r[11])*PITCH_W))
                rawY.append(abs(r[4]-r[2])*PITCH_L*0+abs(r[5]-r[3])*PITCH_W)   # 目标-球员 差距 y
        for k in range(len(rs)-1):
            a=rs[k]; b=rs[k+1]
            if a[12]!=0 or b[12]!=0: continue
            rawY.append(abs(b[5]-a[5])*PITCH_W)             # 目标 y 步
            actY.append(abs(b[3]-a[3])*PITCH_W)             # 球员 y 步
            if a[8] and a[8]==b[8]:
                tgtY.append(abs(b[7]-a[7])*PITCH_W)         # 同拍 tgt y 步（都产 mover）
print("=== 横向来源分解（open 拍）===")
print(f"  formation 目标 y 每拍变化  mean={st.mean(rawY):.4f}m  p90={q(rawY,.9):.4f}  p99={q(rawY,.99):.4f}  max={max(rawY):.3f}")
print(f"  球员实际 y 每拍变化        mean={st.mean(actY):.4f}m  p90={q(actY,.9):.4f}  p99={q(actY,.99):.4f}  max={max(actY):.3f}")
if tgtY: print(f"  同拍 tgt y 变化            n={len(tgtY)} mean={st.mean(tgtY):.4f}m  max={max(tgtY):.3f}")
print(f"\n=== 分离(repulsion)推移量（仅本拍产 mover，同拍比较）===")
print(f"  |Δy| mean={st.mean(py):.4f}m  p90={q(py,.9):.4f}  p99={q(py,.99):.3f}  max={max(py):.3f}   n={len(py)}")
print(f"  |Δx| mean={st.mean(px):.4f}m  p90={q(px,.9):.4f}  p99={q(px,.99):.3f}  max={max(px):.3f}")
print(f"  矢量模 mean={st.mean(pm):.4f}m  p90={q(pm,.9):.4f}  p99={q(pm,.99):.3f}  max={max(pm):.3f}")
print(f"\n=== 逐球员 y 统计 ===")
print(f"  y-sd:  目标 {st.mean([st.pstdev(v) for v in ty_byid.values()]):.3f}m  实际 {st.mean([st.pstdev(v) for v in ay_byid.values()]):.3f}m")
print(f"  y 极差: 目标 {st.mean([max(v)-min(v) for v in ty_byid.values()]):.3f}m  实际 {st.mean([max(v)-min(v) for v in ay_byid.values()]):.3f}m")
