'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { repairPhysicalProseLines: repair } = require('../engine-gpt-prod/physicalProseLines');
const preflight = require('../engine-gpt-prod/sourcePreflight');
const chunks = require('../engine-gpt-prod/structureChunk');
const structure = require('../engine-gpt-prod/documentStructure');
const compact = value => value.replace(/\s/gu, '');
const rows = [
  '이번 관찰에서는 교실마다 배치한 측정 도구와 기록 방식의 차이를 자세히 살펴보았습니',
  '다. 동일한 조건을 기록하는 과정에서도 참가자가 이해한 절차는 서로 달랐으며',
  '이에 따라 안내문의 내용과 실제 작업의 순서를 다시 확인해야 한다고 생각합니',
  '다. 기록을 비교할 때에는 참가자의 역할과 측정 환경을 함께 고려하는 것이 중요합니다.',
  '연구진은 실험이 진행되는 동안 측정 도구가 놓인 위치와 작업자의 움직임을 관찰하고',
  '자료에 제시된 안내 내용이 참가자에게 어떻게 전달되는지 반복해서 살펴보았습니',
  '다. 실험에서 나타난 차이를 설명하려면 전체 상황을 함께 확인하는 과정이 필요합니다.',
  '결과를 검토하는 과정에서는 이전에 확인한 내용을 바탕으로 후속 절차를 설계하고 이',
  '러한 절차가 실제 작업에서 적절히 수행되는지 관찰한 내용을 기록하는 것이 중요합니다.',
  '같은 도구를 사용하더라도 실험 환경에 따라 나타나는 차이를 확인하는 과정이 필요하며',
  '참가자가 안내 내용을 충분히 이해했는지 살펴보는 과정도 함께 진행할 필요가 있습니다.',
  '다음 단계에서는 조건을 유지하면서 동일한 과정을 다시 수행하고 결과를 비교하였으며',
  '후속 측정에서는 서로 다른 조건을 명확히 구분해 기록할 수 있도록 안내를 제공했습니다.'
];
const source = '[서론]\n\n' + rows.join('\n\n') + '\n\n[결론]\n\n측정 조건을 구분하고 기록을 보존한다.';

test('physical PDF prose seams are joined before title/list ownership; content unchanged', () => {
  const fixed = repair(source);
  assert.equal(fixed.changed, true);
  assert.equal(compact(fixed.text), compact(source));
  assert.match(fixed.text, /보았습니다\. 동일한/u);
  assert.match(fixed.text, /생각합니다\. 기록을/u);
  assert.match(fixed.text, /설계하고 이러한/u);
  const result = preflight.auditAndSanitizeSource(source);
  const plan = chunks.splitChunksForGpt(result.text, { coalesceEditable: true });
  assert.ok(!plan.chunks.some(c => c.locked && /^(?:다\.|러한)/u.test(c.text.trim())));
  assert.ok(!plan.chunks.some(c => c.locked && /관찰에서는|연구진은/u.test(c.text)), JSON.stringify(plan.chunks.filter(c=>c.locked)));
  assert.equal(preflight.auditAndSanitizeSource(result.text).text, result.text);
});

test('CRLF normalized preflight and LF physical rows produce the same canonical text', () => {
  const lf = preflight.auditAndSanitizeSource(source).text;
  assert.equal(preflight.auditAndSanitizeSource(source.replace(/\n/g, '\r\n')).text, lf);
});

test('complete similar-width paragraphs and creative short lines are not PDF evidence', () => {
  const normal = Array.from({ length: 15 }, (_, i) => `기록 ${i}에서는 서로 다른 측정 조건을 비교하고 각각의 결과를 명확하게 구분해 제시했습니다.`).join('\n\n');
  assert.equal(repair(normal).text, normal);
  const poem = '멀리 흐르는 물\n\n작은 창 아래\n\n가만히 서서\n\n바람을 기다린다.';
  assert.equal(repair(poem).text, poem);
  assert.equal(repair('오래된 문서의 일부를 다시 확인했습니\n\n다.').changed, false);
});

test('explicit outline, chart, tabular rows, fenced code, quotes and references stay exact', () => {
  const protectedParts = [
    '가. 첫 번째 실험 조건\n\n나. 두 번째 실험 조건\n\n다. 세 번째 실험 조건',
    '[별첨]\n\n담당자는 현재 작업의 변화를 확인할 수 있도록 자료를 준비하고\n\n요청 목적: 서비스 개선을 위한 자세한 자료 검토',
    '[별첨]\n\n담당자는 현재 작업의 변화를 확인할 수 있도록 자료를 준비하고\n\n서비스 개선을 위한 중장기 운영 관리 계획',
    '4. 참고문헌\n\n김연구. 한국 사회의 정책 변화와 지역 사회의 참여 방식에 관한 연구\n\n한국연구출판사 발행, 서울특별시 소재, 개정 증보판, 2026년',
    '[측정표]\n항목\t값\n온도\t23.5\n\n0.15\n\n0.10\n\n2019\t2022\t2025',
    '```text\n조건을 계속 확인합니\n\n다.\n```',
    '“실험 조건을 충분히 설명했습니\n\n다. 원문 인용을 보존한다.”',
    '[참고문헌]\n저자, 자료명, 2026.\nhttps://example.org/report?x=1.2'
  ];
  for (const part of protectedParts) {
    const mixed = source + '\n\n' + part;
    const fixed = repair(mixed);
    assert.equal(fixed.changed, true);
    assert.ok(fixed.text.endsWith(part), part);
    assert.equal(compact(fixed.text), compact(mixed));
  }
});

test('fresh approved structure plans share normalized ownership and legacy hashes fail', () => {
  const doc = structure.buildDocument(source);
  assert.ok(!doc.blocks.some(b => b.kind === 'protected' && /^다\./u.test(b.text)));
  const plan = structure.identityPlan(doc);
  const idx = doc.blocks.findIndex((b,i) => b.kind === 'paragraph' && doc.blocks[i+1]?.kind === 'paragraph'
    && b.barrier === doc.blocks[i+1].barrier);
  assert.ok(idx >= 0);
  plan.groups.splice(idx, 2, { ids: [doc.blocks[idx].id, doc.blocks[idx+1].id], breakAfterSentences: [], reason: '연결된 설명을 묶는다.' });
  const applied = structure.applyPlan(doc, plan);
  assert.equal(applied.applied, true);
  assert.equal(compact(applied.text), compact(doc.source));
  assert.throws(() => structure.applyPlan(doc, { ...plan, sourceHash: 'legacy-source-hash' }), { code: 'STRUCTURE_PLAN_STALE' });
  assert.equal(structure.buildDocument(source).sourceHash, doc.sourceHash);
});

test('a long retained nominal heading keeps its following body boundary', () => {
  const heading = '지역 사회 주거 환경 개선 및 복지 서비스 제공 관련 중장기 운영 계획';
  const body = '새로운 업무를 수행할 때에는 각 부서의 역할과 그에 필요한 구체적인 자료를 함께 검토한다.';
  const appendix = `[별첨]\n\n${heading}\n\n${body}`;
  const fixed = repair(`${source}\n\n${appendix}`);
  assert.equal(fixed.changed, true);
  assert.ok(fixed.text.endsWith(appendix));
  assert.equal(repair(fixed.text).text, fixed.text);
});

test('a long chart caption is protected before physical prose reflow and v3 planning', () => {
  const lead = '담당자는 현재 작업의 변화를 확인할 수 있도록 자료를 준비하고';
  const caption = '지역별 서비스 제공 수준과 연도별 주민 생활 여건 및 시설 활용 비율';
  const chart = caption + '\n0.30\n\n0.20\n\n0.10\n\n0.00\n2020\t2021\t2022\t2023';
  const appendix = '[자료]\n\n' + lead + '\n\n' + chart;
  const mixed = source + '\n\n' + appendix;
  const fixed = repair(mixed);
  assert.equal(fixed.changed, true);
  assert.ok(fixed.text.endsWith(appendix));
  assert.equal(compact(fixed.text), compact(mixed));
  assert.equal(repair(fixed.text).text, fixed.text);
  const doc = structure.buildDocument(mixed);
  const graph = doc.blocks.find(b => b.layoutRole === 'numeric_series');
  assert.equal(graph?.text, chart);
  assert(!graph.text.includes(lead));
});

test('numbered, Roman and Markdown reference headings protect their reference rows', () => {
  const entries = '김연구. 한국 사회의 정책 변화와 지역 사회의 참여 방식에 관한 연구\n\n한국연구출판사 발행, 서울특별시 소재, 개정 증보판, 2026년';
  for (const heading of ['4. 참고문헌', 'IV. 참고문헌', 'Ⅳ. 참고문헌', '# 참고문헌', '## 4. 참고문헌', '## IV. 참고문헌 ##']) {
    const references = `${heading}\n\n${entries}`;
    const fixed = repair(`${source}\n\n${references}`);
    assert.equal(fixed.changed, true);
    assert.ok(fixed.text.endsWith(references), heading);
    assert.equal(compact(fixed.text), compact(`${source}\n\n${references}`));
  }
});

test('no-space list prefixes remain separate without confusing decimal prose', () => {
  const lead = '[별첨]\n\n담당자는 현재 작업의 변화를 확인할 수 있도록 자료를 준비하고';
  const list = '1.실험 조건과 결과를 다시 점검하는 과정은 반복하여 진행한다.\n\n2.측정 자료를 검토하고 안전 규정을 정확하게 지킨다.';
  const appendix = `${lead}\n\n${list}`;
  assert.ok(repair(`${source}\n\n${appendix}`).text.endsWith(appendix));
  const decimal = `${lead}\n\n1.25배의 측정값을 별도로 기록하며 나머지 조건은 동일하게 유지한다.`;
  assert.match(repair(`${source}\n\n${decimal}`).text, /자료를 준비하고 1\.25배의/u);
});

test('no-space Hangul and ASCII item markers never become prose particles', () => {
  const lead = '[별첨]\n\n담당자는 현재 작업의 변화를 확인할 수 있도록 자료를 준비하고';
  for (const markers of [['가.', '나.', '다.'], ['A.', 'B.', 'C.'], ['a)', 'b)', 'c)']]) {
    for (const gap of ['', ' ']) {
      const items = markers.map(marker => marker + gap + '측정 자료의 기록 방식과 정해진 절차를 다시 확인한다.').join('\n\n');
      const appendix = lead + '\n\n' + items;
      const fixed = repair(source + '\n\n' + appendix);
      assert.ok(fixed.text.endsWith(appendix), markers.join(',') + ':' + gap);
      assert.equal(compact(fixed.text), compact(source + '\n\n' + appendix));
    }
  }
  // Unlike a true item, this tail has an attested preceding broken ending.
  const broken = source.replace('다. 동일한', '다.동일한');
  const fixed = repair(broken);
  assert.match(fixed.text, /살펴보았습니다\.동일한/u);
  assert.equal(compact(fixed.text), compact(broken));
});

test('a standalone multiline quote keeps both outer boundaries but inline quote prose remains editable', () => {
  const lead = '[별첨]\n\n담당자는 현재 작업의 변화를 확인할 수 있도록 자료를 준비하고';
  const quote = '“지역 사회의 운영 과정에서 각 부서는 현재 자료와 이전 자료의 차이를 함께 확인하고\n\n필요한 절차에 맞게 진행한다.”';
  const appendix = `${lead}\n\n${quote}\n\n다음 내용은 별도로 검토한다.`;
  const fixed = repair(`${source}\n\n${appendix}`);
  assert.ok(fixed.text.endsWith(appendix));
  const inline = `${lead}\n\n“기록”이라는 용어의 의미와 실제 자료의 구성 방식에 관한 내용을 검토한다.`;
  assert.match(repair(`${source}\n\n${inline}`).text, /자료를 준비하고 “기록”이라는/u);
});

test('a complete unpunctuated continuation joins but retains the next paragraph boundary', () => {
  const lead = '연구자는 모든 참여자의 작업 기록과 환경을 확인하면서 필요한 자료를 많이';
  const tail = '사용한다면 전체 결과의 차이를 해석하기 어렵기 때문입니다';
  const next = '다음 단계에서는 조건을 구분하고 각 집단의 결과를 별도로 비교한다.';
  const part = '[별첨]\n\n' + lead + '\n\n' + tail + '\n\n' + next;
  const fixed = repair(source + '\n\n' + part);
  assert.ok(fixed.text.endsWith('[별첨]\n\n' + lead + ' ' + tail + '\n\n' + next));
  assert.equal(compact(fixed.text), compact(source + '\n\n' + part));
  assert.equal(repair(fixed.text).text, fixed.text);
  for (const short of ['예술입니다', '캐나다']) {
    const isolated = '[별첨]\n\n' + lead + '\n\n' + short;
    assert.ok(repair(source + '\n\n' + isolated).text.endsWith(isolated), short);
  }
});

test('only an inline same-parenthetical date continuation can cross its physical row', () => {
  const lead = '담당자는 현재 작업의 법적 근거와 적용 범위를 다시 확인했습니다(검토법(약칭: 검토) 개정';
  const date = '2026.9.26).';
  const part = '[별첨]\n\n' + lead + '\n\n' + date;
  const fixed = repair(source + '\n\n' + part);
  assert.ok(fixed.text.endsWith('[별첨]\n\n' + lead + ' ' + date));
  assert.equal(compact(fixed.text), compact(source + '\n\n' + part));
  assert.equal(repair(fixed.text).text, fixed.text);
  const unowned = '[별첨]\n\n담당자는 현재 작업의 적용 범위를 확인한 뒤 검토한 자료의 개정\n\n' + date;
  assert.ok(repair(source + '\n\n' + unowned).text.endsWith(unowned));
});

test('date continuation cannot change reference, explicit citation, quote or code layout', () => {
  const citation = '담당자는 현재 작업의 법적 근거와 적용 범위를 다시 확인했습니다(검토법(약칭: 검토) 개정\n\n2026.9.26).';
  const fence = String.fromCharCode(96).repeat(3);
  const protectedParts = [
    '[참고문헌]\n\n' + citation,
    '출처: ' + citation,
    '“' + citation + '”',
    fence + 'text\n' + citation + '\n' + fence
  ];
  for (const part of protectedParts) {
    const fixed = repair(source + '\n\n[별첨]\n\n' + part);
    assert.ok(fixed.text.endsWith(part), part);
    assert.equal(compact(fixed.text), compact(source + '\n\n[별첨]\n\n' + part));
  }
});

test('final structural audit rejects a new orphan ending even with retained headings', () => {
  const src = '[서론]\n\n반복된 실험 조건을 확인했습니다.\n\n[결론]\n\n측정 결과를 자세하게 정리했습니다.';
  const output = src + '\n\n다.';
  const plan = chunks.splitChunksForGpt(src);
  const audit = chunks.buildStructureAudit({ source: src, outputText: output, chunks: plan.chunks });
  assert.equal(audit.fragmentIntegrityPass, false);
  assert.equal(audit.pass, false);
});

test('final audit uses raw physical-tail evidence without reclassifying canonical roles', () => {
  const raw = '검사 담당자는 모든 참가자에게 동일한 측정 도구를\n\n제공해야 합니다. 다음 검사는 오전에 시작합니다.';
  const canonical = raw.replace(/\n+/g, ' ');
  const output = '검사 담당자는 참가자 모두에게 동일한 측정 도구를 제공해야 합니다.\n\n제공해야 합니다. 다음 검사는 오전에 시작합니다.';
  const audit = chunks.buildStructureAudit({ source: canonical, fragmentSource: raw, outputText: output });
  assert.equal(audit.fragmentIntegrityPass, false);
  assert.deepEqual(audit.fragmentIntegrityCodes, ['introduced_duplicate_predicate_tail']);
  assert.equal(audit.pass, false);
});

test('quote particles and inline code survive preflight sentence spacing correction', () => {
  const value = '담당자는 “확인했다.”라고 말했다.다음 단계는 `문장.다음`을 그대로 기록한다.';
  const out = preflight.auditAndSanitizeSource(value).text;
  assert.ok(out.includes('“확인했다.”라고'));
  assert.ok(out.includes('말했다. 다음'));
  assert.ok(out.includes('`문장.다음`'));
});
