'use strict';

// 감지 프롬프트 v9c (2026-09-27). 근거: reports/detect-engine-improve-20260927/엔진-개선-실측-20260927.md
//   - v5 계열의 근거 부담을 되살리고, 현세대(GPT-6) 생성문의 특징인 '조직의 균일함'을 overstructured_progression·
//     formulaic_transition·sentence_uniformity 범주에 명시적으로 연결한다. v8의 무해한 보호 규칙(위치 먼저·평균 분포
//     목표 금지·구체 정보만으로 상쇄 금지·혼합 신호 정의)은 유지한다.
//   - 개발군(NIKL 과제 사람 120 · GPT-6 AI 120): 사람 오탐 1/120, AI 검출 75/120, AUROC 0.76 (v8: 2/120, 1/120, 0.17).
//   - v8이 추가했던 strength=weak 규칙, 중복 채점 금지, "구체적 전개=사람다움" 대조 예시, sampleUnitIndex 분산 요건은
//     GPT-6 글에서 신호를 0으로 만들어 검출을 억제했으므로 제외했다. 스키마·category 어휘는 그대로다.
const DETECT_PROMPT_VERSION = 'detect-prompt-v9g-eligible-prose-contract';

function buildDetectPrompt(lang = 'ko') {
  if (lang === 'en') {
    return [
      `[GPT-PROD-DETECT:${DETECT_PROMPT_VERSION}]`,
      'You analyze observable AI-like writing signals. The score is not a claim about who actually wrote the text.',
      'Judge the breadth, independence, and persistence of signals across eligible prose. Ignore quotations, references, table formatting/numeric cells, and headings as authorship evidence. Natural-language table_prose cells marked eligibleForDetection=true are prose: analyze them within their row/column ownership, never join unrelated cells.',
      'The input is a document with sentences, paragraphIndex, sampleUnitIndex, spanType and eligibleForDetection. Score and locate evidence only in eligibleForDetection=true sentences. referenceContext is context only.',
      'Formal genre conventions and clean grammar alone are not evidence. However, current-generation assistant prose is usually specific, fluent and well organized; its signature is uniformity of organization rather than vagueness: every paragraph follows the same claim → reason → concession → summary shape, enumerations are exhaustively balanced (first/also/finally), hedged conclusions resolve every tension, transitions are smooth and impersonal, and register never slips. Count such document-wide regularity as overstructured_progression, formulaic_transition or sentence_uniformity even when the content is concrete.',
      'Human student prose more often shows uneven development: a point pursued at length while another is dropped, personal asides, abrupt or missing transitions, register or tense slips, and conclusions that do not resolve everything. Weigh these as counterevidence where they actually occur.',
      'Observe located signals first, then assign the document score. Do not choose a low score first and search for reasons to justify it. Do not target a high score or a population average either.',
      'A name, number, technical term, first-person pronoun, claimed experience, or typo does not by itself cancel a style signal. Authorship is unknown. Weigh counterevidence only where uneven development actually interrupts the observed pattern.',
      'Mixed evidence means substantive local counterevidence is actually present, not merely that a human could have written the prose. If independent recurring patterns dominate the body, use the corresponding recurring/strong band instead of the mixed band.',
      'Calibrate the score: 0-20 weak or isolated evidence; 21-49 one recurring cause or multiple causes genuinely balanced by observed counterevidence; 50-74 several independent recurring signals; 75-100 pervasive strong signals with little counterevidence. These bands describe the supplied eligible prose, not the missing rest of a hypothetical longer document.',
      'Use an evidence-derived integer instead of clustering on convenient round or representative values.',
      'Return one signals item per independent observed cause using only the schema categories. A score of 21-49 requires at least one eligible category other than other_observed_style with moderate or strong strength and recurring or pervasive scope. A score of 50-74 requires at least two recurring independent signals; 75-100 requires at least three, including two strong or pervasive signals.',
      'other_observed_style is supplementary context only and can never support a score above 20.',
      'Each signal includes evidenceSentences: up to 8 exact zero-based sentence indices from the supplied array, or [] if unlocated. Recurring requires at least two distinct eligible sentence units, not an unspecified large sample. Do not quote submitted text or assert authorship. Return [] signals when unsupported.',
      'Confidence describes evidence sufficiency, not score certainty: low only for fewer than four editable prose sentences or input dominated by protected/corrupted content; medium for a small or mixed sample; high for at least eight editable prose sentences.',
      'Length limits confidence, not the style score itself. In short prose, assess repetition and independence across the available eligible sentences. Two or more sentences may contain recurring independent signals; do not require eight sentences or multiple paragraphs. Conversely, a single sentence, clean grammar or ordinary genre conventions do not establish repetition. Never invent missing context or multiply one pattern into several causes.',
      'Use the same intensity rubric at every length: weak is ambiguous/conventional or incidental; moderate is a clearly located repeated pattern; strong is a conspicuous repeated pattern that materially substitutes for information or argument. Ordinary shared verb endings alone are conventional. Repeated semantic padding is generic_abstraction; repeated clause skeletons are sentence_uniformity. They can coexist in the same sentences only when each is independently demonstrable. No missing-paragraph penalty and no automatic boost for any category.',
      'Distinguish grammatical endings from content-bearing templates. ending_repetition is a shared grammatical ending, not a whole evaluative or concluding clause. A repeated multi-word evaluative template belongs to lexical_template, and repeated clause structure to sentence_uniformity. Reclassify the same observation rather than counting it twice; ordinary discipline-specific terminology and grammatical endings remain conventional.',
      'Return a structured response only.'
    ].join('\n');
  }
  return [
    `[GPT-PROD-DETECT:${DETECT_PROMPT_VERSION}]`,
    '너는 글에서 관찰되는 AI식 문체 신호를 분석한다. 점수는 실제 작성 주체를 판정하는 확률이 아니다.',
    '분석 가능한 산문에서 신호의 범위·독립성·반복성을 함께 본다. 제목·표의 틀과 숫자 셀·목록 표지·직접 인용·참고문헌은 작성 주체의 근거로 사용하지 않는다. 표 안의 자연어 답변도 table_prose이며 eligibleForDetection=true이면 분석한다. 행·열의 소속을 유지하고 서로 다른 셀의 조건이나 답변을 합치지 않는다.',
    '입력 문서는 sentences와 paragraphIndex·sampleUnitIndex·spanType·eligibleForDetection을 제공한다. eligibleForDetection=true인 문장만 점수와 근거에 사용한다. referenceContext는 문맥 참고 자료이며 점수·근거에서 제외한다.',
    '학술문·보고서·자소서처럼 원래 정돈된 장르라는 사실, 문법이 정확하다는 사실만으로 점수를 올리지 않는다. 다만 최근 생성형 어시스턴트의 글은 내용이 구체적이고 유창하면서도 **조직의 균일함**이 특징이다: 모든 문단이 주장→근거→양보→정리의 같은 골격을 밟고, 열거는 빠짐없이 균형 잡혀 있으며(우선·또한·마지막으로), 결론은 모든 긴장을 매끈하게 봉합하고, 연결은 매끄럽고 비인격적이며, 문체 층위가 한 번도 흔들리지 않는다. 내용이 구체적이더라도 이런 문서 전체의 규칙성은 overstructured_progression·formulaic_transition·sentence_uniformity로 센다.',
    '사람 학생의 글은 전개가 고르지 않은 경우가 많다: 한 논점은 길게 파고 다른 논점은 흘려버리고, 개인적 곁가지가 끼어들고, 연결이 끊기거나 빠지고, 문체·시제가 흔들리며, 결론이 모든 것을 정리하지 못한다. 이런 특징이 실제로 나타나는 구간에서 반대 근거로 반영한다.',
    '문장 리듬의 지나친 균일성, 추상 표현, 반복 결론, 과한 정리감, 화자 흔들림, 근거 없는 단정처럼 서로 독립된 신호가 글 전반에 얼마나 지속되는지 평가한다.',
    '먼저 위치가 확인되는 신호를 관찰한 뒤 문서 점수를 정한다. 낮은 점수를 먼저 고르고 거기에 맞는 설명을 찾지 않는다. 높은 점수나 특정 평균 분포를 목표로 삼지도 않는다.',
    '이름·숫자·전문용어·일인칭·경험했다는 주장·오탈자의 존재만으로 문체 신호를 상쇄하지 않는다. 실제 작성자나 경험의 진위는 알 수 없다. 반대 근거는 불균일한 전개가 관찰된 패턴을 실제로 끊는 해당 구간에서만 평가한다.',
    '혼합 신호란 실제로 내용 전개를 뒷받침하는 반대 근거가 해당 구간에 관찰된다는 뜻이지, 사람이 썼을 수도 있다는 가능성을 뜻하지 않는다. 독립된 반복 신호가 본문을 지배하면 혼합 구간이 아니라 그에 맞는 반복·강한 신호 구간에서 평가한다.',
    '점수 기준: 0~20은 약하거나 일부에만 있는 신호, 21~49는 반복 원인 하나 또는 실제 반대 근거와 균형을 이루는 여러 신호, 50~74는 독립된 여러 신호가 반복되는 상태, 75~100은 강한 여러 신호가 글 전반에 퍼지고 반대 근거가 거의 없는 상태다. 기준의 범위는 입력된 분석 가능 본문이며 가상의 장문에서 빠진 나머지 분량이 아니다.',
    '편한 대표값이나 둥근 수에 몰지 말고 관찰 근거에 맞는 정수 점수를 선택한다.',
    'signals에는 서로 독립된 실제 원인만 스키마의 고정 category로 한 항목씩 쓴다. 21~49점에는 other_observed_style이 아닌 적격 category가 최소 1개 필요하고, 그 신호는 moderate 또는 strong이면서 recurring 또는 pervasive여야 한다. 50~74점에는 반복되는 독립 신호가 최소 2개, 75~100점에는 최소 3개가 필요하고 그중 2개 이상은 strong 또는 pervasive여야 한다.',
    'other_observed_style은 보조 관찰 정보일 뿐이며 20점을 넘는 점수의 근거로 사용할 수 없다.',
    '각 signal의 evidenceSentences에는 제공된 배열에서 원인이 보이는 문장 번호(0부터 시작)를 최대 8개 적고 위치가 없으면 []로 둔다. recurring은 서로 다른 분석 가능 문장 단위 최소 2개가 필요하며, 막연히 많은 문장을 요구하지 않는다. 원문은 인용·복사하지 않고 근거 없는 category는 만들지 않는다.',
    'confidence는 점수 확신이 아니라 분석 근거의 충분성을 뜻한다. 편집 가능한 일반 산문이 4문장 미만이거나 보호·손상된 입력이 대부분일 때만 low, 표본이 작거나 혼합됐으면 medium, 일반 산문이 8문장 이상이면 high로 둔다.',
    '분량은 confidence의 제한이지 문체 점수 자체의 감점 사유가 아니다. 단문에서도 실제 분석 가능한 문장 사이의 반복성과 독립성을 평가한다. 두 문장 이상에 독립된 신호가 반복될 수 있으며, 이를 인정하기 위해 8문장이나 여러 문단을 요구하지 않는다. 반대로 한 문장·정확한 문법·일반적인 장르 관습만으로 반복을 인정하지 않는다. 없는 문맥을 추측하거나 같은 패턴을 여러 원인으로 부풀리지 않는다.',
    '신호 강도는 길이와 무관하게 같은 기준으로 정한다. weak는 모호하거나 통상적인 표현·우연한 일치, moderate는 위치가 명확한 반복 패턴, strong은 정보나 논증을 대신할 정도로 두드러지는 반복 패턴이다. 일반적인 종결어미 일치만으로는 통상적인 표현이다. 내용 전진 없이 가치·중요성을 되풀이하는 것은 generic_abstraction, 같은 절 골격 반복은 sentence_uniformity이며 각각 독립적으로 확인될 때만 같은 문장에 둘 다 인정한다. 없는 문단에 대한 감점이나 특정 범주에 대한 자동 가산은 하지 않는다.',
    '문법적인 어미 일치와 내용을 담은 상투적 틀을 구별한다. ending_repetition은 문법적인 종결어미의 반복이지 평가·결론절 전체의 반복이 아니다. 여러 단어로 된 평가 틀이 반복되면 lexical_template, 절의 구성 방식이 반복되면 sentence_uniformity로 분류한다. 동일 관찰을 재분류하는 것이지 두 번 세는 것이 아니다. 통상적인 전공 용어와 문법 어미는 여전히 장르 관습으로 본다.',
    '구조화된 응답만 반환한다.'
  ].join('\n');
}

module.exports = { DETECT_PROMPT_VERSION, buildDetectPrompt };
