'use strict';

// Evaluation only. Never import from the production detector/prompt builder.
// Every text below is authored synthetically for a paired style experiment.
// Weak/strong labels concern the targeted style signals, NOT authorship truth.
const STYLE_RUBRIC_APPENDIX = `
[평가 전용 후보: 문체 신호의 강도와 분포]
기존 출력 스키마, category, 원문 문장 번호, 보호 범위 및 0~100 정수 점수 단위를 유지한다. 실제 작성 주체는 알 수 없다.
장르 관습, 정확한 문법, 익숙한 소재, 짧은 분량, 상투적 표현 하나만으로 AI 작성을 단정하지 않는다. 구체적 사실이나 일인칭 기억도 사람 작성의 정답이 아니다.
서로 독립된 실제 원인만 signals에 쓴다. 각 원인에 대해 다음을 나누어 평가한다.
강도: weak는 장르 관습이나 우연한 일치와 구별하기 어려운 신호, moderate는 해당 표현·구성이 정보 전개를 대신하는 양상이 명확한 신호,
strong은 같은 의미적 작업이나 절 골격이 두드러지게 되풀이되어 정보·논증의 전진을 대체하는 신호다. 실제 구간에서 그 설명이 타당한지 확인한다.
분포: isolated는 국소적인 사용, recurring은 독립된 구간에서 다시 나타나는 양상, pervasive는 입력된 분석 가능 본문의 전개를 지배하는 양상이다.
표현이 같아도 서로 다른 정보를 줄 수 있고, 표현이 달라도 같은 추상적 평가를 되풀이할 수 있다. 같은 관찰을 여러 category로 중복 계산하지 않는다.
반대 근거: 전개의 변화, 구체적인 인과관계, 의미 있는 예외, 타당한 장르 설명이 해당 신호를 실제로 약화하는지 판단한다.
점수는 신호의 강도·분포·독립성과 실제 반대 근거를 종합한다. category 개수나 문장 개수를 특정 점수대 진입 조건으로 삼지 않는다.
other_observed_style도 구체적으로 위치 확인된 보조 관찰로만 쓰며, 설명할 수 없는 점수를 정당화하는 우회 범주로 쓰지 않는다.
단문에도 강한 국소 신호가 있을 수 있지만 문서 전체에 대한 판단은 불확실할 수 있다. 장문에도 뚜렷한 신호가 없을 수 있다.
짧다는 이유로 점수를 자동 감점하거나 길다는 이유로 가산하지 않는다. 없는 문단이나 문맥을 추측하지 않는다.
confidence는 관찰의 충분성과 해석의 안정성이다. 보호·손상 입력, 부족한 비교 기회, 실제 혼합 신호가 해석을 제한하면 낮춘다.
문장이 많다는 이유만으로 high를 부여하지 않고, 강한 국소 신호와 그 신호의 일반화에 대한 확신을 구분한다.
각 signal의 evidenceSentences에는 제공된 배열에서 실제 원인이 보이는 0부터 시작하는 문장 번호를 최대 8개 쓴다. 위치가 없으면 []로 두고 근거 없는 category는 만들지 않는다.
eligibleForDetection=true인 원문 구간만 사용한다. table_prose도 그 표시가 있을 때만 해당 행·열 안에서 분석한다. 헤더·숫자·코드·인용을 표본으로 만들지 않는다.
근거와 점수가 맞지 않으면 근거와 반대 근거를 다시 검토한다. 특정 평균·점수 상승·정답 작성자를 목표로 삼지 않는다.
이 후보는 검증된 새 보정식이나 점수 하한이 아니다. 원문을 인용·복사하지 않고 기존 스키마의 구조화된 응답만 반환한다.
`;

const SYNTHETIC_PAIRS = [
  {
    id: 'style-short-01', genre: 'short_text', topic: '조별 실험 기록',
    weak: '물을 같은 높이로 맞췄는데 두 번째 비커만 색이 늦게 변했다. 처음에는 온도 탓이라고 적었다가, 타이머를 늦게 누른 걸 기억했다. 다음 실험에서는 버튼을 누르는 사람부터 정해 두려고 한다.',
    strong: '조별 실험은 협력의 중요성을 깨닫는 소중한 기회였다. 서로의 역할을 존중하며 진행한 과정은 책임감의 가치를 보여 주었다. 앞으로도 이러한 배움을 바탕으로 함께 성장하는 자세를 실천하고자 한다.',
    targetSignals: ['distinct observations versus interchangeable abstract lessons', 'conclusion follows a local cause versus repeats broad values'],
    controls: ['Both discuss one group experiment and future action.', 'First-person detail is not proof of human authorship.']
  },
  {
    id: 'style-short-02', genre: 'short_text', topic: '도서관 좌석 예약',
    weak: '예약 시간보다 열 분 늦게 왔더니 좌석이 이미 풀려 있었다. 빈자리는 있었지만 다시 예약해야 해서 좀 번거로웠다. 그래도 점심 내내 가방만 놓인 자리를 줄이려면 취소 기준은 있어야 할 것 같다.',
    strong: '도서관 좌석 예약은 편의와 질서의 조화가 중요한 제도이다. 이용자의 편의를 높이면서도 공정한 이용을 보장해야 한다. 따라서 개인의 책임과 공동체의 배려를 함께 고려하는 균형 잡힌 운영이 필요하다.',
    targetSignals: ['specific concession with a local cost versus generic balance framing', 'independent information versus concept restatement'],
    controls: ['Both support a reservation rule with qualifications.', 'Formal register alone is not the targeted signal.']
  },
  {
    id: 'style-report-01', genre: 'report', topic: '학교 급식 잔반 줄이기',
    weak: '이번 조사는 점심시간에 남은 음식의 양을 비교했다. 밥과 국을 합쳐 무게를 재서 어느 음식이 많이 남았는지는 알 수 없었다. 수요일에는 전체 잔반이 줄었지만, 그날 식사 인원도 적었다. 따라서 총무게만으로 안내문 효과를 판단하기 어렵다. 다음 조사에서는 인원수와 음식 종류를 따로 기록할 예정이다. 작은 접시를 사용하는 방법도 검토했으나 추가 배식 줄이 길어질 가능성이 있어 이번 제안에서는 제외했다. 우선 밥 양을 선택하게 하고, 일주일 뒤 인원당 잔반을 비교하는 방안을 제안한다.',
    strong: '학교 급식의 잔반 문제는 환경과 생활 습관을 함께 고려해야 하는 중요한 과제이다. 첫째, 잔반 감소는 자원 절약의 가치를 실현한다. 필요한 만큼 음식을 받는 습관은 지속 가능한 생활의 출발점이 된다. 둘째, 안내 활동은 학생의 참여를 높이는 데 기여한다. 작은 실천을 함께 이어 가는 과정에서 공동체의 책임감도 자라난다. 셋째, 지속적인 점검은 실천을 정착시키는 기반이 된다. 학교와 학생이 함께 노력할 때 변화는 더욱 의미 있어진다. 결국 잔반을 줄이는 일은 환경을 위한 행동이자 함께 성장하는 교육적 실천이다.',
    targetSignals: ['methods, confounder and excluded alternative versus repeated broad benefit claims', 'section conclusions add information versus interchangeable positive closure'],
    controls: ['Both advocate reducing food waste.', 'Numbered structure and environmental vocabulary alone are genre conventions.']
  },
  {
    id: 'style-report-02', genre: 'report', topic: '대학 셔틀버스 운행',
    weak: '오전 셔틀버스의 대기 시간을 확인하기 위해 월요일과 목요일에 정류장을 관찰했다. 두 날 모두 첫 수업 직전에 줄이 길어졌지만, 비가 온 목요일에는 탑승 인원도 늘었다. 날씨의 영향과 시간표의 영향을 나누려면 추가 관찰이 필요하다. 버스를 한 대 늘리는 안은 배차 간격을 줄일 수 있으나, 현재 자료에는 차량 비용이 없다. 그래서 먼저 출발 시간을 오 분 앞당기는 시험 운행을 제안한다. 이 경우 일찍 도착하는 학생의 대기 시간이 늘 수 있으므로 첫차 이용자에게도 별도로 의견을 물어야 한다.',
    strong: '대학 셔틀버스 운영은 학생의 편의와 학교의 효율성을 함께 높이는 중요한 과제이다. 우선 운행 시간의 개선은 이용 만족도를 높이는 데 기여한다. 학생의 요구를 반영한 운영은 더욱 편리한 이동 환경을 만든다. 또한 지속적인 의견 수렴은 운영의 완성도를 높이는 기반이 된다. 다양한 목소리를 존중하는 과정은 학교 공동체의 신뢰를 강화한다. 나아가 정기적인 점검은 안정적인 운영을 가능하게 한다. 따라서 편의와 효율의 균형을 고려하고 참여와 점검을 이어 갈 때 보다 나은 셔틀버스 운영을 실현할 수 있다.',
    targetSignals: ['bounded proposal with confounders and costs versus repeated benefit-process formula', 'specific downstream tradeoff versus summary restatement'],
    controls: ['Both are recommendations about shuttle operation.', 'Neither sample is an actual measurement record.']
  },
  {
    id: 'style-personal-01', genre: 'personal_essay', topic: '발표에서 실수한 경험',
    weak: '발표 자료를 넘기다가 순서를 하나 건너뛰었다. 화면은 결론인데 나는 아직 첫 실험을 설명하고 있었다. 친구가 손으로 뒤쪽을 가리켜 줘서 돌아갔지만, 그 뒤에는 준비한 말을 자꾸 잊었다. 발표가 끝나고 녹음을 들으니 내가 생각한 만큼 오래 멈추지는 않았다. 오히려 너무 빨리 말해서 결과가 잘 들리지 않았다. 다음 발표에서는 원고를 더 외우는 대신 결과 그림 앞에서 잠깐 멈추는 연습을 했다. 여전히 첫 문장은 떨렸고, 이것까지 나아졌다고 말하기는 어렵다.',
    strong: '발표에서의 실수는 나 자신을 돌아보는 소중한 계기가 되었다. 처음에는 당황했지만 그 과정에서 준비의 중요성과 도전의 가치를 깨달았다. 친구의 도움은 협력의 의미를 일깨워 주었고, 발표를 마친 경험은 자신감을 키우는 밑거름이 되었다. 이후 나는 부족한 부분을 점검하며 더 나은 모습을 위해 노력했다. 작은 실수를 배움의 기회로 바꾸는 자세가 중요하다는 것도 알게 되었다. 앞으로도 이러한 경험을 바탕으로 한계를 두려워하지 않고 꾸준히 성장하는 사람이 되고 싶다.',
    targetSignals: ['self-correction and unresolved limitation versus uniform lesson-growth narrative', 'local causal revision versus abstract positive closure'],
    controls: ['Both describe a mistake, help and later practice.', 'A conventional reflective assignment can legitimately use growth language.']
  },
  {
    id: 'style-personal-02', genre: 'personal_essay', topic: '가족과 함께 요리한 경험',
    weak: '주말에 동생과 볶음밥을 만들었다. 나는 채소를 먼저 볶아야 한다고 했고 동생은 밥부터 넣었다. 이미 팬에 들어간 밥을 다시 꺼낼 수 없어서 그냥 같이 볶았다. 채소가 조금 딱딱했지만 먹지 못할 정도는 아니었다. 설거지는 내가 하기로 했는데 팬에 붙은 밥이 잘 떨어지지 않아 동생을 다시 불렀다. 같이 만들면 시간도 줄 거라고 생각했지만 이번에는 오히려 오래 걸렸다. 그래도 다음에는 채소를 작게 썰어 보자는 이야기는 했다. 요리에 자신감이 생겼다기보다는 무엇부터 정할지 알게 된 것 같다.',
    strong: '가족과 함께한 요리는 일상 속에서 협력의 가치를 발견한 의미 있는 경험이었다. 서로 다른 의견을 조율하는 과정은 소통의 중요성을 알려 주었다. 작은 어려움을 함께 해결하면서 배려의 의미도 깊이 이해할 수 있었다. 요리를 마친 뒤에는 각자의 역할을 다하는 책임감이 소중하다는 사실을 깨달았다. 함께 만든 한 끼는 단순한 음식을 넘어 가족의 유대를 확인하는 시간이 되었다. 앞으로도 이러한 경험을 바탕으로 서로를 존중하고 돕는 자세를 이어 가고 싶다. 일상의 작은 실천이 더 나은 관계와 성장의 출발점이 된다고 생각한다.',
    targetSignals: ['specific disagreement and imperfect outcome versus uniformly abstract positive interpretation', 'distinct narrative consequences versus interchangeable virtues'],
    controls: ['Both are family-cooking reflections of similar length.', 'Neither factual detail nor emotion is an authorship ground truth.']
  }
].map(pair => ({ ...pair, provenance: 'synthetic_by_codex_for_style_evaluation', labelType: 'relative_target_style_signal_not_author_identity',
  lengthRatio: Math.min(pair.weak.length, pair.strong.length) / Math.max(pair.weak.length, pair.strong.length) }));

function buildStyleRubricCandidate(basePrompt) {
  if (typeof basePrompt !== 'string' || !basePrompt.trim()) throw new TypeError('A nonempty base prompt is required');
  // Remove the conflicting Korean band/count/confidence rules; appending a
  // competing rubric would not test a coherent alternative. Fail closed when
  // the production prompt changes instead of silently leaving a hard gate.
  const replacedPrefixes = ['혼합 신호란', '점수 기준:', 'signals에는', 'other_observed_style은',
    '각 signal의 evidenceSentences에는', 'confidence는', '분량은 confidence의', '신호 강도는'];
  const lines = basePrompt.split('\n');
  for (const prefix of replacedPrefixes) {
    if (lines.filter(line => line.startsWith(prefix)).length !== 1) throw new Error('Unsupported Korean base prompt rule: ' + prefix);
  }
  return lines.filter(line => !replacedPrefixes.some(prefix => line.startsWith(prefix))).join('\n') + '\n' + STYLE_RUBRIC_APPENDIX;
}

module.exports = { STYLE_RUBRIC_APPENDIX, SYNTHETIC_PAIRS, buildStyleRubricCandidate };
