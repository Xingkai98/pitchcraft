import json, math, statistics as st

PITCH_L=105.0; PITCH_W=68.0
RUN_SPEED=4.0

def m2(p, q):  # meters between two normalized pts
    return math.hypot((p[0]-q[0])*PITCH_L, (p[1]-q[1])*PITCH_W)

D = json.load(open('/tmp/p38/beat-probe.json'))

def q(a, p):
    a=sorted(a); h=(len(a)-1)*p; lo=math.floor(h); hi=math.ceil(h)
    return a[lo]+(h-lo)*(a[hi]-a[lo])

KIND={0:'formation',1:'close_down',2:'chase',3:'corner_setup'}
PLAY={0:'open',1:'transition',2:'highlight',3:'loose',4:'restart_prep',5:'dead_ball'}

allg=[]; allg_form=[]; moved=[]; sat=0; nmov=0
byplay={}
rows_all=[]
for g in D:
    seed=g['seed']
    rows=g['rows']
    for r in rows:
        t,pid,fx,fy,rx,ry,tx,ty,hm,kind,cx,cy,play,bx,by = r
        if kind!=0: continue          # 只看 formation 目标（队形形状问题）
        from_=(fx,fy); raw=(rx,ry)
        if not math.isfinite(cx): cx,cy = fx,fy
        # gap at beat start (player pos vs raw formation target)
        gstart = m2(from_, raw)
        allg_form.append(gstart)
        byplay.setdefault(play, []).append(gstart)
        if hm:
            nmov+=1
            mv = m2(from_,(cx,cy))
            moved.append(mv)
            if mv >= RUN_SPEED - 1e-6: sat+=1
        else:
            moved.append(0.0)

print("=== Q1 gap（球员位置 vs formation_target 原值，米）===")
print(f"  n={len(allg_form)}")
for p in (0.5,0.75,0.9,0.99):
    print(f"  p{int(p*100):<3} {q(allg_form,p):8.2f}")
print(f"  max  {max(allg_form):8.2f}")
print(f"  mean {st.mean(allg_form):8.2f}")

print("\n=== 按比赛状态 ===")
for pl in sorted(byplay):
    a=byplay[pl]
    print(f"  {PLAY[pl]:<12} n={len(a):7d}  mean={st.mean(a):6.2f}  p50={q(a,.5):6.2f}  p90={q(a,.9):7.2f}  max={max(a):7.2f}")

print("\n=== Q3 速度触顶 ===")
print(f"  产 mover 的拍数 n={nmov}  位移均值={st.mean(moved):.3f}m  p50={q(moved,.5):.3f}  p90={q(moved,.9):.3f}  max={max(moved):.3f}")
print(f"  触顶(≥{RUN_SPEED}m) 次数={sat}  占比={100*sat/nmov:.2f}%")
