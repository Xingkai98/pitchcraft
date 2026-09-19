import json, math, statistics as st
PITCH_L=105.0; PITCH_W=68.0; RUN=4.0
CAP=RUN/PITCH_L   # 0.0380952 归一化
def q(a,p):
    a=sorted(a); h=(len(a)-1)*p; lo=math.floor(h); hi=math.ceil(h)
    return a[lo]+(h-lo)*(a[hi]-a[lo])
D=json.load(open('/tmp/p38/beat-probe.json'))
norm=[]; meters=[]; ratio=[]; xstep=[]; ystep=[]
for g in D:
    for r in g['rows']:
        if r[9]!=0 or not r[8]: continue
        dx=r[10]-r[2]; dy=r[11]-r[3]
        L=math.hypot(dx,dy); norm.append(L)
        meters.append(math.hypot(dx*PITCH_L,dy*PITCH_W))
        ratio.append(L/CAP)
        xstep.append(abs(dx)*PITCH_L); ystep.append(abs(dy)*PITCH_W)
print(f"n={len(norm)}")
print("归一化步长 / cap：", " ".join(f"p{int(p*100)}={q(ratio,p):.3f}" for p in (.1,.25,.5,.75,.9,.99)))
print(f"触顶（ratio≥0.9999）占比 {100*sum(1 for v in ratio if v>=0.9999)/len(ratio):.1f}%")
print(f"触顶（ratio≥0.99）  占比 {100*sum(1 for v in ratio if v>=0.99)/len(ratio):.1f}%")
print(f"\n实际米步长：mean={st.mean(meters):.2f} p50={q(meters,.5):.2f} p90={q(meters,.9):.2f} max={max(meters):.2f}")
print(f"x 分量步长：mean={st.mean(xstep):.2f} p90={q(xstep,.9):.2f}")
print(f"y 分量步长：mean={st.mean(ystep):.2f} p90={q(ystep,.9):.2f}")
print(f"\n若为纯 y 方向触顶，米步长只有 {CAP*PITCH_W:.2f}m（y 轴 cap ≠ x 轴 cap）")
print(f"有效「触顶」判定（米步长≥3.99）：{100*sum(1 for v in meters if v>=3.99)/len(meters):.1f}%")
