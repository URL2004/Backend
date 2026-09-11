"""Synthetic fixtures only. Run: python -m unittest discover -s test -p test_nikl_writing_corpus.py"""
import importlib.util
import json
import io
from contextlib import redirect_stdout
from pathlib import Path
import tempfile
import unittest
import zipfile

spec=importlib.util.spec_from_file_location('nikl',Path(__file__).resolve().parents[1]/'scripts/build-nikl-writing-corpus.py')
nikl=importlib.util.module_from_spec(spec);spec.loader.exec_module(nikl)

def row(key,kind,author='writer',text='독립적으로 만든 합성 검사 문장입니다.',prompt='Q1'):
    return dict(id=key,sourceRecordId=key,kind=kind,authorId=author,promptNumber=prompt,promptHash=nikl.sha(prompt),**nikl.hashes(text))

class IntakeTests(unittest.TestCase):
    def test_json_duplicate_and_nonfinite_rejected(self):
        for data in (b'{"a":1,"a":2}',b'{"a":NaN}'):
            with self.assertRaises(ValueError): nikl.read_json(data)

    def test_hash_matches_js_and_keeps_original(self):
        self.assertEqual(nikl.hashes('\ufeffA\u00a0B')['normalizedSha256'],nikl.sha('A B'))
        self.assertNotEqual(nikl.hashes('\ufeffA')['corpusNormalizedSha256'],nikl.hashes('A')['corpusNormalizedSha256'])
        self.assertNotEqual(nikl.hashes(' A')['sha256'],nikl.hashes('A')['sha256'])

    def test_git_output_rejected_and_external_allowed(self):
        with tempfile.TemporaryDirectory() as folder:
            p=Path(folder);repo=p/'repo';repo.mkdir();(repo/'.git').write_text('gitdir: elsewhere')
            with self.assertRaises(ValueError): nikl.external_path(repo/'private')
            self.assertEqual(nikl.external_path(p/'private'),(p/'private').resolve())

    def test_source_mutation_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            p=Path(folder)/'source';p.write_bytes(b'changed')
            with self.assertRaises(ValueError):nikl.checked_file({'path':str(p),'sha256':nikl.sha('original')})

    def test_related_rows_share_split_and_differences_stay_review(self):
        rows=[row('raw.1','raw2023'),row('score.1','score2023_1',text='수정된 합성 검사 문장입니다.'),
            {**row('instruction.1','instruction2024'), 'sourceDocumentReferences':['raw.1'],'missingInputReference':True}]
        issues,_=nikl.connect(rows,{'seed':'frozen'})
        self.assertEqual(len({r['familyId'] for r in rows}),1)
        self.assertEqual({r['split'] for r in rows},{'development'})
        self.assertTrue(all(r['lineageReviewRequired'] for r in rows))
        self.assertIn('score_raw_text_difference',{i['reason'] for i in issues})
        self.assertIn('empty_instruction_reference',{i['reason'] for i in issues})

    def test_prior_exposure_propagates_to_family(self):
        with tempfile.TemporaryDirectory() as folder:
            rows=[row('raw.1','raw2023'),row('score.1','score2023_1')]
            p=Path(folder)/'prior.json';p.write_bytes(nikl.encoded({'records':[{'lineageKeys':['text:'+rows[0]['corpusNormalizedSha256']]}]}))
            nikl.connect(rows,{'seed':'frozen','priorManifests':[{'path':str(p),'sha256':nikl.sha(p.read_bytes())}]})
            self.assertTrue(all(r['priorExposure'] and r['split']=='development' for r in rows))

    def test_conflicting_reference_is_quarantined(self):
        rows=[row('raw.1','raw2023'),{**row('instruction.1','instruction2024',author='other'),
            'sourceDocumentReferences':['raw.1'],'missingInputReference':False}]
        issues,_=nikl.connect(rows,{'seed':'frozen'})
        self.assertIn('instruction_reference_author_conflict',{i['reason'] for i in issues})
        self.assertTrue(all(r['lineageReviewRequired'] for r in rows))

    def test_verified_near_links_propagate_prior_exposure(self):
        with tempfile.TemporaryDirectory() as folder:
            rows=[row('raw.1','raw2023'),row('raw.2','raw2024',author='second',text='다른 합성 검사 문장입니다.')]
            screen={'complete':True,'archiveHashes':['frozen'],'links':[
                {'left':{'id':rows[0]['id'],'hash':rows[0]['corpusNormalizedSha256']},'right':{'id':rows[1]['id'],'hash':rows[1]['corpusNormalizedSha256']}},
                {'left':{'id':rows[1]['id'],'hash':rows[1]['corpusNormalizedSha256']},'right':{'id':None,'hash':'prior'}}]}
            p=Path(folder)/'screen';p.write_bytes(nikl.encoded(screen))
            config={'seed':'frozen','archives':[{'sha256':'frozen'}],'nearDuplicateScreen':{'path':str(p),'sha256':nikl.sha(p.read_bytes())}}
            nikl.connect(rows,config)
            self.assertEqual(len({r['familyId'] for r in rows}),1)
            self.assertTrue(all(r['priorExposure'] for r in rows))
            screen['complete']=False;p.write_bytes(nikl.encoded(screen));config['nearDuplicateScreen']['sha256']=nikl.sha(p.read_bytes())
            with self.assertRaisesRegex(ValueError,'screen_incomplete'):nikl.connect(rows,config)

    def test_family_partition_is_order_independent(self):
        a=[row('raw.a','raw2023'),row('raw.b','raw2024',author='second',text='두 번째 검사 자료')]
        b=[dict(r) for r in reversed(a)]
        nikl.connect(a,{'seed':'frozen'});nikl.connect(b,{'seed':'frozen'})
        self.assertEqual({r['id']:(r['familyId'],r['split']) for r in a},{r['id']:(r['familyId'],r['split']) for r in b})

    def fixture(self,folder):
        specs=[]
        for kind in sorted(nikl.KINDS):
            d={'id':kind+'.1','metadata':{'author':{'author_id':'writer'},'prompt':{'prompt_num':'Q1','prompt_con':'Synthetic prompt'}},
               'paragraph':[{'form':'Synthetic source paragraph.'}]}
            if kind.startswith('score'):d['evaluation']={'evaluator':[{'final_evaluator_ID':'r2'}], 'evaluation_data':{'evaluator1_total_score':3,'evaluator68_total_score':5}}
            if kind.startswith('instruction'):
                d={'id':kind+'.1','input':[{'metadata':{'author_id':'writer'},'prompt':{'prompt_num':'Q1','prompt_con':'Synthetic prompt'},'paragraph':[{'id':'raw2023.1.1','form':'kept','original_form':'original','edited':'O'}]}],
                   'output':[{'instruction':[{'input_data':'Synthetic source paragraph.'}],'feedback_type':'expression','text_type':'sentence','llm_type':'synthetic-model','expert_comment':[{'comment':'A review, not a rewrite.'}],'task3':[{'answer':'Synthetic model answer.'}]}]}
            p=Path(folder)/(kind+'.zip')
            with zipfile.ZipFile(p,'w') as z:z.writestr('data.json',nikl.encoded({'metadata':{'year':2024},'document':[d]}))
            specs.append({'kind':kind,'corpusId':kind,'path':str(p),'sha256':nikl.sha(p.read_bytes()),'expectedDocuments':1})
        return {'version':nikl.VERSION,'seed':'frozen','archives':specs,'approval':{'documentNumber':'synthetic','institution':'synthetic','localEvaluationAuthorized':True,'validFrom':'2000-01-01','validThrough':'2100-01-01'}}

    def test_full_input_preserves_comments_and_unusual_raters(self):
        with tempfile.TemporaryDirectory() as folder:
            c=self.fixture(folder);rows,texts,originals,_=nikl.prepare(c)
            self.assertEqual(len(rows),6)
            self.assertTrue(all(r['authorshipGoldEligible'] is False and r['permissions']['train'] is False for r in rows))
            score=next(r for r in rows if r['kind']=='score2023_1')
            self.assertEqual(score['evaluation']['evaluation_data']['evaluator68_total_score'],5)
            doc=next(r for r in originals if r['id'].startswith('instruction'))['document']
            self.assertEqual(doc['output'][0]['expert_comment'][0]['comment'],'A review, not a rewrite.')
            self.assertEqual(texts['instruction2024:instruction2024.1'],'Synthetic source paragraph.')

    def test_build_seals_private_files_and_never_overwrites(self):
        with tempfile.TemporaryDirectory() as folder:
            c=self.fixture(folder);c['outputDirectory']=str(Path(folder)/'output')
            p=Path(folder)/'config';p.write_bytes(nikl.encoded(c))
            with redirect_stdout(io.StringIO()):nikl.main(p)
            dest=Path(c['outputDirectory']);manifest=nikl.read_json((dest/'manifest.local.json').read_bytes())
            self.assertEqual(manifest['summary']['documents'],6)
            for name,digest in manifest['files'].items():self.assertEqual(nikl.sha((dest/name).read_bytes()),digest)
            with self.assertRaisesRegex(ValueError,'output_must_not_exist'):nikl.main(p)

    def test_screen_detects_near_text_and_exact_prior_exposure(self):
        screen_spec=importlib.util.spec_from_file_location('screen',Path(nikl.__file__).with_name('screen-nikl-writing-duplicates.py'))
        screen=importlib.util.module_from_spec(screen_spec);screen_spec.loader.exec_module(screen)
        with tempfile.TemporaryDirectory() as folder:
            base=Path(folder)
            a=' '.join('syntheticword'+str(i) for i in range(100))
            b=a+' A small ending edit.'
            texts={'a':a,'b':b};text_bytes=nikl.encoded(texts);(base/'texts.local.json').write_bytes(text_bytes)
            manifest={'records':[{'id':k,'familyId':k,**nikl.hashes(t)} for k,t in texts.items()],
                      'archives':[{'sha256':'source'}],'files':{'texts.local.json':nikl.sha(text_bytes)}}
            mp=base/'manifest';mp.write_bytes(nikl.encoded(manifest))
            pp=base/'prior';pp.write_bytes(nikl.encoded({'old':a}))
            config={'manifest':{'path':str(mp),'sha256':nikl.sha(mp.read_bytes())},
                    'priorTexts':[{'path':str(pp),'sha256':nikl.sha(pp.read_bytes())}],'output':str(base/'screen')}
            cp=base/'config';cp.write_bytes(nikl.encoded(config))
            with redirect_stdout(io.StringIO()):result=screen.main(cp)
            self.assertTrue(result['complete'])
            self.assertTrue(any(l['right']['id'] is None for l in result['links']))
            self.assertTrue(any(l['right']['id'] is not None for l in result['links']))

    def test_unknown_schema_missing_kind_and_count_fail(self):
        with tempfile.TemporaryDirectory() as folder:
            c=self.fixture(folder);c['archives'][0]['expectedDocuments']=2
            with self.assertRaisesRegex(ValueError,'unexpected_document_count'):nikl.prepare(c)
            c['archives']=c['archives'][:-1]
            with self.assertRaisesRegex(ValueError,'six_distinct'):nikl.prepare(c)

    def test_traversal_archive_and_expired_agreement_fail(self):
        with tempfile.TemporaryDirectory() as folder:
            c=self.fixture(folder);p=Path(c['archives'][0]['path'])
            with zipfile.ZipFile(p,'a') as z:z.writestr('../unsafe.json','{}')
            c['archives'][0]['sha256']=nikl.sha(p.read_bytes())
            with self.assertRaisesRegex(ValueError,'unsafe_archive_entry'):nikl.prepare(c)
            c['approval']['validThrough']='2000-01-02'
            with self.assertRaisesRegex(ValueError,'outside_valid_period'):nikl.prepare(c)

if __name__=='__main__':unittest.main()
