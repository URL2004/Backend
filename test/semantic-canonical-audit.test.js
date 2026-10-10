'use strict';

// Independent safety tests for the canonical semantic audit boundary.
// Synthetic fixtures only: every sentence, name and formula below is invented.
//
// Part 1 pins the semantics of the EXISTING freeze/thaw helpers that a
// canonical adapter has to build on. Observations that are behaviour rather
// than contract are reported with t.diagnostic so a later fix to those helpers
// does not break this file; the invariants the adapter relies on are asserted.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const engine = require('../engine-gpt-prod');
const literalSpans = require('../engine-gpt-prod/literalSpans');

const TOKEN = /ZXQ(?:LOCK|MATH|CODE)\d+QXZ/gu;
const count = (text, needle) => String(text).split(needle).length - 1;
// Mirror of index.js restoreLockedBlocks (not exported). The source pin below
// fails if the production body stops being a split/join over block tokens.
const restoreLocked = (text, blocks) => {
  let out = String(text || '');
  for (const block of blocks || []) out = out.split(block.token).join(block.value);
  return out;
};
const locked = (index, text, lockType) => ({ index, text, locked: true, lockType });
const editable = (index, text) => ({ index, text });

test('pin: production restoreLockedBlocks is still the split/join mirrored here', () => {
  const code = fs.readFileSync(path.join(__dirname, '../engine-gpt-prod/index.js'), 'utf8');
  const start = code.indexOf('function restoreLockedBlocks(');
  assert.ok(start > 0);
  const body = code.slice(start, code.indexOf('\n}\n', start));
  assert.match(body, /output\.split\(block\.token\)\.join\(block\.value\)/u);
});

test('identical two-character bullet prefixes freeze by ordinal and thaw exactly', () => {
  const source = '개요 문단이다.\n- 첫째 항목을 설명한다.\n- 둘째 항목을 설명한다.\n- 셋째 항목을 설명한다.\n- 넷째 항목을 설명한다.\n';
  const output = '개요 문단입니다.\n- 첫째 항목을 풀어 쓴다.\n- 둘째 항목을 풀어 쓴다.\n- 셋째 항목을 풀어 쓴다.\n- 넷째 항목을 풀어 쓴다.\n';
  const chunks = [editable(0, '개요 문단이다.')];
  for (let i = 0; i < 4; i += 1) {
    chunks.push(locked(1 + i * 2, '- ', 'bullet_prefix'));
    chunks.push(editable(2 + i * 2, 'x'));
  }
  const frozen = engine.freezeLockedBlocks(source, output, chunks);
  assert.equal(frozen.missCount, 0);
  assert.deepEqual(frozen.blocks.map(b => b.token),
    [0, 1, 2, 3].map(index => frozen.markerContext.token('ZXQLOCK', index)));
  for (const text of [frozen.source, frozen.output]) {
    for (const block of frozen.blocks) assert.equal(count(text, block.token), 1);
    // Ordinal assignment: tokens appear in block order, one per bullet line.
    const order = [...text.matchAll(TOKEN)].map(m => m[0]);
    assert.deepEqual(order, frozen.blocks.map(b => b.token));
    assert.equal(count(text, '- '), 0);
  }
  assert.equal(restoreLocked(frozen.source, frozen.blocks), source);
  assert.equal(restoreLocked(frozen.output, frozen.blocks), output);
  // A value-uniqueness rule can never refreeze this shape: the value occurs
  // four times in the canonical text.
  assert.equal(count(source, '- '), 4);
});

test('first-match freezing can tokenize prose instead of the locked line; text still round-trips', t => {
  const source = '가격 - 품질 관계를 먼저 본다.\n- 항목 하나를 설명한다.\n';
  const output = '먼저 가격과 품질의 관계를 본다.\n- 항목 하나를 풀어 쓴다.\n';
  const chunks = [editable(0, 'x'), locked(1, '- ', 'bullet_prefix'), editable(2, 'y')];
  const frozen = engine.freezeLockedBlocks(source, output, chunks);
  assert.equal(frozen.missCount, 0);
  assert.equal(restoreLocked(frozen.source, frozen.blocks), source);
  assert.equal(restoreLocked(frozen.output, frozen.blocks), output);
  const lineStart = text => {
    const at = text.indexOf(frozen.blocks[0].token);
    return at === 0 || text[at - 1] === '\n';
  };
  t.diagnostic(`source token at line start: ${lineStart(frozen.source)}; output token at line start: ${lineStart(frozen.output)}`);
  // The adapter may not assume a token marks the locked line, nor that source
  // and output tokens mark corresponding positions.
  assert.equal(count(frozen.source, '- ') + count(frozen.output, '- ') > 0, true,
    'one literal occurrence of the value stays outside the token');
});

test('a missed output block leaves auditSource different from the depth source map', () => {
  const source = 'Ⅰ. 서론\n\n본문을 설명한다.\n\nⅡ. 결론';
  const output = '본문을 풀어 쓴다.\n\nⅡ. 결론';
  const chunks = [locked(0, 'Ⅰ. 서론', 'heading'), editable(1, 'x'), locked(2, 'Ⅱ. 결론', 'heading')];
  const audit = engine.freezeLockedBlocks(source, output, chunks);
  const depth = engine.freezeLockedBlocks(source, source, chunks);
  assert.equal(audit.missCount, 1);
  assert.notEqual(audit.source, depth.source);
  assert.equal(audit.blocks.length, 1);
  assert.equal(depth.blocks.length, 2);
  // Each representation thaws exactly only with ITS OWN map.
  assert.equal(restoreLocked(audit.source, audit.blocks), source);
  assert.equal(restoreLocked(depth.source, depth.blocks), source);
  assert.notEqual(restoreLocked(depth.source, audit.blocks), source);
});

test('duplicated or dropped lock tokens thaw without any error signal', () => {
  const blocks = [{ token: 'ZXQLOCK0000QXZ', value: '## 배경' }];
  const duplicated = 'ZXQLOCK0000QXZ\n첫 문단이다.\nZXQLOCK0000QXZ\n둘째 문단이다.';
  assert.equal(count(restoreLocked(duplicated, blocks), '## 배경'), 2);
  const dropped = '첫 문단이다.\n둘째 문단이다.';
  assert.equal(restoreLocked(dropped, blocks), dropped);
});

test('math and inline-code thaw report pass:false and keep tokens when the census is not exactly one', () => {
  const code = literalSpans.freezeInlineCode('값은 `limit` 로 정한다.');
  const duplicated = `${code.text} 다시 ${code.blocks[0].token} 를 쓴다.`;
  const restoredCode = literalSpans.restoreInlineCode(duplicated, code);
  assert.equal(restoredCode.pass, false);
  assert.match(restoredCode.text, TOKEN);
  const math = literalSpans.freezeMath('관계는 $a+b$ 이다.');
  assert.equal(math.count, 1);
  const restoredMath = literalSpans.restoreMath('관계는 생략했다.', math);
  assert.equal(restoredMath.pass, false);
});

test('source token-shaped text round-trips with collision-free tokens; legacy ambiguous maps still fail', () => {
  const raw = '기록에 ZXQCODE0000QXZ 라는 문자열과 `limit` 가 함께 있다.';
  const code = literalSpans.freezeInlineCode(raw);
  assert.equal(count(code.text, 'ZXQCODE0000QXZ'), 1);
  const restored = literalSpans.restoreInlineCode(code.text, code);
  assert.equal(restored.pass, true);
  assert.equal(restored.text, raw);
  const blocks = [{ token: 'ZXQLOCK0000QXZ', value: '## 배경' }];
  const lockedRaw = '## 배경\n본문에 ZXQLOCK0000QXZ 라는 문자열이 있다.';
  const frozen = lockedRaw.replace('## 배경', 'ZXQLOCK0000QXZ');
  assert.notEqual(restoreLocked(frozen, blocks), lockedRaw);
});

test('display math and dollar patterns survive the existing thaw helpers', t => {
  for (const raw of [
    '정의는 $$a^2+b^2=c^2$$ 이다.',
    '명령은 `echo $&` 로 쓴다.',
    "명령은 `cut $' end` 로 쓴다."
  ]) {
    const code = literalSpans.freezeInlineCode(raw);
    const math = literalSpans.freezeMath(code.text);
    const thawedMath = literalSpans.restoreMath(math.text, math);
    const thawed = literalSpans.restoreInlineCode(thawedMath.text, code);
    t.diagnostic(JSON.stringify({ code: code.blocks, math: math.blocks, frozen: math.text, thawed: thawed.text,
      plain: 'a T b'.replace('T', '$$x$$') }));
    assert.equal(thawed.text, raw, raw);
  }
});

test('depth pair renumbers output literals in output order, so the source map does not thaw it', () => {
  const rawSource = 'Ⅰ. 설정\n\n먼저 `alpha` 를 쓰고 다음에 `beta` 를 쓴다.';
  const markerContext = literalSpans.createMarkerContext(rawSource);
  const inline = literalSpans.freezeInlineCode(rawSource, markerContext);
  const chunks = [locked(0, 'Ⅰ. 설정', 'heading'), editable(1, 'x')];
  const initial = engine.freezeLockedBlocks(inline.text, inline.text, chunks, markerContext);
  const primaryFrozen = engine.freezeLockedBlocks(inline.text, inline.text, chunks, markerContext);
  const finalRaw = 'Ⅰ. 설정\n\n먼저 `beta` 를 쓰고 다음에 `alpha` 를 쓴다.';
  const pair = engine.buildHumanizationDepthPair({
    source: inline.text, outputText: finalRaw, chunks, primaryFrozen, canonicalSource: initial.source
  });
  assert.equal((pair.output.match(/ZXQCODE\d{4}QXZ/gu) || []).length, 2);
  const thawed = literalSpans.materializeChunkLiterals(
    [{ text: restoreLocked(pair.output, primaryFrozen.blocks) }],
    { inlineCodeFreeze: inline }
  )[0].text;
  assert.notEqual(thawed, finalRaw);
  assert.match(thawed, /`alpha` 를 쓰고 다음에 `beta`/u);
});

// Part 2: the canonical adapter (engine-gpt-prod/semanticCanonicalAudit.js).
// These are independent of the adapter's own unit tests. Every assertion is a
// safety property: exact inverse, or the legacy path, or a fail-closed view.

const canonicalAudit = require('../engine-gpt-prod/semanticCanonicalAudit');
const provenance = require('../engine-gpt-prod/semanticProvenance');

function fixture() {
  const raw = '## 배경 `core`\n첫 문단은 `limit` 값을 설명한다.\n1. 첫째 항목은 $$a+b$$ 를 쓴다.\n2. 둘째 항목은 결과를 적는다.\n';
  const code = literalSpans.freezeInlineCode(raw);
  const math = literalSpans.freezeMath(code.text);
  const source = math.text;
  const output = source.replace('값을 설명한다', '값을 풀어 쓴다').replace('결과를 적는다', '결과를 기록한다');
  const chunks = [locked(0, `## 배경 ${code.blocks[0].token}`, 'heading'), editable(1, 'x'),
    locked(2, '1. ', 'bullet_prefix'), editable(3, 'y'), locked(4, '2. ', 'bullet_prefix'), editable(5, 'z')];
  const frozen = engine.freezeLockedBlocks(source, output, chunks);
  const canonical = canonicalAudit.createCanonicalAudit({ rawSource: raw, frozenSource: frozen.source,
    lockedBlocks: frozen.blocks, mathBlocks: math.blocks, codeBlocks: code.blocks });
  // Mirror of index.js projectSemanticText for this job's maps.
  const project = value => {
    let text = restoreLocked(value, frozen.blocks);
    text = literalSpans.restoreMath(text, math).text;
    return literalSpans.restoreInlineCode(text, code).text;
  };
  const candidate = raw.replace('값을 설명한다', '값을 풀어 쓴다').replace('결과를 적는다', '결과를 기록한다');
  return { raw, code, math, frozen, canonical, project, candidate };
}
const judged = (report, source, candidate) => provenance.bindSemanticValidation(
  { ran: true, verificationCompleted: true, outputText: candidate, selectedJudgeModel: 'judge-a', ...report },
  source, candidate, { model: 'judge-a', now: () => 0 });
const isPass = (report, source, candidate) => provenance.verifySemanticValidation(
  report, { source, candidate, requireDigest: true }).status === 'pass';

test('prepared adoption baseline is the exact refrozen whitespace-only judge input, not a verdict', async () => {
  const f=fixture(); let baseline, called=false;
  const report=await canonicalAudit.runCanonicalSemanticAudit({canonical:f.canonical,
    options:{source:f.frozen.source,outputText:f.frozen.output,
      prepareCandidateText:async (_source,text)=>text.replace('첫 문단은','첫  문단은')},
    onPreparedCandidate:text=>{assert.equal(called,false);baseline=text;},
    runAudit:async o=>{called=true;assert.equal(f.project(baseline),o.outputText);
      return judged({pass:false,uncertain:true,violations:[]},o.source,o.outputText);}
  });
  assert.notEqual(baseline,f.frozen.output);
  assert.equal(report.pass,false);assert.equal(report.uncertain,true);
  assert.equal(Object.hasOwn(report.canonicalAudit,'preparedCandidate'),false);
});

test('a word-changing formatter cannot replace the candidate adoption baseline', async () => {
  const f=fixture();let callbacks=0;
  await canonicalAudit.runCanonicalSemanticAudit({canonical:f.canonical,
    options:{source:f.frozen.source,outputText:f.frozen.output,
      prepareCandidateText:async (_source,text)=>text.replace('첫 문단은','마지막 문단은')},
    onPreparedCandidate:()=>callbacks++,runAudit:async o=>judged({pass:false},o.source,o.outputText)});
  assert.equal(callbacks,0);
});

test('unavailable canonical mapping never provides a prepared baseline', async () => {
  let callbacks=0;
  await canonicalAudit.runCanonicalSemanticAudit({canonical:{ok:false,reason:'unavailable'},
    options:{source:'원문이다.',outputText:'고친 문장이다.'},onPreparedCandidate:()=>callbacks++,
    runAudit:async o=>judged({pass:false},o.source,o.outputText)});
  assert.equal(callbacks,0);
});

test('per-section preparation can update the baseline but repairs and structural changes cannot', async () => {
  const f=fixture();const baselines=[];
  await canonicalAudit.runCanonicalSemanticAudit({canonical:f.canonical,
    options:{source:f.frozen.source,outputText:f.frozen.output},
    onPreparedCandidate:text=>baselines.push(text),
    runAudit:async o=>{
      assert.equal(typeof o.onPreparedCandidate,'function');
      const spaced=o.outputText.replace('첫 문단은','첫  문단은');
      o.onPreparedCandidate(spaced);
      assert.equal(f.project(baselines.at(-1)),spaced);
      const count=baselines.length;
      o.onPreparedCandidate(spaced.replace('첫  문단은','다른 문단은'));
      o.onPreparedCandidate(spaced.replace('`core`\n','`core` '));
      assert.equal(baselines.length,count);
      return judged({pass:false,uncertain:true},o.source,spaced);
    }});
  assert.equal(baselines.length,2);
});

test('adapter: opt-in formatting is judged before an exact frozen verdict is issued', async () => {
  const f = fixture();
  let calls = 0;
  const formatted = f.candidate.replace('첫 문단은', '첫  문단은');
  const format = async (_source, text) => text.replace(/첫 +문단은/u, '첫  문단은');
  const report = await canonicalAudit.runCanonicalSemanticAudit({
    canonical: f.canonical,
    options: { source: f.frozen.source, outputText: f.frozen.output, prepareCandidateText: format },
    runAudit: async options => {
      calls += 1;
      assert.equal(options.outputText, formatted);
      assert.equal(options.prepareCandidateText, format);
      return judged({ pass: true, violations: [] }, options.source, options.outputText);
    }
  });
  assert.equal(calls, 1);
  assert.equal(f.project(report.outputText), formatted);
  assert.equal(isPass(report, f.frozen.source, report.outputText), true);
  assert.equal(report.canonicalAudit.frozenViewExact, true);
});

test('adapter: a formatter that touches a protected heading is disabled before the model call', async () => {
  const f = fixture();
  let calls = 0;
  const report = await canonicalAudit.runCanonicalSemanticAudit({
    canonical: f.canonical,
    options: { source: f.frozen.source, outputText: f.frozen.output,
      prepareCandidateText: async (_source, text) => text.replace('## 배경', '## 새 배경') },
    runAudit: async options => {
      calls += 1;
      assert.equal(options.outputText, f.candidate);
      assert.equal(options.prepareCandidateText, null);
      return judged({ pass: true, violations: [] }, options.source, options.outputText);
    }
  });
  assert.equal(calls, 1);
  assert.equal(report.outputText, f.frozen.output);
  assert.equal(isPass(report, f.frozen.source, f.frozen.output), true);
});

test('adapter: nested heading code, bullet prefixes and display math materialize and refreeze exactly', () => {
  const { raw, frozen, canonical, project, candidate } = fixture();
  assert.equal(frozen.missCount, 0);
  assert.equal(canonical.ok, true, canonical.reason);
  assert.equal(canonical.canonicalSource, raw);
  const thawed = canonical.materialize(frozen.output);
  assert.deepEqual(thawed, { ok: true, text: candidate });
  assert.equal(project(frozen.output), candidate, 'adapter and pipeline projection agree');
  assert.doesNotMatch(thawed.text, /ZXQ|QXZ/u);
  assert.deepEqual(canonical.refreeze(candidate, frozen.output), { ok: true, text: frozen.output });
  // A repair limited to prose refreezes to a text that thaws to exactly it.
  const repaired = candidate.replace('결과를 기록한다', '결과를 빠짐없이 기록한다');
  const refrozen = canonical.refreeze(repaired, frozen.output);
  assert.equal(refrozen.ok, true, refrozen.reason);
  assert.deepEqual(canonical.materialize(refrozen.text), { ok: true, text: repaired });
  assert.deepEqual(refrozen.text.match(TOKEN), frozen.output.match(TOKEN));
  assert.equal(refrozen.text, frozen.output.replace('결과를 기록한다', '결과를 빠짐없이 기록한다'));
});

test('adapter: any changed, dropped, duplicated or token-like literal refuses to refreeze', () => {
  const { frozen, canonical, candidate } = fixture();
  const variants = {
    headingText: candidate.replace('## 배경 `core`', '## 배경 설명 `core`'),
    headingCode: candidate.replace('`core`', '`cores`'),
    headingJoinedToProse: candidate.replace('`core`\n', '`core` '),
    bulletPrefix: candidate.replace('\n1. ', '\n11. '),
    bulletDropped: candidate.replace('\n2. ', '\n'),
    bulletMovedInline: candidate.replace('\n2. 둘째', ' 2. 둘째'),
    inlineCode: candidate.replace('`limit`', '`limits`'),
    math: candidate.replace('$$a+b$$', '$$a+b+c$$'),
    mathToInline: candidate.replace('$$a+b$$', '$a+b$'),
    duplicatedLiteral: `${candidate}끝으로 \`limit\` 를 다시 쓴다.\n`,
    reorderedLiterals: candidate.replace('`limit`', '$$a+b$$').replace(/\$\$a\+b\$\$ 를/u, '`limit` 를'),
    tokenLike: `${candidate}ZXQLOCK0000QXZ\n`,
    tokenFragment: `${candidate}QXZ\n`
  };
  for (const [name, text] of Object.entries(variants)) {
    assert.notEqual(text, candidate, name);
    const result = canonical.refreeze(text, frozen.output);
    assert.equal(result.ok, false, name);
    assert.match(String(result.reason), /^canonical_/u, name);
    assert.equal(result.text, undefined, name);
  }
});

test('adapter: unavailable when the raw source is not exactly the thawed frozen source', () => {
  const { raw, code, math, frozen } = fixture();
  const build = over => canonicalAudit.createCanonicalAudit({ rawSource: raw, frozenSource: frozen.source,
    lockedBlocks: frozen.blocks, mathBlocks: math.blocks, codeBlocks: code.blocks, ...over });
  const cases = {
    sourceDiffers: build({ rawSource: raw.replace('첫 문단은', '첫  문단은') }),
    trailingNewlineDiffers: build({ rawSource: raw.trimEnd() }),
    rawHasTokenText: build({ rawSource: `${raw}ZXQCODE0009QXZ\n`, frozenSource: `${frozen.source}ZXQCODE0009QXZ\n` }),
    missingMap: build({ mathBlocks: [] }),
    conflictingMap: build({ codeBlocks: [...code.blocks, { token: code.blocks[0].token, value: '`other`' }] }),
    duplicatedSourceToken: build({ frozenSource: `${frozen.source}${frozen.blocks[1].token}` }),
    emptyValue: build({ lockedBlocks: [...frozen.blocks, { token: 'ZXQLOCK0009QXZ', value: '' }] })
  };
  for (const [name, canonical] of Object.entries(cases)) {
    assert.equal(canonical.ok, false, name);
    assert.match(String(canonical.reason), /^canonical_/u, name);
    assert.equal(canonical.materialize(frozen.output).ok, false, name);
    assert.equal(canonical.refreeze(raw, frozen.source).ok, false, name);
  }
});

test('adapter: the audit map and the depth map are not interchangeable after an output miss', () => {
  const source = 'Ⅰ. 서론\n\n본문을 설명한다.\n\nⅡ. 결론\n';
  const output = '본문을 풀어 쓴다.\n\nⅡ. 결론\n';
  const chunks = [locked(0, 'Ⅰ. 서론', 'heading'), editable(1, 'x'), locked(2, 'Ⅱ. 결론', 'heading')];
  const audit = engine.freezeLockedBlocks(source, output, chunks);
  const depth = engine.freezeLockedBlocks(source, source, chunks);
  const own = canonicalAudit.createCanonicalAudit({ rawSource: source, frozenSource: audit.source, lockedBlocks: audit.blocks });
  assert.equal(own.ok, true, own.reason);
  assert.deepEqual(own.materialize(audit.output), { ok: true, text: output });
  const crossed = canonicalAudit.createCanonicalAudit({ rawSource: source, frozenSource: depth.source, lockedBlocks: audit.blocks });
  assert.equal(crossed.ok, false);
  // The depth-frozen pair is not bound to this adapter, so it stays legacy.
  assert.equal(canonicalAudit.prepareCandidate(own, depth.source, depth.output).ok, false);
});

test('adapter: repeated literal values are exact or the adapter is unavailable, never approximate', t => {
  const bullets = '개요 문단이다.\n- 첫째 항목을 설명한다.\n- 둘째 항목을 설명한다.\n';
  const bulletOut = bullets.replace('첫째 항목을 설명한다', '첫째 항목을 풀어 쓴다');
  const prose = '가격 - 품질 관계를 먼저 본다.\n- 항목 하나를 설명한다.\n';
  const proseOut = '먼저 가격과 품질의 관계를 본다.\n- 항목 하나를 풀어 쓴다.\n';
  for (const [name, source, output, count] of [['identical', bullets, bulletOut, 2], ['firstMatchInProse', prose, proseOut, 1]]) {
    const chunks = [editable(0, 'x')];
    for (let i = 0; i < count; i += 1) chunks.push(locked(1 + i, '- ', 'bullet_prefix'));
    const frozen = engine.freezeLockedBlocks(source, output, chunks);
    const canonical = canonicalAudit.createCanonicalAudit({ rawSource: source, frozenSource: frozen.source, lockedBlocks: frozen.blocks });
    t.diagnostic(`${name}: adapter ok=${canonical.ok} reason=${canonical.reason || '-'}`);
    if (!canonical.ok) {
      assert.match(String(canonical.reason), /^canonical_/u, name);
      continue;
    }
    const prepared = canonicalAudit.prepareCandidate(canonical, frozen.source, frozen.output);
    t.diagnostic(`${name}: prepared ok=${prepared.ok} reason=${prepared.reason || '-'}`);
    if (!prepared.ok) continue;
    assert.equal(prepared.canonicalCandidate, output, name);
    const repaired = output.replace('풀어 쓴다', '자세히 풀어 쓴다');
    const refrozen = canonical.refreeze(repaired, frozen.output);
    t.diagnostic(`${name}: refreeze ok=${refrozen.ok} reason=${refrozen.reason || '-'}`);
    if (refrozen.ok) assert.deepEqual(canonical.materialize(refrozen.text), { ok: true, text: repaired }, name);
    assert.equal(canonical.refreeze(`${repaired}- 덧붙인 항목이다.\n`, frozen.output).ok, false, name);
  }
});

test('run: an exact pair is judged in raw form and returned as a provenance-bound frozen view', async () => {
  const { raw, frozen, canonical, project, candidate } = fixture();
  const seen = [];
  const report = await canonicalAudit.runCanonicalSemanticAudit({
    canonical,
    options: { source: frozen.source, outputText: frozen.output, mode: 'assignment', receiptStore: 'store' },
    runAudit: async options => { seen.push(options); return judged({ pass: true, usage: { calls: 1 } }, options.source, options.outputText); }
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].source, raw);
  assert.equal(seen[0].outputText, candidate);
  assert.equal(seen[0].mode, 'assignment');
  assert.equal(seen[0].receiptStore, 'store');
  assert.equal(report.outputText, frozen.output);
  assert.equal(report.pass, true);
  assert.deepEqual(report.usage, { calls: 1 });
  assert.equal(report.canonicalAudit.applied, true);
  assert.equal(isPass(report, frozen.source, frozen.output), true);
  assert.equal(isPass(report, raw, candidate), false, 'the view is bound to the frozen pair only');
  assert.equal(report.validation.parentSourceDigest, provenance.textDigest(raw));
  assert.equal(report.validation.parentCandidateDigest, provenance.textDigest(candidate));
  // The pipeline projection of the view lands on the pair the judge saw.
  const projected = provenance.projectSemanticValidation(report, { source: frozen.source, candidate: report.outputText, project });
  assert.equal(projected.validation.sourceDigest, provenance.textDigest(raw));
  assert.equal(projected.validation.candidateDigest, provenance.textDigest(candidate));
  assert.equal(isPass(projected, raw, candidate), true);
});

test('run: a verified prose repair is refrozen; a repair that touches a literal is never a pass', async () => {
  const { raw, frozen, canonical, candidate } = fixture();
  const run = text => canonicalAudit.runCanonicalSemanticAudit({
    canonical, options: { source: frozen.source, outputText: frozen.output },
    runAudit: async options => judged({ pass: true, rounds: 1, usage: { calls: 2 },
      initialViolations: [{ id: 'initial-1', sourceSpan: '결과를 적는다' }], violations: [] }, options.source, text)
  });
  const repaired = candidate.replace('결과를 기록한다', '결과를 적는다');
  const ok = await run(repaired);
  assert.equal(ok.pass, true);
  assert.deepEqual(canonical.materialize(ok.outputText), { ok: true, text: repaired });
  assert.equal(isPass(ok, frozen.source, ok.outputText), true);
  assert.equal(ok.validation.parentCandidateDigest, provenance.textDigest(repaired));

  const broken = await run(repaired.replace('## 배경 `core`', '## 배경 설명 `core`'));
  assert.equal(broken.pass, false);
  assert.equal(broken.repairRejected, true);
  assert.equal(broken.outputText, frozen.output);
  assert.deepEqual(broken.usage, { calls: 2 });
  assert.deepEqual(broken.violations.map(item => item.id), ['initial-1']);
  for (const [source, text] of [[frozen.source, frozen.output], [raw, candidate], [raw, repaired]]) {
    assert.equal(isPass(broken, source, text), false);
  }
  assert.equal(broken.canonicalAudit.frozenViewExact, false);
});

test('run: a failed conversion keeps initial and residual findings, uncertainty and usage', async () => {
  const { frozen, canonical, candidate } = fixture();
  const text = candidate.replace('`limit`', '`limits`');
  const report = await canonicalAudit.runCanonicalSemanticAudit({
    canonical, options: { source: frozen.source, outputText: frozen.output },
    runAudit: async options => judged({ pass: false, uncertain: true, rounds: 1, usage: { calls: 2 },
      initialViolations: [{ id: 'initial-1', sourceSpan: '값을 설명한다' }],
      violations: [{ id: 'residual-1', sourceSpan: '결과를 적는다' }] }, options.source, text)
  });
  assert.equal(report.pass, false);
  assert.equal(report.uncertain, true);
  assert.equal(report.outputText, frozen.output);
  assert.deepEqual(report.usage, { calls: 2 });
  assert.deepEqual(report.violations.map(item => item.id).sort(), ['initial-1', 'residual-1']);
});

test('run: stale, unbound, uncertain or failed reports never become a pass through the view', async () => {
  const { raw, frozen, canonical, candidate } = fixture();
  const through = make => canonicalAudit.runCanonicalSemanticAudit({
    canonical, options: { source: frozen.source, outputText: frozen.output }, runAudit: async options => make(options) });
  const reports = {
    staleCandidate: await through(o => judged({ pass: true, outputText: o.outputText }, o.source, `${o.outputText} `)),
    staleSource: await through(o => judged({ pass: true }, `${o.source} `, o.outputText)),
    unbound: await through(o => ({ ran: true, pass: true, verificationCompleted: true, outputText: o.outputText })),
    uncertain: await through(o => judged({ pass: false, uncertain: true, verificationCompleted: false }, o.source, o.outputText)),
    failed: await through(o => judged({ pass: false, violations: [{ id: 'v1', sourceSpan: '값을 설명한다' }] }, o.source, o.outputText))
  };
  for (const [name, report] of Object.entries(reports)) {
    assert.equal(report.outputText, frozen.output, name);
    for (const [source, text] of [[frozen.source, frozen.output], [raw, candidate]]) {
      assert.equal(isPass(report, source, text), false, name);
    }
  }
  for (const name of ['staleCandidate', 'staleSource', 'unbound']) assert.equal(reports[name].pass, false, name);
  assert.equal(reports.uncertain.uncertain, true);
  assert.deepEqual(reports.failed.violations.map(item => item.id), ['v1']);
});

test('run: an inexact candidate runs the existing frozen audit unchanged and errors propagate', async () => {
  const { frozen, canonical } = fixture();
  const tokens = frozen.output.match(TOKEN);
  const inexact = {
    dropped: frozen.output.replace(tokens[1], ''),
    duplicated: `${frozen.output}${tokens[1]}`,
    reordered: frozen.output.replace(tokens[1], '\u0001').replace(tokens[3], tokens[1]).replace('\u0001', tokens[3]),
    unknown: `${frozen.output}ZXQLOCK0042QXZ`
  };
  for (const [name, outputText] of Object.entries(inexact)) {
    const seen = [];
    const legacy = { ran: true, pass: false, verificationCompleted: true, outputText, violations: [{ id: 'legacy' }] };
    const options = { source: frozen.source, outputText, mode: 'assignment' };
    const report = await canonicalAudit.runCanonicalSemanticAudit({
      canonical, options, runAudit: async given => { seen.push(given); return legacy; } });
    assert.deepEqual(seen, [options], name);
    const { canonicalAudit: meta, ...rest } = report;
    assert.deepEqual(rest, legacy, name);
    assert.equal(meta.applied, false, name);
    assert.match(String(meta.reason), /^canonical_/u, name);
  }
  await assert.rejects(canonicalAudit.runCanonicalSemanticAudit({
    canonical, options: { source: frozen.source, outputText: frozen.output },
    runAudit: async () => { throw new Error('judge_timeout'); } }), /judge_timeout/u);
});
