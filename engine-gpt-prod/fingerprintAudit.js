'use strict';

const { splitSentences } = require('../engine/koreanText');
const { isV248FeatureEnabled } = require('../lib/humanizeV248Flags');
const { restoreSourceSentenceOrdinals } = require('./sourceSentenceRestore');
const {
  alignSourceSentence,
  alignedOutputCandidates,
  contentTokens
} = require('./sentenceAlignment');

const VERSION = 13;
const GUARDED_FAMILIES = Object.freeze([
  {
    code: 'limitative_additive',
    patterns: [
      /(?:데서|데에|것에|선에)\s*(?:그치지|멈추지)\s*않고/gu,
      /에\s*머무르지\s*않고/gu
    ]
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
  { code: 'contribution_cliche', pattern: /보탬이\s+되(?:고자|도록|겠습니다|었다|었|는|길)/gu }
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
  const families = GUARDED_FAMILIES.map(family => {
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
  const sourceSentences = splitSentences(String(source || '')).map(value => String(value || '').trim()).filter(Boolean);
  const outputSentences = splitSentences(String(output || '')).map(value => String(value || '').trim()).filter(Boolean);
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
    const alignedText = alignment.text;
    for (const rule of SEMANTIC_RELATION_RULES) {
      if (!matches(rule.source, sourceSentence)) continue;
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
      const hedgeRemoved = !hasEpistemicHedge(alignedText);
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
  return /(?:것\s*같(?:다|습니다|았다|았다)|듯(?:하|싶)|것으로\s*보(?:인|인다|입니다)|수도\s*있|지도\s*모르|어쩌면|아마(?:도)?|확실하지\s*않)/u
    .test(String(value || ''));
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

function detectContrastRelationShift(source, output) {
  const sourceSentences = splitSentences(String(source || '')).map(value => String(value || '').trim()).filter(Boolean);
  const outputSentences = splitSentences(String(output || '')).map(value => String(value || '').trim()).filter(Boolean);
  const sentenceOrdinals = [];
  for (let index = 0; index < sourceSentences.length; index += 1) {
    const sourceSentence = sourceSentences[index];
    if (!/(?:아니라|아닌\s+것이(?:라|고)|아님을)/u.test(sourceSentence)) continue;
    // `단순히/단지 X가 아니라 Y`는 X를 완전히 부정하기보다 X만으로 범위를
    // 한정하지 않는 관계다. 이 경우 `X에 머무르지 않고 Y`는 같은 제한적
    // 기능을 유지하므로 부정→가산 반전으로 보지 않는다. `단순한 X가 아니라`는
    // 명사구 대조이므로 이 예외에 포함하지 않는다.
    const limitativeSource = /(?:단순히|단지|그저|오직)[^.!?。！？\n]{0,55}(?:아니라|아닌\s+것이(?:라|고))/u
      .test(sourceSentence);
    const candidates = alignedOutputCandidates(
      sourceSentence,
      index,
      sourceSentences.length,
      outputSentences
    ).filter(item => item.score >= 0.24).slice(0, 4);
    const sourceTokens = contentTokens(sourceSentence);
    const shifted = candidates.some(candidate => {
      if (!/(?:데서\s*(?:그치지|멈추지)\s*않고|에\s*머무르지\s*않고)/u.test(candidate.text)) return false;
      if (/(?:아니라|아닌\s+것이(?:라|고)|아님을)/u.test(candidate.text)) return false;
      const candidateTokens = new Set(contentTokens(candidate.text));
      const shared = sourceTokens.filter(token => candidateTokens.has(token)).length;
      return sourceTokens.length >= 2 && shared / sourceTokens.length >= 0.35;
    });
    if (shifted && !limitativeSource) sentenceOrdinals.push(index + 1);
  }
  return { detected: sentenceOrdinals.length > 0, count: sentenceOrdinals.length, sentenceOrdinals };
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
  const restoredOutput = restoreSourceSentenceOrdinals(
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
    reason: sourceApplied || restoredOutput.applied
      ? 'restored'
      : (restoredSourceGrouped.reason || restoredSourceSingle.reason || restoredOutput.reason)
  };
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
  detectSemanticRelationShifts,
  guardedFamilyAllowance,
  restoreUnsafeRelationSentences,
  isImproved
};
