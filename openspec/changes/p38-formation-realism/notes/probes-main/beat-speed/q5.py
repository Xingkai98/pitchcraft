import json, math, statistics as st, collections
PITCH_L=105.0; PITCH_W=68.0
def sd(a):
    m=sum(a)/len(a); return math.sqrt(sum((v-m)**2 for v in a)/len(a))
def q(a,p):
    a=sorted(a); h=(len(a)-1)*p; lo=math.floor(h); hi=math.ceil(h)
    return a[lo]+(h-lo)*(a[hi]-a[lo])
D=json.load(open('/tmp/p38/beat-probe.json'))

# 逐 seed 逐球员序列（全部状态，kind=0）
rep={'y_t':[], 'y_a':[], 'y_gap_t':[], 'y_gap_a':[], 'x_t':[], 'x_a':[]}
# 120s 窗口（与 findings §4b 同口径：t∈[1800,1920]）
rep120={'y_a':[], 'y_t':[], 'x_a':[], 'x_t':[]}
lag_sign=[]   # 差距在目标运动方向上的投影（正 = 落后于目标）
for g in D:
    seq=collections.defaultdict(list)
    for r in g['rows']:
        if r[9]!=0: continue
        seq[r[1]].append(r)
    for pid,rs in seq.items():
        rs.sort(key=lambda r:r[0])
        # 全场比赛：只取 open
        ro=[r for r in rs if r[12]==0]
        if len(ro)<500: continue
        rep['y_t'].append(sd([r[5] for r in ro])*PITCH_W)
        rep['y_a'].append(sd([r[3] for r in ro])*PITCH_W)
        rep['x_t'].append(sd([r[4] for r in ro])*PITCH_L)
        rep['x_a'].append(sd([r[2] for r in ro])*PITCH_L)
        rep['y_gap_t'].append(st.mean([abs(r[5]-r[3])*PITCH_W for r in ro]))
        # 120s 窗
        w=[r for r in ro if 1800<=r[0]<1920]
        if len(w)>100:
            rep120['y_a'].append(sd([r[3] for r in w])*PITCH_W)
            rep120['y_t'].append(sd([r[5] for r in w])*PITCH_W)
            rep120['x_a'].append(sd([r[2] for r in w])*PITCH_L)
            rep120['x_t'].append(sd([r[4] for r in w])*PITCH_L)
        # 落后判定：目标从 raw_t 移到 raw_{t+1}，球员是否落在 target 的「运动方向相反侧」
        for k in range(len(ro)-1):
            a=ro[k]; b=ro[k+1]
            dvx=(b[4]-a[4])*PITCH_L; dvy=(b[5]-a[5])*PITCH_W
            L=math.hypot(dvx,dvy)
            if L<0.05: continue
            # 球员位置相对新目标的向量
            px=(b[2]-b[4])*PITCH_L; py=(b[3]-b[5])*PITCH_W
            lag_sign.append((px*dvx+py*dvy)/L)

print("=== Q5 横向（y）与纵向（x）逐球员 sd，全部 open 拍（整场）===")
for k,lbl in (('x_t','目标 x-sd'),('x_a','实际 x-sd'),('y_t','目标 y-sd'),('y_a','实际 y-sd')):
    v=rep[k]; print(f"  {lbl:<10} n={len(v)}  mean={st.mean(v):6.2f}  p50={q(v,.5):6.2f}  p90={q(v,.9):6.2f}  max={max(v):6.2f}")
print("\n=== 同口径 120s 窗口（t∈[1800,1920]，对齐 findings §4b 的 0.53m）===")
for k,lbl in (('x_t','目标 x-sd'),('x_a','实际 x-sd'),('y_t','目标 y-sd'),('y_a','实际 y-sd')):
    v=rep120[k]
    if v: print(f"  {lbl:<10} n={len(v)}  mean={st.mean(v):6.2f}  p50={q(v,.5):6.2f}  p90={q(v,.9):6.2f}  max={max(v):6.2f}")

print("\n=== 滞后方向判定：球员相对新目标的向量在目标运动方向上的投影 ===")
print(f"  n={len(lag_sign)}  mean={st.mean(lag_sign):+.3f}m  p50={q(lag_sign,.5):+.3f}  p10={q(lag_sign,.1):+.3f}  p90={q(lag_sign,.9):+.3f}")
pos=sum(1 for v in lag_sign if v>0); print(f"  >0（落在目标身后 = 真滞后）占比 {100*pos/len(lag_sign):.1f}%")
