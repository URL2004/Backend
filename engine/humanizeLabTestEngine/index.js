// [engine/fundamentalengine.js] Admin-only fundamental humanizing test engine helpers.
// Request-intent routing is intentionally excluded. The test axis is genre + risk + protected terms.

const surfaceguard = require('../surfaceguard');
const { buildPrompt } = require('./prompts');
const {
  auditLabOutput,
  buildLabDataSections,
  labPromptSystemRule
} = require('../../lib/labPromptSecurity');

const VERSION = 'fundamental-engine-v1';

function r3(n) {
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null;
}

function unique(arr, limit = 120) {
  const seen = new Set();
  const out = [];
  for (const raw of arr || []) {
    const v = String(raw || '').trim().replace(/\s+/g, ' ');
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= limit) break;
  }
  return out;
}

function countMatches(text, re) {
  return ((text || '').match(re) || []).length;
}

function countColloquialMarkers(text) {
  const t = String(text || '');
  const endings = countMatches(t, /(거든요|잖아요|더라고요)/g);
  const wordMarkers = countMatches(t, /(^|[\s"'“”‘’([<{])(?:근데|뭐랄까|막|확|툭|슬쩍)(?=$|[\s,.!?~…"'“”‘’)\]}>])/g);
  return endings + wordMarkers;
}

function scoreIncludes(text, terms) {
  let score = 0;
  for (const [re, weight] of terms) score += countMatches(text, re) * weight;
  return score;
}

function detectGenre(text, { mode = 'assignment' } = {}) {
  const t = text || '';
  const scores = {
    academic_assignment: scoreIncludes(t, [
      [/서론|본론|결론|참고문헌|본\s*(글|보고서|과제)|분석하고자|조사\s*결과|근거\s*자료/g, 2],
      [/교육과정|누리과정|교사|유아|놀이\s*중심|관찰일지|학습공동체|직무연수|참고문헌/g, 1],
      [/Ⅰ|Ⅱ|Ⅲ|Ⅳ|^\s*\d+\.\s+/gm, 1],
      [/과제|보고서|학부생|교수|제출/g, 1]
    ]),
    report_technical: scoreIncludes(t, [
      [/시스템|정보기술|클라우드|인프라|API|데이터|자동분류|바코드|터미널|예지보전|AWS|Developers\s+Portal/gi, 2],
      [/AI|IT|B2B|CRM|ERP|SDK|DB|서버|알고리즘/g, 1]
    ]),
    field_blog: scoreIncludes(t, [
      [/현장|작업|청소|시공|관리|마무리|고객|업체|사무실|화장실|바닥|세면대|배수구|먼지|오염|정리/g, 2],
      [/안녕하세요|입니다\.|했습니다\./g, 1]
    ]),
    column_opinion: scoreIncludes(t, [
      [/나는|저는|제가|개인적으로|라고\s*본다|라고\s*생각|아닐까|오히려|문제는|핵심은/g, 2],
      [/사회|문화|현상|관점|의미/g, 1]
    ]),
    thesis_research: scoreIncludes(t, [
      [/연구|가설|선행연구|방법론|표본|변수|분석\s*결과|논문|고찰|초록/g, 2],
      [/\((19|20)\d{2}\)|[A-Za-z]+,\s*(19|20)\d{2}/g, 1]
    ]),
    resume_sop: scoreIncludes(t, [
      [/지원\s*(동기|하게|하고자|했습니다|합니다|분야|직무|회사)|입사|귀사|채용|자기소개|자소서|직무|역량|포부/g, 3],
      [/프로젝트|기여|성과|강점|협업/g, 1],
      [/저는|제가|저의|제\s/g, 1]
    ])
  };
  if (mode === 'blog') scores.field_blog += 2;
  if (mode === 'polish' || mode === 'formal' || mode === 'assignment') scores.academic_assignment += 1;

  let label = 'academic_assignment';
  for (const [k, v] of Object.entries(scores)) {
    if (v > scores[label]) label = k;
  }
  const strongResume = /(지원\s*(동기|하게|하고자|했습니다|합니다|분야|직무|회사)|입사|귀사|채용|자기소개|자소서)/.test(t)
    && /(저는|제가|저의|제\s|프로젝트|성과|강점|역량|포부)/.test(t);
  if (label === 'resume_sop' && !strongResume) {
    label = Object.entries(scores)
      .filter(([k]) => k !== 'resume_sop')
      .sort((a, b) => b[1] - a[1])[0]?.[0] || 'academic_assignment';
  }
  if (/(참고문헌|교육과정|누리과정|교사|유아|학습공동체)/.test(t) && !strongResume) {
    if (scores.thesis_research >= 4 && scores.thesis_research > scores.academic_assignment + 2) label = 'thesis_research';
    else label = 'academic_assignment';
  }
  if (scores.report_technical >= scores.academic_assignment && scores.report_technical >= 4) {
    label = 'report_technical';
  }
  if (mode === 'blog' && scores.field_blog >= 4) label = 'field_blog';
  return {
    label,
    scores,
    confidence: r3(scores[label] / Math.max(1, Object.values(scores).reduce((a, b) => a + b, 0))),
    reason: genreReason(label)
  };
}

function genreReason(label) {
  return {
    academic_assignment: '서론/본론/결론, 분석형 표현, 제출문 구조가 강합니다.',
    report_technical: '시스템·기술·API·인프라 같은 보호 용어가 많습니다.',
    field_blog: '현장·작업·업체 후기 성격의 단어가 많습니다.',
    column_opinion: '필자 판단과 칼럼형 전개 신호가 있습니다.',
    thesis_research: '연구·논문·방법론 중심 신호가 있습니다.',
    resume_sop: '지원서·자기소개서 성격의 경험/역량 신호가 있습니다.'
  }[label] || '기본 과제/보고서형으로 판단했습니다.';
}

function extractProtectedTerms(text) {
  const t = text || '';
  const lines = t.split(/\r?\n/);
  const headings = unique(lines
    .map(l => l.trim())
    .filter(l => /^(#{1,6}\s*)?((Ⅰ|Ⅱ|Ⅲ|Ⅳ|Ⅴ|Ⅵ|Ⅶ|Ⅷ|Ⅸ|Ⅹ)\.?\s*|[IVX]{1,6}\.?\s*|\d+[\.)]\s+|[가-힣]\.\s+)?(서론|본론|결론|참고문헌|목차|연구\s*방법|분석\s*결과|고찰|요약|현장\s*정보|작업\s*과정)/i.test(l)
      || /^(Ⅰ|Ⅱ|Ⅲ|Ⅳ|Ⅴ|Ⅵ|Ⅶ|Ⅷ|Ⅸ|Ⅹ)\.?\s*\S+/.test(l)
      || /^\d+[\.)]\s+[^\n]{2,60}$/.test(l)));

  const middleDot = unique(t.match(/[가-힣A-Za-z0-9]+(?:·[가-힣A-Za-z0-9]+)+/g) || []);
  const numbers = unique(t.match(/(?:19|20)\d{2}\s*년?|\d+(?:\.\d+)?\s*(?:개월|개소|페이지|만원|억원|조원|시간|분|초|명|개|건|원|평|년|차|위|배|회|km|kg|m|㎡|대|쪽|%|％)/g) || []);
  const acronyms = unique([
    ...(t.match(/\b[A-Z][A-Z0-9+.-]{1,}\b/g) || []),
    ...(t.match(/\b[A-Z][A-Za-z0-9+.-]{2,}(?:\s+[A-Z][A-Za-z0-9+.-]{2,}){1,3}\b/g) || [])
  ]);
  const namedEntities = unique([
    ...(t.match(/[가-힣A-Za-z0-9]{2,30}(?:택배|전자|대학교|시청|구청|부문|시스템|터미널|허브|센터|기업|회사|공사|공단|연구원|연구소|협회|교육청|포털)/g) || []),
    ...(t.match(/[A-Z][A-Za-z0-9+.-]*(?:\s+[A-Z][A-Za-z0-9+.-]*){0,3}\s+(?:클라우드|포털|API|Portal|Cloud)/g) || []),
    ...(t.match(/[가-힣]{2,}(?:시|군|구|동|읍|면|리)(?=$|[^가-힣A-Za-z0-9_])/g) || [])
  ].filter(v => v.length <= 60 && !/[.?!]\s/.test(v)));
  const referenceLines = [];
  let inRefs = false;
  for (const line of lines.map(l => l.trim()).filter(Boolean)) {
    if (/^참고문헌$|^References$/i.test(line)) { inRefs = true; referenceLines.push(line); continue; }
    if (inRefs && line.length <= 180 && (/^(교육부|보건복지부|[가-힣A-Za-z·]{2,30})\.?\s*\((19|20)\d{2}\)/.test(line) || /세종:|학회지|Journal|출판/.test(line))) {
      referenceLines.push(line);
    }
  }
  const citationMarkers = unique([
    ...(t.match(/[가-힣A-Za-z·]{2,30}\s*\((?:19|20)\d{2}[^)]{0,60}\)/g) || []),
    ...(t.match(/(?:교육부|보건복지부|허지영|[가-힣]{2,8})\s*\([^)]{1,50}\)/g) || [])
  ].filter(v => v.length <= 100));
  const citations = unique([...referenceLines, ...citationMarkers].slice(0, 50));

  const all = unique([...headings, ...middleDot, ...numbers, ...acronyms, ...namedEntities, ...citations], 180);
  return { headings, middleDot, numbers, acronyms, namedEntities, citations, all };
}

function profileRisk(text, protectedTerms) {
  const surface = surfaceguard.buildSurfaceReport(text || '');
  const inputRisk = surfaceguard.classifyInputRisk(text || '');
  const register = surfaceguard.measureRegisterMix(text || '');
  const sentences = surfaceguard.splitSentences(text || '');
  const paras = (text || '').split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const structureItems = protectedTerms.headings.length + countMatches(text, /^\s*(?:[-*]|\d+[\.)])\s+/gm);
  const factItems = protectedTerms.numbers.length + protectedTerms.acronyms.length + protectedTerms.middleDot.length + protectedTerms.namedEntities.length;
  const risk = {
    abstraction: r3(inputRisk.abstractRiskRatio || surface.paragraphs?.abstractRiskRatio || 0),
    anchorDensity: r3(surface.realAnchorDensity?.ratio || 0),
    genericness: r3(surface.genericness?.ratio || 0),
    stanceDensity: r3(surface.stanceDensity?.ratio || 0),
    structureDensity: r3(structureItems / Math.max(1, paras.length)),
    factDensity: r3(factItems / Math.max(1, sentences.length)),
    registerMix: {
      dominant: register.dominant,
      offRatio: r3(register.offRatio || 0),
      offCount: register.offCount || 0
    },
    uniformity: {
      lengthCV: r3(surface.uniformity?.lengthCV || 0),
      maxEndingRun: surface.uniformity?.maxEndingRun || 0,
      paragraphCountCV: r3(surface.uniformity?.paragraphCountCV || 0)
    },
    proxy: { available: false },
    flags: []
  };
  try {
    const ckp = require('../copykiller-proxy');
    if (ckp.airateAvailable()) {
      const input = ckp.predictAiRate(text || '');
      risk.proxy = { available: true, inputRisk: r3(input) };
    }
  } catch (e) {
    risk.proxy = { available: false, error: e && e.message };
  }
  if (risk.abstraction >= 0.65) risk.flags.push('abstract_source');
  if (risk.anchorDensity <= 0.04) risk.flags.push('low_anchor_density');
  if (risk.genericness >= 0.45) risk.flags.push('generic_surface');
  if (risk.structureDensity >= 0.7) risk.flags.push('structure_dense');
  if (risk.factDensity >= 0.7) risk.flags.push('fact_dense');
  if (risk.registerMix.offRatio >= 0.25) risk.flags.push('register_mix');
  if (risk.uniformity.maxEndingRun >= 4 || risk.uniformity.lengthCV <= 0.18) risk.flags.push('uniform_rhythm');
  if (risk.proxy.available && risk.proxy.inputRisk >= 0.65) risk.flags.push('proxy_high');
  return risk;
}

function decideRoute(risk, { userNotes = '', evidence = '' } = {}) {
  const grounded = !!String(userNotes || evidence || '').trim();
  if (risk.proxy.available && risk.proxy.inputRisk <= 0.25 && risk.abstraction < 0.45 && risk.genericness < 0.35) {
    return { mode: 'minimal_cleanup', status: 'done_safe', reason: '원문 표면 위험이 낮아 재작성보다 최소 정리가 안전합니다.' };
  }
  if (!grounded && risk.abstraction >= 0.75 && risk.anchorDensity <= 0.03) {
    return { mode: 'limited_preserve', status: 'done_limited_effect', reason: '추상 일반론이 많고 구체 근거가 부족해 새 사례 없이 제한적으로만 다듬습니다.' };
  }
  if (risk.flags.includes('fact_dense') || risk.flags.includes('structure_dense')) {
    return { mode: 'protected_rewrite', status: 'done_safe', reason: '보호 용어와 구조가 많아 용어·목차·번호를 잠근 뒤 부분 수정합니다.' };
  }
  return { mode: 'genre_risk_rewrite', status: 'done_safe', reason: '장르와 표면 위험에 맞춰 보존형 부분 수정을 적용합니다.' };
}

function buildPlan(text, opts = {}) {
  const genre = detectGenre(text, opts);
  const protectedTerms = extractProtectedTerms(text);
  const risk = profileRisk(text, protectedTerms);
  const route = decideRoute(risk, opts);
  return {
    version: VERSION,
    intent: { skipped: true, reason: '요청의도 라우터는 관리자 결정으로 제외했습니다.' },
    genre,
    protectedTerms,
    risk,
    route
  };
}

function minimalCleanupText(text) {
  let out = String(text || '').trim();
  try { out = require('../spacing').fixSpacing(out).text; } catch {}
  return out;
}

function detectSpeakerRule(text, lang = 'ko') {
  const t = text || '';
  if (lang === 'en') {
    if (/\b(I|my|me)\b/i.test(t)) return "Keep the source's first-person speaker. Do not invent new personal experiences.";
    if (/\b(we|our|us)\b/i.test(t)) return 'Keep the organization/group voice. Do not introduce an individual first-person speaker.';
    return 'The source has no first-person narrator. Do not add first-person pronouns or personal anecdotes.';
  }
  if (/(저는|제가|나는|내가|나의|제\s)/.test(t)) return '원문의 개인 1인칭 화자 시점을 유지한다. 없는 경험·감정·사례는 만들지 않는다.';
  if (/(저희|우리|당사|본\s*(연구|보고서|글))/.test(t)) return '원문의 조직/문서 화자 거리를 유지한다. 개인 1인칭 경험담으로 바꾸지 않는다.';
  return '원문에는 명확한 개인 1인칭 화자가 없다. 1인칭 대명사와 새 개인 경험담을 추가하지 않는다.';
}

function registerLine(text, mode = 'assignment', lang = 'ko') {
  if (lang === 'en') return '';
  const reg = surfaceguard.measureRegisterMix(text || '').dominant;
  if (mode === 'blog') {
    if (reg === 'hap') return '[문체 통일] 원문이 존댓말(~습니다/~입니다)이면 글 전체를 존댓말로 유지하고 해요체나 평어체를 섞지 않는다.';
    if (reg === 'haeyo') return '[문체 통일] 원문이 해요체면 글 전체를 해요체로 유지하고 합니다체나 평어체를 섞지 않는다.';
    if (reg === 'handa') return '[문체 통일] 원문이 평어체면 평어체를 유지하고 중간에 해요체·합니다체를 섞지 않는다.';
    return '[문체 통일] 글 전체 종결체를 하나로 유지한다.';
  }
  if (reg === 'hap') return '[문체 통일] 원문이 존댓말(~습니다/~입니다)이다. 글 전체를 존댓말로 유지한다.';
  if (reg === 'haeyo') return '[문체 통일] 원문이 해요체다. 글 전체를 해요체로 유지하되 격식 장르라면 구어 표지를 늘리지 않는다.';
  if (reg === 'handa') return '[문체 통일] 원문이 평어체(~다/~이다/~한다)다. 글 전체를 평어체로 유지한다.';
  return '[문체 통일] 글 전체 종결체와 인칭을 하나로 유지한다.';
}

function buildTool(lang = 'ko') {
  const isEn = lang === 'en';
  return {
    name: 'return_humanize_lab_test_result',
    description: isEn
      ? 'Return the admin humanizing lab test output.'
      : '관리자 휴머나이징 테스트 엔진 결과를 반환한다.',
    input_schema: {
      type: 'object',
      properties: {
        outputText: {
          type: 'string',
          description: isEn ? 'Finished body text only.' : '수정된 본문만.'
        },
        plan: {
          type: 'string',
          description: isEn ? 'Brief note on what was edited.' : '무엇을 중심으로 다듬었는지 짧은 설명.'
        },
        riskFlags: {
          type: 'array',
          items: { type: 'string' },
          description: isEn ? 'Residual risks, if any.' : '남은 위험 플래그가 있으면 적는다.'
        }
      },
      required: ['outputText']
    }
  };
}

function buildPromptContext(text, { lang = 'ko', mode = 'assignment', plan }) {
  const len = lang === 'en' ? '0.85-1.15x the source' : '원문의 0.85~1.15배';
  return {
    lang,
    mode,
    genre: plan?.genre?.label || 'academic_assignment',
    route: plan?.route || null,
    riskFlags: plan?.risk?.flags || [],
    protectedTerms: plan?.protectedTerms?.all || [],
    lengthText: len,
    speakerRule: detectSpeakerRule(text, lang),
    registerLine: registerLine(text, mode, lang)
  };
}

function normalizeForFind(s) {
  return String(s || '').replace(/\s+/g, '').trim();
}

function missingTerms(terms, outputText, limit = 30) {
  const out = normalizeForFind(outputText);
  const missing = [];
  for (const term of unique(terms, 120)) {
    if (!term || normalizeForFind(term).length < 2) continue;
    if (!out.includes(normalizeForFind(term))) missing.push(term);
    if (missing.length >= limit) break;
  }
  return missing;
}

function genreGate(plan, rawText, outputText) {
  const genre = plan?.genre?.label || 'academic_assignment';
  const register = surfaceguard.measureRegisterMix(outputText || '');
  const paras = (outputText || '').split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const oneSentenceParas = paras.filter(p => surfaceguard.splitSentences(p).length === 1).length;
  const oneSentenceRatio = paras.length ? oneSentenceParas / paras.length : 0;
  const colloquial = countColloquialMarkers(outputText);
  const literary = countMatches(outputText, /(조용히\s*쌓|버티지\s*못|흐려지고\s*맙|여운|스며들|숨결|결을\s*따라|풍경처럼)/g);
  const report = {
    passed: true,
    warnings: [],
    criticals: [],
    metrics: {
      registerDominant: register.dominant,
      registerOffRatio: r3(register.offRatio || 0),
      oneSentenceParagraphRatio: r3(oneSentenceRatio),
      colloquial,
      literary
    }
  };
  if ((genre === 'academic_assignment' || genre === 'report_technical' || genre === 'thesis_research') && colloquial >= 2) {
    report.criticals.push('격식 장르에 구어 표지가 과하게 섞였습니다.');
  }
  if (genre === 'field_blog' && literary >= 2) {
    report.warnings.push('업체/현장 글에 문학적 표현이 남아 있습니다.');
  }
  if (genre === 'field_blog' && oneSentenceRatio >= 0.55 && paras.length >= 4) {
    report.warnings.push('한 문장짜리 문단이 많아 완성된 문단 흐름이 약합니다.');
  }
  if (register.offRatio >= 0.35) {
    report.criticals.push('종결체가 크게 섞였습니다.');
  }
  report.passed = report.criticals.length === 0;
  return report;
}

function protectedGate(plan, outputText) {
  const terms = plan?.protectedTerms || {};
  const criticalMissing = [
    ...missingTerms(terms.numbers || [], outputText),
    ...missingTerms(terms.acronyms || [], outputText),
    ...missingTerms(terms.middleDot || [], outputText),
    ...missingTerms(terms.headings || [], outputText)
  ];
  const warningMissing = [
    ...missingTerms((terms.namedEntities || []).slice(0, 60), outputText, 20),
    ...missingTerms((terms.citations || []).slice(0, 30), outputText, 10)
  ];
  return {
    passed: criticalMissing.length === 0,
    criticalMissing: unique(criticalMissing, 40),
    warningMissing: unique(warningMissing, 30),
    counts: {
      criticalMissing: unique(criticalMissing, 40).length,
      warningMissing: unique(warningMissing, 30).length,
      totalProtected: (terms.all || []).length
    }
  };
}

function riskGate(rawText, baselineText, outputText, plan) {
  const before = profileRisk(rawText || '', plan?.protectedTerms || extractProtectedTerms(rawText || ''));
  const afterTerms = extractProtectedTerms(outputText || '');
  const after = profileRisk(outputText || '', afterTerms);
  const warnings = [];
  const hardReasons = [];
  if (after.genericness > Math.max(before.genericness || 0, 0.25) + 0.12) warnings.push('일반론 비율 증가');
  if ((before.anchorDensity || 0) >= 0.05 && (after.anchorDensity || 0) < (before.anchorDensity || 0) - 0.05) warnings.push('구체 anchor 감소');
  if ((after.registerMix?.offRatio || 0) > Math.max(before.registerMix?.offRatio || 0, 0.15) + 0.20) warnings.push('문체 혼합 악화');
  const rawBareLength = (rawText || '').replace(/\s+/g, '').length;
  const outputBareLength = (outputText || '').replace(/\s+/g, '').length;
  if (outputBareLength < rawBareLength * 0.60) hardReasons.push('분량 과축소');
  else if (outputBareLength < rawBareLength * 0.78) warnings.push('분량 축소 확인 필요');
  return {
    passed: hardReasons.length === 0,
    reasons: [...hardReasons, ...warnings],
    hardReasons,
    warnings,
    before,
    after,
    baselineLength: (baselineText || '').length
  };
}

function evaluateOutput(rawText, baselineText, outputText, plan) {
  const protectedReport = protectedGate(plan, outputText);
  const genreReport = genreGate(plan, rawText, outputText);
  const riskReport = riskGate(rawText, baselineText, outputText, plan);
  const criticals = [
    ...protectedReport.criticalMissing.map(t => `보호 용어 누락: ${t}`),
    ...(riskReport.hardReasons || [])
  ];
  const warnings = [
    ...protectedReport.warningMissing.map(t => `보호 후보 확인 필요: ${t}`),
    ...genreReport.criticals,
    ...genreReport.warnings,
    ...(riskReport.warnings || [])
  ];
  const reverted = criticals.length > 0;
  return {
    status: reverted ? 'reverted' : (warnings.length ? 'done_limited_effect' : (plan?.route?.status || 'done_safe')),
    reverted,
    fallback: reverted ? 'baseline' : null,
    reasons: criticals,
    warnings,
    protected: protectedReport,
    genre: genreReport,
    risk: riskReport
  };
}

function buildMeta(plan, { path = 'llm_genre_risk', applied = [], gates = {}, status = null } = {}) {
  const gateStatus = status || gates?.fundamental?.status || plan?.route?.status || 'done_safe';
  return {
    version: VERSION,
    profile: 'fundamental_engine',
    path,
    status: gateStatus,
    decision: gateStatus,
    reason: plan?.route?.reason || '장르·보호어·리스크 기준의 보존형 테스트 경로로 처리했습니다.',
    genre: plan?.genre || null,
    riskFlags: plan?.risk?.flags || [],
    protectedTermCount: plan?.protectedTerms?.all?.length || 0,
    protectedTermSample: (plan?.protectedTerms?.all || []).slice(0, 20),
    promptModules: plan?.promptModules || [],
    promptSnapshot: plan?.promptSnapshot || null,
    route: plan?.route || null,
    intent: plan?.intent || null,
    applied,
    gates,
    input: plan || null,
    message: fundamentalMessage(gateStatus)
  };
}

function fundamentalMessage(status) {
  if (status === 'reverted') return '보호 용어, 장르, 분량, 문체 중 하나가 안전 기준을 벗어나 기준 출력으로 되돌렸습니다.';
  if (status === 'done_limited_effect') return '구체 근거가 부족하거나 일부 경고가 있어 제한적인 보존형 수정으로 처리했습니다.';
  if (status === 'blocked_need_anchor') return '구체 근거가 부족해 사용자 메모나 실제 근거가 있으면 더 안정적으로 테스트할 수 있습니다.';
  return '요청의도 분기 없이 장르, 보호 용어, 표면 리스크 기준으로 보존형 수정을 적용했습니다.';
}

function floorReportFromGate(gate) {
  const criticals = [];
  const warnings = [
    ...(gate?.reasons || []).map(detail => ({ gate: 'fundamental_engine_revert', detail })),
    ...(gate?.warnings || []).map(detail => ({ gate: 'fundamental_engine_warning', detail }))
  ];
  return {
    status: 'clean',
    criticals,
    warnings,
    metrics: {
      fundamentalStatus: gate?.status || 'done_safe',
      protectedMissing: gate?.protected?.counts?.criticalMissing || 0,
      protectedWarnings: gate?.protected?.counts?.warningMissing || 0,
      registerOffRatio: gate?.genre?.metrics?.registerOffRatio ?? null,
      oneSentenceParagraphRatio: gate?.genre?.metrics?.oneSentenceParagraphRatio ?? null
    }
  };
}

async function run({ text, mode = 'assignment', lang = 'ko', userNotes = '', evidence = '', signal, callModel, extractModelResult } = {}) {
  if (typeof callModel !== 'function') throw new Error('humanizeLabTestEngine requires callModel');
  if (typeof extractModelResult !== 'function') throw new Error('humanizeLabTestEngine requires extractModelResult');

  const source = String(text || '');
  const plan = buildPlan(source, { mode, userNotes, evidence });
  const baseline = minimalCleanupText(source);

  if (plan.route?.mode === 'minimal_cleanup') {
    const gate = evaluateOutput(source, baseline, baseline, plan);
    const meta = buildMeta(plan, {
      path: 'minimal_cleanup',
      applied: ['spacing', 'paragraph_cleanup'],
      gates: { fundamental: gate },
      status: gate.status
    });
    const result = {
      outputText: baseline,
      styleProfile: 'fundamental_engine',
      fundamentalEngine: meta,
      humanizeMeta: meta,
      adminLabProfile: 'fundamental_engine'
    };
    return {
      result,
      floorReport: floorReportFromGate(gate),
      chunkCount: 1,
      fallbackCount: 0,
      gate,
      plan
    };
  }

  const promptCtx = buildPromptContext(source, { lang, mode, plan });
  const prompt = buildPrompt(promptCtx);
  const tool = buildTool(lang);
  const promptData = buildLabDataSections([
    { label: 'ADMIN_HUMANIZE_SOURCE', value: source, allowEmpty: true },
    { label: 'ADMIN_HUMANIZE_NOTE', value: userNotes },
    { label: 'ADMIN_APPROVED_EVIDENCE', value: evidence },
    {
      label: 'ADMIN_HUMANIZE_PROTECTED_TERMS',
      value: JSON.stringify((plan.protectedTerms?.all || []).slice(0, 80))
    }
  ]);
  const systemText = [prompt.text, labPromptSystemRule(tool.name)].join('\n\n');
  plan.promptModules = prompt.modules;
  plan.promptSnapshot = {
    modules: prompt.modules,
    stableChars: systemText.length,
    redacted: true
  };

  const data = await callModel({
    userText: promptData.text,
    systemText,
    tool,
    temperature: 0.35,
    maxOutputTokens: 8192,
    signal,
    task: 'admin_humanize_lab_test_engine',
    phase: 'fundamental:main',
    mode
  });
  const parsed = extractModelResult(data, tool.name) || {};
  const promptSecurity = auditLabOutput(parsed, {
    nonce: promptData.nonce,
    allowedSource: [source, userNotes, evidence, JSON.stringify((plan.protectedTerms?.all || []).slice(0, 80))].filter(Boolean).join('\n')
  });
  let outputText = promptSecurity.pass ? minimalCleanupText(parsed.outputText || '') : baseline;
  if (!outputText) outputText = baseline;

  const gate = evaluateOutput(source, baseline, outputText, plan);
  let path = promptSecurity.pass ? 'llm_genre_risk' : 'prompt_leak_revert_baseline';
  let fallbackCount = promptSecurity.pass ? 0 : 1;
  if (promptSecurity.pass && gate.reverted) {
    outputText = baseline;
    path = 'gate_revert_baseline';
    fallbackCount = 1;
  }
  const meta = buildMeta(plan, {
    path,
    applied: ['prompt_modules', 'llm_partial_rewrite', 'protected_terms_gate', 'genre_gate', 'risk_gate'],
    gates: { fundamental: gate },
    status: gate.status
  });
  meta.promptSecurity = promptSecurity;
  if (promptSecurity.pass && Array.isArray(parsed.riskFlags) && parsed.riskFlags.length) {
    meta.modelRiskFlags = parsed.riskFlags.slice(0, 12);
  }
  if (promptSecurity.pass && parsed.plan) meta.modelPlan = String(parsed.plan).slice(0, 500);
  const result = {
    outputText,
    styleProfile: 'fundamental_engine',
    fundamentalEngine: meta,
    humanizeMeta: meta,
    adminLabProfile: 'fundamental_engine'
  };
  return {
    result,
    floorReport: floorReportFromGate(gate),
    chunkCount: 1,
    fallbackCount,
    gate,
    plan
  };
}

module.exports = {
  VERSION,
  run,
  buildPlan,
  detectGenre,
  extractProtectedTerms,
  profileRisk,
  evaluateOutput,
  buildMeta
};
