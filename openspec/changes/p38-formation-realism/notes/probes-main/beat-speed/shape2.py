import json, math, statistics as st, collections
PITCH_L=105.0; PITCH_W=68.0
def q(a,p):
    a=sorted(a); h=(len(a)-1)*p; lo=math.floor(h); hi=math.ceil(h)
    return a[lo]+(h-lo)*(a[hi]-a[lo])
D=json.load(open('/tmp/p38/beat-probe.json'))
r={'actual':{'hd':[],'spread':[],'width':[]},'target':{'hd':[],'spread':[],'width':[]}}
for g in D:
    beats=collections.defaultdict(lambda: collections.defaultdict(list))
    for rrow in g['rows']:
        if rrow[9]!=0: continue
        beats[rrow[0]][0 if rrow[1]<=10 else 1].append(rrow)
    for t,teams in beats.items():
        for team,rs in teams.items():
            if len(rs)!=9: continue
            F=lambda rrow,i:(PITCH_L-rrow[i]*PITCH_L) if team==1 else rrow[i]*PITCH_L
            for tag,ix in (('actual',2),('target',4)):
                pts=[(F(rrow,ix),rrow[ix+1]*PITCH_W) for rrow in rs]
                xs=sorted(p[0] for p in pts); ys=[p[1] for p in pts]
                r[tag]['hd'].append(q(xs,.9)-q(xs,.1))
                r[tag]['spread'].append(max(ys)-min(ys))
                r[tag]['width'].append(max(xs)-min(xs))
print("每拍每队恰好 9 人，n =",len(r['actual']['hd']))
for k,l in (('hd','纵深'),('spread','紧凑'),('width','宽度')):
    a=st.mean(r['actual'][k]); t2=st.mean(r['target'][k])
    print(f"  {l}: 目标 {t2:7.2f}  实际 {a:7.2f}  差 {a-t2:+.2f} ({100*(a-t2)/t2:+.1f}%)")
