"""Offline NIKL writing intake. Standard library only; never calls a provider."""
import argparse
from collections import Counter, defaultdict
from datetime import date, datetime, timezone, timedelta
import io
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import tempfile
import unicodedata

VERSION = 'nikl-writing-intake-v1'
KINDS = {'raw2023', 'raw2024', 'score2023_1', 'score2023_2', 'score2024', 'instruction2024'}
JS_SPACE = re.compile('[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+')

def sha(value):
    return hashlib.sha256(value if isinstance(value, bytes) else value.encode('utf-8')).hexdigest()

def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')

def unique_object(pairs):
    result = {}
    for k, v in pairs:
        if k in result: raise ValueError('duplicate_json_key:' + k)
        result[k] = v
    return result

def read_json(data):
    return json.loads(data.decode('utf-8-sig'), object_pairs_hook=unique_object,
                      parse_constant=lambda x: (_ for _ in ()).throw(ValueError('nonfinite_json')))

def hashes(text):
    return dict(sha256=sha(text), normalizedSha256=sha(JS_SPACE.sub(' ', unicodedata.normalize('NFC', text)).strip(' ')),
                corpusNormalizedSha256=sha(' '.join(unicodedata.normalize('NFKC', text).split())))

def external_path(value):
    p = Path(value).resolve()
    # Reject any Git checkout, including a linked worktree and a junction to it.
    if any((parent / '.git').exists() for parent in [p, *p.parents]):
        raise ValueError('private_output_inside_git_repository')
    return p

def checked_file(spec):
    p = Path(spec['path']).resolve()
    data = p.read_bytes()
    if not re.fullmatch('[a-f0-9]{64}', spec['sha256']) or sha(data) != spec['sha256']:
        raise ValueError('source_hash_changed:' + p.name)
    return p, data

def text_field(value):
    if not isinstance(value, str): raise ValueError('expected_text_field')
    return value

def body(document):
    paragraphs = document['paragraph']
    if not isinstance(paragraphs, list) or not paragraphs: raise ValueError('paragraphs_missing')
    text = '\n\n'.join(text_field(p['form']) for p in paragraphs)
    if not text.strip(): raise ValueError('empty_document')
    return text

class Families:
    def __init__(self, ids): self.parent = {x: x for x in ids}
    def find(self, x):
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x
    def join(self, a, b): self.parent[self.find(b)] = self.find(a)

def prepare(config):
    import zipfile
    allowed = {'version','outputDirectory','archives','priorManifests','seed','developmentDocumentIds','approval','nearDuplicateScreen'}
    if set(config)-allowed or config.get('version') != VERSION: raise ValueError('invalid_config')
    if not config.get('seed'): raise ValueError('seed_required')
    approval = config['approval']
    if not approval.get('documentNumber') or not approval.get('institution') or approval.get('localEvaluationAuthorized') is not True:
        raise ValueError('local_evaluation_authorization_required')
    if not date.fromisoformat(approval['validFrom']) <= datetime.now(timezone(timedelta(hours=9))).date() <= date.fromisoformat(approval['validThrough']):
        raise ValueError('agreement_outside_valid_period')
    specs = config['archives']
    if len(specs) != 6 or {s['kind'] for s in specs} != KINDS: raise ValueError('six_distinct_corpora_required')
    rows, texts, originals, archive_meta, ids = [], {}, [], [], set()
    for spec in specs:
        p, data = checked_file(spec)
        count = 0
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            entries = z.infolist()
            if len(entries)>20000 or sum(x.file_size for x in entries)>500_000_000: raise ValueError('archive_size_limit')
            names = [x.filename for x in entries]
            if len(names) != len(set(names)): raise ValueError('duplicate_archive_entry')
            for entry in entries:
                name = entry.filename.replace('\\','/')
                if '..' in PurePosixPath(name).parts or name.startswith('/') or ':' in name or entry.flag_bits & 1:
                    raise ValueError('unsafe_archive_entry')
            if z.testzip() is not None: raise ValueError('archive_crc_failed')
            for entry in entries:
                if not entry.filename.lower().endswith('.json'): continue
                payload = read_json(z.read(entry))
                documents = payload['document']
                if not isinstance(documents, list) or not documents: raise ValueError('documents_missing')
                for d in documents:
                    source_id = text_field(d['id'])
                    key = spec['kind'] + ':' + source_id
                    if key in ids: raise ValueError('duplicate_document_id')
                    ids.add(key); count += 1
                    r = dict(id=key, sourceRecordId=source_id, kind=spec['kind'], corpusId=spec['corpusId'],
                        sourceArchiveSha256=spec['sha256'], sourceEntry=entry.filename,
                        sourceDocumentSha256=sha(encoded(d)), sourceYear=payload.get('metadata',{}).get('year'),
                        authorshipGoldEligible=False, writingProcess='unknown', permissions={'localEvaluate':True,'externalTransmit':False,'train':False})
                    if spec['kind']=='instruction2024':
                        if len(d['input'])!=1 or len(d['output'])!=1 or len(d['output'][0]['instruction'])!=1:
                            raise ValueError('instruction_multiplicity_requires_review')
                        inp, out = d['input'][0], d['output'][0]
                        text = text_field(out['instruction'][0]['input_data'])
                        metadata = inp['metadata']; prompt = inp['prompt']
                        r.update(sourceDocumentReferences=sorted({'.'.join(p.get('id','').split('.')[:2]) for p in inp['paragraph'] if p.get('id')}),
                            missingInputReference=any(not p.get('id') for p in inp['paragraph']),
                            feedbackType=out['feedback_type'], textType=out['text_type'], generator=out['llm_type'],
                            outputRole='model_tasks_and_expert_comment_not_gold_rewrite')
                    else:
                        text = body(d); metadata = d['metadata']['author']; prompt = d['metadata']['prompt']
                        if spec['kind'].startswith('score'):
                            r['evaluation'] = d['evaluation']  # Preserve final/re-evaluator roles and all scores.
                    if not text.strip(): raise ValueError('empty_input')
                    r.update(hashes(text))
                    r.update(authorId=text_field(metadata['author_id']), promptNumber=text_field(prompt['prompt_num']),
                        promptHash=hashes(text_field(prompt['prompt_con']))['corpusNormalizedSha256'], chars=len(text))
                    if not r['authorId'] or not r['promptNumber']: raise ValueError('missing_lineage')
                    texts[key] = text; rows.append(r)
                    originals.append(dict(id=key, sourceHeader={k:v for k,v in payload.items() if k!='document'}, document=d))
        if count != spec['expectedDocuments']: raise ValueError('unexpected_document_count:' + spec['kind'])
        archive_meta.append({**spec,'path':str(p),'bytes':len(data),'documents':count})
    return rows, texts, originals, archive_meta

def connect(rows, config):
    uf = Families(r['id'] for r in rows)
    raw = [r for r in rows if r['kind'].startswith('raw')]
    raw_ids = {r['sourceRecordId']:r for r in raw}
    author_prompt = defaultdict(list)
    for r in raw: author_prompt[(r['authorId'],r['promptHash'])].append(r)
    seen, issues = {}, []
    for r in rows:
        for token in ('text:'+r['corpusNormalizedSha256'], 'author:'+r['authorId']):
            if token in seen: uf.join(r['id'],seen[token])
            else: seen[token]=r['id']
        if r['kind'].startswith('raw'): continue
        candidates = author_prompt[(r['authorId'],r['promptHash'])]
        r['linkedRawIds'] = []
        if r['kind'].startswith('score'):
            if len(candidates)==1:
                parent=candidates[0];uf.join(r['id'],parent['id']);r['linkedRawIds']=[parent['id']]
                r['rawTextIdentical']=r['corpusNormalizedSha256']==parent['corpusNormalizedSha256']
                if not r['rawTextIdentical']: issues.append({'id':r['id'],'reason':'score_raw_text_difference','parent':parent['id']})
            else: issues.append({'id':r['id'],'reason':'ambiguous_or_missing_score_parent','candidates':len(candidates)})
        else:
            for ref in r['sourceDocumentReferences']:
                if ref in raw_ids:
                    parent=raw_ids[ref];uf.join(r['id'],parent['id']);r['linkedRawIds'].append(parent['id'])
                    if parent['authorId']!=r['authorId']: issues.append({'id':r['id'],'reason':'instruction_reference_author_conflict'})
                else: issues.append({'id':r['id'],'reason':'unknown_instruction_reference','reference':ref})
            if not r['linkedRawIds'] and len(candidates)==1:
                uf.join(r['id'],candidates[0]['id']);r['linkedRawIds']=[candidates[0]['id']]
                issues.append({'id':r['id'],'reason':'instruction_parent_inferred_from_author_prompt'})
            if r['missingInputReference']: issues.append({'id':r['id'],'reason':'empty_instruction_reference'})
    exposed, prior = set(), []
    for spec in config.get('priorManifests',[]):
        p,data=checked_file(spec); m=read_json(data)
        if not isinstance(m.get('records'),list): raise ValueError('invalid_prior_manifest')
        for r in m['records']:
            for field in ('normalizedSha256','corpusNormalizedSha256','sha256'):
                if r.get(field): exposed.add(r[field])
            exposed.update(k[5:] for k in r.get('lineageKeys',[]) if k.startswith('text:'))
        prior.append(dict(path=str(p),sha256=spec['sha256'],records=len(m['records'])))
    if config.get('nearDuplicateScreen'):
        _,data=checked_file(config['nearDuplicateScreen']);screen=read_json(data)
        by_id={r['id']:r for r in rows}
        if screen.get('complete') is not True: raise ValueError('near_duplicate_screen_incomplete')
        expected_archives=sorted(s['sha256'] for s in config['archives'])
        if sorted(screen['archiveHashes'])!=expected_archives: raise ValueError('near_duplicate_screen_sources_changed')
        for link in screen['links']:
            left=by_id[link['left']['id']]
            if left['corpusNormalizedSha256']!=link['left']['hash']: raise ValueError('near_duplicate_link_changed')
            if link['right'].get('id'):
                right=by_id[link['right']['id']]
                if right['corpusNormalizedSha256']!=link['right']['hash']: raise ValueError('near_duplicate_link_changed')
                uf.join(left['id'],right['id'])
            else:
                exposed.add(left['corpusNormalizedSha256'])
    groups=defaultdict(list)
    for r in rows: groups[uf.find(r['id'])].append(r)
    known=set(config.get('developmentDocumentIds',[])); problematic={x['id'] for x in issues}
    for members in groups.values():
        family=sha('\0'.join(sorted(r['id'] for r in members)))
        overlap=any(any(r[k] in exposed for k in ('sha256','normalizedSha256','corpusNormalizedSha256')) for r in members)
        observed=any(r['sourceRecordId'] in known for r in members)
        review=any(r['id'] in problematic for r in members)
        partition=int(sha(config['seed']+'\0'+family)[:8],16)%10
        split='development' if overlap or observed or review or partition<6 else ('validation' if partition<8 else 'holdout_candidate')
        for r in members:
            r.update(familyId=family,split=split,priorExposure=overlap,observedExample=observed,lineageReviewRequired=review)
    return issues, prior

def main(config_path):
    config=read_json(Path(config_path).read_bytes())
    dest=external_path(config['outputDirectory'])
    if dest.exists(): raise ValueError('output_must_not_exist')
    rows,texts,originals,archives=prepare(config)
    issues,prior=connect(rows,config)
    summary=dict(version=VERSION,documents=len(rows),byKind=dict(Counter(r['kind'] for r in rows)),
        families=len({r['familyId'] for r in rows}),splits=dict(Counter(r['split'] for r in rows)),
        priorExposureDocuments=sum(r['priorExposure'] for r in rows),
        issueCounts=dict(Counter(x['reason'] for x in issues)),
        nearDuplicateScreen='bounded_character_5gram_screen' if config.get('nearDuplicateScreen') else 'pending; exact and author/lineage grouping only',
        holdoutCertified=False,authorshipGoldDocuments=0,providersCalled=0,releaseEligible=False)
    dest.parent.mkdir(parents=True,exist_ok=True)
    staging=Path(tempfile.mkdtemp(prefix=dest.name+'.pending-',dir=dest.parent))
    (staging/'archives').mkdir()
    for a in archives:
        target=staging/'archives'/(a['kind']+'.zip');shutil.copyfile(a['path'],target)
        if sha(target.read_bytes())!=a['sha256']: raise ValueError('archive_copy_changed')
    files={'texts.local.json':encoded(texts),'documents.local.jsonl':b'\n'.join(encoded(r) for r in originals),
           'lineage-issues.local.json':encoded(issues)}
    for name,data in files.items(): (staging/name).write_bytes(data)
    manifest=dict(version=VERSION,createdAt=datetime.now(timezone.utc).isoformat(),seed=config['seed'],
        approval=config['approval'],archives=archives,priorManifests=prior,records=rows,
        files={name:sha(data) for name,data in files.items()},summary=summary)
    (staging/'manifest.local.json').write_bytes(encoded(manifest))
    (staging/'summary.local.json').write_bytes(encoded(summary))
    staging.rename(dest)
    print(json.dumps(summary,ensure_ascii=False,indent=2))
    return summary

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('config');args=parser.parse_args()
    main(args.config)
