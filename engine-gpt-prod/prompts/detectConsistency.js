'use strict';

// Abstract contrasts only: no production documents, institution-specific
// phrases, target scores, or authorship labels used as few-shot shortcuts.
function buildConsistencyCriteria(lang = 'ko') {
  if (lang === 'en') return [
    '[CONSISTENT EVIDENCE REVIEW]',
    'First locate evidence and genre-appropriate counterevidence, then classify each cause, then choose the score. Confidence measures sample sufficiency, not repeatability.',
    'weak: an isolated or ambiguous observation explainable by normal genre conventions. moderate: the same clearly identifiable, non-conventional pattern occurs in at least two independent prose units. strong: that pattern is unmistakable and dominates several independent units even after considering counterevidence. Repetition alone does not upgrade moderate to strong.',
    'Scope measures spread, not strength. recurring needs different sampleUnitIndex values. pervasive needs spread across the document and multiple paragraphs when present. Do not downgrade or upgrade strength merely because there are more numbered items.',
    'Distinguish causes: sentence_uniformity is repeated syntactic/breath patterns, not consistent formal endings; ending_repetition is a formulaic ending beyond the required register; formulaic_transition is repeated canned connective/conclusion logic; overstructured_progression is repetitive content-independent reasoning, not headings or orderly sections.',
    'generic_abstraction needs interchangeable generalities replacing relevant substance. insufficient_grounding concerns claims that need support, not absent personal experience in an academic text. Do not count one vague sentence twice under two names unless you can identify two distinct mechanisms.',
    'Contrast: a report consistently using formal endings is genre convention, not two causes of uniformity and ending repetition. Distinct paragraphs drawing the same generic lesson without content-specific reasoning can support a recurring formulaic conclusion.',
    'Contrast: replacing one closing aspiration with an equivalent aspiration changes neither claim nor signal strength by itself. Changing a qualified possibility to an unsupported certainty can change the evidence; do not enforce score invariance for meaning changes.',
    'Score from the complete evidence including counterevidence, never the presence of one word. Never assume generated provenance, invent missing causes, or force a lower score. Use the existing score bands; do not sum equally weighted categories.'
  ].join('\n');
  return [
    '[일관된 근거 판정]',
    '근거 위치와 장르에 맞는 반대 근거를 먼저 확인하고, 원인별 강도를 정한 뒤 점수를 고른다. confidence는 표본 충분성이며 반복 점수의 안정성을 뜻하지 않는다.',
    'weak: 고립됐거나 모호하며 정상적인 장르 관습으로 설명 가능한 관찰. moderate: 장르 관습만으로 설명되지 않는 같은 패턴이 독립적인 일반 산문 단위 최소 2곳에서 명확히 반복됨. strong: 반대 근거를 고려해도 그 패턴이 여러 독립 단위에서 뚜렷하게 지배함. 반복 횟수만으로 moderate를 strong으로 올리지 않는다.',
    'scope는 분포이고 strength는 강도다. recurring은 서로 다른 sampleUnitIndex, pervasive는 문서 전반과 문단이 여럿이면 여러 문단의 분포가 필요하다. 번호 항목이 많아졌다는 이유로 강도를 바꾸지 않는다.',
    '원인을 구분한다: sentence_uniformity는 통사·호흡 패턴 반복이지 격식 종결의 일관성이 아니다. ending_repetition은 요구된 종결체를 넘어선 정형 종결 반복이다. formulaic_transition은 상투적인 연결·결론 논리 반복, overstructured_progression은 내용과 무관하게 반복되는 논증 틀이지 제목·정돈된 절 구성이 아니다.',
    'generic_abstraction은 필요한 내용을 대신하는 교환 가능한 일반론이 있어야 한다. insufficient_grounding은 뒷받침이 필요한 주장에 관한 것이며 학술문에 개인 경험이 없다는 뜻이 아니다. 별개의 작동 방식을 확인하지 못하면 하나의 모호한 문장을 두 이름으로 중복 가산하지 않는다.',
    '대조 예시: 보고서가 일관된 격식체를 쓰는 것은 장르 관습이지 균일성과 종결 반복이라는 두 원인이 아니다. 서로 다른 문단이 내용에 맞는 추론 없이 같은 추상적 교훈으로 끝나면 반복 결론의 근거가 될 수 있다.',
    '대조 예시: 마지막 포부를 동등한 뜻의 포부로 바꾼 것만으로 주장이나 신호 강도가 달라지지 않는다. 조건부 가능성을 근거 없는 확신으로 바꾸면 근거가 달라질 수 있으므로 의미 변화까지 같은 점수로 강제하지 않는다.',
    '단어 하나의 유무가 아니라 반대 근거를 포함한 전체 근거로 채점한다. 생성 출처를 추정하거나 원인을 억지로 채우거나 낮은 점수를 목표로 삼지 않는다. 기존 점수 구간을 사용하며 항목별 동일 가중치 합산은 하지 않는다.'
  ].join('\n');
}

module.exports = { buildConsistencyCriteria };
