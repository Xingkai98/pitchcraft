import json, math, statistics as st
PITCH_L=105.0; PITCH_W=68.0
def q(a,p):
    a=sorted(a); h=(len(a)-1)*p; lo=math.floor(h); hi=math.ceil(h)
    return a[lo]+(h-lo)*(a[hi]-a[lo])
D=json.load(open('/tmp/p38/beat-probe.json'))
# Row = [t,id,from_x,from_y,raw_x,raw_y,tgt_x,tgt_y,has_mover,kind,cand_x,cand_y,play,ball_x,ball_y]
IDX_ACT=(2,3); IDX_TGT=(4,5)

res={t:{'hd':[], 'spread':[], 'width':[]} for t in ('actual','target')}
gap=[]
for g in D:
    beats={}
    for r in g['rows']:
        if r[9]!=0: continue
        team=0 if r[1]<=10 else 1
        beats.setdefault(r[0],{}).setdefault(team,[]).append(r)
    for t,teams in beats.items():
        for team,rs in teams.items():
            if len(rs)<8: continue
            # 客队镜像到「进攻向右」坐标系
            def cnv(r,i):
                x=r[i]*PITCH_L; y=r[i+1]*PITCH_W
                return (PITCH_L-x if team==1 else x, y)
            act=[cnv(r,IDX_ACT[0]) for r in rs]
            tgt=[cnv(r,IDX_TGT[0]) for r in rs]
            for tag,pts in (('actual',act),('target',tgt)):
                xs=sorted(p[0] for p in pts); ys=[p[1] for p in pts]
                res[tag]['hd'].append(q(xs,0.9)-q(xs,0.1))
                res[tag]['spread'].append(max(ys)-min(ys))
                res[tag]['width'].append(max(xs)-min(xs))
            gap.extend(math.hypot(a[0]-b[0],a[1]-b[1]) for a,b in zip(act,tgt))

print("=== 队形指标：球员实际位置 vs 同一拍的目标位置（9 名外场，非 carrier；客队已镜像）===")
print(f"{'指标':<14}{'目标':>9}{'实际':>9}{'差':>9}{'差%':>8}")
for k,label in (('hd','纵深 q10-q90'),('spread','紧凑 y-span'),('width','宽度 x-span')):
    tg=st.mean(res['target'][k]); ac=st.mean(res['actual'][k])
    print(f"{label:<14}{tg:>9.2f}{ac:>9.2f}{ac-tg:>9.3f}{100*(ac-tg)/tg:>7.1f}%")
print(f"\n帧数 n={len(res['actual']['hd'])}")
print(f"单球员实际↔目标 距离：mean={st.mean(gap):.2f}m  p50={q(gap,.5):.2f}  p90={q(gap,.9):.2f}  max={max(gap):.2f}")
