import json, math, statistics as st
PITCH_L=105.0; PITCH_W=68.0; RUN_SPEED=4.0
def m2(p,q): return math.hypot((p[0]-q[0])*PITCH_L,(p[1]-q[1])*PITCH_W)
def q(a,p):
    a=sorted(a); h=(len(a)-1)*p; lo=math.floor(h); hi=math.ceil(h)
    return a[lo]+(h-lo)*(a[hi]-a[lo])
D=json.load(open('/tmp/p38/beat-probe.json'))
PLAY={0:'open',1:'transition',2:'highlight',3:'loose',4:'restart_prep',5:'dead_ball'}

# 逐 seed 逐 id 建序列（只取 formation 目标）
for g in D:
    seq={}
    for r in g['rows']:
        t,pid,fx,fy,rx,ry,tx,ty,hm,kind,cx,cy,play,bx,by=r
        if kind!=0: continue
        seq.setdefault(pid,[]).append(r)
    g['seq']=seq

# ---- Q3 movers 位移 / 触顶（分 x/y 分量，因 cap 各向异性）----
mv=[]; satx=0; saty=0; nmov=0; diag=[]
for g in D:
    for pid,rs in g['seq'].items():
        for r in rs:
            t,pid_,fx,fy,rx,ry,tx,ty,hm,kind,cx,cy,play,bx,by=r
            if not hm: continue
            nmov+=1
            d=m2((fx,fy),(cx,cy)); mv.append(d)
            # 归一化步长（引擎实际用的）
            step=math.hypot(cx-fx,cy-fy)
            if step>=RUN_SPEED/PITCH_L-1e-9:
                # 分解为纯 x / 纯 y 等效
                if abs(cy-fy)<=1e-9: satx+=1
                elif abs(cx-fx)<=1e-9: saty+=1
                else: diag.append(step*math.hypot((cx-fx)/step*PITCH_L,(cy-fy)/step*PITCH_W))
print("=== Q3 mover 位移（米，仅产 mover 的拍）===")
print(f"  n={nmov}  mean={st.mean(mv):.2f}  p50={q(mv,.5):.2f}  p90={q(mv,.9):.2f}  p99={q(mv,.99):.2f}  max={max(mv):.2f}")
print(f"  归一化步长触顶 {RUN_SPEED/PITCH_L:.6f} (={RUN_SPEED}m/105) 的次数：纯x {satx} / 纯y {saty} / 斜向 {len(diag)}  合计 {satx+saty+len(diag)} ({100*(satx+saty+len(diag))/nmov:.2f}%)")
if diag: print(f"  斜向触顶的实际米位移 mean={st.mean(diag):.2f}")

# ---- Q2 目标自身的移动 vs 球员的移动（拍间）----
tg_mv=[]; pl_mv=[]; gap_start=[]; gap_end=[]; gap_start_off=[]; gap_end_off=[]
for g in D:
    for pid,rs in g['seq'].items():
        for k in range(len(rs)-1):
            r=rs[k]; n=rs[k+1]
            _,_,fx,fy,rx,ry,tx,ty,hm,_,cx,cy,play,_,_ = r
            _,_,nfx,nfy,nrx,nry,ntx,nty,nhm,nkind,ncx,ncy,nplay,_,_ = n
            # 只比较同一「命令窗口」：下一拍的 raw 目标与当前 raw 目标同一（近似）
            tmove=m2((rx,ry),(nrx,nry))
            pmove=m2((fx,fy),(nfx,nfy))
            tg_mv.append(tmove); pl_mv.append(pmove); 
            gs=m2((fx,fy),(rx,ry)); ge=m2((nfx,nfy),(rx,ry))
            gap_start.append(gs); gap_end.append(ge)
            if play==0 and nplay==0:
                gap_start_off.append(gs); gap_end_off.append(ge)
print("\n=== Q2 拍间：目标移动 vs 球员移动（米/拍；拍长 1s）===")
print(f"  目标位移  mean={st.mean(tg_mv):.3f} p50={q(tg_mv,.5):.3f} p90={q(tg_mv,.9):.3f} p99={q(tg_mv,.99):.3f} max={max(tg_mv):.2f}")
print(f"  球员位移  mean={st.mean(pl_mv):.3f} p50={q(pl_mv,.5):.3f} p90={q(pl_mv,.9):.3f} p99={q(pl_mv,.99):.3f} max={max(pl_mv):.2f}")
print(f"  拍首差距  mean={st.mean(gap_start):.2f} p50={q(gap_start,.5):.2f} p90={q(gap_start,.9):.2f} p99={q(gap_start,.99):.2f}")
print(f"  拍末差距  mean={st.mean(gap_end):.2f} p50={q(gap_end,.5):.2f} p90={q(gap_end,.9):.2f} p99={q(gap_end,.99):.2f}")
print(f"  [仅 open→open] 拍首 mean={st.mean(gap_start_off):.2f} p50={q(gap_start_off,.5):.2f} p90={q(gap_start_off,.9):.2f}")
print(f"  [仅 open→open] 拍末 mean={st.mean(gap_end_off):.2f} p50={q(gap_end_off,.5):.2f} p90={q(gap_end_off,.9):.2f}")

# ---- 差距分布 tail ----
import collections
buck=collections.Counter()
for v in gap_start:
    if v<1: buck['<1m']+=1
    elif v<2: buck['1-2m']+=1
    elif v<5: buck['2-5m']+=1
    elif v<10: buck['5-10m']+=1
    else: buck['>10m']+=1
n=len(gap_start)
print("\n  拍首差距分桶：" + "  ".join(f"{k}={100*v/n:.2f}%" for k,v in sorted(buck.items())))
