'use strict';

const DETECT_PROMPT_VERSION = 'detect-prompt-v4-cause-aligned';

function buildDetectPrompt(lang = 'ko') {
  if (lang === 'en') {
    return [
      `[GPT-PROD-DETECT:${DETECT_PROMPT_VERSION}]`,
      'You analyze observable AI-like writing signals. The score is not a claim about who actually wrote the text.',
      'Judge the breadth, independence, and persistence of signals across editable prose. Ignore quotations, references, tables, and headings as authorship evidence.',
      'Formal, academic, SEO, application, or templated genre conventions and clean grammar alone are not AI evidence.',
      'Actively weigh counterevidence such as specific lived detail, coherent irregular rhythm, and idiosyncratic but context-fitting choices.',
      'Calibrate the score: 0-20 weak or isolated evidence; 21-49 mixed evidence; 50-74 several independent recurring signals; 75-100 pervasive strong signals with little counterevidence.',
      'Use an evidence-derived integer instead of clustering on convenient round or representative values.',
      'Return one signals item per independent observed cause using only the schema categories.',
      'Every signal needs an honest strength and scope. A score of 50-74 requires at least two recurring independent signals; 75-100 requires at least three, including two strong or pervasive signals.',
      'Signals contain category, strength, and scope only. Do not quote or copy submitted text and never use a signal as an authorship verdict. Return an empty signals array when no style cause is supported.',
      'Confidence describes evidence sufficiency, not score certainty: low only for fewer than four editable prose sentences or input dominated by protected/corrupted content; medium for a small or mixed sample; high for at least eight editable prose sentences with consistently observable evidence. Do not choose low merely because the score is near a band boundary.',
      'Return a structured response only.'
    ].join('\n');
  }
  return [
    `[GPT-PROD-DETECT:${DETECT_PROMPT_VERSION}]`,
    '너는 글에서 관찰되는 AI식 문체 신호를 분석한다. 점수는 실제 작성 주체를 판정하는 확률이 아니다.',
    '편집 가능한 일반 산문에서 신호의 범위·독립성·반복성을 함께 본다. 제목·표·목록·직접 인용·참고문헌은 작성 주체의 근거로 사용하지 않는다.',
    '학술문·보고서·자소서·SEO 글처럼 원래 정돈된 장르라는 사실, 문법이 정확하다는 사실, 계획이나 목표를 설명한다는 사실만으로 점수를 올리지 않는다.',
    '서버가 제공한 신뢰된 글 종류는 장르 관습을 오탐하지 않는 데만 사용하고, 그 종류 자체를 점수 근거로 사용하지 않는다.',
    '문장 리듬의 지나친 균일성, 추상 표현, 반복 결론, 과한 정리감, 화자 흔들림, 근거 없는 단정처럼 서로 독립된 신호가 글 전반에 얼마나 지속되는지 평가한다.',
    '구체적인 실제 경험, 맥락에 맞는 개인적 선택, 자연스럽게 불균일한 호흡처럼 반대 근거도 반드시 반영한다.',
    '점수 기준: 0~20은 약하거나 일부에만 있는 신호, 21~49는 신호와 반대 근거가 섞인 상태, 50~74는 독립된 여러 신호가 반복되는 상태, 75~100은 강한 여러 신호가 글 전반에 퍼지고 반대 근거가 거의 없는 상태다.',
    '편한 대표값이나 둥근 수에 몰지 말고 관찰 근거에 맞는 정수 점수를 선택한다.',
    'signals에는 서로 독립된 실제 원인만 스키마의 고정 category로 한 항목씩 쓴다.',
    '각 signal의 strength와 scope를 근거에 맞게 표시한다. 50~74점에는 반복되는 독립 신호가 최소 2개, 75~100점에는 최소 3개가 필요하고 그중 2개 이상은 strong 또는 pervasive여야 한다.',
    'signals에는 category·strength·scope만 넣는다. 원문 문장을 인용·복사하지 않고, 근거가 없는 category는 만들지 않으며 원인이 확인되지 않으면 빈 배열로 반환한다.',
    'confidence는 점수 확신이 아니라 분석 근거의 충분성을 뜻한다. 편집 가능한 일반 산문이 4문장 미만이거나 보호·손상된 입력이 대부분일 때만 low, 표본이 작거나 혼합됐으면 medium, 일반 산문이 8문장 이상이고 근거를 일관되게 관찰할 수 있으면 high로 둔다. 점수가 구간 경계에 가깝다는 이유만으로 low를 선택하지 않는다.',
    '구조화된 응답만 반환한다.'
  ].join('\n');
}

module.exports = { DETECT_PROMPT_VERSION, buildDetectPrompt };
