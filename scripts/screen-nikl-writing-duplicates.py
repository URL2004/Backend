"""Bounded lexical screening with hashed 5-grams. No original text in output."""
from collections import Counter, defaultdict
from functools import lru_cache
import hashlib
import heapq
import importlib.util
import json
from pathlib import Path
import sys
import unicodedata

spec=importlib.util.spec_from_file_location('nikl',Path(__file__).with_name('build-nikl-writing-corpus.py'))
nikl=importlib.util.module_from_spec(spec);spec.loader.exec_module(nikl)

def grams(text):
    return {int.from_bytes(hashlib.blake2b(text[i:i+5].encode('utf-8'),digest_size=8).digest(),'big') for i in range(len(text)-4)}

def main(config_path):
    config=nikl.read_json(Path(config_path).read_bytes())
    _,data=nikl.checked_file(config['manifest']);manifest=nikl.read_json(data)
    base=Path(config['manifest']['path']).resolve().parent
    text_bytes=(base/'texts.local.json').read_bytes()
    if nikl.sha(text_bytes)!=manifest['files']['texts.local.json']:raise ValueError('texts_changed')
    texts=nikl.read_json(text_bytes);unique={}
    for r in manifest['records']:
        normalized=' '.join(unicodedata.normalize('NFKC',texts[r['id']]).split())
        if nikl.sha(normalized)!=r['corpusNormalizedSha256']:raise ValueError('text_hash_changed')
        unique.setdefault(r['corpusNormalizedSha256'],{'id':r['id'],'hash':r['corpusNormalizedSha256'],
            'family':r['familyId'],'text':normalized,'prior':False})
    prior_files=[]
    for source in config['priorTexts']:
        p,data=nikl.checked_file(source);prior=nikl.read_json(data)
        if not isinstance(prior,dict) or not all(isinstance(x,str) for x in prior.values()):raise ValueError('prior_text_map_required')
        prior_files.append({'path':str(p),'sha256':source['sha256']})
        for text in prior.values():
            normalized=' '.join(unicodedata.normalize('NFKC',text).split());h=nikl.sha(normalized)
            if h in unique:unique[h]['prior']=True
            else:unique[h]={'id':None,'hash':h,'family':None,'text':normalized,'prior':True}
    nodes=list(unique.values());signatures=[];postings=defaultdict(list)
    for i,r in enumerate(nodes):
        signature=heapq.nsmallest(16,grams(r['text'])) if len(r['text'])>=100 else []
        signatures.append(signature)
        for anchor in signature:postings[anchor].append(i)
    # High-frequency anchors are not useful candidates; this is a stated recall limit.
    usable={k:v for k,v in postings.items() if len(v)<=200}
    @lru_cache(maxsize=256)
    def gramset(i):return grams(nodes[i]['text'])
    links=[];comparisons=0;cap=250000;complete=True
    for i,r in enumerate(nodes):
        if r['id'] and r['prior']:
            links.append({'left':{'id':r['id'],'hash':r['hash']},'right':{'id':None,'hash':r['hash']},'jaccard':1,'containment':1})
        candidates=Counter(j for anchor in signatures[i] for j in usable.get(anchor,[]) if j<i)
        for j,shared in candidates.items():
            other=nodes[j]
            if shared<3 or (not r['id'] and not other['id']) or (r['family'] and r['family']==other['family']):continue
            lo,hi=sorted((len(r['text']),len(other['text'])))
            if not hi or lo/hi<.25:continue
            comparisons+=1
            if comparisons>cap:complete=False;break
            a,b=gramset(i),gramset(j);intersection=len(a&b)
            jac=intersection/len(a|b) if a or b else 0;contain=intersection/min(len(a),len(b)) if a and b else 0
            if jac>=.85 or contain>=.95:
                left,right=(r,other) if r['id'] else (other,r)
                links.append({'left':{'id':left['id'],'hash':left['hash']},'right':{'id':right['id'],'hash':right['hash']},'jaccard':jac,'containment':contain})
        if not complete:break
    output=nikl.external_path(config['output'])
    if output.exists():raise ValueError('output_exists')
    result={'version':'nikl-near-duplicates-v1','complete':complete,'method':'character_5gram_bottom16_anchors',
        'archiveHashes':[a['sha256'] for a in manifest['archives']], 'manifestSha256':config['manifest']['sha256'],
        'priorTexts':prior_files,'uniqueTexts':len(nodes),'candidateComparisons':comparisons,
        'skippedFrequentAnchors':len(postings)-len(usable),'shortTextsNotScreened':sum(len(r['text'])<100 for r in nodes),
        'links':links,'limitations':'Lexical screen, not semantic identity or exhaustive recall. Ignores >200-frequency anchors, <100-char texts, length ratios <.25, and fewer than three shared bottom-16 anchors.'}
    output.parent.mkdir(parents=True,exist_ok=True)
    with output.open('xb') as f:f.write(nikl.encoded(result))
    print(json.dumps({k:v for k,v in result.items() if k not in ['links','archiveHashes','priorTexts']},indent=2))
    print('links:',len(links))
    if not complete:raise ValueError('candidate_cap_exceeded_do_not_certify_holdout')
    return result

if __name__=='__main__':main(sys.argv[1])
