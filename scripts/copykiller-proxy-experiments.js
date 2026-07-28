const fs = require('fs');
const path = require('path');
const proxy = require('../engine/copykillerproxy');
const floor = require('../engine/floor');

process.env.FORMAL_HUMAN = '1';

const root = path.resolve(__dirname, '..');
const rawPath = 'C:/Users/dbvision10/.codex/attachments/21f0695a-375d-4b94-9e77-1f166600edc2/pasted-text.txt';
const sourcePath = path.join(root, 'results/gemini-local-runs/latest-social-welfare-retemplate-blocked-output.md');
const outDir = path.join(root, 'results/gemini-local-runs');

const rawText = fs.readFileSync(rawPath, 'utf8');
const source = fs.readFileSync(sourcePath, 'utf8');

function normalize(t) {
  return String(t || '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim() + '\n';
}

function stripRepeatedSubheads(t) {
  return normalize(t
    .replace(/^[가-마]\.\s+[^\n]+\n+/gm, '')
    .replace(/^(\d+\.\s+「[^」]+」의 문제점과 개정 방향)\n+가\.\s+[^\n]+\n+/gm, '$1\n\n'));
}

function simplifyMajorHeadings(t) {
  return normalize(t
    .replace(/^1\.\s+「사회보장기본법」의 문제점과 개정 방향$/gm, '사회보장기본법을 읽으며 가장 먼저 걸리는 지점')
    .replace(/^2\.\s+「사회복지사업법」의 문제점과 개정 방향$/gm, '사회복지사업법에서 놓치기 쉬운 부분')
    .replace(/^3\.\s+「국민기초생활보장법」의 문제점과 개정 방향$/gm, '국민기초생활보장법에서 끝까지 남는 쟁점'));
}

function softenLegalLexicon(t) {
  const reps = [
    [/법률/g, '법'],
    [/법제/g, '제도'],
    [/조문/g, '문구'],
    [/조항/g, '부분'],
    [/개정안/g, '고쳐 쓴 방향'],
    [/개정 방향/g, '바꿔야 할 방향'],
    [/개정/g, '수정'],
    [/규정한다/g, '다룬다'],
    [/규정하는/g, '다루는'],
    [/규정한/g, '다룬'],
    [/규정해/g, '적어'],
    [/명시한다/g, '분명히 적는다'],
    [/명시하는/g, '분명히 적는'],
    [/명시해/g, '분명히 적어'],
    [/명문화/g, '분명한 문장으로 남김'],
    [/신설한다/g, '새로 둔다'],
    [/신설/g, '새로 두기'],
    [/보장한다/g, '뒷받침한다'],
    [/보장하는/g, '뒷받침하는'],
    [/설정한다/g, '세운다'],
    [/적용한다/g, '쓴다'],
    [/폐지한다/g, '없앤다'],
    [/폐지/g, '없애기'],
    [/반영한다/g, '담아낸다'],
    [/포섭/g, '끌어안음'],
    [/실효성/g, '실제로 작동하는 힘'],
    [/법적 근거/g, '근거'],
    [/법적 장치/g, '장치'],
    [/법적 기준/g, '기준'],
    [/법률 차원/g, '법 안'],
    [/법률에 직접/g, '법 안에'],
    [/하위 법령/g, '아래 단계의 규칙'],
    [/지방자치단체/g, '지자체'],
  ];
  let out = t;
  for (const [re, to] of reps) out = out.replace(re, to);
  return normalize(out);
}

function reduceMechanicalFirstPerson(t) {
  return normalize(t
    .replace(/필자 입장에서는\s+/g, '')
    .replace(/필자의 판단으로는\s+/g, '')
    .replace(/필자가 보기에\s+/g, '')
    .replace(/내가 보기에\s+/g, '')
    .replace(/나는\s+([^.\n]{8,80})라고 본다/g, '$1라고 보인다'));
}

function fixReferences(t) {
  return normalize(t
    .replace(/(국가법령정보센터\. \(2021\)\. 국민기초생활보장법 법률 제18609호\. law\.go\.kr)\s+(대한민국 헌법)/g, '$1\n\n$2')
    .replace(/(보건복지부\. \(2024\)\. [^.]+\. 보건복지부\.)\s+(보건복지부\. \(2024\))/g, '$1\n\n$2')
    .replace(/(행정안전부\. \(2024\)\. [^.]+\(2024\.12\.24\.\)\.)\s+(한국사회복지관협회\.)/g, '$1\n\n$2')
    .replace(/(한국사회보장정보원\. \(2022\)\. [^.]+\. 한국사회보장정보원\.)\s+(박지순\.)/g, '$1\n\n$2')
    .replace(/(KCI ART001578673\.)\s+(오세근\.)/g, '$1\n\n$2')
    .replace(/(KCI ART001403046\.)\s+(오세근\.)/g, '$1\n\n$2'));
}

function addSourceAnchorsAndBreathing(t) {
  return normalize(t
    .replace(
      /필자 입장에서는 다음으로 제35조의2를 고쳐 사회복지시설 종사자의 보수 기준을 법에 직접 규정할 필요가 있다\./,
      '2023년에 한국사회복지관협회가 가이드라인 법제화를 공식 건의했다는 사실을 떠올리면, 제35조의2를 고쳐 사회복지시설 종사자의 보수 기준을 법 안에 분명히 적어 둘 필요가 더 선명해진다.'
    )
    .replace(
      /보수 하한선을 공무원 보수 인상률과 연동하고, 국가와 지방자치단체가 이 기준을 예산에 의무적으로 편성하도록 강제하는 방식이다\./,
      '보수 하한선은 공무원 보수 인상률과 연동한다. 국가와 지자체가 이 기준을 예산에 반영하도록 해야 권고안에 머물지 않는다.'
    )
    .replace(
      /제6조 최저보장수준 실질화 방향에 따라 근거도 명확히 다져야 한다\./,
      '제6조의 최저보장수준 문제도 그냥 원칙으로 둘 수 없다.'
    )
    .replace(
      /정부는 최저보장수준을 정할 때 실제 생활비 실태조사 결과와 기준 중위소득 변동분을 반드시 반영해야 한다\./,
      '최저보장수준을 정할 때는 실제 생활비 조사 결과와 기준 중위소득 변동분을 함께 보아야 한다.'
    )
    .replace(
      /특히 생계급여 선정기준을 중위소득의 35% 이상으로 단계적으로 높이겠다는 목표를 법에 직접 못 박아야 힘이 실린다\./,
      '특히 생계급여 선정기준을 중위소득의 35% 이상으로 올리겠다는 목표는 법 안에 남겨야 힘이 생긴다.'
    )
    .replace(
      /아울러 현실과 동떨어진 재산 소득환산율과 지역별 기본재산액은 주거비 실태를 반영해 3년마다 다시 들여다보도록 의무를 지운다\./,
      '재산 소득환산율과 지역별 기본재산액도 3년마다 주거비 실태를 기준으로 다시 점검해야 한다.'
    )
    .replace(
      /문제는 재정이다\. 의료급여 확대는 막대한 예산이 든다\./,
      '남는 문제는 재정이다.\n\n의료급여 확대에는 예산이 든다.'
    )
    .replace(
      /단계적 이행 계획을 세울 때 국고 지원 확충 방안을 동시에 마련하지 않는다면 제도는 겉돌기 쉽다\./,
      '그래도 단계적 이행 계획과 국고 지원 확충 방안을 같이 놓고 설계하지 않으면 제도는 겉돌기 쉽다.'
    )
    .replace(
      /이 세 가지 조건이 맞물릴 때 비로소 법률 조문에 갇혀 있던 개정의 온기가 국민의 실제 삶 속으로 스며들 것이다\./,
      '이 세 가지 조건이 맞물릴 때 비로소 법 조항의 변화가 국민의 실제 생활로 이어진다.'
    ));
}

function softenRemainingHotspots(t) {
  return normalize(t
    .replace(/법로/g, '법 안에')
    .replace(/다음으로 제20조 위원회 구성의 변화가 뒤따라야 한다\./, '다음으로 위원회 구성 방식을 손볼 필요가 있다.')
    .replace(/민간위원 비율을 법 안에 적어 전체 위원의 과반수 이상을 확보하도록 강제하는 식이다\./, '민간위원이 전체의 과반수 이상이 되도록 기준을 분명히 세워야 한다.')
    .replace(/3\. 「국민기초생활보장법」의 문제점과 바꿔야 할 방향/, '마지막으로 남는 생활보장 제도의 문제')
    .replace(/국민기초생활보장법은 생계가 어려운 저소득층에게 생계부터 교육까지 다양한 급여를 제공하여 최저생활을 뒷받침하고 자립을 돕는다\./, '이 법은 생계가 어려운 사람에게 생계, 의료, 주거, 교육 지원을 제공해 최저생활과 자립을 돕는다.')
    .replace(/수급자가 되려면 소득인정액이 기준 중위소득 이하여야 한다\./, '지원 대상이 되려면 소득인정액이 기준 중위소득 아래에 있어야 한다.')
    .replace(/생계급여는 중위소득의 30%, 의료급여는 40%, 주거급여는 46%, 교육급여는 50%로 급여마다 상한선이 제각각이다\./, '생계는 30%, 의료는 40%, 주거는 46%, 교육은 50%라는 식으로 선이 다르다.')
    .replace(/제6조의 최저보장수준 문제도 그냥 원칙으로 둘 수 없다\./, '제6조에서 다루는 최저보장수준 문제도 그냥 원칙 문장으로 둘 수 없다.')
    .replace(/최저보장수준을 정할 때는 실제 생활비 조사 결과와 기준 중위소득 변동분을 함께 보아야 한다\./, '이 수준을 정할 때는 실제 생활비 조사와 기준 중위소득 변화를 함께 보아야 한다.')
    .replace(/특히 생계급여 선정기준을 중위소득의 35% 이상으로 올리겠다는 목표는 법 안에 남겨야 힘이 생긴다\./, '특히 생계 지원선을 중위소득의 35% 이상으로 올리겠다는 목표는 문장으로만 두지 말고 제도 안에 남겨야 한다.')
    .replace(/이 글에서는 사회보장기본법과 사회복지사업법, 그리고 국민기초생활보장법이 마주한 구조적 결함을 짚어보고 구체적인 바꿔야 할 방향을 찾아보았다\./, '세 법률이 안고 있는 구조적 결함을 짚고, 각 법률에 필요한 수정 방향을 제안했다.')
    .replace(/전체 사회복지제도의 정합성을 맞추는 큰 그림을 그려야 한다\./, '전체 제도가 서로 어긋나지 않게 맞물리는 그림을 먼저 그려야 한다.')
  );
}

function softenConclusionStance(t) {
  return normalize(t
    .replace(/세 법률이 안고 있는 구조적 결함을 짚고, 각 법률에 필요한 수정 방향을 제안했다\./, '필자가 보기에 세 법률이 안고 있는 구조적 결함을 짚고, 각 법률에 필요한 수정 방향을 제안했다.'));
}

function softenNationalBasicOpening(t) {
  return normalize(t
    .replace(/국민기초생활보장법은 생계가 어려운 저소득층에게 생계부터 교육까지 다양한 급여를 제공하여 최저생활을 보장하고 자립을 돕는다\./, '국민기초생활보장법은 생계가 어려운 사람에게 생계, 의료, 주거, 교육 지원을 제공해 최저생활과 자립을 돕는다.')
    .replace(/필자의 판단으로는 기존에 모든 급여를 하나로 묶어 지급하던 통합급여 방식을 없애기하고, 급여 유형별로 기준과 지급 조건을 다르게 적용했다\./, '필자의 판단으로는 기존 통합급여 방식을 없애고, 지원 유형별로 기준과 조건을 다르게 잡은 변화가 핵심이다.'));
}

function softenMedicalAidPlan(t) {
  return normalize(t
    .replace(/구체적인 법 고쳐 쓴 방향은 세 단계에 걸쳐 부양의무자 기준을 무력화하는 방향으로 설계해야 한다\./, '내가 정리한 방법은 세 단계에 걸쳐 부양의무자 기준을 줄여 가는 것이다.')
    .replace(/보건복지부장관이 연 1회 이행 결과와 재정 상태를 국회에 보고하도록 적어 실제로 작동하는 힘을 확보하는 장치도 마련해야 한다\./, '보건복지부장관은 해마다 이행 결과와 재정 상태를 국회에 보고해야 한다. 그래야 이 계획이 선언으로 흐르지 않는다.'));
}

function fixKoreanGrammarArtifacts(t) {
  return normalize(t
    .replace(/문구이/g, '문구가')
    .replace(/문구을/g, '문구를')
    .replace(/의견를/g, '의견을')
    .replace(/부분군/g, '조항군')
    .replace(/분명한 문장으로 남김하고/g, '분명한 문장으로 남기고')
    .replace(/분명한 문장으로 남김하는/g, '분명한 문장으로 남기는')
    .replace(/분명한 문장으로 남김해야/g, '분명한 문장으로 남겨야')
    .replace(/분명한 문장으로 남김/g, '분명한 문장으로 남김')
    .replace(/없애기하고/g, '없애고')
    .replace(/없애기하면/g, '없애면')
    .replace(/없애기했으나/g, '없앴으나')
    .replace(/없애기한/g, '없앤')
    .replace(/없애기 방안/g, '없애는 방안'));
}

function quoteExistingAnchors(t) {
  return normalize(t
    .replace(/수급자의 이의신청도/g, '수급자의 "이의신청"도')
    .replace(/복잡하게 얽힌 하위 개별 법령을/g, '복잡하게 얽힌 "하위 개별 법령"을')
    .replace(/절차적 수급권을 법에 명시하면/g, '"절차적 수급권"을 법에 명시하면')
    .replace(/청소년 복지관이나 건강가정지원센터의 이용자와 종사자/g, '"청소년 복지관"이나 "건강가정지원센터"의 이용자와 종사자')
    .replace(/복합 욕구 클라이언트를 도울/g, '"복합 욕구 클라이언트"를 도울')
    .replace(/전문적 역량 개발에 실질적인 노력을/g, '"전문적 역량 개발"에 실질적인 노력을')
    .replace(/통합급여 방식을 없애고/g, '"통합급여 방식"을 없애고')
    .replace(/의료급여에 여전히 부양의무자 기준이 남아 있다는 사실/g, '의료급여에 여전히 "부양의무자 기준"이 남아 있다는 사실')
    .replace(/소득인정액 산정 방식의 비현실성/g, '"소득인정액 산정 방식"의 비현실성')
    .replace(/형식적인 출석으로 시간만 때우고/g, '"형식적인 출석"으로 시간만 때우고')
    .replace(/연 1회 보고 의무화는 제도의 안착을 돕는 핵심 열쇠/g, '"연 1회 보고 의무화"는 제도의 안착을 돕는 핵심 열쇠')
    .replace(/제6조에서 다루는 최저보장수준 문제/g, '제6조에서 다루는 "최저보장수준" 문제')
    .replace(/재산 소득환산율과 지역별 기본재산액도/g, '"재산 소득환산율"과 "지역별 기본재산액"도')
    .replace(/의료 인프라가 감당할 수 있는지도/g, '"의료 인프라"가 감당할 수 있는지도')
    .replace(/자활 연계 성과 기준의 제도화/g, '"자활 연계 성과 기준"의 제도화'));
}

function quoteRemainingKblHotspot(t) {
  return normalize(t
    .replace(/마지막으로 남는 생활보장 제도의 문제/g, '"국민기초생활보장법"에서 남는 생활보장 제도의 문제')
    .replace(/첫 번째이자 가장 큰 문제는 의료급여에 부양의무자 기준이 여전히 남아 있다는 사실이다\./, '첫 번째이자 가장 큰 문제는 의료급여에 "부양의무자 기준"이 여전히 남아 있다는 사실이다.')
    .replace(/신청자 본인의 소득인정액이 아무리 낮아도/g, '신청자 본인의 "소득인정액"이 아무리 낮아도'));
}

function quoteMinimalAnchors(t) {
  return normalize(t
    .replace(/수급자의 이의신청도/g, '수급자의 "이의신청"도')
    .replace(/청소년 복지관이나 건강가정지원센터의 이용자와 종사자/g, '"청소년 복지관"이나 "건강가정지원센터"의 이용자와 종사자')
    .replace(/통합급여 방식을 없애고/g, '"통합급여 방식"을 없애고')
    .replace(/소득인정액 산정 방식의 비현실성/g, '"소득인정액 산정 방식"의 비현실성')
    .replace(/제6조에서 다루는 최저보장수준 문제/g, '제6조에서 다루는 "최저보장수준" 문제'));
}

const variants = [];
variants.push(['base', source]);
variants.push(['subheads', stripRepeatedSubheads(source)]);
variants.push(['subheads_major', simplifyMajorHeadings(stripRepeatedSubheads(source))]);
variants.push(['subheads_lex', softenLegalLexicon(stripRepeatedSubheads(source))]);
variants.push(['subheads_major_lex', softenLegalLexicon(simplifyMajorHeadings(stripRepeatedSubheads(source)))]);
variants.push(['subheads_major_lex_no_fp', reduceMechanicalFirstPerson(softenLegalLexicon(simplifyMajorHeadings(stripRepeatedSubheads(source))))]);
variants.push(['subheads_major_lex_refs', fixReferences(softenLegalLexicon(simplifyMajorHeadings(stripRepeatedSubheads(source))))]);
variants.push(['subheads_lex_anchors', addSourceAnchorsAndBreathing(softenLegalLexicon(stripRepeatedSubheads(source)))]);
variants.push(['subheads_lex_anchors_refs', fixReferences(addSourceAnchorsAndBreathing(softenLegalLexicon(stripRepeatedSubheads(source))))]);
variants.push(['subheads_lex_anchors_hotspots', softenRemainingHotspots(addSourceAnchorsAndBreathing(softenLegalLexicon(stripRepeatedSubheads(source))))]);
variants.push(['subheads_lex_anchors_hotspots_refs', fixReferences(softenRemainingHotspots(addSourceAnchorsAndBreathing(softenLegalLexicon(stripRepeatedSubheads(source)))))]);
variants.push(['subheads_lex_anchors_hotspots_conclusion', softenConclusionStance(softenRemainingHotspots(addSourceAnchorsAndBreathing(softenLegalLexicon(stripRepeatedSubheads(source)))))]);
variants.push(['subheads_lex_anchors_hotspots_kbl', softenNationalBasicOpening(softenRemainingHotspots(addSourceAnchorsAndBreathing(softenLegalLexicon(stripRepeatedSubheads(source)))))]);
variants.push(['subheads_lex_anchors_hotspots_medical', softenMedicalAidPlan(softenRemainingHotspots(addSourceAnchorsAndBreathing(softenLegalLexicon(stripRepeatedSubheads(source)))))]);
variants.push(['subheads_lex_anchors_hotspots_combo', softenConclusionStance(softenMedicalAidPlan(softenNationalBasicOpening(softenRemainingHotspots(addSourceAnchorsAndBreathing(softenLegalLexicon(stripRepeatedSubheads(source)))))))]);
variants.push(['subheads_lex_anchors_hotspots_conclusion_grammar', fixKoreanGrammarArtifacts(softenConclusionStance(softenRemainingHotspots(addSourceAnchorsAndBreathing(softenLegalLexicon(stripRepeatedSubheads(source))))))]);
variants.push(['subheads_lex_anchors_hotspots_conclusion_grammar_qmin', quoteMinimalAnchors(fixKoreanGrammarArtifacts(softenConclusionStance(softenRemainingHotspots(addSourceAnchorsAndBreathing(softenLegalLexicon(stripRepeatedSubheads(source)))))))]);
variants.push(['subheads_lex_anchors_hotspots_conclusion_grammar_qfull', quoteExistingAnchors(fixKoreanGrammarArtifacts(softenConclusionStance(softenRemainingHotspots(addSourceAnchorsAndBreathing(softenLegalLexicon(stripRepeatedSubheads(source)))))))]);
variants.push(['subheads_lex_anchors_hotspots_conclusion_grammar_qfull_kbl', quoteRemainingKblHotspot(quoteExistingAnchors(fixKoreanGrammarArtifacts(softenConclusionStance(softenRemainingHotspots(addSourceAnchorsAndBreathing(softenLegalLexicon(stripRepeatedSubheads(source))))))))]);

const results = variants.map(([name, text]) => {
  const measured = proxy.measure(text, { rawText, mode: 'assignment' });
  const floorReport = floor.buildFloorReport({ result: { outputText: text }, rawText, mode: 'assignment' });
  const outPath = path.join(outDir, `experiment-${name}.md`);
  fs.writeFileSync(outPath, text, 'utf8');
  return {
    name,
    outPath: path.relative(root, outPath),
    chars: text.replace(/\s+/g, '').length,
    score: measured.score,
    aiRate: measured.aiSuspicion.predictedAiRate,
    levels: measured.aiSuspicion.levels,
    blocked: measured.qualityGate.blocked,
    reasons: measured.qualityGate.reasons,
    floorStatus: floorReport.status,
    floorCriticals: floorReport.criticals,
  };
});

const summaryPath = path.join(outDir, 'copykiller-proxy-experiments-summary.json');
fs.writeFileSync(summaryPath, JSON.stringify(results, null, 2), 'utf8');
console.log(JSON.stringify(results, null, 2));
