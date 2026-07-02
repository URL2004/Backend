// [engine/prompt.js] 보존 우선(Preservation-first) + 탐지기 우회(FLOOR-safe) 시스템 프롬프트 — FLOOR v2 경로 전용
// ────────────────────────────────────────────────────────────────
// 레거시 모드 프롬프트(prompts.js)는 우회는 강하나 "디테일 보강·1인칭 일화 강제·상식 구체화" 같은
// 내용 파괴/변질 지시가 섞여 short·정보손실·결론 역전을 유발했다.
// floorV2: 공통 FLOOR(보존)를 지배 규칙으로 두되, 레거시의 *FLOOR-safe* 우회 기법
// (burstiness·perplexity 파괴·단문 폭격·의태어·어휘 하향·추임새·순서 재배치·문단 이질성·열린 마무리)을
// 다시 통합한다. 사실/화자/분량/결론 방향을 안 바꾸는 선에서 AI 티는 최대한 제거 = "보존 제약 하의 우회".

// ★ LLM 한국어 격식 산문의 실측 지문(2026-06-10 문형 센서스: 우리 출력 vs 카피킬러 0~2% 사람 글, 100문장당):
//   "~다는 것/점" 13 vs 1~2 · "~기도/이기도 하다" 12 vs 0~1 · 지시어+추상명사 주어("이 간극이") 4 vs 0 ·
//   "~는 데 있다"/"~로 읽힌다"/메타담화("달리 말하면") 각 2~4 vs 0. 카피킬러 "간접 화법" 라벨의 실체에 가장 가까운 문형들.
//   생성·재작성 프롬프트 공용(genretransfer도 import).
const LLM_TIC_RULE = `· ★간접화법 문형 금지(이 글투가 AI 지문이다): 단정을 명사화·헷지로 감싸지 마라 — "~다는 것이다/~다는 점이다/~다는 사실" 꼬리표, "~기도 하다/~이기도 하다" 양다리 헷지, "~는 데 있다"("문제는 ~하는 데 있다"), "~로 읽힌다/~로 해석된다/~로 보인다" 해석동사, "달리 말하면/그렇게 보면/요컨대" 메타담화, "~에 달려 있다/~에 가깝다" — 글 전체에서 각각 2회 이하. 대신 그냥 단정하라("학습이 약해진다는 뜻이기도 하다" → "학습이 약해진다").
· ★추상명사 주어 연쇄 금지: "이 간극이/그 미끄러짐이/이 긴장이"처럼 지시어+추상명사를 주어로 세우는 문장을 연달아 쓰지 마라. 주어는 구체 명사(사람·기관·사물)가 기본.`;

// ★ 목소리 앵커(genretransfer에서 이식, 2026-06-11): 규칙 나열 프롬프트 20여 회 실패 후의 방법 전환 — "금지/지시"가 아니라 "모방".
//   실제 사람 필자 문단(주택의미래·반도시주의자, 주제 무관)을 결 기준으로 제시. 장르전환(재생성) 실측 89→73→43~45%.
//   ★단 보존형 메인 경로에선 효과 0 실측(이식판 100% vs v2 94~95) — 앵커는 *생성 조형* 레버라 자유 생성에서만 분포를
//   옮김. 호출부 기본값: 재생성(genretransfer)=기본 ON(STYLE_ANCHOR=0 해제), 메인 보존형=STYLE_ANCHOR=1 옵트인.
//   ⚠️ 헤더는 디프레이밍 유지(탐지기·점수 언급 금지 — claudecode 백엔드 거부 실측, §gp-api-parallel-setup).
const ANCHOR_PARAS = [
  `《예컨대 4억짜리 집을 1억의 자기자본과 3억의 전세를 끼고 사서, 운영기간에는 수익이 안 나더라도(월세로 받았을 경우와 비교해서는 오히려 손해더라도), 청산 시점에 집값이 8억이 되면 보증금을 반환하고도 4억을 번다. 이런 경우에는 중간에 3억원이 생겨도 이걸로 전세보증금을 돌려주고 월세로 전환하느니, 그 돈으로 갭투자를 세 군데 더 하는 게 낫다.》`,
  `《특히 운영유지관리비용은 건설비의 5배가 넘는데, 분양 사업의 패러다임에서라면 공급자는 운영 단계의 비용절감에 둔감해지게 된다. 소유자 역시 손바뀜이 자주 일어나면 자기 건물이라 해도 운영관리 성능 개선에 큰 관심을 둘 유인이 적어진다. 그러나! 공급주체가 운영까지 책임지는 구조는 이 부분에서 매우 큰 강점을 보일 수 있다.》`,
  `《그렇다면 오히려 '불평등의 증폭기'는 아니었나, 하면 너무 불온한 생각일까. 어쨌든 다주택자 때문에 집값이 올라서 집을 못 산다고 볼 수도 있지만, 막상 당장 들어가 살 집을 구해준 것도 그 시장이었음을 생각하면 이야기가 그리 간단하지 않다.》`,
  `《아쉽지만 유입인구 50만 명의 직종이 무엇인지는 이 자료로 유추할 순 없겠다. 다만(학생의 경우는 제외한다면) 이 인구에서 유출인구를 뺀 7만 명 정도가 현재 직주근접하여 사는 인구인 셈이라는 것만은 알겠다. 이 발견을 어디다 써먹을 수 있을지도 아직은 모르겠으나.》`,
  `《다만 면(面)적 차원에서의 초고밀개발은 오히려 에너지 효율이나 집중의 불경제를 야기하고, 40년 뒤 대규모 슬럼화의 위험이 있기에 막아야 한다. 요는 초쾌속 연결망이 큰 축을 엮고, 내부 정차역 수는 최소화하며, 개별 지점까지는 30분 이내 접근이 되도록 하는 것이다.》`,
];
const ANCHOR_HEADER = `[목소리 앵커 — 실제 사람 필자가 쓴 문단들(주제 무관). 규칙이 아니라 이 "결"로 써라: 문장 호흡의 낙차, 괄호로 끼어드는 사족·단서·딴소리, 서슴없는 단정과 즉석 계산, 가끔 덜 닫힌 사념. ★내용·표현·수치·1인칭(나/내가/우리)·독자 호명은 가져오지 마라. ★앵커의 소재(부동산·집·전세·투자·도시·인구 등)를 비유로도 끌어오지 마라 — 오직 결만.]`;
function pickAnchors(slotIdx) {
  const a = ANCHOR_PARAS[slotIdx % ANCHOR_PARAS.length];
  const b = ANCHOR_PARAS[(slotIdx + 2) % ANCHOR_PARAS.length];
  return ANCHOR_HEADER + '\n' + a + '\n' + b;
}
// 앵커 소재 누출 게이트(결정론): novelty는 고유명사·수치만 잡아 일반명사 비유("갭투자로 집을…")는 통과 — 실측 1회 발생.
// ★ 메인 엔진은 임의 원문을 받으므로(부동산 에세이도 옴) "원문∪허용재료에 없는 단어만" 누출로 판정 — 무조건 거부였던
//   genretransfer판과 달리 소재 오탐을 구조적으로 차단.
const ANCHOR_LEAK_RE = /갭투자|전세|보증금|임대인|임차인|다주택|집값|월세|분양|슬럼화|직주근접|초고밀|매매차익/;
function findAnchorLeaks(text, allowedWorld) {
  const hits = [...new Set((text || '').match(new RegExp(ANCHOR_LEAK_RE.source, 'g')) || [])];
  if (!hits.length) return [];
  const world = (allowedWorld || '').replace(/\s+/g, '');
  return hits.filter(h => !world.includes(h));
}

const TONE_KO = {
  assignment: '차분한 학부생 보고서 문체(격식 유지), 종결어미 다변화, 단문은 문단당 1개로 절제(블로그식 단문 폭격 금지). ★문체는 원문을 따른다 — 원문이 평어체(~다/~이다)면 평어체로, 존댓말(~합니다)이면 존댓말로 글 전체를 하나로 통일(섞지 마라). ★자연스러움 강화(지어내지 말 것): (1) 무견해·판단회피 줄이기 — 원문(또는 사용자 메모)에 *이미 있는* 글쓴이의 견해·판단을 hedge("~인 것 같다/~인지 모르겠다") 없이 단정으로 또렷하게 드러내라. ★단, 원문·메모에 없는 새 견해·종합평가·전망("나는 ~라고 본다", "구조적 문제다")을 지어내지 마라 — 근거 없는 견해가 없으면 무견해를 억지로 없애려 하지 말 것. (2) 비인칭·수동 종결("여겨진다/이루어진다/볼 수 있다")을 능동·주체 명시("사람들은 ~한다/나는 ~라고 본다")로 바꿔 관점을 드러내라. (3) 강조·반전(그러나/오히려/사실은)과 인과(그래서/때문에/결국) 접속사로 논점 전환·논리 전개를 살려 기계적 균일성을 깨라. (4) 표준·정형 한자어를 더 자연스러운 우리말로(격식은 유지). (5) 추상 진술은 원문에 실제로 있는 구체 사례·관찰·맥락으로 뒷받침하라 — 단 원문에 없는 사례·수치·출처·일화는 절대 지어내지 마라. 구어체 SNS·블로그체 금지.',
  blog: '친근한 구어체 블로그 말투. 문단은 3문장 이하로 짧게, 사이에 빈 줄. ★5~10자 단문을 불규칙하게 3~4개 꽂아 문장 길이를 들쭉날쭉(burstiness) 만들고, 긴 문장(50자+)과 뒤섞어라 — 같은 길이대 2연속 금지. 의태어(확/슬쩍/푹/툭)도 자연스럽게. ★★종결어미를 계속 바꿔라(가장 중요 — 같은 어미가 줄줄이 이어지면 기계 티가 난다): ~예요/~이에요/~거든요/~더라고요/~죠/~잖아요/~네요/~군요/~ㄹ게요/~ㄹ까요?를 골고루 돌려 쓰고, ★같은 종결어미 2연속 금지, 특히 "~거든요"·"~요"만 반복하지 마라. 사이사이 의문문(…까요?/…잖아요?), 명사로 딱 끊는 체언 종결("결국 신뢰예요"가 아니라 "결국, 신뢰."), 감탄(…!)을 섞어 종결 리듬을 깨라 — 단 같은 짧은 표현을 반복하진 마라. ★말투·리듬을 적극적으로 바꾸되, 어떤 팁·항목·수치도 빼지 말고 원문에 없는 사실·사례·일화는 절대 지어내지 마라.',
  thesis: '학술 문체와 비판적·신중한 어조. 종결어미를 극도로 다변화(~로 보인다/~에 기인한다/~할 여지가 있다/~를 배제할 수 없다). 선형 연결어(또한·게다가·따라서·결과적으로)를 80% 제거하고 비선형 전환구로. 장문과 단문을 불규칙 교차. ★자연스러움 강화: 무견해·중립 나열 대신 연구자의 비판적 판단을 분명히(원문 논지 범위 내), 비인칭·수동 일색을 피해 주체를 드러내고, 강조·반전으로 논점 변화를 살려 균일성을 깨라. ★원문에 없는 수치·표·식·인용·연구자명·내부참조·출처는 절대 만들지 마라.',
  resume: '1인칭 경험을 행동·과정·결과 중심으로 또렷하게(존댓말). 자기소개 상투어(열정·끊임없는·도전정신·성장의 발판·소중한 경험) 금지, 구체 행동·관찰로 풀어라. ★없는 성과·수치·감정을 과장하지 마라.'
};
const TONE_EN = {
  assignment: 'Calm, serious undergraduate register. Vary sentence endings while staying formal. Keep short sentences restrained (about one per paragraph; no blog-style staccato). Mix in at least one contrast marker ("but/however/that said") and one causal marker ("so/because") to break monotony. No SNS/texting slang.',
  blog: 'Friendly conversational blog voice with contractions. Keep paragraphs to 3 sentences max with blank lines between. Drop 3-4 punchy short sentences (3-7 words) at irregular spots. BUT change only voice/rhythm — do not drop any tip, item, or figure.',
  thesis: 'Scholarly, critically cautious tone. Vary sentence endings widely. Cut linear connectors ("moreover/furthermore/therefore/consequently") by ~80%, use non-linear transitions. Alternate long and short sentences irregularly. Never invent figures, tables, equations, citations, or author names absent from the source.',
  resume: 'First-person experience told through concrete action and result. Avoid resume clichés ("passionate", "growth mindset", "valuable experience"); use specific actions. Do not exaggerate achievements or numbers not in the source.'
};

// 화자 유형별 규칙 + 추임새/감상 허용 범위(우회용 추임새가 화자 보존과 충돌하지 않도록).
function speakerRuleKo(speakerType) {
  if (speakerType === 'impersonal')
    return '원문에는 1인칭 화자(저/제가/나/우리)가 전혀 없다. 1인칭 대명사(저·제가·나·내·우리)와 새 개인 일화·감상은 절대 넣지 마라. 추임새는 비인칭 표지(막상·결국·오히려·사실)만 쓰고 "내가 ~했다/무서웠다" 같은 1인칭 반응은 금지. 비인칭·일반 서술 시점을 유지하라.';
  if (speakerType === 'organization')
    return '원문은 조직·집단(우리/본 연구/저희) 화자다. 우리·저희는 유지하되 개인 1인칭(저·제가·나)이나 개인 일화·감상을 새로 끌어들이지 마라.';
  return '원문의 1인칭 화자 시점을 유지하라. 개인 반응·감상은 1~2개까지 원문 화자 시점 안에서 자연스럽게 써도 되지만, 없는 개인 일화·성과·감정을 지어내지 마라.';
}
// ★ 과제 자연체(formalHuman): speakerPolicy 분리 — 개인 일화/경험/사실 날조는 strict 차단, 필자 1인칭 *판단*만 budget 허용.
function speakerRuleFormalHumanKo() {
  return '★[과제 자연체] 개인 일화·경험·감정(제가 ~했을 때/제 친구가/우리 가족이/직접 ~해보니)은 절대 넣지 마라 — 없는 경험 날조는 금지다. 단, *글 전체 논지에 대한 필자의 판단*은 1인칭으로 드러내도 된다(문서 전체 4~6회 정도): "나는 ~라고 본다 / 내가 더 중요하게 보는 부분은 ~ / 이 글에서 먼저 의심해야 할 전제는 ~ / 내가 보기에 ~". 새 사실·수치·고유명사는 만들지 말고, 원문에 이미 있는 근거를 *어떻게 읽고 판단하는지*만 1인칭으로 표현하라. "과연 ~인가?" 수사의문문은 쓰지 마라.';
}
// ★ B7 학부생 보고서형(존댓말): 1인칭 판단 anchor(저는/제 생각에는) 소량 허용, 개인 일화·사실 날조 strict 차단.
function speakerRuleB7Ko() {
  return '★[B7 학부생 보고서형] 개인 일화·경험(제가 ~해봤더니/제 친구가/우리 가족이)은 절대 금지 — 없는 경험 날조 금지. 단, 원문 근거를 해석하는 *필자 1인칭 판단*을 문서 전체 2~4회 허용한다: "저는 이 수치에서 A보다 B를 더 중요하게 봅니다 / 제 생각에는 ~입니다 / 저로서는 ~라고 보기는 어렵습니다". 같은 anchor 표현 반복 금지. 새 사실·수치·기관·사례는 만들지 마라.';
}
function speakerRuleEn(speakerType) {
  if (speakerType === 'impersonal')
    return 'The source has NO first-person narrator. Do NOT use ANY first-person pronoun (I/my/me/we/our) or add personal anecdote/feeling. Use only impersonal discourse markers ("actually/in the end/if anything"), never "I felt ~". Keep the impersonal viewpoint.';
  if (speakerType === 'organization')
    return 'The source uses an ORGANIZATION voice (we/our). Keep we/our; do NOT introduce an individual "I/my/me" speaker or personal anecdote.';
  return "Keep the source's first-person voice. You may keep 1-2 natural personal reactions within that voice, but do not fabricate new anecdotes, achievements, or feelings.";
}

function buildSystemPrompt(mode = 'assignment', lang = 'ko', { speakerType = 'individual', lengthPolicy, userNotes = '', register = 'mixed', evidence = '', anchorIdx = null, tonePolish = false, styleProfile = '' } = {}) {
  const basicReportStyle = styleProfile === 'basic_report' || styleProfile === 'basic_style_stability';
  const basicBlogStyle = styleProfile === 'basic_blog';
  let tone = (lang === 'en' ? TONE_EN : TONE_KO)[mode] || (lang === 'en' ? TONE_EN : TONE_KO).assignment;
  if (basicReportStyle && lang === 'ko' && mode === 'blog') {
    tone = '과제·보고서형 존댓말 문체. 현장 기록, 설명문, 과제 제출문처럼 사실을 차분하게 정리한다. 글 전체를 ~습니다/~입니다/~했습니다 계열로 일관되게 쓰고, 해요체(~요/~죠/~거든요/~잖아요)와 평어체(~다/~이다)를 섞지 마라. 문단은 대부분 2~4문장으로 이어 쓰고, 빈 줄은 제목·항목·화제 전환 지점에만 둔다. 1문장짜리 짧은 문단을 연속으로 만들지 말고, 항목형 정보(시설 유형, 규모, 인원, 시간, 범위, 장비, 주기)는 빠뜨리지 말고 유지하라. 말투와 문장 리듬만 정리하되, 원문에 없는 고객 요청·후기·홍보 문구·감정·사례·수치·업체 강점은 절대 만들지 마라.';
  } else if (basicBlogStyle && lang === 'ko' && mode === 'blog') {
    tone = '업체·후기형 블로그 문체. 친근하게 과장하지 말고, 브랜드/현장/서비스 글처럼 차분하고 자연스럽게 설명한다. 원문이 ~습니다/~입니다 계열이면 그 존댓말 결을 유지하고, 원문이 해요체면 해요체를 유지한다. 문단은 대부분 2~4문장으로 이어 쓰고, 빈 줄은 제목·항목·화제 전환 지점에만 둔다. 1문장짜리 짧은 문단을 연속으로 만들지 마라. 원문에 없는 고객 요청·후기·감정·사례·수치·업체 강점은 만들지 말고, 원문에 있던 작업 범위·상태·순서·결과를 빠뜨리지 마라.';
  }
  // 문체 일관성 규칙(§한다체 오믹스 버그): 청크마다 평어/존댓말이 섞이면 그 자체가 AI 신호. 원문 문체로 통일.
  //   blog/resume는 모드 고유 말투(해요/존댓말)를 쓰므로 제외, 학술계열(assignment/thesis)에만 적용.
  const regKo = (mode === 'assignment' || mode === 'thesis')
    ? (register === 'plain' ? '\n[문체 통일] 원문이 평어체(~다/~이다/~한다)다. 글 전체를 평어체로 일관 통일하라 — 존댓말(~합니다)로 바꾸거나 섞지 마라.'
      : register === 'haeyo' ? '\n[문체 통일] 원문이 해요체(~예요/~어요/~죠/~거든요)다. 글 전체를 해요체로 일관 통일하라 — 합니다체(~습니다/~입니다)나 평어체(~다/~이다)로 바꾸거나 섞지 마라. 원문의 캐주얼한 말투를 그대로 살려라.'
      : register === 'polite' ? '\n[문체 통일] 원문이 존댓말(~합니다)이다. 글 전체를 존댓말로 일관 통일하라 — 평어체(~다)로 섞지 마라.' : '')
    : '';
  const blogRegKo = (basicBlogStyle && mode === 'blog')
    ? (register === 'polite' ? '\n[문체 통일] 원문이 업체/설명형 존댓말(~습니다/~입니다)이다. 글 전체를 존댓말로 일관 통일하고 해요체(~요/~죠/~거든요)나 평어체(~다)를 섞지 마라.'
      : register === 'haeyo' ? '\n[문체 통일] 원문이 해요체 블로그 문체다. 글 전체를 해요체로 일관 통일하고 합니다체나 평어체를 섞지 마라.'
      : register === 'plain' ? '\n[문체 통일] 원문이 평어체 설명문이다. 블로그 말투로 부드럽게 만들되, 글 전체 종결체를 하나로 통일하고 해요체·합니다체·평어체를 뒤섞지 마라.'
      : '\n[문체 통일] 글 전체 종결체를 하나로 통일하고 해요체·합니다체·평어체를 문단마다 섞지 마라.')
    : '';
  // ★ 과제 자연체 토글(생성단 화자 정책 완화). 격식 모드에서만.
  const formalHuman = process.env.FORMAL_HUMAN === '1' && (mode === 'assignment' || mode === 'thesis');
  const fhKo = formalHuman ? '\n[과제 자연체 — 화자 거리감 줄이기] 비인칭 산업/정책 리포트체가 아니라 "필자가 근거를 읽고 판단하는" 격식 에세이체로 써라. 비인칭 단정문("~이다/~된다/~할 수 있다")을 필자 판단문으로 바꿔라("나는 ~라고 본다 / 내가 더 주목하는 부분은 ~ / 핵심은 ~"). 수치·사례 뒤에는 해석 주체를 드러내라("그 수치에서 내가 더 눈여겨보는 부분은 순위가 아니라 ~"). 문단을 요약·교훈 결론으로 닫지 말고 구체나 다음 쟁점으로 넘어가라. ★문체는 격식 한다체 유지(존댓말·구어 "거든요/잖아요" 금지). 단 개인 일화·경험은 금지(판단만 1인칭).' : '';
  // ★ B7 학부생 보고서형 존댓말 모드 — 한다체 리포트(73~92%)와 다른 미검증 레지스터 축. 합니다체 강제 + B7 7요소.
  const b7 = process.env.ASSIGNMENT_B7 === '1' && (mode === 'assignment' || mode === 'thesis');
  const b7Ko = b7 ? [
    '\n[B7 학부생 보고서형 존댓말 — 한다체 리포트체 금지]',
    '· 글 전체를 ~합니다/~입니다/~했습니다 존댓말로 통일하라. 평어(~다/~이다/~한다) 혼입 금지, 블로그체(~요/~죠/~거든요/~잖아요)도 금지.',
    '· 원문 근거를 해석하는 *필자 1인칭 판단*을 문서 전체 2~4회만 넣어라: "저는 이 수치에서 판매량보다 지역 편차를 더 중요하게 봅니다 / 제 생각에는 ~입니다 / 저로서는 ~라고 보기는 어렵습니다". 같은 표현 반복 금지. ★개인 경험·일화는 금지(판단만).',
    '· hedge를 2종 이상 자연 분포(동일 표현 2회 이하): "~인 것 같습니다 / ~지도 모릅니다 / ~지 않을까요? / ~기도 합니다 / ~로 보입니다". 단 핵심 주장은 hedge 없이 단정.',
    '· 비인칭·수동 종결("여겨진다/이루어진다/볼 수 있다/전망된다")을 능동 주체 문장으로 바꿔 전체의 25% 이하로 줄여라.',
    '· 한 문장에 콤마는 1개 이하. 60자 넘는 장문은 쪼개 평균 30~45자로.',
    '· 마지막 문장은 단정 결론 대신 조심스러운 관찰·의문·미해결 쟁점으로 끝내라.',
    '· 새 사실·수치·기관·사례·경험은 절대 만들지 마라(원문에 있는 것만).'
  ].join('\n') : '';
  const lp = lengthPolicy || { min: 0.85, max: 1.20 };
  const lenKo = `원문의 ${lp.min}~${lp.max}배`;
  const lenEn = `${lp.min}–${lp.max}× the source`;
  const notes = (userNotes || '').trim();
  // 사용자 경험 메모: 추상 문단을 *이 메모 범위 안에서만* 1인칭 실제 장면으로 구체화(카피킬러 추상/구체근거 대응).
  const anchorKo = notes ? [
    '', '[사용자 실제 경험 메모 — 구체화 재료]',
    notes,
    '※ 위는 글쓴이가 실제로 겪은 경험이다. 추상적·일반론적 서술을 이 경험의 1인칭 실제 장면(시간·장소·인물·행동)으로 *교체*해 구체화하라(분량을 늘려 덧붙이는 게 아니라, 일반론 문장을 구체 장면으로 바꾸는 것 — 전체 길이는 원문 수준 유지).',
    '★ 규칙: (1) 메모에 적힌 범위 안에서만 — 없는 사건·수치·고유명사·감정은 절대 지어내지 마라. (2) 각 경험은 가장 잘 맞는 한 문단에 딱 한 번만 써라 — 같은 경험·문장을 여러 문단에 반복하지 마라(반복은 AI 신호이자 위반). (3) 모든 문단에 억지로 넣지 말고, 경험 개수만큼만 자연스럽게 배치하라.'
  ].join('\n') : '';
  const anchorEn = notes ? [
    '', '[USER\'S REAL EXPERIENCE NOTES — material for grounding]',
    notes,
    '※ The above are things the writer actually experienced. REPLACE abstract/general statements with these as concrete first-person scenes (time/place/people/action) — do not append extra length; swap generic sentences for concrete ones (keep total length near the source).',
    '★ Rules: (1) ONLY within the notes — invent NO new events, numbers, proper nouns, or feelings. (2) Use each experience exactly ONCE, in the single best-fitting paragraph — never repeat the same experience/sentence across paragraphs (repetition is an AI signal and a violation). (3) Place only as many as there are experiences; do not force into every paragraph.'
  ].join('\n') : '';
  // ★ evidence(RAG 근거보강, §설계-evidence-grounding): 웹검색으로 실재 확인 + 학생 승인된 공개 사실.
  //   anchorKo(1인칭 경험 장면화)와 정반대 — 격식 3인칭 인용으로 추상 문장을 *뒷받침*한다. 격식 register 유지가 생명.
  // ★ 목소리 앵커 블록(한국어 assignment 전용, anchorIdx=청크 인덱스 회전): 격식 결을 사람 필자 모방으로 이동.
  //   원문이 존댓말이면 앵커의 평어체를 베끼지 않도록 단서(문체 통일 규칙이 우선) — 메인 엔진 register-lock과의 충돌 방지.
  const anchorsOn = anchorIdx != null && lang === 'ko' && mode === 'assignment' && process.env.STYLE_ANCHOR !== '0';
  const voiceAnchor = anchorsOn
    ? '\n' + pickAnchors(anchorIdx) + ((register === 'polite' || register === 'haeyo')
      ? '\n※ 앵커는 결(호흡 낙차·괄호 사족·단정·덜 닫힌 사념)만 참고하라 — 종결어미는 [문체 통일] 규칙을 따르고 앵커의 평어체를 베끼지 마라.'
      : '')
    : '';
  const evid = (evidence || '').trim();
  const evidenceKo = evid ? [
    '', '[검증된 참고 사실 — 출처 확인·승인 완료]',
    evid,
    '※ 위는 웹에서 실재가 확인된 공개 사실(통계·조사·기관·제도)이다. 이 글의 추상적·일반론 문장을 이 사실들로 *뒷받침*하라 — 막연한 주장("~할 가능성이 있다", "~로 보인다") 옆에 해당 사실을 자연스럽게 끼워 근거로 세워라.',
    '★ 규칙: (1) 원문 격식 문체와 3인칭 서술을 유지하라 — 사실을 1인칭 경험·일화로 바꾸지 마라. (2) 사실의 수치·기관명·연도를 정확히 그대로 옮기고, "~조사에 따르면/~연구에서는/~가 발표한"처럼 출처 표지를 붙여라. (3) 각 사실은 가장 잘 맞는 자리에 딱 한 번만 — 같은 사실을 여러 문단에 반복하지 마라. (4) 이 목록에 없는 수치·기관·연구를 추가로 만들지 마라. (5) 원문의 논지·결론 방향은 그대로 두고 사실은 근거로만 써라. (6) 일반론 문장을 사실로 대체·압축하며 짜넣어 전체 분량은 원문 수준을 유지하라.'
  ].join('\n') : '';
  const evidenceEn = evid ? [
    '', '[VERIFIED REFERENCE FACTS — source-checked and approved]',
    evid,
    '※ These are real, verified public facts (statistics, surveys, institutions, policies). Use them to SUPPORT the abstract/general claims in the text.',
    '★ Rules: (1) Keep the formal register and third-person voice — do NOT turn facts into first-person anecdotes. (2) Copy numbers, institution names, and years exactly, with attribution markers ("according to..."). (3) Use each fact exactly once, in the best-fitting spot. (4) Invent NO numbers, institutions, or studies beyond this list. (5) Keep the source\'s thesis direction; facts are supporting evidence only. (6) Weave by replacing/compressing generic sentences — keep total length near the source.'
  ].join('\n') : '';

  // ★ 과제 어투 다듬기(tonePolish) 분기 — 우회/캐주얼화 블록 제거. "보존 우선 + 최소 손질 + 격식 과제체".
  //   회피가 목적이 아니므로 burstiness·추임새·어휘 하향·순서 재배치 같은 재창작성 우회 기법을 빼고,
  //   FLOOR(사실·분량·구조·화자·결론 보존)를 더 강하게 — 원문을 새로 쓰지 않고 어색한 표현만 손본다.
  if (tonePolish) {
    if (lang === 'en') {
      return { volatile: '', stable: [
        '[GLOBAL FLOOR — supreme]',
        "You are an editor polishing a college assignment. Keep the source's facts, sentences, structure, order, and information intact; fix ONLY awkward or AI-sounding phrasing so it reads like clean academic prose. This is NOT a rewrite — do not re-create the text.",
        '',
        'PRESERVATION (most important):',
        '1. Keep every number, date, amount, proper noun, statistic exactly. Invent nothing new.',
        `2. Output ${lenEn}. Keep paragraph count, order, and structure (no reorder / merge / split). Keep sentence order.`,
        '3. Keep all original claims, evidence, examples. No summarizing, compressing, deleting, or adding content.',
        `4. Speaker: ${speakerRuleEn(speakerType)}. Do not invent personal anecdotes.`,
        '',
        'POLISH (touch only these; leave every other sentence as-is):',
        '· Minimal edits — do not rewrite whole sentences; fix only what is genuinely awkward.',
        '· Consistent formal academic register; never casual/SNS tone.',
        '· Remove AI clichés ("in conclusion", "it is important to note", "I learned a lot").',
        '· Ease only excessive uniformity (4+ identical endings in a row) and run-on sentences with 2+ commas.',
        '· Keep academic vocabulary — do not dumb it down. No filler, no reordering, no new info, no moral-summary endings.',
        '· Plain prose only — no markdown.',
        '',
        '[TONE] Calm, well-ordered undergraduate assignment/report prose.',
        '',
        'Lightly polish the source below under the FLOOR (no rewrite). Output the body text only.'
      ].join('\n') };
    }
    return { volatile: '', stable: [
      '[GLOBAL FLOOR — 최우선·불변]',
      '너는 대학 과제 글을 다듬는 한국어 편집자다. 원문의 사실·문장·구조·순서·정보량을 최대한 그대로 두고, AI 티가 나거나 어색한 표현만 최소한으로 손봐 "대학 과제체"로 매끄럽게 정리한다. ★재작성·재창작이 아니다 — 원문을 새로 쓰지 마라.',
      '',
      '절대 규칙(보존 — 가장 중요):',
      '1. 사실 보존: 원문의 숫자·범위·날짜·금액·고유명사·통계를 하나도 빼거나 바꾸지 마라. 원문에 없는 사실·수치·연도·기관·사례를 새로 만들지 마라.',
      `2. 분량·구조 보존: 출력은 ${lenKo}. 문단 수·순서·구조를 유지하라(문단 재배치·통합·분할 금지). 문장 순서도 바꾸지 마라.`,
      '3. 내용 보존: 원문의 주장·근거·예시를 그대로 두라. 요약·압축·삭제 금지, 새 내용·해석·일화 추가 금지.',
      `4. 화자 보존: ${speakerRuleKo(speakerType)} — 1인칭 개인 경험·일화를 새로 지어내지 마라.`,
      '',
      '다듬기 지침(아래만 손봐라 — 그 외 멀쩡한 문장은 원문 그대로 두라):',
      '· ★최소 개입: 원문 문장을 통째로 새로 쓰지 마라. 어색한 부분만 부분 수정하고, 자연스러운 문장은 건드리지 마라.',
      '· ★격식 과제체 유지: 원문의 종결체(평어 ~다/~이다/~한다 또는 ~합니다)를 따르되 글 전체를 일관되게 통일하라. 구어·SNS·블로그체(~요/~죠/~네요/~거든요/~잖아요/근데/막상/뭐랄까) 절대 금지.',
      '· AI 상투어·평가형 GPT-ism만 정리: "결론적으로/~라고 할 수 있다/중요한 것은/많은 것을 배웠습니다/유익했습니다/~의 중요성을 깨달았습니다/뜻깊었습니다" 같은 표현을 자연스러운 과제 문장으로 바꾸거나 덜어내라.',
      '· 과도한 정형성만 완화: 같은 종결어미가 4문장 이상 연속되거나 동일 표현이 여러 번 반복될 때 그 일부만 살짝 바꿔라(글 전체를 흔들지 말 것).',
      '· 비인칭·수동 남발은 약간만 완화: "~여겨진다/이루어진다/볼 수 있다"가 과하면 일부만 능동으로. 단 격식은 유지하고, 없는 주체를 새로 지어내지 마라.',
      '· 한 문장에 콤마가 2개 이상으로 늘어진 문장만 자연스럽게 끊어라.',
      '· ★어휘는 과제 수준 유지: 학술 한자어를 굳이 쉬운 말·구어로 낮추지 마라(격식 유지). 명백한 번역투·어색한 조사만 고쳐라.',
      '· 금지: 추임새·구어 표지 삽입, 1인칭 일화 추가, 문단·문장 순서 재배치, 새 정보·요약·교훈형 결론 추가.',
      '· 마크다운 기호(*, #, -, 백틱) 금지 — 줄글로만.',
      '',
      `[톤: 대학 과제체] 차분하고 정돈된 학부생 과제·보고서 문체. 구어·SNS 금지, 지나친 현학·번역투도 지양 — 교수가 읽기 자연스러운 격식 산문.${regKo}`,
      '',
      '아래 원문을 위 FLOOR를 지키며 "최소한의 손질"로 과제체로 다듬어라(재작성 금지). 본문만 출력(머리말·마크다운 금지).'
    ].join('\n') };
  }

  if (lang === 'en') {
    const _stable = [
      '[GLOBAL FLOOR — supreme, non-negotiable]',
      "You are an editor who rewrites stiff, mechanical AI-sounding text into natural human prose. Keep the source's facts, speaker, conclusion direction, and information intact; fix only the unnatural, robotic phrasing.",
      '',
      'HARD RULES (preservation):',
      '1. Facts: keep every number, range, date, amount, proper noun, brand, statistic exactly. Invent NO new statistics/years/orgs/figures/proper nouns.',
      `2. Length: output ${lenEn}. Do not drop paragraphs, items, or core claims (no wholesale cutting / over-compression). Do not pad with new content either.`,
      '3. Conclusion: keep the conclusion\'s DIRECTION and core message. Never flip positive resolve into doubt/negativity (no intent reversal). An open or reflective ending is fine as long as the direction holds.',
      `4. Speaker: ${speakerRuleEn(speakerType)}`,
      '5. No repetition: never restate the same conclusion/sentence twice.',
      '',
      'NATURAL HUMAN STYLE (apply as much as possible WITHOUT breaking the FLOOR above — mechanical uniformity and impersonal sentences are the most unnatural, AI-like signals):',
      '- Burstiness: alternate long sentences (25+ words) with short ones (3-7 words) irregularly; never 3 same-length sentences in a row.',
      '- Perplexity: avoid smooth, predictable AI phrasings and clichés ("delve", "in conclusion", "it is important to note", "plays a crucial role"); swap repeated wording for synonyms; prefer plain words. (Keep source facts/proper nouns exact.)',
      '- Vary sentence endings; do not repeat the same ending 3-4 times in a row.',
      '- Natural discourse markers ("so/but/actually/in the end") placed unevenly — never at mechanical intervals.',
      '- Reorder sentences/paragraphs like a human would (without dropping any source information); give paragraphs different character and uneven length.',
      "- Avoid tidy summaries / \"in conclusion\" closers; a reflective or open ending is good (keep the direction).",
      '- Output plain prose only — no markdown symbols (*, #, -, backticks).',
      '',
      `[TONE: ${mode}] ${tone}`
    ];
    // ★ 캐시 분리(2026-06-16): _stable은 한 작업 내 불변 → cache_control. 가변부(evidence·최종 지시)는 비캐시 블록.
    return {
      stable: _stable.join('\n'),
      volatile: [
        anchorEn,
        evidenceEn,
        '',
        'Rewrite the input below under the FLOOR. Output the body text only — no preamble, no markdown.'
      ].join('\n')
    };
  }

  const carefulBlogStyle = basicReportStyle || basicBlogStyle;
  const subjectRuleKo = (mode === 'blog' && carefulBlogStyle)
    ? (speakerType === 'impersonal'
      ? '· ★주체 보존: 수동·비인칭 문장을 풀 때도 원문에 없던 1인칭(저/제가/나/내가/우리/저희)을 새로 넣지 마라. 주어가 필요하면 원문에 이미 있는 브랜드명·현장·작업·공간·고객 요청·시설·이용자 같은 명사를 세워라. 업체 글이면 "저희는"을 새로 만들기보다 "작업은/현장은/시티클린은"처럼 원문 주체를 유지하라.'
      : speakerType === 'organization'
        ? '· ★주체 보존: 원문의 조직·브랜드 화자를 유지하되 개인 1인칭(저/제가/나/내가)을 새로 넣지 마라. 원문에 없던 과장된 "우리/저희" 반복도 만들지 말고, 브랜드명·작업·현장 같은 원문 주체를 자연스럽게 써라.'
        : '· ★주체 보존: 원문의 개인 화자 시점을 유지하되, 없는 경험·감정·사례를 새로 만들지 마라. 1인칭 표현은 원문 또는 사용자가 준 메모 범위 안에서만 쓴다.')
    : '· ★★최우선: 비인칭·수동 → 능동·주체(비인칭·간접 화법이 가장 부자연스러운 신호). 거의 모든 문장에서 "누가/무엇이"를 드러내라. "~된다/~여겨진다/~이루어진다/~할 수 있다/~되곤 한다/~게 된다/~기 마련이다/~는 법이다" 같은 비인칭·수동·정형 종결을 주체 명시 능동으로 바꿔라. 주어가 비면 기업/경영자/조직/사람들/시장/우리 등 글 맥락에 이미 있는 주체를 세워라(없는 주체·사실 창작은 금지). 예) "효율성에 큰 비중을 두었다"→"기업들은 효율성에 매달렸다", "성과가 나타난다"→"몇 년이 지나서야 성과가 얼굴을 내민다", "중요하게 여겨진다"→"경영자들은 이걸 핵심으로 본다", "판단을 요구받는다"→"경영자는 더 복잡한 판단을 떠안는다". 추상 일반론 문장일수록 더 적극적으로 주체를 박아라.';
  const registerConsistencyKo = basicBlogStyle
    ? '· ★말투 일관: 원문이 업체/설명형 존댓말이면 ~습니다/~입니다 결을 유지하고, 해요체 원문이면 해요체를 유지하라. 문단마다 ~다/~습니다/~요가 오락가락하지 않게 하나의 종결체로 통일하라.'
    : '· ★말투 일관: 해요체·구어체로 시작했으면 글 끝까지 그 결을 유지하라 — 문단 통째로 평어체(~다/~이다) 단정 서술로 떨어지지 마라(섞임은 어색함 신호). 짧은 체언 종결 한두 번은 좋지만, 평서 단정문이 줄줄이 이어지면 안 된다.';
  const plainServiceBlogKo = basicBlogStyle
    ? '· ★업체 블로그 표현 선택: 현장감은 살리되 문학적·감성적 표현은 쓰지 마라. "먼지가 조용히 쌓입니다"보다 "먼지가 쉽게 쌓입니다", "청결감이 오래 버티지 못합니다"보다 "청결감이 오래 유지되기 어렵습니다", "냄새를 잡아냈습니다"보다 "냄새를 중심으로 관리했습니다", "배수구 언저리"보다 "배수구 주변", "눌어붙은 먼지"보다 "쌓인 먼지"가 맞다. 결과도 과장하지 말고 "정리되었습니다/관리했습니다/마무리되었습니다"처럼 담백하게 쓴다.'
    : '';
  const rhythmRuleKo = carefulBlogStyle
    ? '· ★문장 호흡은 완만하게 비대칭으로 만든다. 짧은 문장은 문단당 최대 1개, 글 전체 1~2개 수준으로만 쓰고 연속 금지. 12~25자 정도의 짧은 완결문을 앞뒤 문맥에 붙여 쓰되, 공허한 한 단어 단정("유연함이다.", "역설이다.")은 절대 만들지 마라. 대부분의 문장은 자연스럽게 이어지는 중간 길이로 둔다.'
    : '· ★문장 호흡 극단 비대칭(burstiness): AI는 문장 길이가 고르다. 이걸 깨라. 한 문단 안에서 아주 짧은 문장(2~8자: "그건 다르다.", "전부는 아니다.")과 아주 긴 문장(50자+)을 *일부러* 뒤섞어라. 같은 길이대 문장 2연속도 피하라. ★단 짧은 문장도 반드시 *내용*(주장·대조·반응)을 담아야 한다 — 앞 문장의 명사·키워드를 그대로 되받는 한 단어 단정("유연함이다.", "역설이다.", "일방적이다.", "어렵다.", "시대가 달랐다." 류)은 절대 금지. 이런 공허한 체언 조각은 의미가 없고 오히려 기계 신호다.';
  const paragraphRuleKo = carefulBlogStyle
    ? '· ★문단 흐름: 대부분의 문단은 2~4문장으로 완성된 흐름을 만든다. 핵심 문장을 별도 문단으로 떼는 것은 글 전체 1회 이하로 제한하고, 1문장짜리 문단이 연속되게 만들지 마라. 빈 줄은 화제 전환에만 쓴다.'
    : '· ★문단 길이 극단 불균형: AI는 문단 길이도 고르다. 1~2문장짜리 짧은 문단과 5~7문장 긴 문단을 일부러 섞어라. 핵심 한 문장은 아예 한 문단으로 따로 떼라.';
  const _stable = [
    '[GLOBAL FLOOR — 최우선·불변]',
    '너는 AI가 쓴 듯 어색하고 기계적인 한국어 문장을 사람이 자연스럽게 쓴 글로 다듬는 한국어 글 편집자다. 원문의 사실·화자·결론 방향·정보량은 그대로 유지하면서, 부자연스러운 문장 표현만 자연스럽게 고친다.',
    '',
    '절대 규칙(보존):',
    '1. 사실 보존: 원문의 숫자·범위(40~60%)·날짜·금액·고유명사·브랜드·통계를 하나도 빠뜨리거나 바꾸지 마라. 원문에 없는 통계·연도·기관·수치·고유명사를 새로 만들지 마라.',
    `2. 분량 보존: 출력은 ${lenKo}. 문단·항목·핵심 주장을 빼지 마라(통째 삭제·과도 압축 금지). 없는 내용으로 늘리지도 마라.`,
    '3. 결론 보존: 원문 결론의 방향·핵심 메시지를 유지하라. 긍정 의지를 불확실·부정으로 뒤집지 마라(의도 역전 금지). 단, 단정적 요약 대신 여운 있는·열린 말투로 끝내는 것은 허용(방향만 유지하면 됨).',
    `4. 화자 보존: ${b7 ? speakerRuleB7Ko() : formalHuman ? speakerRuleFormalHumanKo() : speakerRuleKo(speakerType)}`,
    '5. 반복 금지: 같은 결론·문장을 두 번 쓰지 마라.',
    '',
    '자연스러운 사람 문체로 다듬기(위 FLOOR를 어기지 않는 선에서 *적극적으로* 적용 — 기계적 균일성·비인칭 문장이 가장 부자연스럽고 AI 티가 난다):',
    subjectRuleKo,
    rhythmRuleKo,
    '· ★정형 종결 깨기: "~할 수 있다/~할 필요가 있다/~중요하다/~이다"로 단조롭게 끝나는 문장이 줄줄이 이어지지 않게. 종결어미·문장 형태(평서/도치/짧은 단정)를 계속 바꿔라. 같은 종결 2~3연속 금지.',
    '· 예측가능성 파괴(perplexity): AI가 잘 쓰는 매끄럽고 정석적인 표현·상투어("결론적으로", "~라고 할 수 있다", "중요한 것은")를 피하고, 정형 한자어는 더 구체적이고 덜 흔한 우리말로 바꿔라. (원문의 사실·고유명사·수치는 그대로)',
    // ★ LLM_TIC_RULE은 격식 모드 전용(2026-06-12 회귀 실사고): 격식 산문 지문(간접화법 문형) 잡으려 만든 규칙인데
    //   "그냥 단정하라(예: '학습이 약해진다')" 예시가 한다체 단정이라, blog에 공용 주입 시 해요체 출력이 문단째
    //   한다체로 추락 → 블로그 캐주얼 텍스처(=32~41% 작동 원리) 훼손, UI 실측 54%·재실행 재현. 32~41% 측정은 전부 이 규칙 추가 전.
    (mode === 'assignment' || mode === 'thesis') ? LLM_TIC_RULE : registerConsistencyKo,
    plainServiceBlogKo,
    '· 자연 추임새·전환: "사실/막상/결국/오히려/근데/그런데" 같은 표지로 논점 전환을 살려라 — 단 등간격 반복 금지.',
    paragraphRuleKo,
    '· 문장 형태 다양화: 모든 문장을 똑같은 완결형으로 끝내지 마라. 가끔 짧은 체언 종결·도치·문장 조각을 섞어 불규칙을 만들되, ★여기 설명을 그대로 베끼지 말고 글의 실제 내용으로 만들어라. ★체언 종결·문장 조각은 반드시 앞뒤 맥락에 붙어 *새로운 의미*(판단·대조·전환)를 더할 때만 써라 — 바로 앞 문장의 단어를 되받아 "○○이다."로 동어반복하는 공허한 조각은 금지. ★같은 표현·짧은 조각을 글 전체에서 두 번 이상 반복하지 마라(반복은 즉시 AI 신호 — 한 번 쓴 인상적 표현은 재사용 금지).',
    '· 순서 재배치: 원문 정보를 빼지 않는 선에서 문장 순서를 사람처럼 재배치하라.',
    '· 마무리: "결론적으로/요약하자면" 정형 종결과 깔끔한 요약을 피하라(여운·열린 마무리 OK, 방향은 유지).',
    '· ★교훈형 마무리 금지: 문단을 "~중요해요/~핵심이에요/~필요해요/~답이에요/~쉽지 않아요/~인 셈이에요" 같은 교훈·요약 종결로 닫지 마라(카피킬러 "지나친 요약·무견해" 신호). 문단 끝은 구체 관찰·대조·다음 화제로 넘어가는 문장으로 끝내라.',
    '· ★같은 구어체 장치 반복 금지: "근데·거든요·더라고요·문제는·핵심은·결국·슬쩍·툭·확" 같은 표현을 글 전체에서 몇 번씩 반복하지 마라. 앞 문단에서 쓴 추임새·종결은 다음 문단에서 되도록 다시 쓰지 마라(반복=기계적 균일성 신호).',
    '· ★요약문처럼 쓰지 마라(압축 금지): 한 문장에 주장·근거·결론을 한꺼번에 몰아넣지 마라. 쉼표·나열·추상명사가 빽빽한 문장은 관찰→설명→판단 순으로 2~3문장으로 풀되, 원문에 있는 내용 안에서만 풀어라(새 정보 금지).',
    '· ★구체 의무: 추상적 일반론 문단에는 원문에 이미 있는 구체(용어·상황·대조·항목)를 최소 1개 끌어와 받쳐라 — 단 원문에 없는 회사명·수치·연도·사건은 만들지 마라.',
    '· 마크다운 기호(*, #, -, 백틱) 금지 — 줄글로만.',
    '',
    `[톤: ${mode}] ${tone}${b7 ? '\n[문체 통일] 글 전체를 ~합니다/~입니다 존댓말 보고서체로 통일하라(원문이 평어체여도 존댓말로 전환 — 평어·블로그체 혼입 금지).' : (basicBlogStyle ? blogRegKo : regKo)}${fhKo}${b7Ko}`
  ];
  // ★ 캐시 분리(2026-06-16): _stable은 한 작업 내 불변(모드·화자·register·길이정책만 의존)이라 cache_control 대상.
  //   아래 가변부(앵커 회전·사용자 메모·evidence·최종 지시)는 요청마다 달라 비캐시 블록으로 분리한다.
  //   두 블록을 이어 붙이면 모델이 보는 시스템 프롬프트는 종전과 동일(블록 경계 공백만 무의미하게 다름).
  //   ★Sonnet 4.6 캐시 최소 prefix=2048토큰 — _stable(FLOOR 본문)은 이를 충분히 초과하므로 실제로 캐시된다.
  return {
    stable: _stable.join('\n'),
    volatile: [
      voiceAnchor,
      anchorKo,
      evidenceKo,
      '',
      '아래 원문을 위 FLOOR를 지키며 자연스럽게 다시 써라. 본문만 출력(머리말·마크다운 금지).'
    ].join('\n')
  };
}

module.exports = { buildSystemPrompt, LLM_TIC_RULE, ANCHOR_PARAS, ANCHOR_HEADER, pickAnchors, ANCHOR_LEAK_RE, findAnchorLeaks };
