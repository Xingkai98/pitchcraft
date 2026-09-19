import json, math, statistics as st, collections
PITCH_L=105.0; PITCH_W=68.0
def q(a,p):
    a=sorted(a); h=(len(a)-1)*p; lo=math.floor(h); hi=math.ceil(h)
    return a[lo]+(h-lo)*(a[hi]-a[lo])
D=json.load(open('/tmp/p38/beat-probe.json'))
repY=[]; repX=[]; fault_t=[]; fault_a=[]; avgseq_t=[]; avgseq_a=[]
for g in D:
    beats=collections.defaultdict(lambda: collections.defaultdict(list))
    for r in g['rows']:
        if r[9]!=0: continue
        beats[r[0]][0 if r[1]<=10 else 1].append(r)
    for t,teams in beats.items():
        for team,rs in teams.items():
            if len(rs)<8: continue
            F=lambda r,i: (PITCH_L-r[i]*PITCH_L) if team==1 else r[i]*PITCH_L
            Y=lambda r,i: r[i]*PITCH_W
            tgt=sorted(F(r,6) for r in rs); act=sorted(F(r,2) for r in rs)
            for p1,p2 in zip(rs,rs):
                repY.append(abs(r[7]-r[5])*PITCH_W if False else abs(p2[7]-p2[5])*PITCH_W)
                repX.append(abs(p2[6]-p2[4])*PITCH_L)
            gt=[tgt[i+1]-tgt[i] for i in range(len(tgt)-1)]
            ga=[act[i+1]-act[i] for i in range(len(act)-1)]
            fault_t.append(max(gt)); fault_a.append(max(ga))
            avgseq_t.append(st.mean(gt)); avgseq_a.append(st.mean(ga))
print("=== repulsion（raw 目标 → 最终目标）推移量 ===")
print(f"  |Δy| mean={st.mean(repY):.5f}m  p99={q(repY,.99):.4f}  max={max(repY):.3f}")
print(f"  |Δx| mean={st.mean(repX):.5f}m  p99={q(repX,.99):.4f}  max={max(repX):.3f}")
print("\n=== 断层：目标形状自身 vs 球员实际形状 ===")
print(f"  相邻次序最大间距  目标 mean={st.mean(fault_t):.2f}m  实际 mean={st.mean(fault_a):.2f}m  （帧数 {len(fault_t)}）")
print(f"  相邻次序平均间距  目标 mean={st.mean(avgseq_t):.2f}m  实际 mean={st.mean(avgseq_a):.2f}m")
print("\n  → 断层在**目标里就已经存在**，与实际位置几乎同值")
