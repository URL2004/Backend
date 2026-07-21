'use strict';

const baseChunk = require('../engine/chunk');
const freezeBlocks = require('../engine/freezeblocks');
const { splitSentenceSpans, splitSentences } = require('../engine/koreanText');
const { paragraphExpansionLimit } = require('./voiceProfile');
const layoutStructure = require('./layoutStructure');

const VERSION = 'gpt-structure-chunk-v2';
const UNSAFE_END_RE = /(?:보다|및|과|와|의|을|를|은|는|이|가|에|에서|으로|로|부터|까지|처럼|대한|관한|그리고|그러나|하지만|또한|따라서|때문에|위해|통해|하며|하고)$/;

function splitChunksForGpt(text, {
  coalesceEditable = false,
  preserveSentenceBoundaries = false,
  sentenceBoundaryMinimum = 4,
  preserveLineBoundaries = false,
  formatProfile = null
} = {}) {
  const base = baseChunk.splitChunks(text);
  const academicSpans = freezeBlocks.detectAcademicSpans(text);
  const chunks = [];
  const state = {
    currentSection: '',
    lastPiece: null,
    academicSpans,
    sourceLineRoles: buildSourceLineRoleMap(text),
    questionnaire: formatProfile?.primary === 'questionnaire'
      || formatProfile?.flags?.includes?.('questionnaire') === true
  };

  for (const chunk of base) {
    const expanded = expandBaseChunk(chunk, state);
    if (!expanded.length) {
      chunks.push(chunk);
      continue;
    }
    chunks.push(...expanded);
  }

  const plannedChunks = coalesceEditable ? coalesceEditableChunks(chunks) : chunks;
  const lineBoundaryPolicy = preserveLineBoundaries === true
    ? 'all'
    : String(preserveLineBoundaries || 'none');
  if (lineBoundaryPolicy !== 'none') addLineBoundaryMarkers(plannedChunks, lineBoundaryPolicy);
  if (preserveSentenceBoundaries) addSentenceBoundaryMarkers(plannedChunks, sentenceBoundaryMinimum);
  reindexChunks(plannedChunks);
  return {
    version: VERSION,
    chunks: plannedChunks,
    audit: buildPlanAudit(plannedChunks)
  };
}

function mergeChunks(chunks) {
  return baseChunk.mergeChunks(chunks);
}

function expandBaseChunk(chunk, state) {
  const pieces = splitLinePieces(chunk.text, chunk.start || 0);
  if (!pieces.length) return [];

  const groups = [];
  let current = null;

  for (const sourcePiece of pieces) {
    const expandedPieces = state.questionnaire && isQuestionnaireQuestionLine(String(sourcePiece.text || '').trim())
      ? [sourcePiece]
      : splitEditablePrefixPiece(sourcePiece);
    for (const piece of expandedPieces) {
      const info = classifyPiece(piece, state);
      const key = info.locked ? `locked:${info.lockType}` : 'body';
      if (!current || current.key !== key) {
        flushGroup(groups, current);
        current = {
          key,
          locked: info.locked,
          lockType: info.lockType,
          sectionPath: info.sectionLabel || state.currentSection || '',
          pieces: []
        };
      }
      current.pieces.push(piece);
      if (info.sectionLabel) state.currentSection = info.sectionLabel;
      state.lastPiece = {
        text: String(piece.text || '').trim(),
        locked: info.locked,
        lockType: info.lockType || '',
        sectionLabel: info.sectionLabel || state.currentSection || ''
      };
    }
  }
  flushGroup(groups, current);

  if (!groups.length) return [];
  if (chunk._lead) groups[0]._lead = (groups[0]._lead || '') + chunk._lead;
  groups[groups.length - 1].sep = (groups[groups.length - 1].sep || '') + (chunk.sep || '');
  return groups;
}

function splitLinePieces(text, offset = 0) {
  const source = String(text || '');
  if (!source) return [];
  const out = [];
  let pos = 0;
  while (pos < source.length) {
    const nl = source.indexOf('\n', pos);
    if (nl === -1) {
      out.push({ text: source.slice(pos), sep: '', start: offset + pos, end: offset + source.length });
      break;
    }
    let nlEnd = nl;
    while (nlEnd < source.length && source.charAt(nlEnd) === '\n') nlEnd += 1;
    out.push({ text: source.slice(pos, nl), sep: source.slice(nl, nlEnd), start: offset + pos, end: offset + nl });
    pos = nlEnd;
  }
  return out;
}

function buildSourceLineRoleMap(text) {
  const map = new Map();
  for (const record of layoutStructure.buildLineRecords(text)) {
    if (record.blank) continue;
    map.set(`@${record.start}:${record.end}`, [record.role]);
    const key = String(record.text || '');
    const roles = map.get(key) || [];
    roles.push(record.role);
    map.set(key, roles);
  }
  return map;
}

function sourceLineRole(map, value, start, end) {
  const positional = map instanceof Map ? map.get(`@${start}:${end}`) : null;
  const roles = positional || (map instanceof Map ? map.get(layoutStructure.visibleTrim(value)) : null);
  if (!Array.isArray(roles)) return '';
  if (roles.includes('title')) return 'title';
  if (roles.includes('label')) return 'label';
  return roles[0] || '';
}

function classifyPiece(piece, state) {
  const raw = String(piece?.text || '');
  const s = raw.trim();
  if (!s) return { locked: false, lockType: 'blank' };

  // 목차·참고문헌은 문서 전체 보존 계약이 접두부 편집 규칙보다 우선한다.
  // 그렇지 않으면 참고문헌 안의 `저자: 서명` 같은 행이 label body로 풀려
  // 원문 그대로 보존해야 할 블록 일부가 모델 호출에 들어갈 수 있다.
  const frozen = freezeBlocks.academicSpanAt(state.academicSpans, piece.start, piece.end);
  if (frozen) return { locked: true, lockType: frozen.type === 'toc' ? 'toc_item' : 'reference_item', sectionLabel: frozen.type === 'toc' ? '목차' : '참고문헌' };

  if (piece?.forceLockType) return {
    locked: true,
    lockType: piece.forceLockType,
    sectionLabel: piece.forceSectionLabel || state.currentSection
  };
  if (piece?.forceEditable) return { locked: false, lockType: '', sectionLabel: state.currentSection };

  const sourceRole = sourceLineRole(state.sourceLineRoles, s, piece.start, piece.end);
  if (sourceRole === 'title') return { locked: true, lockType: 'title', sectionLabel: s };
  if (sourceRole === 'label') return { locked: true, lockType: 'label', sectionLabel: state.currentSection };
  if (sourceRole === 'code') return { locked: true, lockType: 'code', sectionLabel: state.currentSection };
  if (sourceRole === 'table') return { locked: true, lockType: 'table', sectionLabel: state.currentSection };
  if (sourceRole === 'signature') return { locked: true, lockType: 'signature', sectionLabel: state.currentSection };
  if (sourceRole === 'quote' && isStandaloneQuotedTitle(s)) {
    return { locked: true, lockType: 'title', sectionLabel: s };
  }
  if (sourceRole === 'quote') return { locked: true, lockType: 'quote', sectionLabel: state.currentSection };
  if (sourceRole === 'legal_clause') return { locked: true, lockType: 'legal_clause', sectionLabel: s };
  if (isStandaloneQuotedTitle(s)) return { locked: true, lockType: 'title', sectionLabel: s };

  // 문답형 문서는 질문/번호를 편집 대상에서 제외하고, 질문 사이의 답변만
  // 독립 청크로 보낸다. 이 경계 때문에 서로 다른 답변의 문장이 이동할 수 없다.
  if (state.questionnaire && isQuestionnaireQuestionLine(s)) {
    return { locked: true, lockType: 'questionnaire_question', sectionLabel: s };
  }
  if (isHeadingLine(s)) {
    return { locked: true, lockType: 'heading', sectionLabel: s };
  }
  if (isHeadingContinuationLine(s, state.lastPiece)) {
    const sectionLabel = [state.currentSection, s].filter(Boolean).join(' ').trim() || s;
    return { locked: true, lockType: 'heading_continuation', sectionLabel };
  }
  if (isHypothesisLine(s)) return { locked: true, lockType: 'hypothesis', sectionLabel: state.currentSection };
  if (isTableLine(s)) return { locked: true, lockType: 'table', sectionLabel: state.currentSection };
  if (isStatLine(s)) return { locked: true, lockType: 'stat_line', sectionLabel: state.currentSection };
  return { locked: false, lockType: '', sectionLabel: state.currentSection };
}

function flushGroup(groups, group) {
  if (!group || !group.pieces.length) return;
  const pieces = group.pieces;
  const last = pieces[pieces.length - 1];
  let text = '';
  for (let i = 0; i < pieces.length; i += 1) {
    text += pieces[i].text;
    if (i < pieces.length - 1) text += pieces[i].sep || '';
  }
  const chunk = {
    start: pieces[0].start,
    end: last.end,
    sep: last.sep || '',
    text,
    outputText: null
  };
  if (group.locked) {
    chunk.locked = true;
    chunk.lockType = group.lockType || 'structure';
    chunk.skipReason = `structure_lock:${chunk.lockType}`;
  } else if (group.sectionPath) {
    chunk.sectionPath = group.sectionPath;
  }
  groups.push(chunk);
}

function reindexChunks(chunks) {
  const n = chunks.length;
  chunks.forEach((chunk, i) => {
    chunk.index = i;
    chunk.position = n === 1 ? 'single' : (i === 0 ? 'intro' : (i === n - 1 ? 'conclusion' : 'body'));
  });
}

function coalesceEditableChunks(chunks, targetChars = 1600, hardMaxChars = 2500) {
  const out = [];
  let current = null;
  const flush = () => {
    if (current) out.push(current);
    current = null;
  };
  for (const sourceChunk of chunks || []) {
    const chunk = { ...sourceChunk };
    if (chunk.locked) {
      flush();
      out.push(chunk);
      continue;
    }
    if (!current) {
      current = chunk;
      continue;
    }
    const sameSection = String(current.sectionPath || '') === String(chunk.sectionPath || '');
    const boundary = `${current.sep || ''}${chunk._lead || ''}`;
    const joinText = `${current.text || ''}${boundary}${chunk.text || ''}`;
    if (sameSection && current.text.length < targetChars && joinText.length <= hardMaxChars) {
      const existingMarkers = Array.isArray(current.boundaryMarkers) ? current.boundaryMarkers : [];
      const marker = `[[[V2_BOUNDARY_${String(existingMarkers.length + 1).padStart(3, '0')}]]]`;
      const start = String(current.text || '').length;
      current.llmText = `${current.llmText || current.text || ''}${marker}${chunk.llmText || chunk.text || ''}`;
      current.boundaryMarkers = [...existingMarkers, { marker, boundary, start, end: start + boundary.length }];
      current.text = joinText;
      current.end = chunk.end;
      current.sep = chunk.sep || '';
      current.outputText = null;
      continue;
    }
    flush();
    current = chunk;
  }
  flush();
  return out;
}

function restoreBoundaryMarkers(outputText, chunk) {
  const markers = [
    ...(Array.isArray(chunk?.boundaryMarkers) ? chunk.boundaryMarkers : []),
    ...(Array.isArray(chunk?.lineBoundaryMarkers) ? chunk.lineBoundaryMarkers : []),
    ...(Array.isArray(chunk?.sentenceBoundaryMarkers) ? chunk.sentenceBoundaryMarkers : [])
  ];
  if (!markers.length) return { text: String(outputText || ''), ok: true, applied: false, missing: [], duplicated: [] };
  let text = String(outputText || '');
  const missing = [];
  const duplicated = [];
  for (const item of markers) {
    const count = text.split(item.marker).length - 1;
    if (count === 0) missing.push(item.marker);
    if (count > 1) duplicated.push(item.marker);
    if (count === 1) text = text.replace(item.marker, item.boundary);
  }
  const leaked = /\[\[\[V2_(?:BOUNDARY|LINE|SENTENCE)_\d{3,4}\]\]\]/.test(text);
  const sentenceLocked = Array.isArray(chunk?.sentenceBoundaryMarkers) && chunk.sentenceBoundaryMarkers.length > 0;
  const lineLocked = Array.isArray(chunk?.lineBoundaryMarkers) && chunk.lineBoundaryMarkers.length > 0;
  const exactLineLocked = lineLocked && String(chunk?.lineBoundaryPolicy || 'all') === 'all';
  const expectedSentenceCount = sentenceLocked ? splitSentenceSpans(String(chunk?.text || '')).length : null;
  const actualSentenceCount = sentenceLocked ? splitSentenceSpans(text).length : null;
  const expectedLineCount = lineLocked ? countLines(String(chunk?.text || '')) : null;
  const actualLineCount = lineLocked ? countLines(text) : null;
  const segmentationChanged = (sentenceLocked && expectedSentenceCount !== actualSentenceCount)
    || (exactLineLocked && expectedLineCount !== actualLineCount);
  return {
    text,
    ok: missing.length === 0 && duplicated.length === 0 && !leaked && !segmentationChanged,
    applied: true,
    missing,
    duplicated,
    leaked,
    segmentationChanged,
    expectedSentenceCount,
    actualSentenceCount,
    expectedLineCount,
    actualLineCount
  };
}

// 의미 감사 이후에는 어휘를 다시 바꾸지 않는다. 이 단계는 동결 제목을
// 독립 행으로 되돌리고, 구조가 잠기지 않은 일반 산문의 문단 경계만 조정한다.
function restorePostSemanticLayout({ source, outputText, chunks, mode = '', requestStrength = '', documentProfile = '', profileConfidence = 0 } = {}) {
  const heading = restoreLockedHeadingLayout(source, outputText, chunks);
  const paragraphs = restoreParagraphLayout({
    source,
    outputText: heading.text,
    chunks,
    mode,
    requestStrength,
    documentProfile,
    profileConfidence
  });
  return {
    text: paragraphs.text,
    applied: heading.applied || paragraphs.applied,
    heading,
    paragraphs,
    pass: heading.missingCount === 0 && paragraphs.pass
  };
}

function restoreLockedHeadingLayout(source, outputText, chunks) {
  const headings = (chunks || [])
    .filter(chunk => chunk?.locked
      && ['heading', 'heading_continuation', 'title', 'label'].includes(String(chunk.lockType || ''))
      && String(chunk.text || '').trim())
    .map(chunk => String(chunk.text).trim());
  let text = normalizeNewlines(outputText);
  const sourceText = normalizeNewlines(source);
  let sourceCursor = 0;
  let outputCursor = 0;
  let restoredCount = 0;
  let missingCount = 0;
  for (const heading of headings) {
    const sourceIndex = sourceText.indexOf(heading, sourceCursor);
    const outputIndex = text.indexOf(heading, outputCursor);
    if (outputIndex < 0) {
      missingCount += 1;
      continue;
    }
    const hasSourceBefore = sourceIndex > 0 && sourceText.slice(0, sourceIndex).trim().length > 0;
    const hasSourceAfter = sourceIndex >= 0
      && sourceText.slice(sourceIndex + heading.length).trim().length > 0;
    let left = outputIndex;
    let right = outputIndex + heading.length;
    while (left > 0 && /\s/u.test(text[left - 1])) left -= 1;
    while (right < text.length && /\s/u.test(text[right])) right += 1;
    const sourceBefore = hasSourceBefore ? sourceLineSeparator(sourceText, sourceIndex, 'before') : '';
    const sourceAfter = hasSourceAfter ? sourceLineSeparator(sourceText, sourceIndex + heading.length, 'after') : '';
    const replacement = `${sourceBefore}${heading}${sourceAfter}`;
    const previous = text.slice(left, right);
    text = text.slice(0, left) + replacement + text.slice(right);
    if (previous !== replacement) restoredCount += 1;
    sourceCursor = sourceIndex >= 0 ? sourceIndex + heading.length : sourceCursor;
    outputCursor = left + replacement.length;
  }
  return {
    text,
    applied: restoredCount > 0,
    headingCount: headings.length,
    restoredCount,
    missingCount
  };
}

function restoreParagraphLayout({ source, outputText, chunks, mode = '', requestStrength = '', documentProfile = '', profileConfidence = 0 } = {}) {
  const sourceParagraphs = splitParagraphs(source);
  const before = splitParagraphs(outputText);
  const sourceCount = sourceParagraphs.length;
  const beforeCount = before.length;
  const profileName = typeof documentProfile === 'object'
    ? String(documentProfile?.profile || documentProfile?.contentGenre || 'unknown')
    : String(documentProfile || '');
  const confidence = Math.max(
    Number(profileConfidence) || 0,
    typeof documentProfile === 'object' ? Number(documentProfile?.confidence) || 0 : 0
  );
  const sensitiveReport = confidence >= 0.75
    && ['academic_paper', 'report_assignment', 'long_explainer', 'clinical_record', 'legal_contract'].includes(profileName);
  const creativeLayout = profileName === 'creative';
  const sourceReadability = layoutStructure.measureParagraphReadability(sourceParagraphs);
  const beforeReadability = layoutStructure.measureParagraphReadability(before);
  const readableMinimum = Math.max(sourceReadability.minimumCount, beforeReadability.minimumCount);
  const formatFlags = new Set(typeof documentProfile === 'object' ? (documentProfile?.formatProfile?.flags || []) : []);
  const sourceLineLayout = layoutStructure.analyzeLineStructure(source);
  const preserveResumeUnits = profileName === 'resume_application'
    && sourceCount >= 3
    // 빈 줄 없이 완결 행이 연속된 붙여넣기 형식만 문항 묶음으로 본다.
    // 명시적으로 나뉜 소수의 긴 문단은 기존처럼 문단 내부 역할 전환을
    // 기준으로 읽기 좋게 세분할 수 있다.
    && Number(sourceLineLayout?.explicitParagraphCount || 0) === 1
    && Number(sourceLineLayout?.semanticBoundaryCount || 0) >= sourceCount - 2;
  const semanticProseRoles = ['basic', 'advanced'].includes(String(requestStrength || ''))
    && mode !== 'polish'
    && !creativeLayout
    // 자기소개서는 제목 없이 여러 문항 답변을 완결 행으로 붙여 넣는 경우가
    // 많다. 이 행들을 일반 산문의 서론·근거·결론 문단으로 재배치하면 서로
    // 다른 문항이 합쳐지므로, 원문에서 감지한 읽기 단위를 그대로 유지한다.
    && !preserveResumeUnits
    && !['questionnaire', 'list_heavy', 'table', 'table_heavy', 'sectioned', 'reference_heavy', 'creative_lines']
      .some(flag => formatFlags.has(flag))
    && !(chunks || []).some(chunk => chunk?.locked && String(chunk.text || '').trim());
  if (semanticProseRoles) {
    const roleLayout = buildSemanticProseRoleLayout(outputText, { profileName });
    if (roleLayout.applicable) {
      const afterReadability = layoutStructure.measureParagraphReadability(splitParagraphs(roleLayout.text));
      return {
        text: roleLayout.text,
        applied: roleLayout.text !== normalizeParagraphWhitespace(outputText),
        policy: 'semantic_prose_roles',
        sourceCount,
        beforeCount,
        targetCount: roleLayout.paragraphCount,
        afterCount: roleLayout.paragraphCount,
        roleBoundaryCount: roleLayout.roleBoundaryCount,
        readability: compactReadability(afterReadability),
        pass: roleLayout.contentPreserved && afterReadability.overlongCount === 0
      };
    }
  }
  let targetCount = beforeCount;
  let policy = 'none';
  if (mode === 'polish' && sourceCount > 0) {
    targetCount = Math.max(
      sourceCount,
      sourceReadability.minimumCount,
      beforeReadability.overlongCount > 0 ? beforeReadability.targetCount : 0
    );
    policy = targetCount > sourceCount ? 'readable_polish' : 'exact_polish';
  } else if (!creativeLayout && sourceCount > 0) {
    // 원문의 문단 분포를 상한으로 삼되, 장문을 다시 벽글로 합치지 않는다.
    // 제목·완결된 장문 행은 원문의 읽기 단위로 세고, 나머지 과분할만
    // 1.5배 상한까지 어휘 변경 없이 병합한다.
    const compactSourceLength = bare(source).length;
    const maximum = paragraphExpansionLimit(sourceCount, compactSourceLength);
    const safeMaximum = Math.max(maximum, readableMinimum);
    if (beforeCount > safeMaximum) {
      targetCount = safeMaximum;
      policy = sensitiveReport ? 'bounded_sensitive_report' : 'bounded_source_paragraphs';
    } else if (beforeReadability.overlongCount > 0 && beforeReadability.targetCount > beforeCount) {
      targetCount = beforeReadability.targetCount;
      policy = 'readability_cap';
    }
  }
  if (policy === 'none' || (beforeCount === targetCount && beforeReadability.overlongCount === 0)) {
    return {
      text: String(outputText || ''),
      applied: false,
      policy,
      sourceCount,
      beforeCount,
      targetCount,
      afterCount: beforeCount,
      readability: compactReadability(beforeReadability),
      pass: beforeReadability.overlongCount === 0
    };
  }

  const protectedBlocks = new Set((chunks || [])
    .filter(chunk => chunk?.locked)
    .map(chunk => bare(chunk.text))
    .filter(Boolean));
  const paragraphs = [...before];
  while (paragraphs.length > targetCount) {
    const candidate = findMergeCandidate(paragraphs, protectedBlocks);
    if (!candidate) break;
    paragraphs.splice(
      candidate.index,
      2,
      `${paragraphs[candidate.index].trim()}${candidate.separator}${paragraphs[candidate.index + 1].trim()}`.trim()
    );
  }
  while (paragraphs.length < targetCount) {
    const candidate = findSplitCandidate(paragraphs, protectedBlocks);
    if (!candidate) break;
    paragraphs.splice(candidate.index, 1, candidate.left, candidate.right);
  }
  const text = normalizeParagraphWhitespace(paragraphs.join('\n\n'));
  const afterCount = splitParagraphs(text).length;
  const afterReadability = layoutStructure.measureParagraphReadability(splitParagraphs(text));
  return {
    text,
    applied: text !== normalizeParagraphWhitespace(outputText),
    policy,
    sourceCount,
    beforeCount,
    targetCount,
    afterCount,
    readability: compactReadability(afterReadability),
    pass: afterCount === targetCount && afterReadability.overlongCount === 0
  };
}

function buildSemanticProseRoleLayout(value, { profileName = '' } = {}) {
  const normalized = normalizeParagraphWhitespace(value);
  const paragraphs = splitParagraphs(normalized);
  const sentences = splitSentences(normalized)
    .map(sentence => String(sentence || '').replace(/\s+/gu, ' ').trim())
    .filter(Boolean);
  const compactLength = bare(normalized).length;
  if (compactLength < 320 || sentences.length < 7 || layoutStructure.isStructureDominatedParagraph(normalized)) {
    return { applicable: false, text: normalized, paragraphCount: paragraphs.length, roleBoundaryCount: 0, contentPreserved: true };
  }

  let targetCount = Math.max(
    2,
    Math.min(
      8,
      Math.floor(sentences.length / 2),
      Math.max(Math.ceil(sentences.length / 4), Math.ceil(compactLength / 600))
    )
  );
  if (targetCount < 2) {
    return { applicable: false, text: normalized, paragraphCount: paragraphs.length, roleBoundaryCount: 0, contentPreserved: true };
  }

  const candidates = new Map();
  const addCandidate = (index, priority, kind) => {
    if (!Number.isInteger(index) || index <= 0 || index >= sentences.length) return;
    const previous = candidates.get(index);
    if (!previous || priority > previous.priority) candidates.set(index, { index, priority, kind });
  };

  let searchFrom = 1;
  for (const paragraph of paragraphs.slice(1)) {
    const first = splitSentences(paragraph).map(sentence => String(sentence || '').replace(/\s+/gu, ' ').trim()).find(Boolean);
    if (!first) continue;
    const key = sentenceKey(first);
    const index = sentences.findIndex((sentence, cursor) => cursor >= searchFrom && sentenceKey(sentence) === key);
    if (index > 0) {
      addCandidate(index, 8, 'existing');
      searchFrom = index + 1;
    }
  }
  sentences.forEach((sentence, index) => {
    const kind = semanticTransitionKind(sentence, profileName);
    if (kind) addCandidate(index, kind === 'conclusion' ? 10 : 9, kind);
  });
  const semanticBoundaryCount = [...candidates.values()]
    .filter(candidate => candidate.kind !== 'existing' && candidate.index >= 2 && candidate.index <= sentences.length - 2)
    .sort((a, b) => a.index - b.index)
    .reduce((state, candidate) => {
      if (candidate.index - state.lastIndex < 2) return state;
      return { count: state.count + 1, lastIndex: candidate.index };
    }, { count: 0, lastIndex: -2 }).count;
  targetCount = Math.min(
    8,
    Math.floor(sentences.length / 2),
    Math.max(targetCount, Math.min(6, semanticBoundaryCount + 1))
  );
  const currentReadability = layoutStructure.measureParagraphReadability(paragraphs);
  if (paragraphs.length === targetCount && currentReadability.overlongCount === 0) {
    return {
      applicable: true,
      text: normalized,
      paragraphCount: paragraphs.length,
      roleBoundaryCount: 0,
      contentPreserved: true
    };
  }

  const selected = [];
  let previousIndex = 0;
  for (let slot = 1; slot < targetCount; slot += 1) {
    const remainingGroups = targetCount - slot;
    const minimum = previousIndex + 2;
    const maximum = sentences.length - (remainingGroups * 2);
    if (minimum > maximum) break;
    const expected = Math.max(minimum, Math.min(maximum, Math.round(sentences.length * slot / targetCount)));
    const nearby = [...candidates.values()]
      .filter(candidate => candidate.index >= minimum && candidate.index <= maximum && !selected.some(item => item.index === candidate.index))
      .map(candidate => ({
        ...candidate,
        distance: Math.abs(candidate.index - expected),
        score: candidate.priority * 12 - Math.abs(candidate.index - expected) * 7
      }))
      .sort((a, b) => b.score - a.score || a.distance - b.distance || a.index - b.index);
    const chosen = nearby[0]?.score >= 55
      ? nearby[0]
      : { index: expected, priority: 0, kind: 'balanced', distance: 0, score: 0 };
    selected.push(chosen);
    previousIndex = chosen.index;
  }
  if (selected.length !== targetCount - 1) {
    return { applicable: false, text: normalized, paragraphCount: paragraphs.length, roleBoundaryCount: 0, contentPreserved: true };
  }

  const boundaries = new Set(selected.map(item => item.index));
  const groups = [];
  let current = [];
  sentences.forEach((sentence, index) => {
    if (boundaries.has(index) && current.length) {
      groups.push(current.join(' '));
      current = [];
    }
    current.push(sentence);
  });
  if (current.length) groups.push(current.join(' '));
  const text = normalizeParagraphWhitespace(groups.join('\n\n'));
  const contentPreserved = bare(text) === bare(normalized);
  const beforeReadability = layoutStructure.measureParagraphReadability(paragraphs);
  const afterReadability = layoutStructure.measureParagraphReadability(groups);
  const beforeDistance = Math.abs(paragraphs.length - targetCount);
  const afterDistance = Math.abs(groups.length - targetCount);
  const improved = afterDistance < beforeDistance
    || afterReadability.overlongCount < beforeReadability.overlongCount;
  const alreadyOptimal = beforeDistance === 0 && text === normalized;
  if (!contentPreserved || groups.length !== targetCount || (!improved && !alreadyOptimal)) {
    return { applicable: false, text: normalized, paragraphCount: paragraphs.length, roleBoundaryCount: 0, contentPreserved };
  }
  return {
    applicable: true,
    text,
    paragraphCount: groups.length,
    roleBoundaryCount: selected.filter(item => !['existing', 'balanced'].includes(item.kind)).length,
    contentPreserved
  };
}

function semanticTransitionKind(value, profileName = '') {
  const sentence = String(value || '').trim();
  if (/^(?:(?:이러한|이런|이와\s*같은)\s*(?:경험|과정|논의|분석|결과|역량|노력)(?:을|를)?\s*(?:통해|바탕으로)|이를\s*바탕으로|종합하면|결론적으로|결과적으로|따라서|그러므로|입사\s*후|앞으로(?:도)?)/u.test(sentence)) return 'conclusion';
  if (/^(?:반면|그러나|하지만|다만|한편|그럼에도|이에\s*반해)/u.test(sentence)) return 'contrast';
  if (/^(?:예를\s*들어|구체적으로|실제로|대표적으로|사례를\s*보면)/u.test(sentence)) return 'evidence';
  if (/^(?:첫째|둘째|셋째|넷째|먼저|다음으로|마지막으로|또\s*다른|이와\s*별개로)/u.test(sentence)) return 'topic_shift';
  if (/^(?:연구실|회사|기관|현장|팀|부서|조직|근무지)(?:에서는|에서)\s/u.test(sentence)) return 'context';
  if (/^(?:장비|업무|연구|프로젝트|실험)(?:를|을)\s*(?:단순히|그저|사용하는\s+데서|수행하는\s+데서)/u.test(sentence)) return 'development';
  if (profileName === 'resume_application'
      && /^(?!연구(?:를|가)\s)(?:[가-힣A-Za-z0-9·-]+\s+){0,5}(?:연구|프로젝트|과제|인턴십?|현장\s*실습)(?:에서는|에서)\s/u.test(sentence)) return 'experience';
  return '';
}

function sentenceKey(value) {
  return String(value || '').normalize('NFKC').replace(/[\p{P}\p{S}\s]/gu, '');
}

function splitEditablePrefixPiece(piece) {
  const raw = String(piece?.text || '');
  const legal = raw.match(/^(\s*제\s*\d{1,3}\s*조(?:의\s*\d{1,3})?(?:\s*[（(][^）)\n]{1,80}[）)])?\s+)(\S[\s\S]*)$/u);
  const bullet = legal ? null : raw.match(/^(\s*(?:[-*+•▪◦·●○■□◆◇▶▷※]|\d+(?:[-.]\d+)*[.)]|[가-힣][.)]|[①-⑳])\s+)(\S[\s\S]*)$/u);
  const label = legal || bullet ? null : raw.match(/^(\s*[가-힣A-Za-z][가-힣A-Za-z0-9 _/·()（）-]{0,30}[:：]\s*)(\S[\s\S]*)$/u);
  const match = legal || bullet || label;
  if (!match || /^\s*(?:https?|mailto):/iu.test(raw)) return [piece];
  const prefix = match[1];
  const body = match[2];
  const start = Number(piece?.start) || 0;
  return [
    {
      ...piece,
      text: prefix,
      sep: '',
      start,
      end: start + prefix.length,
      forceLockType: legal ? 'legal_clause_prefix' : (bullet ? 'bullet_prefix' : 'label_prefix'),
      forceSectionLabel: legal ? prefix.trim() : ''
    },
    {
      ...piece,
      text: body,
      start: start + prefix.length,
      end: Number(piece?.end) || (start + raw.length),
      forceEditable: true
    }
  ];
}

function isStandaloneQuotedTitle(value) {
  const text = String(value || '').trim();
  return text.length <= 180
    && /^(?:["“][^"”\n]{1,176}["”]|['‘][^'’\n]{1,176}['’]|「[^」\n]{1,176}」|『[^』\n]{1,176}』|《[^》\n]{1,176}》|〈[^〉\n]{1,176}〉)$/u.test(text);
}

function compactReadability(value) {
  return {
    overlongCount: Number(value?.overlongCount) || 0,
    maxBare: Number(value?.maxBare) || 0,
    maxSentences: Number(value?.maxSentences) || 0,
    minimumCount: Number(value?.minimumCount) || 0
  };
}

function sourceLineSeparator(text, boundary, direction) {
  let start = boundary;
  let end = boundary;
  if (direction === 'before') {
    while (start > 0 && /\s/u.test(text[start - 1])) start -= 1;
  } else {
    while (end < text.length && /\s/u.test(text[end])) end += 1;
  }
  const whitespace = direction === 'before' ? text.slice(start, boundary) : text.slice(boundary, end);
  const newlineCount = (whitespace.match(/\n/gu) || []).length;
  return newlineCount >= 2 ? '\n\n' : '\n';
}

function findMergeCandidate(paragraphs, protectedBlocks) {
  let selected = null;
  let selectedLength = Infinity;
  for (let index = 0; index < paragraphs.length - 1; index += 1) {
    const protectedPair = touchesProtectedBlock(paragraphs[index], protectedBlocks)
      || touchesProtectedBlock(paragraphs[index + 1], protectedBlocks);
    if (protectedPair
        || layoutStructure.isStructureDominatedParagraph(paragraphs[index])
        || layoutStructure.isStructureDominatedParagraph(paragraphs[index + 1])) continue;
    const merged = `${paragraphs[index].trim()} ${paragraphs[index + 1].trim()}`;
    const mergedReadability = layoutStructure.measureParagraphReadability([merged]);
    if (mergedReadability.overlongCount > 0) continue;
    const score = bare(merged).length;
    if (score < selectedLength) {
      selected = { index, separator: ' ' };
      selectedLength = score;
    }
  }
  return selected;
}

function findSplitCandidate(paragraphs, protectedBlocks) {
  const ranked = paragraphs
    .map((paragraph, index) => ({ paragraph, index, length: bare(paragraph).length }))
    .filter(item => !touchesProtectedBlock(item.paragraph, protectedBlocks))
    .sort((a, b) => b.length - a.length);
  for (const item of ranked) {
    const sentences = splitSentences(item.paragraph);
    if (sentences.length < 2) continue;
    const half = sentences.reduce((sum, sentence) => sum + bare(sentence).length, 0) / 2;
    let running = 0;
    let splitIndex = 1;
    for (let index = 0; index < sentences.length - 1; index += 1) {
      running += bare(sentences[index]).length;
      splitIndex = index + 1;
      if (running >= half) break;
    }
    const left = sentences.slice(0, splitIndex).join(' ').trim();
    const right = sentences.slice(splitIndex).join(' ').trim();
    if (left && right) return { index: item.index, left, right };
  }
  return null;
}

function touchesProtectedBlock(paragraph, protectedBlocks) {
  const normalized = bare(paragraph);
  if (!normalized) return false;
  for (const block of protectedBlocks || []) {
    if (normalized === block || normalized.includes(block)) return true;
  }
  return false;
}

function splitParagraphs(value) {
  return layoutStructure.splitReadableParagraphs(value);
}

function normalizeNewlines(value) {
  return String(value || '').replace(/\r\n?/gu, '\n');
}

function normalizeParagraphWhitespace(value) {
  return normalizeNewlines(value).replace(/[ \t]+\n/gu, '\n').replace(/\n[ \t]+/gu, '\n').replace(/\n{3,}/gu, '\n\n').trim();
}

function addLineBoundaryMarkers(chunks, policy = 'all') {
  let markerIndex = 1;
  for (const chunk of chunks || []) {
    if (!chunk || chunk.locked) continue;
    const text = String(chunk.text || '');
    const paragraphEvents = (chunk.boundaryMarkers || [])
      .filter(item => Number.isInteger(item.start) && Number.isInteger(item.end))
      .map(item => ({ ...item, kind: 'paragraph' }));
    const lineEvents = [];
    const records = layoutStructure.buildLineRecords(text);
    for (let index = 0; index < records.length - 1; index += 1) {
      const left = records[index];
      const right = records[index + 1];
      if (!layoutStructure.shouldPreserveLineBoundary(left, right, policy)) continue;
      const start = left.end;
      const end = right.start;
      if (paragraphEvents.some(event => rangesOverlap(start, end, event.start, event.end))) continue;
      const marker = `[[[V2_LINE_${String(markerIndex).padStart(4, '0')}]]]`;
      markerIndex += 1;
      lineEvents.push({ marker, boundary: text.slice(start, end) || '\n', start, end, kind: 'line' });
    }
    if (!lineEvents.length) continue;
    chunk.lineBoundaryMarkers = lineEvents.map(({ kind, ...item }) => item);
    chunk.lineBoundaryPolicy = policy;
    chunk.llmText = renderMarkerEvents(text, [...paragraphEvents, ...lineEvents]);
  }
}

function addSentenceBoundaryMarkers(chunks, minimumSentenceCount = 4) {
  let markerIndex = 1;
  for (const chunk of chunks || []) {
    if (!chunk || chunk.locked) continue;
    const text = String(chunk.text || '');
    const spans = splitSentenceSpans(text);
    if (spans.length < Math.max(2, Number(minimumSentenceCount) || 4)) continue;
    const paragraphEvents = (chunk.boundaryMarkers || [])
      .filter(item => Number.isInteger(item.start) && Number.isInteger(item.end))
      .map(item => ({ ...item, kind: 'paragraph' }));
    const lineEvents = (chunk.lineBoundaryMarkers || [])
      .filter(item => Number.isInteger(item.start) && Number.isInteger(item.end))
      .map(item => ({ ...item, kind: 'line' }));
    const sentenceEvents = [];
    for (let i = 0; i < spans.length - 1; i += 1) {
      const start = spans[i].end;
      const end = spans[i + 1].start;
      if ([...paragraphEvents, ...lineEvents].some(event => rangesOverlap(start, end, event.start, event.end))) continue;
      const marker = `[[[V2_SENTENCE_${String(markerIndex).padStart(4, '0')}]]]`;
      markerIndex += 1;
      sentenceEvents.push({ marker, boundary: text.slice(start, end), start, end, kind: 'sentence' });
    }
    if (!sentenceEvents.length) continue;
    chunk.sentenceBoundaryMarkers = sentenceEvents.map(({ kind, ...item }) => item);
    chunk.llmText = renderMarkerEvents(text, [...paragraphEvents, ...lineEvents, ...sentenceEvents]);
  }
}

function renderMarkerEvents(text, events) {
  const sorted = [...events].sort((a, b) => a.start - b.start || a.end - b.end);
  let cursor = 0;
  let output = '';
  for (const event of sorted) {
    if (event.start < cursor) continue;
    output += text.slice(cursor, event.start) + event.marker;
    cursor = event.end;
  }
  return output + text.slice(cursor);
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  if (aStart === aEnd) return aStart >= bStart && aStart <= bEnd;
  if (bStart === bEnd) return bStart >= aStart && bStart <= aEnd;
  return aStart < bEnd && bStart < aEnd;
}

function countLines(value) {
  return String(value || '').split(/\r?\n/u).length;
}

function repairUnsafeChunkBoundaries(chunks) {
  const repairs = [];
  for (let i = 0; i < (chunks || []).length - 1; i += 1) {
    const left = chunks[i];
    const right = chunks[i + 1];
    if (!left || !right || left.locked || right.locked) continue;
    const leftText = String(left.outputText != null ? left.outputText : left.text || '').trim();
    const rightText = String(right.outputText != null ? right.outputText : right.text || '').trim();
    if (!leftText || !rightText) continue;
    if (!/\n/.test(left.sep || '')) continue;
    if (!looksUnsafeChunkEnd(leftText)) continue;
    if (!/^[가-힣A-Za-z0-9("']/.test(rightText)) continue;
    const before = left.sep;
    left.sep = ' ';
    repairs.push({
      index: i,
      reason: 'unsafe_sentence_boundary',
      before,
      after: left.sep,
      leftTail: leftText.slice(-40),
      rightHead: rightText.slice(0, 40)
    });
  }
  return {
    applied: repairs.length > 0,
    count: repairs.length,
    repairs: repairs.slice(0, 20)
  };
}

function buildStructureAudit({ source, outputText, chunks, plan, boundaryRepair, layoutRepair } = {}) {
  const locked = (chunks || []).filter(c => c.locked && String(c.text || '').trim());
  const output = String(outputText || '');
  const lost = [];
  const outOfOrder = [];
  let orderCursor = 0;
  for (const chunk of locked) {
    const value = String(chunk.text || '').trim();
    if (!value) continue;
    const orderedIndex = output.indexOf(value, orderCursor);
    if (orderedIndex >= 0) {
      orderCursor = orderedIndex + value.length;
      continue;
    }
    if (output.includes(value)) {
      outOfOrder.push({ index: chunk.index, lockType: chunk.lockType || 'structure' });
      continue;
    }
    const key = bare(value).slice(0, 80);
    if (key.length >= 2 && bare(output).includes(key)) continue;
    lost.push({
      index: chunk.index,
      lockType: chunk.lockType || 'structure',
      text: value.slice(0, 160)
    });
  }
  const boundaryWarnings = findUnsafeOutputBoundaries(chunks);
  const sectionPathErrors = findSectionPathErrors(chunks);
  const counts = plan?.audit?.lockedByType || countLockedByType(locked);
  return {
    version: VERSION,
    enabled: true,
    sourceChars: String(source || '').length,
    chunkCount: (chunks || []).length,
    lockedCount: locked.length,
    lockedByType: counts,
    lostLockedCount: lost.length,
    lostLocked: lost.slice(0, 20),
    lockedOrderChanged: outOfOrder.length > 0,
    lockedOutOfOrderCount: outOfOrder.length,
    lockedOutOfOrder: outOfOrder.slice(0, 20),
    boundaryRepair: boundaryRepair || { applied: false, count: 0, repairs: [] },
    layoutRepair: compactLayoutRepair(layoutRepair),
    unsafeBoundaryCount: boundaryWarnings.length,
    unsafeBoundaries: boundaryWarnings.slice(0, 20),
    sectionPathErrorCount: sectionPathErrors.length,
    sectionPathErrors: sectionPathErrors.slice(0, 20),
    pass: lost.length === 0
      && outOfOrder.length === 0
      && boundaryWarnings.length === 0
      && sectionPathErrors.length === 0
      && layoutRepair?.pass !== false
  };
}

function findSectionPathErrors(chunks) {
  const errors = [];
  let currentSection = '';
  for (const chunk of chunks || []) {
    const lockType = String(chunk?.lockType || '');
    if (chunk?.locked && ['heading', 'heading_continuation', 'title', 'legal_clause', 'legal_clause_prefix'].includes(lockType)) {
      currentSection = String(chunk.text || '').trim() || currentSection;
      continue;
    }
    if (chunk?.locked || !String(chunk?.text || '').trim()) continue;
    const actual = String(chunk.sectionPath || '');
    if (actual !== currentSection) {
      errors.push({ index: chunk.index, expected: currentSection, actual });
    }
  }
  return errors;
}

function compactLayoutRepair(value) {
  if (!value) return { applied: false };
  return {
    applied: value.applied === true,
    pass: value.pass !== false,
    heading: value.heading ? {
      applied: value.heading.applied === true,
      headingCount: Number(value.heading.headingCount) || 0,
      restoredCount: Number(value.heading.restoredCount) || 0,
      missingCount: Number(value.heading.missingCount) || 0
    } : null,
    paragraphs: value.paragraphs ? {
      applied: value.paragraphs.applied === true,
      policy: String(value.paragraphs.policy || 'none'),
      sourceCount: Number(value.paragraphs.sourceCount) || 0,
      beforeCount: Number(value.paragraphs.beforeCount) || 0,
      targetCount: Number(value.paragraphs.targetCount) || 0,
      afterCount: Number(value.paragraphs.afterCount) || 0,
      roleBoundaryCount: Number(value.paragraphs.roleBoundaryCount) || 0,
      readability: value.paragraphs.readability ? {
        overlongCount: Number(value.paragraphs.readability.overlongCount) || 0,
        maxBare: Number(value.paragraphs.readability.maxBare) || 0,
        maxSentences: Number(value.paragraphs.readability.maxSentences) || 0,
        minimumCount: Number(value.paragraphs.readability.minimumCount) || 0
      } : null,
      pass: value.paragraphs.pass !== false
    } : null,
    speakerRestore: value.speakerRestore ? {
      applied: value.speakerRestore.applied === true,
      restoredSentenceCount: Number(value.speakerRestore.restoredSentenceCount) || 0,
      restoredKinds: Array.isArray(value.speakerRestore.restoredKinds)
        ? value.speakerRestore.restoredKinds.map(item => String(item || '')).filter(Boolean).slice(0, 2)
        : [],
      reason: String(value.speakerRestore.reason || '')
    } : null,
    formatting: value.formatting ? {
      version: Number(value.formatting.version) || 1,
      applied: value.formatting.applied === true,
      changeCount: Number(value.formatting.changeCount) || 0,
      changeCodes: Array.isArray(value.formatting.changeCodes)
        ? value.formatting.changeCodes.map(item => String(item || '')).filter(Boolean).slice(0, 12)
        : [],
      brokenLineBreakRepairCount: Number(value.formatting.brokenLineBreakRepairCount) || 0,
      brokenParagraphBreakRepairCount: Number(value.formatting.brokenParagraphBreakRepairCount) || 0,
      excessiveBlankLineRepairCount: Number(value.formatting.excessiveBlankLineRepairCount) || 0,
      missingSentenceSpaceRepairCount: Number(value.formatting.missingSentenceSpaceRepairCount) || 0,
      contextualSpacingRepairCount: Number(value.formatting.contextualSpacingRepairCount) || 0,
      skipped: value.formatting.skipped === true,
      reason: String(value.formatting.reason || '')
    } : null
  };
}

function buildPlanAudit(chunks) {
  const locked = (chunks || []).filter(c => c.locked);
  return {
    version: VERSION,
    chunkCount: (chunks || []).length,
    lockedCount: locked.length,
    lockedByType: countLockedByType(locked)
  };
}

function countLockedByType(locked) {
  const out = {};
  for (const chunk of locked || []) {
    const key = chunk.lockType || 'structure';
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function findUnsafeOutputBoundaries(chunks) {
  const out = [];
  for (let i = 0; i < (chunks || []).length - 1; i += 1) {
    const left = chunks[i];
    const right = chunks[i + 1];
    if (!left || !right || left.locked || right.locked) continue;
    if (!/\n/.test(left.sep || '')) continue;
    const leftText = String(left.outputText != null ? left.outputText : left.text || '').trim();
    const rightText = String(right.outputText != null ? right.outputText : right.text || '').trim();
    if (!leftText || !rightText) continue;
    if (!looksUnsafeChunkEnd(leftText)) continue;
    out.push({
      index: i,
      leftTail: leftText.slice(-40),
      rightHead: rightText.slice(0, 40)
    });
  }
  return out;
}

function looksUnsafeChunkEnd(text) {
  const s = String(text || '').trim().replace(/[.,;:，、]$/, '');
  return UNSAFE_END_RE.test(s);
}

function isReferenceHeading(s) {
  return /^(?:참고\s*문헌|참고\s*자료|인용\s*문헌|출처|References|Bibliography|Works\s+Cited)$/i.test(s);
}

function isTocHeading(s) {
  return /^(?:목\s*차|차례|Table\s+of\s+Contents)$/i.test(s);
}

function isMainBodyHeading(s) {
  return /^[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]\s*[.)．]?\s*(?:서론|본론|결론|초록|이론|연구|논의|참고\s*문헌)/.test(s) ||
    /^제\s?\d{1,3}\s?(?:장|절|항|조)(?=$|[^가-힣A-Za-z0-9_])/.test(s);
}

function isHeadingLine(s) {
  if (layoutStructure.isKnownHeadingLine(s)) return true;
  if (/^[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]\s*[.)．]?\s*\S.{0,100}$/.test(s)) return true;
  if (/^\d{1,2}(?:\.\d{1,2}){0,3}\s*[.)]?\s+\S.{0,100}$/.test(s) && s.length <= 120) return true;
  if (/^제\s?\d{1,3}\s?(?:장|절|항)(?:\s+\S.{0,100})?$/.test(s)) return true;
  if (/^제\s?\d{1,3}\s?조(?:의\s?\d{1,3})?(?:\s*[（(][^）)\n]{1,80}[）)])?$/.test(s)) return true;
  if (/^(?:서론|본론|결론|초록|요약|연구\s*방법|연구\s*결과|연구\s*가설|분석\s*결과|결과\s*분석|논의|시사점|한계점|제언|부록|참고\s*문헌|결과\s*분석\s*및\s*함의)$/.test(s)) return true;
  if (/^(?:Abstract|Introduction|Methods?|Methodology|Results?|Discussion|Conclusion|References|Appendix)$/i.test(s)) return true;
  return false;
}

function isQuestionnaireQuestionLine(s) {
  const value = String(s || '').trim();
  if (/^(?:\d{1,2}[.)]|[①②③④⑤⑥⑦⑧⑨⑩])\s+\S/u.test(value)) return true;
  return /[?？]\s*$/u.test(value)
    || /(?:무엇|어떻게|어떠했|왜|어떤|얼마나|서술(?:하시오|하세요)?|작성(?:하시오|하세요)?|설명(?:하시오|하세요)?|적어\s*(?:보세요|주세요)|말해\s*(?:보세요|주세요)|기술(?:하시오|하세요)?)(?:[?.？]|\s*$)/u.test(value);
}

function isHeadingContinuationLine(s, lastPiece) {
  if (!lastPiece || !lastPiece.locked || !/^heading/.test(lastPiece.lockType || '')) return false;
  if (!s || s.length > 40) return false;
  if (/[.!?。！？]$/.test(s)) return false;
  if (/^(?:및|과|와|또는|그리고)\s+\S.{0,34}$/.test(s)) return true;
  return /^(?:함의|시사점|한계점|제언|논의|요약)$/.test(s);
}

function isHypothesisLine(s) {
  return /^(?:\(?\s*)?(?:가설|연구\s*가설|H)\s*[-:]?\s*\d+[a-zA-Z]?\s*[.:)：)]?(?:\s+|$)/.test(s) ||
    /^(?:\(?\s*)?(?:가설|연구\s*가설|H)\s*[-:]?\s*\d+[a-zA-Z]?\s*[.:)：)]?\S.{0,180}$/.test(s);
}

function isTableLine(s) {
  if (/^(?:표|그림)\s*[0-9A-Za-z가-힣.-]+/.test(s)) return true;
  if (/^\|.+\|$/.test(s)) return true;
  return false;
}

function isStatLine(s) {
  return /\b(?:p|r|R²|R2|F|t|β|B|SE|M|SD)\s*[<=>]\s*-?\d+(?:\.\d+)?\b/i.test(s) ||
    /(?:유의확률|표준오차|회귀계수|결정계수|상관계수)\s*[:=]?\s*-?\d+(?:\.\d+)?/.test(s);
}

function bare(text) {
  return String(text || '').replace(/\s+/g, '').replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
}

module.exports = {
  VERSION,
  splitChunksForGpt,
  mergeChunks,
  repairUnsafeChunkBoundaries,
  buildStructureAudit,
  looksUnsafeChunkEnd,
  coalesceEditableChunks,
  restoreBoundaryMarkers,
  restorePostSemanticLayout,
  restoreLockedHeadingLayout,
  restoreParagraphLayout,
  isQuestionnaireQuestionLine,
  splitEditablePrefixPiece,
  isStandaloneQuotedTitle
};
