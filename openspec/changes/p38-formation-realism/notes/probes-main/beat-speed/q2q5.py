import json, math, statistics as st, collections
PITCH_L=105.0; PITCH_W=68.0
def q(a,p):
    a=sorted(a); h=(len(a)-1)*p; lo=math.floor(h); hi=math.ceil(h)
    return a[lo]+(h-lo)*(a[hi]-a[lo])
D=json.load(open('/tmp/p38/beat-probe.json'))

# 拍首差距 × 是否产 mover
g_mv=[]; g_idle=[]
# 滞后投影（负=球员落在目标运动方向的反侧=落后）；归一化为「占目标本拍步长的比例」
proj_norm=[]
# 拍末差距
end_gap=[]
for g in D:
    seq=collections.defaultdict(list)
    for r in g['rows']:
        if r[9]!=0: continue
        seq[r[1]].append(r)
    for pid,rs in seq.items():
        rs.sort(key=lambda r:r[0])
        for k in range(len(rs)-1):
            a=rs[k]; b=rs[k+1]
            gap=m=math.hypot((a[2]-a[4])*PITCH_L,(a[3]-a[5])*PITCH_W)
            (g_mv if a[8] else g_idle).append(gap)
            # 投影
            dvx=(b[4]-a[4])*PITCH_L; dvy=(b[5]-a[5])*PITCH_W; L=math.hypot(dvx,dvy)
            if L>0.05:
                px=(b[2]-b[4])*PITCH_L; py=(b[3]-b[5])*PITCH_W
                proj_norm.append(((px*dvx+py*dvy)/L)/L)
            end_gap.append(math.hypot((b[2]-b[4])*PITCH_L,(b[3]-b[5])*PITCH_W))

print("=== Q1/Q3 拍首差距 × 是否产 mover ===")
for lbl,v in (('产 mover 的拍',g_mv),('静止拍（dead-zone 内）',g_idle)):
    print(f"  {lbl:<22} n={len(v):7d} ({100*len(v)/(len(g_mv)+len(g_idle)):5.1f}%)  mean={st.mean(v):5.2f}  p50={q(v,.5):5.2f}  p90={q(v,.9):5.2f}  p99={q(v,.99):6.2f}  max={max(v):6.2f}")

print("\n=== Q2 拍首 vs 拍末差距 ===")
print(f"  拍首 mean={st.mean(g_mv+g_idle):.3f}  拍末 mean={st.mean(end_gap):.3f}  → 单拍净收敛 {st.mean(g_mv+g_idle)-st.mean(end_gap):+.3f}m")

print("\n=== Q2 滞后投影（占目标本拍步长比例；<0 = 球员落在目标身后 = 落后）===")
print(f"  n={len(proj_norm)}  mean={st.mean(proj_norm):+.3f}  p10={q(proj_norm,.1):+.3f}  p50={q(proj_norm,.5):+.3f}  p90={q(proj_norm,.9):+.3f}")
neg=sum(1 for v in proj_norm if v<-0.5); print(f"  落后超过半个步长的占比 {100*neg/len(proj_norm):.1f}%")
