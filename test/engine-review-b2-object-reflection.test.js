'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const discourse = require('../engine-gpt-prod/discourseAudit');

// 2026-10-09 점검(F-14): `마음을 돌아보며`, `수용성을 돌아보도록`처럼 목적어를
// 받는 돌아보다가 설명·활동 문단을 성찰 문단으로 바꿨다고 집계됐다.

const SOURCE = [
  '글쓰기 수업은 학생이 자기 생각을 문장으로 옮기는 연습을 중심으로 진행한다.',
  '매주 한 편의 글을 쓰고 친구들과 바꿔 읽으며 고칠 점을 표시한다.',
  '수업 후반에는 짧은 글을 여러 번 고쳐 쓰면서 어휘를 넓히고 글 쓰는 힘을 기른다.'
].join('\n\n');

test('목적어를 받는 돌아보다만 생긴 활동 문단은 성찰 문단으로의 역할 이동이 아니다', () => {
  const output = [
    '글쓰기 수업은 학생이 자기 생각을 문장으로 옮기는 연습을 중심으로 진행한다.',
    '매주 한 편의 글을 쓰고 친구들과 바꿔 읽으며 고칠 점을 표시한다.',
    '수업 후반에는 짧은 글을 여러 번 고쳐 쓰면서 어휘를 넓히고, 자신의 마음을 돌아보며 글 쓰는 힘을 기른다.'
  ].join('\n\n');
  const audit = discourse.compareDiscourse(SOURCE, output);
  assert.equal(audit.codes.includes('rhetorical_role_shift'), false, JSON.stringify(audit.codes));

  const purposive = [
    '글쓰기 수업은 학생이 자기 생각을 문장으로 옮기는 연습을 중심으로 진행한다.',
    '매주 한 편의 글을 쓰고 친구들과 바꿔 읽으며 고칠 점을 표시한다.',
    '수업 후반에는 학생이 스스로 자신의 수용성을 돌아보도록 이끄는 질문을 던지며 글 쓰는 힘을 기른다.'
  ].join('\n\n');
  const purposiveAudit = discourse.compareDiscourse(SOURCE, purposive);
  assert.equal(purposiveAudit.codes.includes('rhetorical_role_shift'), false, JSON.stringify(purposiveAudit.codes));
});

test('새 깨달음 결론이 붙은 활동 문단은 계속 역할 이동으로 잡는다', () => {
  const output = [
    '글쓰기 수업은 학생이 자기 생각을 문장으로 옮기는 연습을 중심으로 진행한다.',
    '매주 한 편의 글을 쓰고 친구들과 바꿔 읽으며 고칠 점을 표시한다.',
    '수업 후반에는 짧은 글을 여러 번 고쳐 쓰면서 어휘를 넓히고 글 쓰는 힘을 기른다. 이 과정이 서로의 생각을 존중하는 일이었음을 깨달았다.'
  ].join('\n\n');
  const audit = discourse.compareDiscourse(SOURCE, output);
  assert.equal(audit.codes.includes('rhetorical_role_shift'), true, JSON.stringify(audit.codes));
});

test('성찰의 틀을 여는 돌아보면은 그대로 성찰 기능으로 센다', () => {
  const output = [
    '글쓰기 수업은 학생이 자기 생각을 문장으로 옮기는 연습을 중심으로 진행한다.',
    '매주 한 편의 글을 쓰고 친구들과 바꿔 읽으며 고칠 점을 표시한다.',
    '수업 후반에는 짧은 글을 여러 번 고쳐 쓰면서 어휘를 넓히고 글 쓰는 힘을 기른다. 한 학기를 돌아보면 고쳐 쓰기가 가장 큰 변화였다.'
  ].join('\n\n');
  const audit = discourse.compareDiscourse(SOURCE, output);
  assert.equal(audit.codes.includes('rhetorical_role_shift'), true, JSON.stringify(audit.codes));
});
