import json, math, statistics as st, collections
PITCH_L=105.0; PITCH_W=68.0; RUN=4.0
def q(a,p):
    a=sorted(a); h=(len(a)-1)*p; lo=math.floor(h); hi=math.ceil(h)
    return a[lo]+(h-lo)*(a[hi]-a[lo])
D=json.load(open('/tmp/p38/beat-probe.json'))
ballx=[]; bally=[]; cap=0; nmov=0; diag_cap=0; purex=0; purey=0
steps=[]
firstt={}
for g in D:
    for r in g['rows']:
        if r[9]!=0: continue
        ballx.append(r[13]); bally.append(r[14])
        if r[8]:
            nmov+=1
            dx=(r[10]-r[2]); dy=(r[11]-r[3]); L=math.hypot(dx,dy)
            steps.append(L*PITCH_L if abs(dy)<1e-12 else math.hypot(dx*PITCH_L,dy*PITCH_W))
            if abs(L - RUN/PITCH_L)<1e-9:
                cap+=1
                if abs(dy)<1e-12: purex+=1
                elif abs(dx)<1e-12: purey+=1
                else: diag_cap+=1
        firstt.setdefault(r[1], []).append(r)
print("=== 球位范围（open 拍）===")
print(f"  ball.x  轨迹（x*PITCH_L，因队形公式用的是归一化 x）：p1={q(r[13] for r in g['rows']) if False else q(ballx,.01):.3f}  p50={q(ballx,.5):.3f}  p99={q(ballx,.99):.3f}  min={min(ballx):.3f} max={max(ballx):.3f}")
print(f"  ball.y   p1={q(bally,.01):.3f}  p50={q(bally,.5):.3f}  p99={q(bally,.99):.3f}")
print(f"\n  → 球位 x 的实际覆盖 [{(min(ballx)-0.5)*0.06*PITCH_L:+.1f}m, {(max(ballx)-0.5)*0.06*PITCH_L:+.1f}m] 横向位移（SIDE_SHIFT_FACTOR=0.06）")
print(f"  → 球位 y 的实际覆盖 [{(min(bally)-0.5)*0.06*0.6*PITCH_W:+.2f}m, {(max(bally)-0.5)*0.06*0.6*PITCH_W:+.2f}m]（y 项 ×0.6）")
print(f"\n=== mover 步长触顶 ===")
print(f"  产 mover 拍数 {nmov}  触顶(={RUN}m/105 归一化) {cap} ({100*cap/nmov:.2f}%)")
print(f"    其中 纯x {purex} / 纯y {purey} / 斜向 {diag_cap}")
print(f"  步长（实际米）：mean={st.mean(steps):.2f} p50={q(steps,.5):.2f} p90={q(steps,.9):.2f} max={max(steps):.2f}")
