'use strict';

const { splitSentences } = require('../engine/koreanText');
const { isV248FeatureEnabled } = require('../lib/humanizeV248Flags');
const { restoreSourceSentenceOrdinals } = require('./sourceSentenceRestore');
const {
  alignSourceSentence,
  alignedOutputCandidates,
  contentTokens
} = require('./sentenceAlignment');

const VERSION = 20;
// 의미 보존용 배제 탐지는 항상 넓은 범위를 사용한다. 아래 상투구 정책의
// 환경변수와 무관하며, 정책을 끄더라도 의미 약화 탐지를 줄이지 않는다.
// "~에/데(서) 그치지·멈추지·머무르지·머물지 않-", "~에 한정되지·국한되지 않-",
// "~데(서) 끝나지 않-"의 실제 출력 형태 전체. 2026-10-09 점검(F-04)에서 종전
// 정규식(`데서·데에·것에·선에 + 그치지/멈추지 않고`, `에 머무르지 않고`)은 결과
// 81회 가운데 6회만 인식했다. 앞에 조사·의존명사가 없는 `오래 머물지 않는다`,
// `전쟁이 끝나지 않고` 같은 문자 그대로의 쓰임은 계속 세지 않는다.
const ADDITIVE_RELATION_PATTERNS = Object.freeze([
  /(?:데서|데에|데|것에|것|선에|수준에|차원에|[가-힣A-Za-z0-9'’"”」』)\]]+(?:에서|에|로|으로|에만|만으로|만))\s*(?:그치지|멈추지|머무르지|머물지)\s*않(?:고|는|습|으며|을|았|음|기|지|다|아)/gu,
  /(?:데서|데에|데|것에|[가-힣A-Za-z0-9'’"”」』)\]]+(?:에서|에|로|으로|에만|만으로))\s*(?:한정되지|한정하지|국한되지|국한하지|끝나지)\s*않(?:고|는|습|으며|을|았|음|기|지|다|아)/gu
]);
// X1 이전 운영의 문체 정책 범위. 넓은 의미 탐지 정규식과 섞지 않는다.
const LEGACY_LIMITATIVE_STYLE_PATTERNS = Object.freeze([
  /(?:데서|데에|것에|선에)\s*(?:그치지|멈추지)\s*않고/gu,
  /에\s*머무르지\s*않고/gu
]);
const GUARDED_FAMILIES = Object.freeze([
  {
    code: 'limitative_additive',
    patterns: LEGACY_LIMITATIVE_STYLE_PATTERNS
  },
  {
    code: 'possibility_point',
    // `점은/점을`이 `점도`로 바뀐 것은 같은 기능성 표현의 조사 교체다.
    // 조사별로 서로 다른 지문으로 세면 원문에도 있던 계열을 신규 주입으로
    // 오인하므로 계열 전체를 하나로 센다.
    patterns: [/수\s*있다는\s*점(?:도|을|이|은|에서|으로)/gu]
  }
]);

const SHADOW_PATTERNS = Object.freeze([
  { code: 'in_the_process', pattern: /그\s*과정에서/gu },
  { code: 'can_and', pattern: /수\s*있고/gu },
  {
    code: 'experience_transition',
    pattern: /(?:이런|이러한)\s+경험(?:은|이)?[^.!?。！？\n]{0,80}(?:이어졌|이어지|연결되)/gu
  },
  { code: 'review_together', pattern: /함께\s+(?:살펴봤|살펴보|살피|검토하)/gu },
  { code: 'contribution_cliche', pattern: /보탬이\s+되(?:고자|도록|겠습니다|었다|었|는|길)/gu },
  // 2026-10-09 점검(F-04)에서 문서마다 한 번씩 주입되는 것으로 확인된 계열.
  // 기록만 하고 재시도·경고에 연결하지 않는다.
  { code: 'touching_adjacent', pattern: /맞닿아\s*있/gu },
  { code: 'advance_from_there', pattern: /데서\s*나아가/gu },
  { code: 'because_of_this', pattern: /(?<![가-힣])이\s*때문에/gu },
  { code: 'interlocked', pattern: /맞물려/gu },
  { code: 'also_especially_impressive', pattern: /도\s*특히\s*인상/gu }
]);

// 흔한 낱말 자체는 오류가 아니다. 다만 엔진이 여러 장르에서 같은 방향으로
// 어휘를 반복 치환하는지 원문 대비 shadow 통계로만 관찰한다.
const LEXICAL_TRANSITIONS = Object.freeze([
  { code: 'these_to_these_colloquial', from: /이러한/gu, to: /이런/gu },
  { code: 'various_to_several', from: /다양한/gu, to: /여러/gu },
  { code: 'therefore_to_so', from: /따라서/gu, to: /그래서/gu },
  { code: 'however_to_but', from: /그러나/gu, to: /다만/gu },
  { code: 'occur_to_happen', from: /발생(?:하|했|한|하는|한다|합니다|했다|할)/gu, to: /(?:생기(?:다|고|며|는|면|게|기|었다|었|는다면)|생긴|생겼|생겨)/gu },
  { code: 'within_to_inside', from: /내에서/gu, to: /안에서/gu }
]);

function isEnabled() {
  return isV248FeatureEnabled('fingerprintAudit');
}

function isExpandedLimitativeStyleEnabled() {
  // 명시적 1일 때만 X1의 넓힌 상투구 감사·재시도·복원을 켠다.
  return process.env.GPT_FINGERPRINT_EXPANDED_LIMITATIVE_STYLE === '1';
}

const ZERO_NEW_FINGERPRINT_PROFILES = new Set([
  'academic_paper',
  'report_assignment',
  'long_explainer',
  'resume_application',
  'clinical_record',
  'legal_contract',
  'student_record_teacher',
  'student_self_assessment'
]);

function profileName(documentProfile) {
  return String(documentProfile?.profile || documentProfile?.contentGenre || documentProfile || 'unknown');
}

function guardedFamilyAllowance(profile, { sourceCount = 0 } = {}) {
  // 전문 문서에는 없던 기능성 상투구를 새로 만드는 것은 계속 0회 정책을
  // 유지한다. 다만 원문에 이미 같은 계열이 있으면 조사 교체·동등 의역으로
  // 한 용례가 갈라지는 것까지 엔진 지문으로 오인하지 않도록 1회를 허용한다.
  if (!ZERO_NEW_FINGERPRINT_PROFILES.has(String(profile || ''))) return 1;
  return Number(sourceCount || 0) > 0 ? 1 : 0;
}

function auditFingerprint(source, output, documentProfile = null) {
  const before = String(source || '');
  const after = String(output || '');
  const profile = profileName(documentProfile);
  const expandedLimitativeStyleEnabled = isExpandedLimitativeStyleEnabled();
  const families = GUARDED_FAMILIES.map(legacyFamily => {
    const family = expandedLimitativeStyleEnabled && legacyFamily.code === 'limitative_additive'
      ? { ...legacyFamily, patterns: ADDITIVE_RELATION_PATTERNS }
      : legacyFamily;
    const sourceCount = countFamily(before, family);
    const outputCount = countFamily(after, family);
    const allowedIntroducedCount = guardedFamilyAllowance(profile, { sourceCount });
    const introducedCount = Math.max(0, outputCount - sourceCount);
    const introducedSentenceOrdinals = introducedCount > 0
      ? introducedFamilySentenceOrdinals(before, after, family, introducedCount)
      : [];
    return {
      code: family.code,
      sourceCount,
      outputCount,
      introducedCount,
      allowedIntroducedCount,
      excessIntroducedCount: Math.max(0, introducedCount - allowedIntroducedCount),
      introducedSentenceOrdinals
    };
  });
  const relationShift = detectContrastRelationShift(before, after);
  const semanticRelations = detectSemanticRelationShifts(before, after);
  const violations = [];
  for (const family of families) {
    if (family.excessIntroducedCount > 0) {
      violations.push({
        code: 'engine_phrase_fingerprint',
        family: family.code,
        count: family.excessIntroducedCount,
        allowedIntroducedCount: family.allowedIntroducedCount,
        sentenceOrdinals: family.introducedSentenceOrdinals
      });
    }
  }
  if (relationShift.detected) {
    violations.push({
      code: 'contrast_relation_shift',
      family: 'negative_to_additive',
      count: relationShift.count,
      sentenceOrdinals: relationShift.sentenceOrdinals
    });
  }
  for (const item of semanticRelations.shifts) {
    violations.push({
      code: 'semantic_relation_shift',
      family: item.family,
      count: Math.max(1, item.sentenceOrdinals.length),
      sentenceOrdinals: item.sentenceOrdinals,
      documentLevel: item.documentLevel === true
    });
  }
  const shadow = SHADOW_PATTERNS.map(item => {
    const sourceCount = countMatches(before, item.pattern);
    const outputCount = countMatches(after, item.pattern);
    return { code: item.code, sourceCount, outputCount, delta: outputCount - sourceCount };
  });
  // 넓은 문체 계열은 두 모드 모두 관측한다. shadow는 위반이나 개선 판단에
  // 사용하지 않으며, 기존 index.js의 fingerprintShadow로 숫자만 전달한다.
  const expandedStyleFamily = { patterns: ADDITIVE_RELATION_PATTERNS };
  const expandedSourceCount = countFamily(before, expandedStyleFamily);
  const expandedOutputCount = countFamily(after, expandedStyleFamily);
  shadow.push({
    code: 'limitative_additive_expanded',
    sourceCount: expandedSourceCount,
    outputCount: expandedOutputCount,
    delta: expandedOutputCount - expandedSourceCount,
    introducedCount: Math.max(0, expandedOutputCount - expandedSourceCount)
  });
  const lexicalTransitions = LEXICAL_TRANSITIONS.map(item => {
    const sourceFromCount = countMatches(before, item.from);
    const outputFromCount = countMatches(after, item.from);
    const sourceToCount = countMatches(before, item.to);
    const outputToCount = countMatches(after, item.to);
    const fromDecrease = Math.max(0, sourceFromCount - outputFromCount);
    const toIncrease = Math.max(0, outputToCount - sourceToCount);
    return {
      code: item.code,
      sourceFromCount,
      outputFromCount,
      sourceToCount,
      outputToCount,
      transitionCount: Math.min(fromDecrease, toIncrease)
    };
  });
  return {
    version: VERSION,
    enabled: isEnabled(),
    expandedLimitativeStyleEnabled,
    profile,
    pass: violations.length === 0,
    families,
    introducedCount: families.reduce((sum, item) => sum + item.introducedCount, 0),
    excessIntroducedCount: families.reduce((sum, item) => sum + item.excessIntroducedCount, 0),
    violations,
    issueCodes: [...new Set(violations.map(item => item.code))],
    relationShift,
    semanticRelations,
    shadow,
    lexicalTransitions,
    lexicalTransitionCount: lexicalTransitions.reduce((sum, item) => sum + item.transitionCount, 0)
  };
}

const SEMANTIC_RELATION_RULES = Object.freeze([
  {
    family: 'difficulty_strengthened_to_impossibility',
    source: /(?:어려웠|어렵|쉽지\s*않)/u,
    output: /(?:할|갈|볼|낼|올|될|쓸|참여할|수행할)\s*수\s*없|불가능/u,
    retained: /(?:어려웠|어렵|쉽지\s*않)/u
  },
  {
    family: 'current_responsibility_changed_to_past',
    source: /(?:현재|지금)[^.!?。！？]{0,70}(?:맡고|담당하고|수행하고)\s*있/u,
    output: /(?:맡았던|맡았습니다|담당했던|담당했습니다|수행했던|수행했습니다)/u,
    retained: /(?:맡고|담당하고|수행하고)\s*있/u
  },
  {
    family: 'reflective_emotion_removed',
    source: /(?:큰\s*감명|깊은\s*감동|절감했|절감하였|뿌듯함을\s*느|보람을\s*느)/u,
    output: /(?:확인|관찰|알게|이해|분석)(?:하|했|되|한)/u,
    retained: /(?:감명|감동|절감|뿌듯|보람|가슴|깊이\s*느)/u
  },
  {
    family: 'proof_goal_weakened_to_check',
    source: /증명(?:하|해|했|하기|하고|하려)/u,
    output: /확인(?:하|해|했|하기|하고|하려)/u,
    retained: /증명/u
  },
  {
    family: 'consideration_weakened_to_seeing',
    source: /고려(?:하|해|했|해야|하고|하며)/u,
    output: /(?:함께\s*)?(?:봐야|보아야|봤|보았|보며)/u,
    retained: /고려/u
  },
  {
    family: 'rediscovery_changed_to_reviving',
    source: /재발견/u,
    output: /(?:다시\s*)?(?:살리|살려|살렸|되살리|되살려|부활)/u,
    retained: /재발견/u
  },
  {
    family: 'active_stance_changed_to_directness',
    source: /적극적(?:으로|인)/u,
    output: /(?:바로|직접(?:적으로)?)/u,
    retained: /적극적/u
  },
  {
    family: 'coercion_direction_reversed',
    source: /내몰리|내몰린|내몰렸/u,
    output: /몰려오|몰려온|몰려왔/u,
    retained: /내몰/u
  },
  {
    family: 'priority_changed_to_progression',
    source: /자체보다/u,
    output: /(?:에서|하는\s*데서)\s*나아가/u,
    retained: /자체보다/u
  },
  {
    family: 'background_changed_to_chronology',
    source: /(?:을|를)\s*배경으로\s*(?:등장|형성|발전|탄생)/u,
    output: /(?:하던|했던|한|되던|된)\s*(?:시기|당시|때)(?:에|의)?\s*(?:등장|형성|발전|탄생)/u,
    retained: /배경으로/u
  },
  {
    family: 'priority_changed_to_exclusion',
    source: /자체보다/u,
    output: /(?:이|가)\s*아니라/u,
    retained: /자체보다/u
  },
  {
    family: 'additive_scope_changed_to_exclusion',
    source: /(?:에|로)\s*그치지\s*않고/u,
    output: /(?:이|가)\s*아니라/u,
    retained: /(?:에|로)\s*그치지\s*않고/u
  },
  {
    family: 'question_scope_changed_from_whether_to_degree',
    source: /여부/u,
    output: /얼마나[^.!?。！？\n]{0,45}(?:는지|인지|했는지|됐는지|큰지|작은지|높은지|낮은지|강한지|약한지)/u,
    retained: /여부/u
  },
  {
    family: 'configured_state_changed_to_actor',
    source: /(?:지정|설정|선정)된\s+(?:음성|안내|값|시간|조건|신호|출력|동작|부품|대상)/u,
    output: /(?:지정|설정|선정)한\s+(?:음성|안내|값|시간|조건|신호|출력|동작|부품|대상)/u,
    retained: /(?:지정|설정|선정)된\s+(?:음성|안내|값|시간|조건|신호|출력|동작|부품|대상)/u
  },
  {
    family: 'applied_change_changed_to_direct_action',
    source: /(?:교체|변경|개편|도입)(?:이|가)\s*(?:적용|반영|완료|진행)된/u,
    output: /(?:을|를)\s*(?:교체|변경|개편|도입)(?:하|해|했|한|하고)/u,
    retained: /(?:교체|변경|개편|도입)(?:이|가)\s*(?:적용|반영|완료|진행)된|(?:변경|교체|도입)에\s*(?:맞춰|따라|대응)/u
  },
  {
    family: 'participation_changed_to_ownership',
    source: /(?:참여|지원|협업|보조)(?:하|해|했|하여|하고|했다)/u,
    output: /(?:주도|총괄|전담|완료)(?:하|해|했|하여|하고|했다)/u,
    retained: /(?:참여|지원|협업|보조)(?:하|해|했|하여|하고|했다)/u
  },
  {
    family: 'team_context_changed_to_contrast',
    source: /(?:\d+\s*인\s*)?팀에서(?!는)/u,
    output: /(?:\d+\s*인\s*)?팀에서는/u,
    retained: /(?:\d+\s*인\s*)?팀에서(?!는)/u
  },
  {
    family: 'requirement_translation_changed_to_insertion',
    source: /요구(?:\s*사항)?(?:을|를)[^.!?。！？\n]{0,100}(?:사양|구조|설계|산출물)(?:로|으로)\s*(?:구체화|변환|전환|정의)/u,
    output: /(?:사양|구조|설계|산출물)[^.!?。！？\n]{0,90}(?:에|에는)\s*[^.!?。！？\n]{0,50}요구(?:\s*사항)?(?:을|를)\s*(?:구체적으로\s*)?(?:반영|적용)/u,
    retained: /요구(?:\s*사항)?(?:을|를)[^.!?。！？\n]{0,100}(?:사양|구조|설계|산출물)(?:로|으로)\s*(?:구체화|변환|전환|정의)/u
  },
  {
    family: 'competency_claim_weakened_to_foundation',
    source: /(?:역량|능력)(?:을|를)\s*(?:길렀|기르|강화|높였|키웠|갖췄|갖추)/u,
    output: /(?:이해|파악)[^.!?。！？\n]{0,70}(?:기반|토대)(?:을|도)?\s*(?:다졌|마련|쌓았)/u,
    retained: /(?:역량|능력)(?:을|를)\s*(?:길렀|기르|강화|높였|키웠|갖췄|갖추)/u
  },
  {
    family: 'learning_changed_to_possession',
    source: /(?:배웠|배우게\s*되|익혔|익히게\s*되|깨달|알게\s*되|이해하게\s*되|체감|확인할\s*수\s*있었)/u,
    output: /(?:(?:역량|능력|전문성)(?:을|를)?\s*(?:갖췄|갖추었|보유|확보)|(?:갖춘|보유한)\s*(?:역량|능력|전문성))/u,
    retained: /(?:배웠|배우게\s*되|익혔|익히게\s*되|깨달|알게\s*되|이해하게\s*되|체감|확인할\s*수\s*있었)/u
  },
  {
    family: 'definition_changed_to_starting_point',
    source: /(?:것|과정|행위|학문|역할)(?:이|이라고)\s*(?:생각|본|볼|정의)/u,
    output: /(?:데서|데에서|것에서|과정에서|관계에서)\s*출발(?:하|한|했|합니다|한다)/u,
    retained: /(?:것|과정|행위|학문|역할)(?:이|이라고)\s*(?:생각|본|볼|정의)/u
  },
  {
    family: 'preference_changed_to_additive_scope',
    source: /(?:하려\s*하기|하려|하기|하는)\s*보다/u,
    output: /(?:데만|데에만|것에만|과정에만)\s*(?:있는|머무는)?\s*것이\s*아니라/u,
    retained: /(?:하려\s*하기|하려|하기|하는)\s*보다/u
  },
  {
    family: 'relation_subject_replaced_by_deictic',
    source: /(?:은|는|이|가)[^.!?。！？\n]{2,100}(?:와|과)\s*(?:자연스럽게\s*)?(?:연결|이어질)/u,
    output: /(?:^|[.!?。！？]\s*)(?:여기에|거기에|이곳에|그곳에)\s+[^.!?。！？\n]{2,70}(?:이|가)\s*(?:자연스럽게\s*)?(?:이어(?:지|져|졌|진)|연결)/u,
    retained: /(?:은|는|이|가)[^.!?。！？\n]{2,100}(?:와|과)\s*(?:자연스럽게\s*)?(?:연결|이어질)/u
  }
]);

function detectSemanticRelationShifts(source, output) {
  // Segment punctuation-poor prose for matching, but retain the public source
  // ordinal used by restoration. Never pass inferred ordinals to a restorer
  // that still operates on the original sentence list.
  const sourceUnits = splitSentences(String(source || '')).flatMap((text, index) =>
    splitSentences(text, { inferPlainEndings: true }).map(text => ({ text, ordinal: index + 1 })));
  const sourceSentences = sourceUnits.map(unit => unit.text);
  const outputSentences = splitSentences(String(output || ''), { inferPlainEndings: true });
  const grouped = new Map();
  const add = (family, ordinal) => {
    if (!grouped.has(family)) grouped.set(family, new Set());
    grouped.get(family).add(ordinal);
  };

  sourceSentences.forEach((sourceSentence, sourceIndex) => {
    const alignment = alignSourceSentence(
      sourceSentence,
      sourceIndex,
      sourceSentences.length,
      outputSentences
    );
    if (!alignment || alignment.score < 0.24) return;
    const assessPair = alignedText => {
      const issues = [];
      const add = (family, ordinal) => issues.push({ family, ordinal });
      for (const rule of SEMANTIC_RELATION_RULES) {
        if (!matches(rule.source, sourceSentence)) continue;
        if (rule.family === 'difficulty_strengthened_to_impossibility'
            && matches(rule.output, sourceSentence)) continue;
        if (rule.family === 'priority_changed_to_exclusion'
            && matches(rule.output, sourceSentence)) continue;
        if (rule.family === 'background_changed_to_chronology'
            && matches(rule.output, sourceSentence)) continue;
        const shifted = matches(rule.output, alignedText)
          && !matches(rule.retained, alignedText);
        if (shifted) add(rule.family, sourceIndex + 1);
      }

      if (conceptNarrowedByActionModifier(sourceSentence, alignedText)) {
        add('concept_narrowed_by_modifier', sourceIndex + 1);
      }
      if (explicitSpeakerEvidenceRemoved(sourceSentence, alignedText)) {
        add('speaker_evidence_removed', sourceIndex + 1);
      }

      if (/(?:었|였|했|됐|였으|했으)지만/u.test(sourceSentence)) {
        const shifted = /(?:었|였|했|됐)고/u.test(alignedText)
          && !/(?:지만|으나|반면|그러나|하지만|그럼에도)/u.test(alignedText);
        if (shifted) add('contrast_connector_removed', sourceIndex + 1);
      }

      if (/(?:연구|분석|조사|검토)(?:를|을)?\s*통해[^.!?。！？\n]{0,45}(?:확인|파악|알)(?:할)?\s*수\s*있/u.test(sourceSentence)) {
        const shifted = !/(?:연구|분석|조사|검토)(?:를|을)?\s*통해/u.test(alignedText)
          && !/(?:확인|파악|알)(?:할)?\s*수\s*있/u.test(alignedText);
        if (shifted) add('evidence_frame_removed', sourceIndex + 1);
      }

      if (hasMainPossibilityClaim(sourceSentence)) {
        const possibilityRemoved = !hasPossibilityMarker(alignedText)
          && !/(?:이해되|해석되|판단되|볼\s*수\s*있)/u.test(alignedText);
        if (possibilityRemoved && hasGoalFrame(alignedText)) {
          add('possibility_changed_to_goal', sourceIndex + 1);
        } else {
          const shifted = possibilityRemoved && (
            /(?:한다|된다|이다|있다|확정된다|분명하다)[.!?。！？]?(?:\s|$)/u.test(alignedText)
            || /(?:분명히|명확히|확실히)[^.!?。！？\n]{0,40}(?:보여\s*준다|드러낸다|입증한다|확인된다)/u.test(alignedText)
          );
          if (shifted) add('possibility_hardened_to_certainty', sourceIndex + 1);
        }
      }

      if (hasEpistemicHedge(sourceSentence)) {
        const hedgeRemoved = !hasClaimScopedEpistemicHedge(sourceSentence, alignedText);
        const shifted = hedgeRemoved
          && hasDirectDeclarativeEnding(alignedText)
          && (
            hasCertaintyMarker(alignedText)
            || alignedCoreSimilarity(sourceSentence, alignedText) >= 0.34
          );
        if (shifted) add('epistemic_hedge_hardened', sourceIndex + 1);
      }

      if (hasNecessityClaim(sourceSentence) && !hasImpossibilityClaim(sourceSentence)) {
        const shifted = hasImpossibilityClaim(alignedText);
        if (shifted) add('necessity_strengthened_to_impossibility', sourceIndex + 1);
      }

      if (hasTentativeNormativeClaim(sourceSentence)) {
        const shifted = hasFirmNormativeClaim(alignedText)
          && !hasTentativeNormativeClaim(alignedText);
        if (shifted) add('tentative_norm_hardened', sourceIndex + 1);
      }

      if (hasCollaborativeRoleQualifier(sourceSentence)) {
        const shifted = hasDirectCompletionClaim(alignedText)
          && !hasCollaborativeRoleQualifier(alignedText);
        if (shifted) add('collaborative_role_scope_removed', sourceIndex + 1);
      }

      if (hasExternalResponsibilityRejection(sourceSentence)) {
        const shifted = hasResponsibilityTransferToPerson(alignedText)
          && !hasExternalResponsibilityRejection(alignedText);
        if (shifted) add('responsibility_attribution_shifted_to_person', sourceIndex + 1);
      }

      if (hasResponsibilityForChoice(sourceSentence)) {
        const shifted = hasResponsibilityForOutcome(alignedText)
          && !hasResponsibilityForChoice(alignedText);
        if (shifted) add('responsibility_object_changed_to_outcome', sourceIndex + 1);
      }

      if (hasImportanceClaim(sourceSentence)) {
        const shifted = hasObligationClaim(alignedText)
          && !hasImportanceClaim(alignedText);
        if (shifted) add('importance_hardened_to_obligation', sourceIndex + 1);
      }

      // `이에`처럼 중립적인 연결을 `이를 보완하기 위해`로 바꾸면 연구자가
      // 기존 연구의 결함을 직접 보완하려 했다는 목적 관계가 새로 생긴다.
      // 문장 유사도만으로는 사실 추가로 보이지 않으므로 관계 감사에서 별도로
      // 잡고, 원문에 같은 보완 목적이 실제로 있을 때는 허용한다.
      if (hasExplicitRemediationPurpose(alignedText)
          && !hasExplicitRemediationPurpose(sourceSentence)) {
        add('neutral_link_hardened_to_remediation', sourceIndex + 1);
      }

      // 범위를 넓히거나 예외를 없애는 부사는 짧지만 명제 강도를 바꾼다.
      // 원문에 없던 `일괄적으로·전면적으로·반드시` 등을 문체 장식으로
      // 주입하지 못하게 원문 대응 문장 단위로 비교한다.
      if (introducedScopeQualifier(sourceSentence, alignedText)) {
        add('unsupported_scope_qualifier', sourceIndex + 1);
      }

      const sourceConcurrent = /(?:면서|으며|동시에|함께|및|을\s*통해|를\s*통해)/u.test(sourceSentence);
      const sourceSequential = /(?:한|한\s*|된|된\s*|하고\s*난)\s*(?:뒤|후)|이후|먼저[^.!?。！？\n]{0,50}(?:다음|이어)/u.test(sourceSentence);
      const outputSequential = /(?:한|한\s*|된|된\s*|하고\s*난)\s*(?:뒤|후)|이후|먼저[^.!?。！？\n]{0,50}(?:다음|이어)/u.test(alignedText);
      const outputConcurrent = /(?:면서|으며|동시에|함께|및|을\s*통해|를\s*통해)/u.test(alignedText);
      if (sourceConcurrent && !sourceSequential && outputSequential && !outputConcurrent) {
        add('concurrent_relation_hardened_to_sequence', sourceIndex + 1);
      }
      return issues;
    };
    let issues = assessPair(alignment.text);
    // Paragraph/sentence expansion can put the true partner outside the local
    // proportional window. Recheck only a flagged pair, with a bounded global
    // single-sentence search. A clearly stronger, unique match is required;
    // ambiguous repetitions and genuine split sentences keep the original audit.
    if (issues.length && outputSentences.length <= 400) {
      const candidates = alignedOutputCandidates(sourceSentence, sourceIndex,
        sourceSentences.length, outputSentences,
        { window: outputSentences.length, maxOutputGroup: 1 });
      const best = candidates[0], runnerUp = candidates[1];
      if (best && best.score >= 0.45 && best.score >= alignment.score + 0.1
          && (!runnerUp || best.score - runnerUp.score >= 0.12)) {
        issues = assessPair(best.text);
      }
    }
    for (const issue of issues) add(issue.family, sourceUnits[sourceIndex].ordinal);
  });

  const sourceUrgency = countMatches(source, /(?:바로|즉시|곧바로)\s+(?:움직|착수|시작|실행|대응|신청|지원|결정|나섰)/gu);
  const outputUrgency = countMatches(output, /(?:바로|즉시|곧바로)\s+(?:움직|착수|시작|실행|대응|신청|지원|결정|나섰)/gu);
  if (outputUrgency > sourceUrgency) add('unsupported_immediacy', 0);

  const shifts = [...grouped.entries()].map(([family, ordinals]) => ({
    family,
    sentenceOrdinals: [...ordinals].filter(value => value > 0).sort((a, b) => a - b),
    documentLevel: ordinals.has(0)
  }));
  return {
    detected: shifts.length > 0,
    count: shifts.reduce((sum, item) => sum + Math.max(1, item.sentenceOrdinals.length), 0),
    shifts
  };
}

function hasMainPossibilityClaim(value) {
  const text = String(value || '').trim();
  if (/(?:가능성(?:이|은|도)?\s*(?:있|높)|예상(?:된|되|하)|전망(?:된|되|하))/u.test(text)) return true;
  if (/(?:이해|파악|확인|알)할\s*수\s*있/u.test(text)) return false;
  if (/수\s*있는\s+[가-힣A-Za-z]/u.test(text) || /수\s*있(?:을)?\s*(?:때|지만|으며|고|도록|기\s*때문)/u.test(text)) return false;
  return /수\s*있(?:다|습니다|을\s*것이다|다고\s*(?:본다|예상한다|판단한다))\s*[.!?。！？]?$/u.test(text);
}

function hasPossibilityMarker(value) {
  return /(?:수\s*있|가능|예상|전망|것으로\s*보|듯하|수도\s*있)/u.test(String(value || ''));
}

function hasEpistemicHedge(value) {
  return /(?:것\s*같(?:다|습니다|았다|아요|아|고|으며|지만|은데)|듯(?:하|싶)|것으로\s*보(?:인|인다|입니다)|수도\s*있|지도\s*모르|어쩌면|아마(?:도)?|확실하지\s*않)/u
    .test(String(value || ''));
}

function hasClaimScopedEpistemicHedge(source, alignedText) {
  if (!hasEpistemicHedge(alignedText)) return false;
  const sentences = splitSentences(alignedText, { inferPlainEndings: true });
  if (sentences.length <= 1) return true;
  // A neighbouring claim's hedge cannot license hardening this claim. Require
  // a strongly matching declarative clause and a clear content-coverage gap;
  // ordinary split clauses with distributed content keep their group context.
  let hedgedCoverage = 0, directCoverage = 0;
  for (const sentence of sentences) {
    const coverage = alignedCoreSimilarity(source, sentence);
    if (hasEpistemicHedge(sentence)) hedgedCoverage = Math.max(hedgedCoverage, coverage);
    else if (hasDirectDeclarativeEnding(sentence)) directCoverage = Math.max(directCoverage, coverage);
  }
  return !(directCoverage >= 0.65 && directCoverage - hedgedCoverage >= 0.25);
}

function hasCertaintyMarker(value) {
  return /(?:분명(?:하|해졌|해진)|확실(?:하|해졌|해진)|명백(?:하|해졌|해진)|틀림없|단정할\s*수\s*있)/u
    .test(String(value || ''));
}

function hasDirectDeclarativeEnding(value) {
  return /(?:다|습니다|이다|입니다|됐다|되었습니다|해졌다|확인됐다|드러났다|나타났다)[.!?。！？]?\s*$/u
    .test(String(value || '').trim());
}

function alignedCoreSimilarity(left, right) {
  const leftTokens = contentTokens(String(left || ''))
    .filter(token => !isHedgeToken(token));
  const rightTokens = new Set(contentTokens(String(right || ''))
    .filter(token => !isHedgeToken(token)));
  if (!leftTokens.length) return 0;
  return leftTokens.filter(token => rightTokens.has(token)).length / leftTokens.length;
}

function isHedgeToken(token) {
  return /^(?:같다|같습니다|듯하다|듯싶다|보인다|어쩌면|아마도?|모르다)$/u.test(String(token || ''));
}

function hasImportanceClaim(value) {
  return /(?:것|점|태도|과정|방법|역할|기준|원칙)(?:은|는|이|가)?\s*중요(?:하|했|한|함|합|합니다|하다)/u
    .test(String(value || ''));
}

function hasExplicitRemediationPurpose(value) {
  return /(?:이를|이것을|이\s*점(?:을|를)|이러한?\s*(?:문제|한계|공백)(?:을|를)|문제(?:를|을)|한계(?:를|을)|공백(?:을|를))[^.!?。！？\n]{0,28}(?:보완|해결|극복|개선)(?:하|해|하기|하고자|하려)/u
    .test(String(value || ''));
}

const SCOPE_QUALIFIER_PATTERNS = Object.freeze([
  /일괄적으로/u,
  /전면적으로/u,
  /전적으로/u,
  /예외\s*없이/u,
  /반드시/u,
  /오직/u,
  /완전히/u
]);

function introducedScopeQualifier(source, output) {
  const before = String(source || '');
  const after = String(output || '');
  return SCOPE_QUALIFIER_PATTERNS.some(pattern => matches(pattern, after) && !matches(pattern, before));
}

function hasObligationClaim(value) {
  return /(?:해야|하여야|해야만|할\s*필요가\s*있|필수(?:적)?(?:이|이었|입니다|이다))/u
    .test(String(value || ''));
}

function hasGoalFrame(value) {
  return /(?:(?:목적|목표|취지|방향|의도)(?:은|는|이|가|를|을|에)?[^.!?。！？\n]{0,28}(?:있|두|삼|향하)|(?:하는|하는\s*데|하기\s*위한)\s*(?:목적|목표|취지))/u
    .test(String(value || ''));
}

function hasNecessityClaim(value) {
  return /(?:필요(?:하|하다|하며|한|하다)|해야\s*(?:한다|할|하며)|요구(?:되|하))/u.test(String(value || ''));
}

function hasImpossibilityClaim(value) {
  const text = String(value || '');
  if (/(?:불가능하|할\s*수\s*없)/u.test(text)) return true;
  return /(?:하지\s*않으면|하지\s*않고서는|없이는|머물러서는|그대로는)[^.!?。！？\n]{0,70}(?:불가능|어렵)/u.test(text);
}

function hasTentativeNormativeClaim(value) {
  return /(?:해야\s*할\s*것이다|필요할\s*것이다|필요하다고\s*(?:본다|판단한다)|바람직할\s*것이다)/u.test(String(value || ''));
}

function hasFirmNormativeClaim(value) {
  return /(?:해야\s*한다|필요하다|필수적이다|의무이다)\s*[.!?。！？]?(?=\s|$)/u.test(String(value || '').trim());
}

function hasCollaborativeRoleQualifier(value) {
  return /(?:참여|지원|협업|보조|공동으로|함께)(?:하|해|했|하여|하고|했다|진행)/u.test(String(value || ''));
}

function hasDirectCompletionClaim(value) {
  return /(?:완료|달성|확보|구축|개발|설계|도출|수행)(?:하|해|했|하여|하고|했다)/u.test(String(value || ''));
}

function hasExternalResponsibilityRejection(value) {
  const text = String(value || '');
  const external = /(?:외부\s*요인|환경|상황|타인|남|주변|사회)(?:에|에게|으로|탓으로)?/u;
  const attribution = /(?:책임(?:을)?\s*(?:돌리|전가)|탓(?:으로)?\s*(?:돌리|하))/u;
  const limiting = /(?:벗어나|않|말|그치지|머무르지|만으로\s*보지|만의\s*문제로\s*보지)/u;
  if (!external.test(text) || !attribution.test(text) || !limiting.test(text)) return false;
  const externalIndex = text.search(external);
  const attributionIndex = text.search(attribution);
  const limitingIndex = text.slice(Math.max(0, attributionIndex)).search(limiting);
  return externalIndex >= 0
    && attributionIndex >= externalIndex
    && attributionIndex - externalIndex <= 70
    && limitingIndex >= 0
    && limitingIndex <= 45;
}

function hasResponsibilityTransferToPerson(value) {
  const text = String(value || '');
  const person = /(?:내담자|상담\s*대상자|당사자|개인|본인|자기|자신)(?:의)?/u;
  const transfer = /(?:옮기|돌리|귀속|지우|부과|전환)/u;
  const responsibility = /책임(?:의\s*(?:방향|소재|주체|초점))?/u;
  if (!responsibility.test(text) || !person.test(text) || !transfer.test(text)) return false;
  const responsibilityIndex = text.search(responsibility);
  const personIndex = text.search(person);
  const transferIndex = text.search(transfer);
  const transferTail = transferIndex >= 0 ? text.slice(transferIndex, transferIndex + 18) : '';
  if (/(?:옮기|돌리|귀속|지우|부과|전환)[^.!?。！？\n]{0,8}(?:지\s*않|지\s*말|지\s*못)/u.test(transferTail)) {
    return false;
  }
  return responsibilityIndex >= 0
    && personIndex >= responsibilityIndex
    && personIndex - responsibilityIndex <= 100
    && transferIndex >= personIndex
    && transferIndex - personIndex <= 55;
}

function hasResponsibilityForChoice(value) {
  return /(?:선택|결정|행동)(?:(?:에|에는|에\s*대해)\s*책임|(?:을|를)\s*책임)(?:을\s*)?(?:지|지게|지는|져|져야)/u
    .test(String(value || ''));
}

function hasResponsibilityForOutcome(value) {
  return /(?:결과|귀결|성과|영향)(?:(?:에|에는|에\s*대해)\s*책임|(?:을|를)\s*책임)(?:을\s*)?(?:지|지게|지는|져|져야)/u
    .test(String(value || ''));
}

// 원문의 `아니라`가 X를 배제하지 않고 "X만으로 한정하지 않음"을 뜻하는 꼴.
// 이때 `X에 그치지 않고 Y`는 같은 관계라 반전이 아니다(상투구 주입으로는 계속 센다).
// - `단순히·단지·그저·그냥 X가 아니라`: 부사가 부정되는 X(최대 다섯 어절) 바로
//   앞에 올 때만. `오직`은 범위를 좁히는 부사라 넣지 않는다.
// - `X뿐(만) 아니라`, `X만이·만은 아니라`, `X만(으로) …하는 것이 아니라`.
// - `X에 그치는·머무는·한정된·국한된 (것이) 아니라`.
const LIMITATIVE_ADVERB_EXCEPTION = /(?:단순히|단지|그저|그냥)\s*(?:[가-힣A-Za-z0-9·'‘’"“”]+\s*){0,5}?(?:이|가|은|는|을|를|만|만이|만은|만으로|것이|것만이|것만은|뿐)\s*(?:아니라|아닌\s+것이(?:라|고))/u;
const LIMITATIVE_MARKER_EXCEPTION = /(?:(?:뿐|뿐만|만이|만은)\s*(?:아니라|아닌\s+것이(?:라|고))|만(?:으로)?\s*(?:[가-힣A-Za-z0-9·]+\s*){0,3}?(?:것이|것은|것만이|것만은)\s*(?:아니라|아닌\s+것이(?:라|고))|(?:에|로|으로)(?:만)?\s*(?:그치는|머무는|머무르는|한정된|국한된|한정되는|국한되는)\s*(?:[가-힣]+\s*){0,2}?(?:것이|것은|현상이|문제가|일이)?\s*(?:아니라|아닌\s+것이(?:라|고)))/u;

function detectContrastRelationShift(source, output) {
  const sourceSentences = splitSentences(String(source || '')).map(value => String(value || '').trim()).filter(Boolean);
  const outputSentences = splitSentences(String(output || '')).map(value => String(value || '').trim()).filter(Boolean);
  const sentenceOrdinals = [];
  const shifts = [];
  for (let index = 0; index < sourceSentences.length; index += 1) {
    const sourceSentence = sourceSentences[index];
    if (!/(?:아니라|아닌\s+것이(?:라|고)|아님을)/u.test(sourceSentence)) continue;
    // `단순히/단지 X가 아니라 Y`는 X를 완전히 부정하기보다 X만으로 범위를
    // 한정하지 않는 관계다. 이 경우 `X에 머무르지 않고 Y`는 같은 제한적
    // 기능을 유지하므로 부정→가산 반전으로 보지 않는다. `단순한 X가 아니라`는
    // 명사구 대조이므로 이 예외에 포함하지 않는다. 부사가 부정되는 X 바로
    // 앞에 붙어 그 범위를 한정할 때만 예외다. 문장 앞쪽 다른 자리의 `단순히`
    // (`단순히 인사이동으로 대응할 경우 … 해결하는 것이 아니라`)는 예외가 아니다.
    const limitativeSource = LIMITATIVE_ADVERB_EXCEPTION.test(sourceSentence)
      || LIMITATIVE_MARKER_EXCEPTION.test(sourceSentence);
    const candidates = alignedOutputCandidates(
      sourceSentence,
      index,
      sourceSentences.length,
      outputSentences
    ).filter(item => item.score >= 0.24).slice(0, 4);
    // Sentence splitting can drift beyond the proportional window. Add only a
    // globally best single comparison counterpart, still subject to X/Y and
    // reciprocal ownership checks below. Additive retrieval stays unchanged.
    const comparisonCandidate = outputSentences.some(text => weakenedComparisonPattern(sourceSentence, text))
      ? alignedOutputCandidates(sourceSentence, index, sourceSentences.length, outputSentences,
        { window: outputSentences.length, maxOutputGroup: 1 })[0]
      : null;
    if (comparisonCandidate?.score >= 0.24
        && weakenedComparisonPattern(sourceSentence, comparisonCandidate.text)) candidates.push(comparisonCandidate);
    const sourceTokens = contentTokens(sourceSentence);
    let found = null;
    const shifted = candidates.some(candidate => {
      // 1:N 묶음이면 계열 표현이 실제로 들어 있는 결과 문장이 원문과 겹쳐야
      // 한다. 이웃 문장의 `그치지 않고`를 이 문장의 반전으로 세지 않는다.
      const members = Array.isArray(candidate.sentences) && candidate.sentences.length
        ? candidate.sentences
        : [candidate.text];
      return members.some((member, memberIndex) => {
        if (/(?:아니라|아닌\s+것이(?:라|고)|아님을|아니다|아닙니다|아니었다)/u.test(member)) return false;
        const additive = ADDITIVE_RELATION_PATTERNS.some(pattern => matches(pattern, member));
        const pattern = additive ? 'limitative_additive' : weakenedComparisonPattern(sourceSentence, member);
        if (!pattern) return false;
        const candidateTokens = new Set(contentTokens(member));
        const shared = sourceTokens.filter(token => candidateTokens.has(token)).length;
        if (sourceTokens.length < 2 || shared / sourceTokens.length < 0.35) return false;
        if (!additive) {
          // A shared topic in an adjacent sentence is insufficient. The selected
          // member must be the best single counterpart, with no stronger owner.
          const best = comparisonCandidate;
          if (!best || best.start !== candidate.start + memberIndex) return false;
          const ownScore = alignSourceSentence(sourceSentence, 0, 1, [member]).rawScore;
          if (sourceSentences.some((other, otherIndex) => otherIndex !== index
              && alignSourceSentence(other, 0, 1, [member]).rawScore >= ownScore - 0.02)) return false;
        }
        found = { sourceOrdinal: index + 1, outputOrdinal: candidate.start + memberIndex + 1, pattern };
        return true;
      });
    });
    if (shifted && !limitativeSource) {
      sentenceOrdinals.push(index + 1);
      shifts.push(found);
    }
  }
  const patternCounts = { limitative_additive: 0, action_comparison: 0, nominal_comparison: 0, recharacterizing_comparison: 0 };
  for (const shift of shifts) patternCounts[shift.pattern] += 1;
  return { detected: sentenceOrdinals.length > 0, count: sentenceOrdinals.length, sentenceOrdinals, patternCounts, shifts };
}

// Attested in the saved corpus: 압도하기보다, 경쟁시키기보다, 능력보다,
// 개념이라기보다. Require the excluded X head and an affirmative Y anchor;
// synonyms, multiple exclusions and idiomatic "다름이 아니라" remain unclassified.
function weakenedComparisonPattern(source, output) {
  const exclusions = [...source.matchAll(/아니라/gu)];
  if (exclusions.length !== 1 || /보다|다름이\s*아니라|다른\s*것이\s*아니라/u.test(source)) return null;
  // A comparison can coexist with an explicit retained exclusion. Scope of a
  // second negation is uncertain without parsing, so prefer a missed detection.
  if (/아닌|아니며|아니고|아니었다|않(?:는|다|았|습)/u.test(output)) return null;
  const at = exclusions[0].index;
  const left = source.slice(0, at).trim()
    .replace(/(?:는|은)\s*(?:것|방식|일)(?:이|가)?$/u, '')
    .replace(/(?:이|가)$/u, '').trim();
  const head = left.match(/[가-힣]+$/u)?.[0];
  if (!head || head.length < 2) return null;
  const modifier = contentTokens(left.slice(0, -head.length)).at(-1);
  const rightTokens = contentTokens(source.slice(at + 3));
  for (const match of output.matchAll(/[가-힣]+보다(?:는)?(?=[\s,.;!?]|$)/gu)) {
    let target = match[0].replace(/보다(?:는)?$/u, '');
    let pattern = 'nominal_comparison';
    if (/(?:이)?라기$/u.test(target)) {
      target = target.replace(/(?:이)?라기$/u, '');
      pattern = 'recharacterizing_comparison';
    } else if (/기$/u.test(target)) {
      target = target.slice(0, -1);
      pattern = 'action_comparison';
    }
    if (target !== head && target !== `${head}하`) continue;
    // Matching just "속도" would conflate "구매 속도" and "판매 속도".
    // Keep the immediately preceding lexical anchor too; uncertain paraphrases
    // of that modifier are deliberately left for the existing model judge.
    if (modifier && contentTokens(output.slice(0, match.index)).at(-1) !== modifier) continue;
    const afterTokens = new Set(contentTokens(output.slice(match.index + match[0].length)));
    if (!rightTokens.some(token => afterTokens.has(token))) continue;
    return pattern;
  }
  return null;
}

// Internal sets contain source sentence keys only for this run. Engine metadata
// exposes numbers, never source text. Ordinals may change after preprocessing.
function createContrastShiftMetrics() {
  const detected = new Set(), retried = new Set(), restored = new Set();
  const patterns = new Map();
  function entries(source, audit) {
    const sentences = splitSentences(String(source || ''));
    const occurrences = new Map();
    const keys = sentences.map(sentence => {
      const text = String(sentence || '').replace(/\s+/gu, ' ').trim();
      const occurrence = (occurrences.get(text) || 0) + 1;
      occurrences.set(text, occurrence);
      return `${text}\u0000${occurrence}`;
    });
    return (audit?.relationShift?.shifts || []).map(shift => ({
      key: keys[shift.sourceOrdinal - 1],
      pattern: shift.pattern
    })).filter(item => item.key);
  }
  function observe(source, audit) {
    for (const {key, pattern} of entries(source, audit)) {
      detected.add(key);
      if (!patterns.has(pattern)) patterns.set(pattern, new Set());
      patterns.get(pattern).add(key);
    }
  }
  function resolved(source, before, after, kind) {
    observe(source, before); observe(source, after);
    const remaining = new Set(entries(source, after).map(item => item.key));
    const target = kind === 'retry' ? retried : restored;
    for (const {key} of entries(source, before)) if (!remaining.has(key)) target.add(key);
  }
  function snapshot() {
    return {
      contrastRelationDetectedSentenceCount: detected.size,
      contrastRelationPatternCounts: Object.fromEntries(['limitative_additive', 'action_comparison',
        'nominal_comparison', 'recharacterizing_comparison'].map(code => [code, patterns.get(code)?.size || 0])),
      contrastRelationRetryResolvedSentenceCount: retried.size,
      contrastRelationSourceRestoreSentenceCount: restored.size
    };
  }
  return { observe, resolved, snapshot };
}

function countFamily(text, family) {
  return (family.patterns || []).reduce((sum, pattern) => sum + countMatches(text, pattern), 0);
}

function familySentenceOrdinals(text, family) {
  const ordinals = [];
  splitSentences(String(text || '')).forEach((sentence, index) => {
    if ((family.patterns || []).some(pattern => countMatches(sentence, pattern) > 0)) ordinals.push(index + 1);
  });
  return ordinals;
}

function introducedFamilySentenceOrdinals(source, output, family, introducedCount) {
  const sourceSentences = splitSentences(String(source || ''))
    .map(value => String(value || '').trim())
    .filter(Boolean);
  const outputSentences = splitSentences(String(output || ''))
    .map(value => String(value || '').trim())
    .filter(Boolean);
  const outputFamilyOrdinals = familySentenceOrdinals(output, family);
  const sourceFamilySentences = sourceSentences
    .map((sentence, index) => ({ sentence, index }))
    .filter(item => (family.patterns || []).some(pattern => countMatches(item.sentence, pattern) > 0));
  const introduced = [];
  for (const ordinal of outputFamilyOrdinals) {
    const outputIndex = ordinal - 1;
    const outputSentence = outputSentences[outputIndex] || '';
    // 1:N 정렬 결과 전체에 같은 계열이 있다는 이유만으로 현재 결과
    // 문장을 carryover로 보지 않는다. 해당 계열이 실제로 있던 개별 원문
    // 문장과 현재 결과 문장의 내용 정렬 점수가 충분할 때만 같은 용례다.
    const carriedFamily = sourceFamilySentences.some(item => {
      const alignment = alignSourceSentence(
        item.sentence,
        item.index,
        sourceSentences.length,
        [outputSentence]
      );
      return Number(alignment?.rawScore ?? alignment?.score ?? 0) >= 0.3;
    });
    if (!carriedFamily) introduced.push(ordinal);
  }
  if (introduced.length >= introducedCount) return introduced.slice(0, introducedCount);
  // 정렬이 불확실해도 복원 대상 번호를 비워 두지는 않는다. 이미 같은
  // 계열로 대응된 문장을 뒤로 미루고, 남은 결과 문장을 필요한 수만큼 채운다.
  for (const ordinal of outputFamilyOrdinals) {
    if (introduced.includes(ordinal)) continue;
    introduced.push(ordinal);
    if (introduced.length >= introducedCount) break;
  }
  return introduced.slice(0, introducedCount);
}

function countMatches(text, pattern) {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  return (String(text || '').match(new RegExp(pattern.source, flags)) || []).length;
}

function matches(pattern, value) {
  if (!(pattern instanceof RegExp)) return false;
  pattern.lastIndex = 0;
  return pattern.test(String(value || ''));
}

function isImproved(before, after) {
  if (!before || !after) return false;
  if (after.violations.length < before.violations.length) return true;
  if (after.excessIntroducedCount < before.excessIntroducedCount) return true;
  if (before.relationShift?.detected === true && after.relationShift?.detected !== true) return true;
  if (Number(after.relationShift?.count || 0) < Number(before.relationShift?.count || 0)) return true;
  return Number(after.semanticRelations?.count || 0) < Number(before.semanticRelations?.count || 0);
}

function restoreUnsafeRelationSentences(source, output, audit) {
  const sourceOrdinals = [];
  const outputOrdinals = [];
  for (const violation of audit?.violations || []) {
    if (!['contrast_relation_shift', 'semantic_relation_shift', 'engine_phrase_fingerprint'].includes(violation.code)) continue;
    const target = violation.code === 'engine_phrase_fingerprint'
      ? outputOrdinals
      : sourceOrdinals;
    target.push(...(violation.sentenceOrdinals || []));
  }
  const restoredOutput = restoreFingerprintOutputSentences(
    source,
    output,
    outputOrdinals,
    {
      maxRestoreCount: 8,
      minSimilarity: 0.24,
      ordinalSpace: 'output'
    }
  );
  // output ordinal은 감사 당시 결과 문장 번호다. source 기반 복원을 먼저
  // 수행해 1:N 문장이 합쳐지면 뒤 output 번호가 밀릴 수 있으므로 반드시
  // 원래 결과 번호 기반 복원을 먼저 끝낸다. source ordinal은 이후에도
  // 공통 정렬기로 현재 결과에 다시 대응시킬 수 있다.
  // 의미 관계 감사의 번호는 source ordinal이다. 같은 주제의 인접 결과
  // 문장이 많으면 공통 정렬기가 1:N 묶음을 더 높은 점수로 고를 수 있고,
  // 문단 경계를 건넌 묶음은 안전 복원기에서 거절된다. 먼저 1:1 문장을
  // 복원해 주변의 정상 휴머나이징을 지키고, 실제 문장 분할 사례만 1:N으로
  // 한 번 더 시도한다.
  const restoredSourceSingle = restoreSourceSentenceOrdinals(
    source,
    restoredOutput.text,
    sourceOrdinals,
    {
      maxRestoreCount: Math.max(0, 8 - restoredOutput.restoredSentenceCount),
      minSimilarity: 0.24,
      ordinalSpace: 'source',
      maxOutputGroup: 1
    }
  );
  const restoredSourceOrdinalSet = new Set(restoredSourceSingle.restoredSentenceOrdinals || []);
  const remainingSourceOrdinals = sourceOrdinals.filter(ordinal => !restoredSourceOrdinalSet.has(ordinal));
  const restoredSourceGrouped = restoreSourceSentenceOrdinals(
    source,
    restoredSourceSingle.text,
    remainingSourceOrdinals,
    {
      maxRestoreCount: Math.max(
        0,
        8 - restoredOutput.restoredSentenceCount - restoredSourceSingle.restoredSentenceCount
      ),
      minSimilarity: 0.24,
      ordinalSpace: 'source',
      maxOutputGroup: 3
    }
  );
  const sourceApplied = restoredSourceSingle.applied || restoredSourceGrouped.applied;
  return {
    ...restoredSourceGrouped,
    text: restoredSourceGrouped.text,
    applied: sourceApplied || restoredOutput.applied,
    restoredSentenceCount:
      restoredSourceSingle.restoredSentenceCount
      + restoredSourceGrouped.restoredSentenceCount
      + restoredOutput.restoredSentenceCount,
    restoredSentenceOrdinals: [
      ...(restoredOutput.restoredSentenceOrdinals || []),
      ...(restoredSourceSingle.restoredSentenceOrdinals || []),
      ...(restoredSourceGrouped.restoredSentenceOrdinals || [])
    ],
    restoredSourceSentenceOrdinals: [
      ...(restoredOutput.restoredSourceSentenceOrdinals || []),
      ...(restoredSourceSingle.restoredSourceSentenceOrdinals || []),
      ...(restoredSourceGrouped.restoredSourceSentenceOrdinals || [])
    ],
    rejectedOutputSentenceOrdinals: restoredOutput.rejectedOutputSentenceOrdinals || [],
    reason: sourceApplied || restoredOutput.applied
      ? 'restored'
      : (sourceOrdinals.length ? restoredSourceGrouped.reason : restoredOutput.reason)
  };
}

function restoreFingerprintOutputSentences(source, output, ordinals, options) {
  let remaining = [...new Set(ordinals)], restored;
  const rejected = new Set(), owners = new Map();
  const sources = splitSentences(String(source || ''));
  const outputs = splitSentences(String(output || ''));
  // A group can have a high score because of the NEXT output sentence, even
  // though the fingerprint belongs to this one. Require independent ownership
  // of the actual flagged member before accepting the existing restorer's edit.
  for (let round = 0; round <= ordinals.length; round++) {
    restored = restoreSourceSentenceOrdinals(source, output, remaining, options);
    const invalid = [];
    for (let i = 0; i < restored.restoredSentenceOrdinals.length; i++) {
      const ordinal = restored.restoredSentenceOrdinals[i];
      if (!owners.has(ordinal)) {
        const candidates = alignedOutputCandidates(outputs[ordinal - 1], ordinal - 1, outputs.length,
          sources, {window: sources.length, maxOutputGroup: 1}).sort((a,b) => b.rawScore - a.rawScore);
        const best = candidates[0];
        owners.set(ordinal, best && (!candidates[1] || best.rawScore > candidates[1].rawScore + 0.02)
          ? best.start + 1 : null);
      }
      if (owners.get(ordinal) !== restored.restoredSourceSentenceOrdinals?.[i]) invalid.push(ordinal);
    }
    if (!invalid.length) break;
    for (const ordinal of invalid) rejected.add(ordinal);
    remaining = remaining.filter(ordinal => !rejected.has(ordinal));
  }
  return {...restored, rejectedOutputSentenceOrdinals: [...rejected],
    reason: !restored.applied && rejected.size ? 'ambiguous_fingerprint_source_owner' : restored.reason};
}

// One unsafe style restoration must not veto a separate, well-grounded meaning
// repair. Re-audit after every accepted edit: source/output ordinals can shift.
// The caller retains all quote, structure and candidate integrity gates.
function restoreValidatedRelationSentences(source, output, profile, validate) {
  let text = String(output || ''), restoredSentenceCount = 0;
  const rejected = new Set();
  for (let round = 0; round < 8; round++) {
    const before = auditFingerprint(source, text, profile);
    let accepted = false;
    for (const violation of before.violations || []) {
      for (const ordinal of violation.sentenceOrdinals || []) {
        const key = JSON.stringify([text, violation.code, violation.family, ordinal]);
        if (rejected.has(key)) continue;
        const restored = restoreUnsafeRelationSentences(source, text, {
          violations: [{ ...violation, sentenceOrdinals: [ordinal] }]
        });
        if (restored.applied && isImproved(before, auditFingerprint(source, restored.text, profile))
            && validate(text, restored.text) === true) {
          text = restored.text;
          restoredSentenceCount += restored.restoredSentenceCount;
          accepted = true;
          break;
        }
        rejected.add(key);
      }
      if (accepted) break;
    }
    if (!accepted) break;
  }
  return { text, applied: text !== output, restoredSentenceCount };
}

function conceptNarrowedByActionModifier(source, output) {
  const before = String(source || '');
  const after = String(output || '');
  const concepts = [...before.matchAll(/([가-힣A-Za-z][가-힣A-Za-z0-9· -]{0,24}?)의\s*중요성/gu)]
    .map(match => String(match[1] || '').trim())
    .filter(value => value.length >= 1);
  return concepts.some(concept => {
    const escaped = concept.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const narrowed = new RegExp(`${escaped}(?:을|를)?\\s*(?:두기|하기|지키기|유지하기|실천하기)의\\s*중요성`, 'u');
    return narrowed.test(after) && !narrowed.test(before);
  });
}

function explicitSpeakerEvidenceRemoved(source, output) {
  const before = String(source || '');
  const after = String(output || '');
  const explicitSpeaker = /(?:^|[^가-힣A-Za-z0-9_])(?:저는|제가|나는|내가)(?=$|[^가-힣A-Za-z0-9_])/u.test(before);
  if (!explicitSpeaker) return false;
  const experientialAction = /(?:수행|담당|참여|경험|배웠|익혔|깨달|느꼈|알게\s*되|확인할\s*수\s*있었|생각했|판단했|노력했|해결했|개선했)/u.test(before);
  if (!experientialAction) return false;
  return !/(?:^|[^가-힣A-Za-z0-9_])(?:저는|제가|나는|내가)(?=$|[^가-힣A-Za-z0-9_])/u.test(after);
}

module.exports = {
  VERSION,
  GUARDED_FAMILIES,
  SHADOW_PATTERNS,
  LEXICAL_TRANSITIONS,
  isEnabled,
  auditFingerprint,
  detectContrastRelationShift,
  createContrastShiftMetrics,
  detectSemanticRelationShifts,
  guardedFamilyAllowance,
  restoreUnsafeRelationSentences,
  restoreValidatedRelationSentences,
  isImproved
};
