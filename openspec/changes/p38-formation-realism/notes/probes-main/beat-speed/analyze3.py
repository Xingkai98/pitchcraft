import json, math, statistics as st
PITCH_L=105.0; PITCH_W=68.0; RUN_SPEED=4.0
DEAD_ZONE_M=2.0
def m2(p,q): return math.hypot((p[0]-q[0])*PITCH_L,(p[1]-q[1])*PITCH_W)
def sd(a):
    m=sum(a)/len(a); return math.sqrt(sum((v-m)**2 for v in a)/len(a))
def q(a,p):
    a=sorted(a); h=(len(a)-1)*p; lo=math.floor(h); hi=math.ceil(h)
    return a[lo]+(h-lo)*(a[hi]-a[lo])
D=json.load(open('/tmp/p38/beat-probe.json'))
PLAY={0:'open',1:'transition',2:'highlight',3:'loose',4:'restart_prep',5:'dead_ball'}

# ---- 大差距出现在哪 ----
import collections
byplay=collections.Counter(); big=collections.Counter()
gaps_by_play=collections.defaultdict(list)
for g in D:
    for r in g['rows']:
        t,pid,fx,fy,rx,ry,tx,ty,hm,kind,cx,cy,play,bx,by=r
        if kind!=0: continue
        gg=m2((fx,fy),(rx,ry))
        byplay[PLAY[play]]+=1
        gaps_by_play[PLAY[play]].append(gg)
        if gg>5: big[PLAY[play]]+=1
print("=== 拍首差距 >5m 的分布 ===")
for k in sorted(gaps_by_play):
    a=gaps_by_play[k]
    print(f"  {k:<12} n={len(a):7d}  >5m {big[k]:6d} ({100*big[k]/len(a):5.2f}%)  p99={q(a,.99):6.2f} max={max(a):6.2f}")

# ---- Q5 横向专项：目标自身的 y 运动 vs 实际的 y 运动 ----
print("\n=== Q5 横向：目标 y 运动 vs 球员 y 运动（只取 open 状态 = 队形目标常态）===")
recs=[]
for g in D:
    for pid,rs in g.get('seq',{}).items() if 'seq' in g else []: pass
# 重建 seq（analyze2 未持久化）
for g in D:
    seq={}
    for r in g['rows']:
        if r[9]!=0: continue
        seq.setdefault(r[1],[]).append(r)
    for pid,rs in seq.items():
        ro=[r for r in rs if r[12]==0]
        if len(ro)<200: continue
        ty=[r[5] for r in ro]; ay=[r[3] for r in ro]
        txr=[r[4] for r in ro]; ax=[r[2] for r in ro]
        recs.append(dict(seed=g['seed'],id=pid,
            ty_sd=sd(ty)*PITCH_W, ay_sd=sd(ay)*PITCH_W,
            tx_sd=sd(txr)*PITCH_L, ax_sd=sd(ax)*PITCH_L,
            ty_range=(max(ty)-min(ty))*PITCH_W, ay_range=(max(ay)-min(ay))*PITCH_W,
            tgap=st.mean([abs(r[5]-r[3])*PITCH_W for r in ro]),
            xgap=st.mean([abs(r[4]-r[2])*PITCH_L for r in ro])))
for k in ('ty_sd','ay_sd','tx_sd','ax_sd','ty_range','ay_range','tgap','xgap'):
    v=[r[k] for r in recs]
    print(f"  {k:<9} n={len(v)} mean={st.mean(v):7.3f}  p50={q(v,.5):7.3f}  p90={q(v,.9):7.3f}  max={max(v):7.3f}")

# ---- 目标 y 的每拍增量 vs dead zone ----
dy=[]; dy_m=[]; dx_m=[]
for g in D:
    seq={}
    for r in g['rows']:
        if r[9]!=0: continue
        seq.setdefault(r[1],[]).append(r)
    for pid,rs in seq.items():
        ro=[r for r in rs if r[12]==0]
        for k in range(len(ro)-1):
            a=ro[k]; b=ro[k+1]
            dy.append(abs(b[5]-a[5])); dy_m.append(abs(b[5]-a[5])*PITCH_W); dx_m.append(abs(b[4]-a[4])*PITCH_L)
print(f"\n  目标 y 每拍变化：mean={st.mean(dy_m):.4f}m  p50={q(dy_m,.5):.4f}  p90={q(dy_m,.9):.4f}  p99={q(dy_m,.99):.4f}  max={max(dy_m):.3f}")
print(f"  目标 x 每拍变化：mean={st.mean(dx_m):.4f}m  p50={q(dx_m,.5):.4f}  p90={q(dx_m,.9):.4f}  p99={q(dx_m,.99):.4f}  max={max(dx_m):.3f}")
print(f"  dead zone = {DEAD_ZONE_M}m（归一化 {DEAD_ZONE_M/PITCH_L:.5f}，度量用归一化欧氏）")
print(f"  理论最大横向目标位移 = 0.5*SIDE_SHIFT_FACTOR*0.6 = {0.5*0.06*0.6*PITCH_W:.3f}m")
