(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GPDetectInterpretation = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  // Shared verbatim with the browser. This is interpretation, never rescoring.
  const VERSION = 'detect-interpretation-v1';
  const SUB_BANDS = Object.freeze([
    { key: 'minimal', min: 0, max: 10, band: 'low', label: '낮은 구간 · 0~10점' },
    { key: 'low', min: 11, max: 20, band: 'low', label: '낮은 구간 · 11~20점' },
    { key: 'noticeable', min: 21, max: 34, band: 'moderate', label: '중간 구간 · 21~34점' },
    { key: 'mixed', min: 35, max: 49, band: 'moderate', label: '중간 구간 · 35~49점' },
    { key: 'repeated', min: 50, max: 69, band: 'high', label: '높은 구간 · 50~69점' },
    { key: 'pronounced', min: 70, max: 100, band: 'high', label: '높은 구간 · 70~100점' }
  ].map(Object.freeze));
  const PATTERNS = Object.freeze({
    sentence_uniformity: ['문장 호흡', '비슷한 길이와 문장 골격', '같은 길이의 문장이 이어지는 부분에서 핵심 문장과 설명 문장의 호흡을 구분해 보세요.'],
    ending_repetition: ['종결 표현', '반복되는 문장 끝 표현', '표시된 문장 끝을 비교하고, 내용에 맞는 문장만 연결하거나 나누어 보세요.'],
    formulaic_transition: ['연결과 결론', '정형적인 연결·마무리 표현', '접속어나 마지막 요약이 앞 내용을 되풀이하는지 확인하고, 필요한 연결만 남겨 보세요.'],
    generic_abstraction: ['일반적인 설명', '주제에 폭넓게 쓰이는 일반론', '일반적인 설명이 글의 주장에 꼭 필요한지 확인하고, 원문에 있는 사례와 연결해 보세요.'],
    insufficient_grounding: ['주장과 근거', '주장을 뒷받침하는 설명이 적은 부분', '근거가 필요한 주장에 이미 확인한 자료나 원문 속 사례를 연결해 보세요. 없는 경험은 추가하지 마세요.'],
    overstructured_progression: ['전개 방식', '반복되는 설명 순서', '목차 형식은 유지하고, 각 절이 같은 설명 순서를 불필요하게 되풀이하는지 확인해 보세요.'],
    voice_instability: ['화자와 시점', '화자·시점이 흔들리는 부분', '누가 말하는지와 시제가 바뀌는 위치를 확인하고, 의도한 관점을 유지해 보세요.'],
    unsupported_assertion: ['단정의 강도', '근거보다 강한 단정 표현', '주장의 강도가 실제 근거와 맞는지 확인하고, 단정 범위와 출처를 함께 점검해 보세요.'],
    lexical_template: ['어휘 조합', '상투적으로 이어지는 표현', '표시된 어휘 조합이 이 글의 뜻을 구체적으로 전달하는지 확인해 보세요.'],
    other_observed_style: ['문체 특징', '일부 문체 특징', '표시된 문장을 앞뒤 맥락과 함께 읽고, 의도한 표현인지 확인해 보세요.']
  });
  const LIMITATION = '문체 신호를 설명하는 참고 결과예요. 작성 주체나 외부 검사 결과를 확정하지 않아요.';
  function normalizeScore(value) {
    if (!['number', 'string'].includes(typeof value) || (typeof value === 'string' && !value.trim())) return null;
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null;
  }
  function count(value) {
    if (!['number', 'string'].includes(typeof value) || (typeof value === 'string' && !value.trim())) return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  }
  function groundedPatterns(evidence, characters, sentences) {
    const byCategory = new Map();
    for (const item of Array.isArray(evidence) ? evidence : []) {
      if (!item || !Object.hasOwn(PATTERNS, item.category) || item.locationStatus !== 'source_range_verified') continue;
      const seen = new Set();
      const paragraphs = new Set();
      for (const loc of Array.isArray(item.locations) ? item.locations : []) {
        if (![loc?.sentenceIndex, loc?.start, loc?.end].every(Number.isSafeInteger)
          || loc.sentenceIndex < 0 || loc.start < 0 || loc.end <= loc.start
          || (characters !== null && loc.end > characters)
          || (sentences !== null && loc.sentenceIndex >= sentences)) continue;
        seen.add(loc.sentenceIndex);
        if (Number.isSafeInteger(loc.paragraphIndex) && loc.paragraphIndex >= 0
          && loc.paragraphIndex < (characters === null ? 10000 : characters)) paragraphs.add(loc.paragraphIndex);
      }
      if (!seen.size) continue;
      const strength = { weak: 1, moderate: 2, strong: 3 }[item.strength] || 0;
      const pattern = { category: item.category, label: PATTERNS[item.category][0],
        description: PATTERNS[item.category][1], locationCount: seen.size,
        scope: seen.size >= 2 ? 'recurring' : 'isolated', strength,
        paragraphIndices: [...paragraphs].sort((a, b) => a - b) };
      const prior = byCategory.get(item.category);
      if (!prior || pattern.locationCount > prior.locationCount || (pattern.locationCount === prior.locationCount && strength > prior.strength)) byCategory.set(item.category, pattern);
    }
    return [...byCategory.values()].sort((a, b) => b.locationCount - a.locationCount || b.strength - a.strength || (a.category < b.category ? -1 : a.category > b.category ? 1 : 0));
  }
  function buildDetectInterpretation(input = {}) {
    const score = normalizeScore(input.probability);
    const sub = score === null ? null : SUB_BANDS.find(row => score <= row.max);
    const characters = count(input.textLength), sentences = count(input.sentenceTotal);
    const short = (characters !== null && characters < 300) || (sentences !== null && sentences < 3);
    const small = short || (characters !== null && characters < 500) || (sentences !== null && sentences < 5);
    const unavailable = score === null || input.probSource !== 'llm';
    const patterns = groundedPatterns(input.signalEvidence, characters, sentences);
    const pattern = patterns[0] || null;
    const requiredLocated = score >= 75 ? 3 : score >= 50 ? 2 : score >= 21 ? 1 : 0;
    const partial = input.causeCoverageStatus === 'partial'
      || patterns.length < requiredLocated;
    const evidenceLimited = unavailable || short || input.confidence === 'low';
    const sufficient = !evidenceLimited && !small && !partial
      && characters !== null && sentences !== null
      && input.confidence === 'high' && input.causeCoverageStatus === 'aligned';
    const level = evidenceLimited ? 'limited' : sufficient ? 'sufficient' : 'some';
    const reason = unavailable ? '완료된 모델 점수나 분석 자료를 확인할 수 없어요.'
      : short ? '글이나 문장 수가 적어 문체의 반복 여부를 넓게 비교하기 어려워요.'
      : input.confidence === 'low' ? '이번 분석에서 문체를 설명할 근거가 제한적이에요.'
      : partial ? '표시 점수와 확인된 문체 근거를 충분히 연결하지 못했어요.'
      : small ? '비교할 문장이 적어 일부 표현의 영향이 클 수 있어요.'
      : sufficient ? '분석 분량과 점수에 연결되는 설명이 확보됐어요. 작성자 판정의 확률을 뜻하지 않아요.'
      : '확인된 문체 특징을 참고할 수 있지만 분석 범위나 근거에는 한계가 있어요.';
    const evidence = { level, label: { limited: '분석 근거 제한', some: '분석 근거 일부', sufficient: '분석 근거 충분' }[level], reason };
    let headline, description, nextSteps;
    if (unavailable) {
      headline = '분석 결과를 확인할 수 없어요';
      description = '점수가 없는 상태를 낮은 신호로 해석하지 않아요. 원문과 결과 상태를 먼저 확인해 주세요.';
      nextSteps = ['저장된 결과를 다시 열거나, 입력 상태를 확인한 뒤 분석해 주세요.'];
    } else if (short) {
      headline = '짧은 글이라 해석 범위가 좁아요';
      description = `AI 티 지수는 ${score}/100이에요. 한두 문장의 특징이 전체 점수에 크게 반영될 수 있어요.`;
      nextSteps = ['관련된 앞뒤 문단이 있다면 함께 확인해 주세요. 분량을 채우기 위한 문장은 덧붙이지 않아도 돼요.'];
    } else if (partial || input.confidence === 'low') {
      headline = '점수와 함께 근거의 범위를 확인해 주세요';
      description = pattern ? `${pattern.label}에서 확인한 문체 특징은 있지만, 이것만으로 전체 점수를 설명하기에는 한계가 있어요.` : '점수는 나왔지만 원문 위치와 연결해 설명할 수 있는 근거가 충분하지 않아요.';
      nextSteps = ['점수만 보고 글 전체를 고치기보다 확인된 문장과 앞뒤 맥락부터 살펴보세요.'];
    } else if (pattern) {
      const where = pattern.locationCount === 1 ? '한 문장' : `${pattern.locationCount}개 문장`;
      headline = sub.band === 'low' ? `전체 신호는 낮고, ${pattern.label}을 살펴볼 수 있어요` : `${pattern.label}부터 살펴보세요`;
      description = `${where}에서 ${pattern.description}이 관찰됐어요. 이 특징이 글의 목적과 맥락에 맞는지 함께 확인해 보세요.`;
      if (pattern.paragraphIndices.length) description += ` 확인 위치: ${pattern.paragraphIndices.slice(0, 3).map(n => n + 1).join('·')}번 문단${pattern.paragraphIndices.length > 3 ? ' 등' : ''}.`;
      nextSteps = [PATTERNS[pattern.category][2]];
    } else if (sub.band === 'low') {
      headline = sub.key === 'minimal' ? '이번 분석의 문체 신호가 매우 낮아요' : '전반적인 문체 신호가 낮아요';
      description = '위치까지 연결된 뚜렷한 문체 신호는 확인되지 않았어요. 사람 작성 여부나 글의 사실성을 증명하는 결과는 아니에요.';
      nextSteps = ['표현을 일괄 바꾸기보다 논리의 연결과 사실·인용의 정확성을 먼저 확인해 주세요.'];
    } else {
      headline = '점수에 연결된 문장 근거를 먼저 확인해 주세요';
      description = `문체 신호는 ${sub.band === 'high' ? '높은' : '중간'} 구간이지만, 원문 위치까지 확인한 설명은 제한적이에요.`;
      nextSteps = ['근거 위치가 없는 항목만으로 글 전체를 수정하지 말고 원문의 맥락을 함께 확인해 주세요.'];
    }
    const limitations = [LIMITATION];
    if (small && !short) limitations.push('비교할 문장이 적어 결과 해석에 주의가 필요해요.');
    if (!pattern && !unavailable) limitations.push('확인된 위치가 없는 특징은 구체적인 수정 대상으로 제시하지 않았어요.');
    return {
      version: VERSION, score, status: unavailable ? 'unavailable' : evidenceLimited ? 'limited' : partial ? 'partial' : 'ready',
      band: sub?.band || 'unknown', subBand: sub ? { ...sub } : null,
      label: sub?.label || '점수 확인 필요', headline, description, evidence,
      pattern: pattern ? { category: pattern.category, label: pattern.label, description: pattern.description, locationCount: pattern.locationCount, scope: pattern.scope, paragraphIndices: pattern.paragraphIndices } : null,
      nextSteps, limitations, sample: { characters, sentences }
    };
  }
  return { VERSION, SUB_BANDS, normalizeScore, buildDetectInterpretation };
});
