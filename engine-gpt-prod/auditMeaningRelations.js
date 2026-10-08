'use strict';

// Local review nominations, never substitutions or factual verdicts. The
// caller supplies aligned complete sentences; the existing judge resolves
// these questions against the surrounding source before any repair is allowed.
const VERSION = 'audit-meaning-relations-v1';
const CODES = ['qualification_strength_candidate', 'force_direction_candidate',
  'reflection_attribution_candidate', 'parallel_result_candidate',
  'retrospective_tense_candidate', 'introduced_nominal_grammar_candidate',
  'antecedent_value_candidate'];
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
function hasPoeticLineEvidence(source) {
  const text = String(source || ''), lines = text.split(/\r?\n/u).map(s => s.trim()).filter(Boolean);
  return lines.length >= 6 && text.split(/\n\s*\n/u).filter(s => s.trim()).length >= 3
    && lines.filter(s => s.length <= 40).length / lines.length >= 0.8
    && /(?<![가-힣])(?:아아|오오|([가-힣]{1,3})\1)(?![가-힣])/u.test(text)
    && lines.filter(s => /[.!?。！？]\s*$/u.test(s)).length / lines.length < 0.45;
}
function directionalPairs(originals, rewritten) {
  const { ngramJaccard } = require('../engine/koreanText');
  const result = [];
  for (const outputSpan of rewritten) {
    if (!/(?:압력|하중|힘)/u.test(outputSpan)) continue;
    const ranked = originals.filter(sourceSpan => sentenceCodes(sourceSpan, outputSpan).includes('force_direction_candidate'))
      .map(sourceSpan => ({ sourceSpan, score: ngramJaccard(sourceSpan, outputSpan, 2) }))
      .sort((a, b) => b.score - a.score);
    if (!ranked.length || ranked[0].score < 0.18 || (ranked[1] && ranked[0].score - ranked[1].score < 0.05)) continue;
    result.push({ code: 'force_direction_candidate', sourceSpan: ranked[0].sourceSpan, outputSpan });
  }
  return result;
}

function sentenceCodes(source, output) {
  if (source === output) return [];
  const codes = [];
  // Studying a discipline does not itself attest a formal major. The same
  // document may attest it elsewhere, so this is explicitly a question.
  if (/(?:학과|분야|학문|과목|전공)[^.!?\n]{0,45}공부/u.test(source)
      && !/전공(?:했|하였|하던|한\s)/u.test(source)
      && /전공(?:했|하였|하던|한\s)/u.test(output)) codes.push(CODES[0]);
  for (const match of source.matchAll(/(?<![가-힣])([가-힣]{1,12})의\s*(압력|힘|하중)/gu)) {
    if (new RegExp(`${escape(match[1])}(?:에|에게)\\s*(?:가하|가해|주는|주어진|작용하)[^.!?\\n]{0,12}${match[2]}`, 'u').test(output)) codes.push(CODES[1]);
  }
  const reflection = /(?:생각이\s*들었|배웠|깨달았|느꼈|알게\s*(?:되었|됐)|이해하게\s*(?:되었|됐))/u;
  const retained = /(?:생각|배웠|배운|깨달|느꼈|느낀|알게|이해했|이해하게|수업에서|강의에서|들었다|들었습니다)/u;
  if (reflection.test(source) && !retained.test(output)
      && /(?:해야\s*(?:한|합)|는\s*데\s*있|[가-힣](?:다|습니다)\.)/u.test(output)) codes.push(CODES[2]);
  if (/검토(?:하)?(?:며|면서)[^.!?\n]{0,60}아이디어(?:를|을)[^.!?\n]{0,20}발전/u.test(source)
      && /검토(?:해|하여)[^.!?\n]{0,60}아이디어로[^.!?\n]{0,20}발전/u.test(output)) codes.push(CODES[3]);
  if (/(?:알게\s*된\s*점|새롭게\s*알았|배운\s*점)/u.test(source)
      && /(?:알게\s*(?:된다|됩니다)|새롭게\s*안다|배우게\s*된다)/u.test(output)) codes.push(CODES[4]);
  if (/(?:나눠|나누어)\s*주는\s*일/u.test(source)
      && /(?:나눠|나누어)\s*주는\s*뜻/u.test(output)) codes.push(CODES[5]);
  if (!/전체와\s*(?:형태|모양)와/u.test(source)
      && /전체와\s*(?:형태|모양)와\s*크기/u.test(output)) codes.push(CODES[5]);
  if (/(?:그것이|이것이)\s*곧\s*(?:나|저)에게\s*가치가\s*없는\s*것은\s*아니/u.test(source)
      && /그렇다고\s*(?:나|저)에게\s*가치가\s*없는\s*것은\s*아니/u.test(output)) codes.push(CODES[6]);
  return [...new Set(codes)];
}

const instruction = 'qualification_strength_candidate·force_direction_candidate·reflection_attribution_candidate·parallel_result_candidate·retrospective_tense_candidate·introduced_nominal_grammar_candidate·antecedent_value_candidate는 문맥 확인 질문이다. 공부와 공식 전공, 힘을 주는 주체와 받는 대상, 현재 문단의 배움·생각 귀속, 병렬 행동과 결과물 생성, 과거 인식과 현재 일반 서술, 신규 명사 호응, 가치의 지시 대상을 각각 SOURCE 앞뒤와 대조한다. 다른 문단에 화자가 남아 있다는 이유로 현재 성찰의 일반 사실화를 허용하지 않는다. 공부→전공 등의 어휘 교체 자체를 오류로 확정하거나 실제 허위 학력이라고 추정하지 않는다. 같은 관계의 자연스러운 의역·문장 분리와 원래 있던 비문은 preserved/source_issue로 구분하고, 새 관계 변화·호응 파손이 확인될 때만 정확한 introduced violation을 쓴다. 확정되지 않으면 uncertain이며 자동 단어 교체나 문장 복원은 금지한다.';
module.exports = { VERSION, CODES, sentenceCodes, directionalPairs, hasPoeticLineEvidence, instruction };
