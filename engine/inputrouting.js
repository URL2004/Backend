// [engine/inputrouting.js] 입력 글이 '재구성(재생성)'에 부적합한지 결정론으로 판정(무LLM·무과금).
// ────────────────────────────────────────────────────────────────
// 왜: 부적합한 글(자소서·생기부·탐구문, 짧고 추상적인 글)을 고급(재구성)에 넣으면 LLM이 원문에 없는
//   사실·평가·전망을 지어내(added_claim) 거의 확정적으로 차단된다. 그 사이 ledger·plan·슬롯×시도·weave·
//   judge·수리로 수십 번의 생성 호출이 통째로 낭비된다(실측: 재구성 1건 차단 = 수백 크레딧 상당 API).
//   → /diagnose(무LLM)와 /transform 시작점에서 결정론으로 걸러 보존형(다듬기)으로 유도, API 낭비를 0으로.

// 자소서·생기부·탐구 유형 감지. '저/제' 1인칭이 드물어도(존댓말 자기서술) 강한 신호어가 있으면 자소서류로 본다.
//   기존엔 1인칭 밀도 + '지원/면접/역량' 어휘를 동시에 요구해, "주제를 선정했습니다"식 생기부·탐구문(1인칭
//   대명사·취업 어휘 없음)이 안 걸려 재구성까지 가 added_claim 폭발(실측 junnny1004 2026-06-16).
function looksLikeResume(text) {
  const t = text || '';
  const bare = t.replace(/\s+/g, '').length || 1;
  const fp = (t.match(/저는|저의|저를|저도|제가|제 강점|제 경험|본인은|본인의/g) || []).length;
  const fpPer1k = fp / (bare / 1000);                 // 1000자당 1인칭 자기지칭
  const vocab = (t.match(/지원|합격|자격증|면접|입사|자기소개|지원동기|강점|역량|기여하겠|되겠습니다|성장하|채용|포부/g) || []).length;
  // ① 강한 자소서·생기부 골격어(단독 성립, 인용 유무와 무관): 세특·생기부·자소서·진로·동아리·지원동기 — 시사·논증 글엔 안 나옴.
  if (/세부\s*능력\s*및?\s*특기|세특|생활기록부|생기부|진로\s*(?:활동|희망|탐색)|동아리\s*활동|지원\s*동기|자기소개서/.test(t)) return true;
  // ② 주제 선정/선택: 탐구·생기부에 흔하지만 일반 보고서에도 나온다("이 주제를 선택한 이유는…"). 그래서 단독 성립이되,
  //   ★인용 기반 논증 보고서 예외(2026-06-16 실측 dayoung3360 '북한 정보통제' 보고서: 인용 6개인데 "주제로 선택한 이유"에
  //   걸려 자소서로 오분류→보존형 오라우팅). (이름, 2023)식 학술 인용이 2개+면 재구성이 지어낼 게 없는 사실기반 논증 글
  //   (=시사·논증=재구성 적합)이므로 이 신호로는 라우팅하지 않는다. (gy6326 탐구문은 이런 인용이 없어 그대로 잡힘.)
  const citations = (t.match(/\([가-힣A-Za-z·]+\s*,?\s*(?:19|20)\d{2}\)/g) || []).length;
  if (citations < 2 && /주제\s*(?:를|로)?\s*(?:선정|선택)|(?:선정|선택)하(?:게|였|았|고자|기로|는\s*과정)|(?:이|해당)\s*주제를?\s*(?:선정|선택)/.test(t)) return true;
  // ★탐구·세특 보고서 골격어(2026-06-16): 단일 출현은 정상 글에도 있을 수 있어 2개 이상 동시 출현 시에만 성립(오탐 방지).
  //   "주제를 선정/선택" 명시구가 없는 탐구문(예: gy6326)도 이 조합으로 잡아 보존형으로 유도한다.
  const inquiry = (t.match(/탐구\s*(?:주제|활동|보고서|내용|과정|동기|결과)|탐구(?:를|해)?\s*(?:통해|보고\s*싶|해\s*보고\s*싶)|후속\s*활동|이번\s*탐구|느낀\s*점|더\s*깊이\s*탐구|탐구해\s*보고\s*싶/g) || []).length;
  if (inquiry >= 2) return true;
  // ★자소서·지원서 신호어(2026-06-16): 합니다체 자소서는 명시적 1인칭("저는")이 드물어 fpPer1k 기준을 빠져나간다
  //   (실측 LG CNS 자소서 fpPer1k 2.2 → 미탐지 → 재구성이 자소서를 '지원자 비평 칼럼'으로 바꿔 배출). "지원했/입사 후/
  //   성장하겠/인재가 되고 싶" 같은 지원·포부 표현이 2개 이상이면 자소서로 본다(정상 시사·논증 글엔 이 조합이 거의 없음).
  const apply = (t.match(/지원했|지원하게\s*된|지원하(?:고|게)\s*싶|지원\s*동기|지원\s*이유|입사\s*후|입사하(?:면|게|여)|인재가?\s*되|기여하(?:겠|고\s*싶)|성장하(?:겠|고\s*싶)|되고\s*싶습니다|뽑아\s*주|합격하/g) || []).length;
  if (apply >= 2) return true;
  return (fpPer1k >= 3 && vocab >= 2);
}

// 사실 밀도(연도·%·인용·통계 가중합 / 천자). 빼곡하면 재구성 시 사실 누락·연도 오기 위험 → 보존형 권장.
function factDensity(text) {
  const t = text || '';
  const years = (t.match(/(?:19|20)\d{2}/g) || []).length;
  const pcts = (t.match(/\d+(?:\.\d+)?\s*(?:%|％|퍼센트)/g) || []).length;
  const cites = (t.match(/\([^)]*(?:19|20)\d{2}[^)]*\)|[가-힣]{2,}(?:연구원|협회|재단|위원회|학회|대학교|공사|기구|청|부)/g) || []).length;
  const nums = (t.match(/\d[\d,]*(?:\.\d+)?\s*(?:명|개|건|원|달러|배|점|회|개월|조|억|만)/g) || []).length;
  const bare = t.replace(/\s+/g, '').length || 1;
  return (years * 2 + pcts * 2 + cites + nums) / Math.max(1, bare / 1000);
}
const FACT_DENSE_THRESHOLD = Number(process.env.FACT_DENSE_THRESHOLD) || 5;

// 장문 구조화 논문 감지(2026-06-16 실측 zoz040224: 26,934자 논문 재구성→결과 29%·8%로 접힘=length_collapse 차단,
//   연도·수치 대량 누락). 재구성(genreTransferV2)은 글 전체를 한 번에 새로 써내므로 초장문은 모델이 '요약'으로
//   오해해 접힌다. 이런 논문은 보존형(runHumanizeChunked=문단 청크별 재작성+청크별 FLOOR)으로 보내야 collapse가 없다.
//   조건: 매우 긴 글(공백제외 14,000자+) AND 논문 구조 신호(로마숫자 대제목 목차 또는 학술 섹션 표지).
//   ※ 사실밀집(factDense)만으론 막지 않는다(사장님 결정) — 구조 신호가 있는 초장문 논문만 라우팅.
function isLongStructuredThesis(text) {
  const t = text || '';
  const noSp = t.replace(/\s+/g, '').length;
  if (noSp < 14000) return false;
  const hasRoman = /[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]\s*\./.test(t);                       // Ⅰ. 서론 … Ⅵ. 결론
  const hasToc = /(논문의\s*구성|선행\s*연구|이론적\s*배경|참고\s*문헌|연구\s*(?:방법|배경|목적|문제)|초록|Abstract)/.test(t);
  return hasRoman || hasToc;
}

// 학술 논문(학위논문·학회지 인용 기반) 감지(2026-06-16 실측 #9 항공논문 섹션): 인용 예외로 재구성에 들어가면 단일패스
//   재구성이 국토부 논의·저자명·정책 전망을 날조해 added_claim 차단된다(정당한 차단). 학술 논문은 사실·인용 밀도가
//   높아 재구성이 빈자리를 지어내므로, 차단 대신 '청크 기반 격식 회피'로 보낸다(보존+우회=날조 없음). 길이 무관.
//   시사 칼럼(뉴스 인용 "(이름, 2023)")과 구분: 학위논문·학회지·『저널명』 같은 학술 1차출처 표기 2개+.
function isAcademicCited(text) {
  const t = text || '';
  const refs = (t.match(/학위\s*논문|석사\s*학위|박사\s*학위|학회지|학술지|『[^』\n]{2,}』/g) || []).length;
  return refs >= 2;
}

// 독후감·서평·감상문(개인 성찰문) 감지(2026-06-16 실측 yune0604 '수치심' 독후감: 재구성이 없는 장 번호("10장이
//   경고하는 대목")·평가를 날조해 차단). 책 내용에 대한 개인 감상이라 새 외부 사실이 없어 재구성이 빈자리를 지어낸다
//   → 보존형(다듬기)으로 유도. 강한 정형 구조(【줄거리】/【시사점】·독후감/서평)는 단독, 그 외엔 책 언급+1인칭 성찰 다수.
function looksLikeReflection(text) {
  const t = text || '';
  if (/【\s*줄거리\s*】|【\s*시사점\s*】|독후감|서평|감상문/.test(t)) return true;
  const book = (t.match(/이\s*책(은|이|을|에서|의|을\s*통해|을\s*읽)|저자는|글쓴이는|작가는|책을\s*읽/g) || []).length;
  const reflect = (t.match(/나는|내가|느꼈|깨달았|깨닫게|생각이\s*들|마음에\s*남|위안이\s*되|돌아보게/g) || []).length;
  return book >= 1 && reflect >= 3;   // 책 언급 + 1인칭 성찰 3개+ = 독후감/감상문(정상 시사·논증 글엔 이 조합 드묾)
}

// ★ 영어(비한국어) 위주 입력 판정(2026-06-16). 회피(기본 blog·고급 재구성) 엔진은 "한국 시사 칼럼 필자"로
//   하드코딩된 한국어 전용이라, 영어를 넣으면 한국어로 번역·축약해 원문을 망친다(영어 28,891자 → 한국어
//   4,081자, 14% 손상). hangul/letters<0.15 = 영어 위주(프런트 evDetectLang과 동일 기준). 다듬기(polish)는
//   영어를 영어 그대로 다듬으므로 이 판정으로 막지 않는다.
function isEnglishInput(text) {
  const t = text || '';
  const hangul = (t.match(/[가-힣]/g) || []).length;
  const letters = (t.match(/[A-Za-z가-힣]/g) || []).length || 1;
  return letters >= 200 && hangul / letters < 0.15;
}
const ENGLISH_UNFIT_REASON = '영어 글은 「피하기」가 아니라 「그대로 다듬기」로 진행해 주세요. 피하기(기본·고급)는 한국어 전용이라 영어를 넣으면 한국어로 번역·축약돼 원문이 크게 손상돼요. 다듬기는 영어를 영어 그대로 자연스럽게 다듬어요.';

// ★ 격식 문서 감지(2026-06-17, CSV 감사 #21·#83·#90·#72): 보고서·계약서·실험·논문을 기본 피하기(blog)에 넣으면
//   해요체 구어체로 변질된다(가벼운 말투가 그 형식에 안 맞음). 가중 점수 ≥2면 격식문서로 보고 고급 피하기로 안내.
//   강신호(계약 조항·계약서)는 +2로 단독 통과. 캐주얼 블로그 오탐을 줄이려 '서론/본론/결론' 같은 흔한 말은 제외.
function isFormalDocument(text) {
  const t = text || '';
  let score = 0;
  if (/제\s?\d{1,3}\s?조(?:\s*\(|\s|$)/.test(t)) score += 2;                                   // 제N조(계약·법령)
  if (/계약(?:서|자)|합의서|협약서|갑\s*(?:과|은|는)\s*을/.test(t)) score += 2;                    // 계약 강신호
  if (/[ⅠⅡⅢⅣⅤ]\s*[.、)].*[ⅠⅡⅢⅣⅤ]\s*[.、)]|^\s*목\s*차\s*$/ms.test(t)) score += 1;             // 로마숫자 목차(2개+)
  if (/가설|대조군|유의\s*수준|실험\s*방법|시료|측정\s*결과/.test(t)) score += 1;                   // 실험보고서
  if (/참고\s*문헌|초록|Abstract|선행\s*연구|이론적\s*배경/.test(t)) score += 1;                    // 학술
  if (/(?:<|\[|\(|【)?\s*표\s*\d+/.test(t)) score += 1;                                          // 표N
  if (((t.match(/\([가-힣A-Za-z·]+,?\s*(?:19|20)\d{2}\)/g) || []).length) >= 2) score += 1;       // 인용 2개+
  return score >= 2;
}
const FORMAL_GUIDANCE_REASON = '이 글은 보고서·계약서·논문 같은 격식 문서 형식이에요. 가벼운 말투의 「기본 피하기」로 돌리면 구어체로 바뀌어 형식이 깨져요. 원문 구조와 격식을 살리는 「고급 피하기(재구성)」로 진행해 주세요.';

// ★ 각주(¹⁾ ²⁾ …) 인용이 많은 논증·학술 글(2026-06-16 실측 학생선수 최저학력제 논증문): 단일패스
//   genreTransferV2가 원문을 부풀리며 평가·메타주장을 합성(added_claim)해 semanticJudge로 막힌다(차단 후
//   복구해도 genreTransferV2 호출 1회 낭비 + 합성본). 위첨자 각주 표지가 3개 이상이면 처음부터 청크 회피
//   (문단별 충실 재작성)로 직행시켜 낭비 없이 충실한 우회 결과를 낸다. 실측: 청크 경로 100% clean 통과.
function isFootnoteCited(text) {
  const sup = ((text || '').match(/[⁰¹²³⁴⁵⁶⁷⁸⁹]+\s*⁾/g) || []).length;   // ¹⁾ ²⁾ … ¹⁴⁾
  return sup >= 3;
}

// 재구성 부적합 판정 + 사용자에게 그대로 보여줄 '명확한 사유'. ir = surfaceguard.classifyInputRisk(text).
//   factDense(사실 빼곡)는 '권장'(소프트)이라 여기서 막지 않는다 — 사장님 결정으로 사실밀집 글도 고급을
//   돌릴 수 있어야 함(B). 막다른 길로 만드는 두 부류만 사전 차단한다: ① 자소서·생기부·탐구 ② 짧고 추상적.
function restructureUnfit(text, ir = {}) {
  const t = text || '';
  const bare = t.replace(/\s+/g, '').length || 1;
  // 영어 위주 글 → 「그대로 다듬기」로 유도(POST 진입부에서 1차 차단하지만 직접 호출 대비 방어).
  if (isEnglishInput(t)) {
    return { unfit: true, kind: 'english', reason: ENGLISH_UNFIT_REASON };
  }
  if (looksLikeResume(t)) {
    return {
      unfit: true, kind: 'resume',
      reason: '이 글은 자소서·생활기록부·탐구활동처럼 1인칭으로 자기 경험·동기를 적은 글이에요. 고급(재구성)은 시사·논증 칼럼으로 새로 써내는 방식이라, 이런 글을 넣으면 AI가 원문에 없는 지원 동기·평가·일화를 지어내 차단돼요. 「그대로 다듬기」나 「기본 피하기」로 진행해 주세요.'
    };
  }
  if (looksLikeReflection(t)) {
    return {
      unfit: true, kind: 'reflection',
      reason: '이 글은 책에 대한 개인 감상(독후감·서평)이에요. 고급(재구성)은 시사·논증 칼럼으로 새로 써내는 방식이라, 책 내용에 없는 장 번호·평가·해석을 지어내 차단돼요. 「그대로 다듬기」나 「기본 피하기」로 진행해 주세요.'
    };
  }
  // ※ 초장문 구조화 논문(isLongStructuredThesis)은 여기서 unfit으로 막지 않는다 — 보존형(그대로 다듬기)으로 보내면
  //   '피하기(우회)' 기능이 빠지기 때문. 대신 transform.runJob이 단일패스 재구성(collapse) 대신 '청크 기반 격식 회피'
  //   (runHumanizeChunked mode=assignment·tonePolish=false = 우회 유지 + 문단별이라 접힘 없음)로 라우팅한다.
  // 짧고 추상적이라 풀어낼 사실이 거의 없는 글: 재구성이 빈 자리를 지어내 채운다.
  const abstract = (ir.grade === 'C') || (Number(ir.abstractRiskRatio) >= 0.5);
  if (bare < 600 && abstract && factDensity(t) < 1.0) {
    return {
      unfit: true, kind: 'thin',
      reason: '글이 짧고 추상적이라(구체적인 수치·사례·이름이 거의 없어요) 고급(재구성)이 빈 내용을 지어내 채우다 차단되기 쉬워요. 구체적 경험·수치를 더 보태거나 「그대로 다듬기」로 진행해 주세요.'
    };
  }
  return { unfit: false, kind: null, reason: '' };
}

// 입력에 같은 내용이 통째로 반복됐는지 결정론 감지(무LLM·무과금). 실측(2026-06-16): 사용자가 약사 리포트를
//   실수로 두 번 붙여넣어 ~2만 자(blog 412크레딧)로 제출 → 중복 분량만큼 과금되고, 긴 입력이 judge 수리에서
//   잘려 결과까지 절반 소실. 차감 전에 막아 비용·혼선을 없앤다(차단 시 무차감 — 중복 빼고 재시도 유도).
//   판정: 문단(공백 무시 30자+)을 앞 80자 키로 묶어, 2회+ 나온 문단의 분량이 전체 본문의 35%+면 중복 입력.
// ★ 인용 날조 감지(2026-06-17, CSV 100건 감사 #56·#47): genreTransferV2가 근거 빈약한 학술 글을 부풀리며
//   원문에 없던 논문·학회지·저자(연도)·출처·통계 인용을 지어낸다(실측 lenRatio 207%, novelty·semanticJudge가
//   모두 통과시킴 — 게이트 사각지대). 출력에 있고 원문(공백무시)엔 없는 학술인용 표지 종류 수를 센다. ≥2면
//   날조로 보고 청크 회피(충실 재작성)로 재수정(차단 아님). 전체 100건 임계값 ≥2 오탐 0 실측.
function countFabricatedCitations(src, out) {
  const norm = s => (s || '').replace(/\s+/g, '');
  const S = norm(src);
  const re = /『[^』\n]{1,40}』|학회지|학위\s*논문|등재\s*(?:논문|연구)|출처\s*[:：]|[가-힣]{2,4}·[가-힣]{2,4}\s*\(?\s*20\d{2}|[가-힣]{2,4},\s*「|KISTI|KCI|WIPO|USPTO|pp?\.?\s*\d|\d+\s*권\s*\d*\s*호|보고서\s*\(?\s*20\d{2}/g;
  const hits = new Set();
  for (const m of (out || '').matchAll(re)) { const tok = m[0]; if (!S.includes(norm(tok))) hits.add(tok); }
  return hits.size;
}

// ★ 날조 인용 결정론 제거(2026-06-17, #99): 블로그처럼 더 깨끗한 재라우팅 경로가 없는 곳에서, 원문에 없는
//   '괄호형' 인용/출처만 안전하게 떼어낸다(문장 안 깨짐 — 괄호는 통째 제거 가능). 본문에 녹아든 인라인 인용은
//   건드리지 않는다(그건 isFormalDocument 라우팅으로 고급에 보내 재수정). stripSubmitterMeta와 동형.
function stripFabricatedCitations(src, out) {
  const norm = s => (s || '').replace(/\s+/g, '');
  const S = norm(src);
  let t = out || '', removed = 0;
  const drop = m => { if (!S.includes(norm(m))) { removed++; return ''; } return m; };
  t = t.replace(/[(（]\s*출처\s*[:：][^)）\n]*[)）]/g, drop);                                              // (출처: …)
  t = t.replace(/[(（]\s*[가-힣A-Za-z·]+(?:\s*[·,]\s*[가-힣A-Za-z·]+)*\s*,?\s*(?:19|20)\d{2}\s*[)）]/g, drop);  // (저자, 2023)
  if (removed) t = t.replace(/ {2,}/g, ' ').replace(/\s+([.,，。])/g, '$1');
  return { text: t, removed };
}

// ★ 고유명사 과반복 감지(2026-06-17, CSV 감사 #86): genreTransferV2가 매 문단을 원문의 distinctive 명사구에
//   재-앵커링하면서 같은 인용 제목·수상 이력("제17회 롄허보 문학상")을 8회씩 연결어처럼 반복(novelty·repetition
//   게이트 둘 다 0). 출력의 명사구(상·학회지·제N회 등)가 원문 대비 4배+·5회+ 반복되면 그 횟수를 돌려준다(≥5면
//   날조와 같은 청크 회피로 재수정). split 카운트라 정규식 이스케이프 불필요. 전체 100건 이 신호 오탐 0 실측.
function maxNamedRepeat(src, out) {
  const cands = [...new Set(((out || '').match(/[가-힣]{2,10}(?:문학상|대상|학회지|보고서|선언문?|협약|참사|사건|판결)|제\s?\d{1,3}\s?[회권호]/g) || []))];
  let best = 0;
  for (const c of cands) {
    if (c.length < 3) continue;
    const oc = out.split(c).length - 1;
    const sc = (src || '').split(c).length - 1;
    if (oc >= 5 && oc > sc * 2 && oc > best) best = oc;
  }
  return best;
}

// ★ 제출자 메타데이터 제거(2026-06-17, CSV 감사 #97): 입력 머리말의 "제출자: OO학부 20260423 변정빈"을
//   재생성 엔진이 인용 저자처럼 본문에 엮어("변정빈(20260423)이 설계한…") 학생 본인 이름이 가짜 인용이 됐다.
//   돌리기 전에 학부·학번·이름/라벨형 메타데이터를 결정론으로 떼어낸다(본문 내용은 안 건드림). 학번은 6자리+
//   연속 숫자라 4자리 연도와 구분된다.
function stripSubmitterMeta(text) {
  let t = text || '', changed = 0;
  const patterns = [
    /제\s*출\s*자\s*[:：]?\s*[가-힣]{0,20}(?:학부|학과|전공|대학원)?\s*\d{6,10}\s*[가-힣]{2,4}/g,
    /[가-힣]{2,12}(?:학부|학과|전공|대학원)\s+\d{6,10}\s+[가-힣]{2,4}/g,
    /(?:학\s*번|성\s*명|이\s*름|제\s*출\s*일|담당\s*교수|과목\s*명)\s*[:：]\s*[^\n,]{1,20}/g,
  ];
  for (const re of patterns) t = t.replace(re, () => { changed++; return ''; });
  return { text: t, changed };
}

function detectInputDuplication(text) {
  const t = text || '';
  const norm = (s) => (s || '').replace(/\s+/g, '');
  // ① 문단/줄 단위 반복. ★ 분할을 \n{2,}→\n+ 로 넓힌다(2026-06-16 실측: 환경교육 보고서가 빈 줄 없이
  //   단일 개행으로 두 번 이어붙어 \n{2,}로는 1블록 → 미감지였다). 키(앞 80자) 반복은 내용이 실제로
  //   겹칠 때만 발생하므로 줄 단위로 잘게 나눠도 정상 글 오탐은 없다.
  const blocks = t.split(/\n+/).map(norm).filter(b => b.length >= 30);
  if (blocks.length >= 3) {
    const seen = new Set();
    let dup = 0, total = 0;
    for (const b of blocks) {
      total += b.length;
      const key = b.slice(0, 80);   // 문단 앞 80자로 근사 동일성 판정(완전 일치 반복을 안정적으로 포착)
      if (seen.has(key)) dup += b.length; else seen.add(key);
    }
    const ratio = total ? dup / total : 0;
    if (ratio >= 0.35) return { duplicated: true, ratio: Math.round(ratio * 100) / 100 };
  }
  // ② 통짜 반복(경계 무시): 앞 절반의 60자 윈도우 다수가 뒤 절반에 그대로 재등장하면 두 번 붙여넣기다.
  //   문단 경계가 재붙여넣기로 달라져 ①이 놓치는 경우(부분 줄바꿈)까지 포착. 60자 정확 일치는 정상 글에서
  //   거의 안 겹쳐 오탐이 낮다.
  const full = norm(t);
  if (full.length >= 400) {
    const h = Math.floor(full.length / 2);
    const a = full.slice(0, h), b = full.slice(h);
    let match = 0, n = 0;
    for (let i = 0; i + 60 <= a.length; i += 60) { n++; if (b.includes(a.slice(i, i + 60))) match++; }
    if (n >= 3 && match / n >= 0.6) return { duplicated: true, ratio: Math.round((match / n) * 100) / 100 };
  }
  return { duplicated: false, ratio: 0 };
}

module.exports = { looksLikeResume, looksLikeReflection, factDensity, isLongStructuredThesis, isAcademicCited, isFootnoteCited, isEnglishInput, ENGLISH_UNFIT_REASON, restructureUnfit, detectInputDuplication, stripSubmitterMeta, countFabricatedCitations, stripFabricatedCitations, maxNamedRepeat, isFormalDocument, FORMAL_GUIDANCE_REASON, FACT_DENSE_THRESHOLD };
