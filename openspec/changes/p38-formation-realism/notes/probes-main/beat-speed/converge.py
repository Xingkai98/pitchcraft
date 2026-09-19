import json, math, statistics as st
PITCH_L=105.0; PITCH_W=68.0
def q(a,p):
    a=sorted(a); h=(len(a)-1)*p; lo=math.floor(h); hi=math.ceil(h)
    return a[lo]+(h-lo)*(a[hi]-a[lo])
D=json.load(open('/tmp/p38/beat-probe.json'))
gs=[]; ge=[]; gs2=[]; ge2=[]
for g in D:
    seq={}
    for r in g['rows']:
        if r[9]!=0: continue
        seq.setdefault(r[1],[]).append(r)
    for pid,rs in seq.items():
        rs.sort(key=lambda r:r[0])
        for k in range(len(rs)-1):
            a=rs[k]; b=rs[k+1]
            if a[12]!=0 or b[12]!=0: continue
            ga=math.hypot((a[2]-a[4])*PITCH_L,(a[3]-a[5])*PITCH_W)
            gb=math.hypot((b[2]-b[4])*PITCH_L,(b[3]-b[5])*PITCH_W)
            if a[8]:   # 本拍产了 mover
                gs.append(ga); ge.append(gb)
            else:
                gs2.append(ga); ge2.append(gb)
print("=== 产 mover 的拍：拍首差距 → 拍末差距（米）===")
print(f"  n={len(gs)}  拍首 mean={st.mean(gs):.2f} p50={q(gs,.5):.2f} p90={q(gs,.9):.2f}  |  拍末 mean={st.mean(ge):.2f} p50={q(ge,.5):.2f} p90={q(ge,.9):.2f}")
print(f"  → 平均收敛 {st.mean(gs)-st.mean(ge):+.2f}m")
print(f"  拍末仍 >2m 的占比 {100*sum(1 for v in ge if v>2)/len(ge):.1f}%")
print("\n=== 静止拍（dead-zone 内，不产 mover）===")
print(f"  n={len(gs2)}  拍首 mean={st.mean(gs2):.2f}  拍末 mean={st.mean(ge2):.2f}  （理论 ≤2.0m 归一化欧氏 ⇒ 米制各向异性）")
print("\n=== 归一化 dead-zone 的米制换算 ===")
print(f"  DEAD_ZONE_METERS=2.0 → norm_step=2/105={2/105:.5f}")
print(f"  纯 x 方向 = 2.00m ; 纯 y 方向 = {2/105*68:.2f}m（横向死区只有纵向的 65%）")
