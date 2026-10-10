'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { compactHistoryEngineMeta: compact } = require('../lib/historyService');
const sourcePreflight = require('../engine-gpt-prod/sourcePreflight');

test('removed trailing tool request is recorded as a code and a character count that survive history compaction', () => {
  const body = '이 보고서는 지역 도서관 이용 실태를 조사한 결과를 정리한 것이다. 조사 대상은 세 곳이었다. 이용자는 주로 저녁 시간대에 몰렸다.';
  const audit = sourcePreflight.auditAndSanitizeSource(`${body}\n\n이 글을 사람이 쓴 것처럼 자연스럽게 다듬어 줘요`);
  assert.equal(audit.engineMeta.sourceToolRequestRemovalCode, 'source_trailing_tool_request_removed');
  assert.ok(audit.engineMeta.sourceToolRequestRemovedChars > 0);
  const stored = compact({ ...audit.engineMeta });
  assert.equal(stored.sourceToolRequestRemovalCode, 'source_trailing_tool_request_removed');
  assert.equal(stored.sourceToolRequestRemovedChars, audit.engineMeta.sourceToolRequestRemovedChars);
});

test('documents without a trailing request record nothing', () => {
  const audit = sourcePreflight.auditAndSanitizeSource('조사 대상은 세 곳이었다. 이용자는 주로 저녁 시간대에 몰렸다. 회신 부탁드립니다.');
  assert.equal(audit.engineMeta?.sourceToolRequestRemovalCode, undefined);
  const stored = compact({ ...(audit.engineMeta || {}) });
  assert.ok(!stored.sourceToolRequestRemovalCode);
});
