'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const pre = require('../engine-gpt-prod/sourcePreflight');
const st = require('../engine-gpt-prod/structureChunk');
const layout = require('../engine-gpt-prod/layoutStructure');
const ordinal = require('../engine-gpt-prod/koreanOrdinal');
const bare = value => value.replace(/\s/gu, '');

test('a wrapped labelled list is one editable sentence; only its number is locked', () => {
  const source = '<이용 대상>\n1. 이용자 - 안내문을 자세히 확인하고 실제 신청 절차를 비교하며 필요한 자료를\n바탕으로 신청 여부를 결정할 수 있다.\n2. 운영 기관 - 잘못된 자료의 배포가 제한되고 점검\n대상이 되므로 안내 내용을 다시 확인해야 한다.';
  const prepared = pre.auditAndSanitizeSource(source);
  assert.equal(bare(prepared.text), bare(source));
  assert.match(prepared.text, /자료를 바탕으로/u);
  assert.match(prepared.text, /점검 대상이/u);
  assert.equal(pre.auditAndSanitizeSource(prepared.text).text, prepared.text);
  const chunks = st.splitChunksForGpt(prepared.text).chunks;
  assert.ok(!chunks.some(c => c.locked && /자료를|점검/u.test(c.text)));
  assert.ok(chunks.some(c => !c.locked && /자료를 바탕으로/u.test(c.text)));
  const rewritten = prepared.text.replace('필요한 자료를 바탕으로', '필요한 자료에 근거해');
  const audit = st.buildStructureAudit({ source: prepared.text, integritySource: source, outputText: rewritten, chunks });
  assert.deepEqual(audit.lineAnchorLosses, []);
  const lostHeading = st.buildStructureAudit({ source: prepared.text, integritySource: source,
    outputText: rewritten.replace('<이용 대상>', '') });
  assert.equal(lostHeading.pass, false, 'real standalone heading remains protected');
  for (const boundary of ['\n\n', '\n2. 다음 항목\n', '\n| 열 이름 | 값 |\n']) {
    const input = source.split('자료를\n')[0] + '자료를' + boundary + '바탕으로 신청 여부를 결정할 수 있다.';
    assert.ok(!pre.auditAndSanitizeSource(input).text.includes('자료를 바탕으로'), boundary);
  }
});

test('a completed sentence followed by an unfinished clause never becomes a contextual heading', () => {
  const source = '확률의 관계를 자세히 살펴본다.\n검사 결과를 해석하는 방법이다. 담당자는 대상자의 나이나\n이전 기록과 검사 결과를 함께 고려해 판단한다.\n새로운 항목\n다음 항목에서는 자료의 수집 과정과 활용 방식을 상세히 설명한다.';
  const out = pre.auditAndSanitizeSource(source);
  assert.match(out.text, /나이나 이전 기록/u);
  const record = layout.buildLineRecords(out.text).find(r => r.text.includes('나이나'));
  assert.equal(record.role, 'prose');
});

test('a newly dangling list prefix gets only its unique source item restored for revalidation', () => {
  const { restore, findings } = require('../engine-gpt-prod/wrappedListIntegrity');
  const source = '1. 참가자 - 담당자에게 받은 안내 사항을 자세히 읽고 제출에 필요한 확인 자료를 바탕으로 접수 여부를 결정할 수 있다. 접수 절차를 정확히 알 수 있다.\n2. 담당자 - 제출된 자료를 검토하고 접수 절차를 안내한다.';
  const output = '1. 참가자 - 담당자에게 받은 안내 사항을 자세히 읽고 제출에 필요한 확인 자료를\n\n이를 바탕으로 접수 여부를 결정할 수 있으며 접수 절차도 정확히 알 수 있다.\n\n2. 담당자 - 제출된 자료를 살피고 접수 절차를 설명한다.';
  const out = restore(source, output);
  assert.equal(out.restoredCount, 1); assert.ok(out.text.startsWith(source.split('\n')[0]));
  assert.ok(out.text.endsWith(output.split('\n').at(-1)));
  assert.equal(findings(source, out.text).length, 0);
  assert.equal(restore(source, output, { preserveLines: true }).applied, false);
  assert.equal(restore(source + '\n' + source, output).applied, false, 'ambiguous owner');
  assert.equal(restore(source, output.replace('이를 바탕으로', '새로운 제목\n\n이를 바탕으로')).applied, false, 'independent new boundary');
});

test('bare numeric marker and source-backed ordinal frames keep structural identity', () => {
  assert.deepEqual(st.extractOriginalStructuralMarkers('1.  \n본문 문장입니다.').map(x => x.key),
    st.extractOriginalStructuralMarkers('1.\n본문 문장입니다.').map(x => x.key));
  const source = '세 가지 이유를 설명한다. 첫째는 자료를 충분히 검토한다는 원칙이다. 둘째는 절차를 명확히 안내한다는 원칙이다. 셋째는 기록이 근거이자 자료이며 확인은 곧 책임이라는 결론이다.';
  const output = '세 가지 이유를 설명한다. 첫째는 자료를 충분히 검토한다는 원칙이다. 둘째는 절차를 명확히 안내한다는 원칙이다. 셋째 결론은 기록이 근거이자 자료이며, 확인은 곧 책임이라는 것이다.';
  assert.deepEqual(ordinal.ordinalMarkers(output, { source }).map(x => x.number), [1, 2, 3]);
  assert.deepEqual(ordinal.ordinalMarkers(output.replace('셋째 결론은', '결론은'), { source }).map(x => x.number), [1, 2]);
  assert.equal(ordinal.ordinalMarkers('첫째 아이는 학교에 갔다. 둘째 아이는 집에 있었다.').length, 0);
});

test('unique quoted item labels survive a topic-to-frame rewrite without inventing missing items', () => {
  const source = '네 가지 항목이 있다. 첫 번째는 ‘자료를 살피다’이다. 두 번째는 ‘기록을 남기다’이다. 세 번째는 ‘함께 질문하다’이다.';
  const output = '첫 번째 ‘자료를 살피다’에서는 자료를 본다. 두 번째 ‘기록을 남기다’에서는 기록한다. 세 번째 코너는 ‘함께 질문하다’로 구성된다.';
  assert.deepEqual(ordinal.ordinalMarkers(output, { source }).map(x => x.number), [1, 2, 3]);
  assert.deepEqual(ordinal.ordinalMarkers(output.replace('두 번째', '다른'), { source }).map(x => x.number), [1, 3]);
});

test('flattened report restores all numbered section boundaries without changing letters', () => {
  const body = '각 항목은 자료를 살피고 작성 내용을 확인하는 과정을 설명한다. 자료와 기록을 함께 비교하여 필요한 내용을 검토한다. ';
  const source = '[작성한 보고서]자료 점검 기록1. 선정 이유' + body + '2. 조사 내용' + body + '3. 알고 싶은 점' + body + '4. 3번에 대한 답' + body;
  const out = pre.auditAndSanitizeSource(source).text;
  assert.equal(bare(out), bare(source));
  for (const n of [1, 2, 3, 4]) assert.match(out, new RegExp('\\n' + n + '\\. '));
  assert.deepEqual(st.buildStructureAudit({ source: out, integritySource: source, outputText: out }).lineAnchorLosses, []);
  assert.equal(pre.auditAndSanitizeSource(out).text, out);
  assert.equal(pre.repairInlineHeadingBoundaries('[메모]1. 사과 2. 배 3. 포도').text, '[메모]1. 사과 2. 배 3. 포도');
});

test('CSP and event floods cannot consume business or notification request limits', async t => {
  const express = require('express');
  const { limiter, cspReportLimiter, eventLimiter, notificationLimiter } = require('../config');
  const app = express();
  for (const [path, middleware] of [['csp', cspReportLimiter], ['events', eventLimiter], ['business', limiter], ['notifications', notificationLimiter]]) {
    app.post('/' + path, middleware, (_req, res) => res.json({ ok: true }));
  }
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = path => fetch(`http://127.0.0.1:${server.address().port}/${path}`, { method: 'POST' });
  for (const path of ['csp', 'events']) {
    for (let i = 0; i < 30; i++) assert.equal((await request(path)).status, 200);
    const blocked = await request(path);
    assert.equal(blocked.status, 429); assert.ok(blocked.headers.get('retry-after'));
    assert.equal((await blocked.json()).code, 'RATE_LIMITED');
  }
  assert.equal((await request('business')).status, 200);
  assert.equal((await request('notifications')).status, 200);
});
