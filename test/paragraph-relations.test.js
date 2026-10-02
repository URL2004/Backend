'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { refineParagraphRelations: refine } = require('../engine-gpt-prod/paragraphRelations');
const { repairLabelSubtitleBoundaries: subtitles } = require('../engine-gpt-prod/inlineLabelParagraphs');
const { ordinalMarkers, restoreOrdinalParagraphGaps } = require('../engine-gpt-prod/koreanOrdinal');
const pre = require('../engine-gpt-prod/sourcePreflight');
const st = require('../engine-gpt-prod/structureChunk');
const bare = s => s.replace(/\s/gu, '');
const fixtures = [
  {
    name: 'evaluation and developed colon alternatives',
    source: '이 사례는 의사결정 과정을 공개하고 담당자가 결과를 설명할 필요가 있음을 보여 준다.\n공개 절차: 누구나 결정 과정을 확인할 수 있도록 회의 내용과 변경 이유를 정기적으로 게시해야 한다.\n역할 분담: 각 담당자가 자신이 수행할 업무와 확인할 기준을 이해하도록 역할과 책임을 명확하게 정해야 한다.',
    from: '보여 준다.\n공개 절차:', to: '보여 준다.\n\n공개 절차:'
  },
  {
    name: 'short acknowledgement belongs to its introduction',
    source: '좋습니다.\n\n① 지역에 관한 질문 세 가지를 먼저 제안하겠습니다. 현장에서 관찰한 문제와 해결 과정을 함께 물어보면 좋겠습니다.\n\n질문 목록\n\n참여하면서 가장 어려웠던 일은 무엇인가요?',
    from: '좋습니다.\n\n①', to: '좋습니다.\n①'
  },
  {
    name: 'numbered claim and complete reason keep line ownership',
    source: '1. 공동 활동은 다양한 의견을 만나는 과정이다.\n서로 다른 관점을 듣고 함께 방법을 찾을 수 있기 때문입니다.\n\n2. 기록은 대화를 이어 주는 자료이다.\n\n같은 자리에서 이야기를 나누지 못한 사람도 기록을 읽고 자신의 의견을 더할 수 있기 때문입니다.',
    from: '자료이다.\n\n같은', to: '자료이다.\n같은'
  },
  {
    name: 'explanation joins its claim before a new context',
    source: '지역의 기록은 여러 사람이 함께 만든다. 주민과 기관은 자신이 아는 사실을 공유하고 활동을 기록한다. 이 활동이 계속되는 이유를 지원금만으로 설명할 수는 없다고 생각했다.\n\n사람들이 공동의 가치를 형성하고 새로운 참여자가 경험을 이어 가기 때문에 활동이 지속될 수 있다고 보았다. 온라인 플랫폼의 도입으로 기록을 공유하는 방식도 달라지고 있다. 이런 변화 속에서 새로운 참여 방식을 살펴볼 필요가 있다. 앞으로는 자료를 공유하는 과정을 직접 관찰하고 싶다.',
    from: '생각했다.\n\n사람들이', to: '생각했다. 사람들이',
    additional: '보았다.\n\n온라인'
  },
  {
    name: 'recommendation and its exception stay together',
    source: '한 번에 많은 자료를 읽기보다는 필요한 부분부터 천천히 확인하세요. 처음에는 기록을 조금만 남기고, 확인한 뒤에 나누어 정리하세요.\n\n그렇다고 기록을 아예 안 남기면 확인할 자료가 없으니, 활동 사이사이에는 짧게 기록해야 해요. 정리한 자료는 날짜별로 보관해요. 다른 사람의 의견도 함께 기록하면 비교할 때 도움이 돼요.',
    from: '정리하세요.\n\n그렇다고', to: '정리하세요. 그렇다고',
    additional: '해야 해요.\n\n정리한'
  },
  {
    name: 'measurement condition and response, then another addressee',
    source: '경고가 나오면 먼저 장비 온도를 재 볼게요. 화면에 나타나는 측정값도 함께 살펴요.\n\n실제로 온도가 높으면 장비 지침에 따라 작동을 멈추고 온도를 다시 확인할게요. 담당자에게도 부탁드려요. 장비를 다시 켜기 전에는 점검 결과를 확인해 주세요.',
    from: '살펴요.\n\n실제로', to: '살펴요. 실제로',
    additional: '확인할게요.\n\n담당자'
  },
  {
    name: 'conditional summary item precedes reassurance',
    source: '오늘 말씀드린 내용은 세 가지로 정리해 볼게요. 작업을 시작하기 전에 안내를 읽으세요. 자료를 확인한 뒤에 기록하세요.\n\n어려우면 담당자에게 바로 알려 주세요. 대부분은 함께 연습하면 익숙해지니 너무 걱정하지 마세요. 궁금한 점은 언제든 다시 물어보세요.',
    from: '기록하세요.\n\n어려우면', to: '기록하세요. 어려우면',
    additional: '알려 주세요.\n\n대부분'
  },
  {
    name: 'citation stays with claim before geographical transition',
    source: '지역 기록은 공동체가 변화를 이해하는 자료가 된다. 여러 도시가 기록 보관 방식을 비교하고 있다. 디지털 자료가 늘면서 관련 논의도 확대되었다. 이런 논의는 다양한 형태로 나타난다. (김연구, 2020) 참여가 늘면서 국내 기록 산업은 새로운 전환점을 맞고 있다. 각 기관은 자료를 정리하는 방법을 검토한다. 이러한 활동은 기록을 활용하는 기회를 넓힌다.',
    from: '(김연구, 2020) 참여가', to: '(김연구, 2020)\n\n참여가'
  }
];

for (const f of fixtures) {
  test(f.name + ': whitespace only, protected roles and idempotence', () => {
    const result = refine(f.source);
    assert.ok(result.text.includes(f.to), result.text);
    if (f.additional) assert.ok(result.text.includes(f.additional), result.text);
    assert.equal(result.text.includes(f.from), false);
    assert.equal(bare(result.text), bare(f.source));
    assert.equal(refine(result.text).text, result.text);
    for (const wrapped of ['“' + f.source + '”', '~~~text\n' + f.source + '\n~~~']) {
      assert.equal(refine(wrapped).text, wrapped);
    }
    assert.equal(refine(f.source, {protectedBlocks: [f.source]}).text, f.source);
  });
  for (const mode of ['blog', 'formal']) test(f.name + ': final ' + mode + ' pipeline', () => {
    const source = pre.auditAndSanitizeSource(f.source).text;
    const chunks = st.splitChunksForGpt(source).chunks;
    const options = {source, outputText: f.source, chunks, mode,
      documentProfile: {profile: 'report_assignment', confidence: .95}, normalizeVisualGaps: true};
    const out = st.restoreFinalDocumentLayout(options);
    assert.equal(out.pass, true, JSON.stringify(out.returnedStructureAudit));
    assert.equal(out.converged, true);
    assert.equal(bare(out.text), bare(f.source));
    assert.ok(out.text.includes(f.to), out.text);
    if (f.additional) assert.ok(out.text.includes(f.additional), out.text);
    assert.equal(st.restoreFinalDocumentLayout({...options, outputText: out.text}).text, out.text);
  });
}

const body = '저는 사람들의 이야기를 듣고 기록을 정리했다. 자료를 읽는 데서 그치지 않고 작은 활동을 직접 해 보는 일이 중요하다고 느꼈다.';
const subtitleSource = '학습의 변화\n초기 모습: 준비하면서 시작을 미룬 시간\n' + body
  + '\n\n전환 경험: 작은 활동을 통해 얻은 깨달음 작은 활동에서 가장 기억에 남은 것은 실패를 두려워하지 않고 직접 시도하는 모습이었다. 이 경험을 통해 내 행동을 돌아보았다.'
  + '\n\n현재 모습: 배움을 실행으로 옮기는 태도 이 경험을 바탕으로 일상에서 작은 계획을 세우고 직접 실행하고 있다. 앞으로도 다양한 의견을 들으며 생각을 정리하고 싶다.';

test('attested label subtitle boundaries survive preparation, repair and final audit', () => {
  const source = pre.auditAndSanitizeSource(subtitleSource).text;
  assert.ok(source.includes('깨달음\n작은 활동에서'));
  assert.ok(source.includes('태도\n이 경험을'));
  assert.equal(pre.auditAndSanitizeSource(source).text, source);
  assert.equal(bare(source), bare(subtitleSource));
  const chunks = st.splitChunksForGpt(source).chunks;
  const options = {source, outputText: subtitleSource, chunks, mode: 'formal',
    documentProfile: {profile: 'personal_essay', confidence: .95}, normalizeVisualGaps: true};
  const out = st.restoreFinalDocumentLayout(options);
  assert.equal(out.pass, true, JSON.stringify(out.returnedStructureAudit));
  assert.ok(out.text.includes('깨달음\n작은 활동에서'), out.text);
  assert.ok(out.text.includes('태도\n이 경험을'), out.text);
  assert.equal(bare(out.text), bare(subtitleSource));
  assert.equal(st.restoreFinalDocumentLayout({...options, outputText: out.text}).text, out.text);
});

test('subtitle inference rejects ambiguous cuts, ordinary labels, code, quotes and metadata', () => {
  const ambiguous = subtitleSource.replace('이 경험을 바탕으로', '이 경험을 통해 얻은 깨달음 저는 이를 바탕으로');
  assert.ok(subtitles(ambiguous).text.includes('태도 이 경험을 통해 얻은 깨달음 저는'));
  for (const s of [
    '설명: 새로운 경험을 바탕으로 생각을 정리했다.',
    subtitleSource.replace('초기 모습: 준비하면서 시작을 미룬 시간\n' + body, ''),
    '“' + subtitleSource + '”',
    '~~~\n' + subtitleSource + '\n~~~',
    '성명: 홍연습\n소속: 작은 활동을 통해 얻은 깨달음 이 단체는 배움을 실천한다.'
  ]) assert.equal(subtitles(s).text, s);
});

test('period and comma ordinals have identical identity, not unchecked new items', () => {
  const a = '첫째, 활동의 목표를 충분히 검토하고 필요한 자료와 준비 사항을 확인한다. 참여자가 자신의 역할을 이해하도록 설명하고 의견을 듣는 과정이 필요하다. 준비 단계에서 놓친 부분이 없는지도 점검한다.';
  const b = '둘째, 활동 결과를 기록하고 서로 다른 의견을 비교하여 어떤 방법이 적절한지 판단한다. 하나의 의견만 보고 결정하기보다 다양한 관점을 함께 검토해야 한다. 이를 바탕으로 개선할 내용을 정리한다.';
  const c = '셋째. 정리한 내용을 바탕으로 다음 활동을 계획하고 직접 실행한다. 참여자들이 자신의 경험을 나눌 수 있도록 충분한 시간을 마련하고 실행 결과도 함께 기록한다.';
  const source = a + '\n\n' + b + ' ' + c;
  const output = source.replace('셋째.', '셋째,');
  assert.deepEqual(ordinalMarkers(source).map(x => x.number), [1, 2, 3]);
  const gaps = restoreOrdinalParagraphGaps(source, output);
  assert.ok(gaps.text.includes('\n\n셋째,'));
  assert.equal(bare(gaps.text), bare(output));
  assert.equal(restoreOrdinalParagraphGaps(source, gaps.text).text, gaps.text);
  const chunks = st.splitChunksForGpt(source).chunks;
  const out = st.restoreFinalDocumentLayout({source, outputText: output, chunks, mode: 'formal',
    documentProfile: {profile:'report_assignment', confidence:.95}, normalizeVisualGaps: true});
  assert.equal(out.pass, true, JSON.stringify(out.returnedStructureAudit));
  assert.ok(out.text.includes('\n\n셋째,'));
  const missing = st.buildStructureAudit({source, outputText: output.replace('셋째,', ''), chunks});
  assert.equal(missing.pass, false);
  const reordered = st.buildStructureAudit({source, outputText: b + '\n\n' + a + '\n\n' + c, chunks});
  assert.equal(reordered.pass, false);
  for (const s of ['첫째 아이가 왔다. 둘째 아이도 왔다.', '“첫째. 설명이다. 둘째. 설명이다.”', '~~~\n첫째. 코드다.\n둘째. 코드다.\n~~~']) {
    assert.equal(ordinalMarkers(s).length, 0);
    assert.equal(restoreOrdinalParagraphGaps(s, s).text, s);
  }
});

test('negative controls: contrast, disconnected conditions and citations are not forced together', () => {
  for (const s of [
    '짧은 영상만 보면 긴 설명을 따라가기 어려울 수 있다고 생각한다.\n\n그렇다고 해서 영상을 무조건 나쁘다고 볼 필요는 없다고 생각한다. 관건은 영상을 어떻게 이용하느냐이다. 필요할 때 긴 글도 함께 읽으면 좋겠다.',
    '먼저 장비 온도를 측정하고 결과를 확인한다.\n\n실제로 참여율이 높으면 활동 시간을 늘릴 수 있다. 담당자에게도 부탁드려요. 의견을 보내 주세요.',
    fixtures[7].source.replace('참여가 늘면서 국내', '이러한 논의를 바탕으로 국내'),
    '항목: 하나\n결과: 둘',
    '먼저 장비 온도를 확인한다.\n\n실제로 온도가 높으면 꺼야 한다.',
    '1. 제목\n\n이 내용은 앞의 제목에 관해 설명하는 것이다.'
  ]) assert.equal(refine(s).text, s);
});

test('whole-line preservation, creative and polish policies never opt into relation refinement', () => {
  const source = fixtures[4].source;
  for (const options of [
    {mode:'polish',documentProfile:{profile:'general',confidence:.95}},
    {mode:'formal',documentProfile:{profile:'creative',confidence:.95}},
    {mode:'formal',documentProfile:{profile:'clinical_record',confidence:.95}},
    {mode:'formal',documentProfile:{profile:'legal_contract',confidence:.95}}
  ]) {
    const out = st.restoreFinalDocumentLayout({source, outputText:source, chunks:st.splitChunksForGpt(source).chunks,
      normalizeVisualGaps:true, ...options});
    assert.equal(out.relationBoundaryCount, 0);
  }
  const chunks = st.splitChunksForGpt(source,{preserveLineBoundaries:'all'}).chunks
    .map(c => ({...c, lineBoundaryPolicy: 'all'}));
  const out = st.restoreFinalDocumentLayout({source,outputText:source,chunks,mode:'formal',normalizeVisualGaps:true});
  assert.equal(out.relationBoundaryCount, 0);
});

test('indented CRLF and astral characters retain exact sentence/citation coordinates', () => {
  for (const f of [fixtures[3], fixtures[7]]) {
    const source = ('📚 ' + f.source).split('\n').map(s => s ? '  ' + s : '').join('\r\n');
    const out = refine(source);
    assert.equal(bare(out.text), bare(source));
    assert.ok(out.repairCount > 0);
    const normalized = out.text.replace(/\r/gu, '').split('\n').map(s => s.trim()).join('\n');
    assert.ok(normalized.includes(f.additional || f.to), normalized);
    assert.equal(refine(out.text).text, out.text);
  }
});

test('locked substrings outside a changed gap are untouched; a locked gap cannot change', () => {
  const f = fixtures[1];
  assert.ok(refine(f.source, {protectedBlocks:['① ']}).text.includes(f.to));
  assert.equal(refine(f.source, {protectedBlocks:['좋습니다.\n\n① ']}).text, f.source);
});
