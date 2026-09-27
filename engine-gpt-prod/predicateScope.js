'use strict';

// Bounded review hints, not grammatical verdicts or deterministic rewrites.
const BEGINNING = /기\s*시작(?:했|하였|한|하는|하고)/u;
const RETROSPECTIVE = /[가-힣]{2,}(?:한|된|온|는|던)\s+셈(?:이었|이다|입니다)/u;
const INTERPRETATION = /(?:셈(?:이었|이다|입니다)|것으로\s*(?:보|해석|생각)|[라다]고\s*(?:볼|생각|해석)|것\s*같|듯(?:했|하))/u;
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

function predicateScopeCandidates(source, output) {
  const original = String(source || ''), candidate = String(output || '');
  if (original === candidate) return [];
  const codes = [];
  if (BEGINNING.test(original)) {
    // Bind beginning to its object, rather than accepting a beginning verb
    // attached to an unrelated action elsewhere in the rewritten sentence.
    for (const match of original.matchAll(/(?<![가-힣])([가-힣]{2,16}?)(?:부터|을|를)\s+(?:(?:막|처음|먼저|다시|차근차근|새로)\s+)?[가-힣]{1,16}기\s*시작(?:했|하였|한|하는|하고)/gu)) {
      const target = new RegExp(`(?<![가-힣])${escape(match[1])}(?:부터|을|를|은|는)\\s+([^.!?\\n]{1,65})`, 'u').exec(candidate);
      if (!target) continue;
      const clause = target[1];
      if (/(?:기\s*시작|착수|진행|하고\s*있|중이|하려|예정)/u.test(clause)) continue;
      if (/[가-힣](?:했|하였|었|았|냈|쳤)다(?:\s|,|$)/u.test(clause)) {
        codes.push('action_completion_candidate'); break;
      }
    }
  }
  if (RETROSPECTIVE.test(original) && !INTERPRETATION.test(candidate)) codes.push('retrospective_interpretation_candidate');
  return codes;
}

function sourceScopeHints(source) {
  const text = String(source || '');
  return [
    BEGINNING.test(text) ? '행동의 시작·진행·완료를 구별한다. 무엇을 시작했는지 목적어에 연결하고, 다른 행동에 “시작”을 남긴 채 원래 행동을 완료로 확정하지 않는다.' : '',
    RETROSPECTIVE.test(text) ? '“~한 셈이었다”의 사후 해석 범위를 보존한다. 문장은 자연스럽게 바꾸되 해석을 확정 사실로 높이지 않는다.' : ''
  ].filter(Boolean).join('\n');
}

module.exports = { predicateScopeCandidates, sourceScopeHints };
