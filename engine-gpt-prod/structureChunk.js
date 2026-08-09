'use strict';

const baseChunk = require('../engine/chunk');
const freezeBlocks = require('../engine/freezeblocks');
const { splitSentenceSpans, splitSentences, ngramJaccard } = require('../engine/koreanText');
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
  const base = protectStructuralLineChunkBoundaries(baseChunk.splitChunks(text), text);
  const academicSpans = freezeBlocks.detectAcademicSpans(text);
  const chunks = [];
  const state = {
    currentSection: '',
    lastPiece: null,
    academicSpans,
    tocEntryKeys: freezeBlocks.tocEntryKeys(text, academicSpans),
    sourceLineRoles: buildSourceLineRoleMap(text),
    questionnaire: formatProfile?.primary === 'questionnaire'
      || formatProfile?.flags?.includes?.('questionnaire') === true,
    assessment: formatProfile?.primary === 'assessment_item'
      || formatProfile?.flags?.includes?.('assessment_item') === true,
    assessmentSection: 'protected',
    editableBlockquoteWrapper: formatProfile?.editableBlockquoteWrapper === true
      || formatProfile?.flags?.includes?.('editable_blockquote_wrapper') === true
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
    const sourceText = String(sourcePiece.text || '').trim();
    const wholeLineRole = sourceLineRole(
      state.sourceLineRoles,
      sourceText,
      sourcePiece.start,
      sourcePiece.end
    );
    // 번호형 소제목을 불릿 접두부와 본문으로 먼저 분해하면 `1. 연구 배경`의
    // 제목성이 사라지고 뒤 본문이 상위 절 경로에 남는다. 구조 판정을 접두부
    // 편집 규칙보다 먼저 적용해 제목 행 전체를 하나의 잠금 단위로 유지한다.
    const preserveWholeStructuralLine = [
      'title',
      'heading',
      'signature',
      'code',
      'table',
      'flow',
      'quote'
    ].includes(wholeLineRole)
      || isHeadingLine(sourceText)
      || isRepeatedTocHeadingLine(sourceText, state)
      || isStandaloneQuotedTitle(sourceText);
    const assessmentExplanationPieces = state.assessment
      ? splitAssessmentExplanationPiece(sourcePiece, state.assessmentSection)
      : null;
    const editableBlockquotePieces = state.editableBlockquoteWrapper
      ? splitEditablePrefixPiece(sourcePiece, { editableBlockquoteWrapper: true })
      : null;
    const expandedPieces = assessmentExplanationPieces
      || editableBlockquotePieces
      || (preserveWholeStructuralLine
      || (state.assessment && shouldKeepAssessmentLineWhole(sourceText, state.assessmentSection))
      || (state.questionnaire && isQuestionnaireQuestionLine(sourceText))
      ? [sourcePiece]
      : splitEditablePrefixPiece(sourcePiece));
    for (const piece of expandedPieces) {
      const info = classifyPiece(piece, state);
      const key = info.locked ? `locked:${info.lockType}` : 'body';
      const sectionChanged = Boolean(
        current
        && info.locked
        && info.sectionLabel
        && String(current.sectionPath || '') !== String(info.sectionLabel)
      );
      if (!current || current.key !== key || sectionChanged) {
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
  if (frozen) {
    // 목차·참고문헌은 본문 밖의 동결 블록이지 이후 본문의 현재 절이 아니다.
    // 여기서 `목차`를 sectionLabel로 넣으면 동결 구간이 끝난 뒤 첫 본문
    // 청크가 목차 문맥으로 모델에 전달된다.
    return {
      locked: true,
      lockType: frozen.type === 'toc' ? 'toc_item' : 'reference_item',
      sectionLabel: state.currentSection
    };
  }

  if (piece?.forceLockType) return {
    locked: true,
    lockType: piece.forceLockType,
    sectionLabel: piece.forceSectionLabel || state.currentSection
  };
  if (piece?.forceEditable) return { locked: false, lockType: '', sectionLabel: state.currentSection };

  // 질문지의 번호형 질문은 일반 번호 제목과 모양이 같아 layoutStructure가
  // heading으로 먼저 분류할 수 있다. 문서 프로필이 질문지로 확정된 경우에는
  // 질문/답변 경계 계약이 일반 제목 판정보다 우선해야 답변별 독립 청크와
  // questionnaire_question 관측값이 유지된다.
  if (state.questionnaire && isQuestionnaireQuestionLine(s)) {
    return { locked: true, lockType: 'questionnaire_question', sectionLabel: s };
  }

  const sourceRole = sourceLineRole(state.sourceLineRoles, s, piece.start, piece.end);
  if (sourceRole === 'title') return { locked: true, lockType: 'title', sectionLabel: s };
  if (sourceRole === 'label') return { locked: true, lockType: 'label', sectionLabel: state.currentSection };
  if (sourceRole === 'code') return { locked: true, lockType: 'code', sectionLabel: state.currentSection };
  if (sourceRole === 'table') return { locked: true, lockType: 'table', sectionLabel: state.currentSection };
  if (sourceRole === 'flow') return { locked: true, lockType: 'flow', sectionLabel: state.currentSection };
  if (sourceRole === 'signature') return { locked: true, lockType: 'signature', sectionLabel: state.currentSection };
  if (sourceRole === 'quote' && isStandaloneQuotedTitle(s)) {
    return { locked: true, lockType: 'title', sectionLabel: s };
  }
  if (sourceRole === 'quote') return { locked: true, lockType: 'quote', sectionLabel: state.currentSection };
  if (sourceRole === 'legal_clause') return { locked: true, lockType: 'legal_clause', sectionLabel: s };
  if (isStandaloneQuotedTitle(s)) return { locked: true, lockType: 'title', sectionLabel: s };

  const assessment = assessmentLineInfo(s, state);
  if (assessment) return assessment;
  if (sourceRole === 'heading' || isRepeatedTocHeadingLine(s, state)) {
    return { locked: true, lockType: 'heading', sectionLabel: s };
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
  }
  if (group.sectionPath) chunk.sectionPath = group.sectionPath;
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
  // `*`, `-` 같은 ASCII 불릿 접두부는 굵게 표시하는 `**` 내부와 문자
  // 자체가 같아 literal indexOf로 위치를 찾을 수 없다. 반면 `①`, `●`,
  // `1.` 같은 식별 가능한 접두부는 의미 감사 뒤 행갈이 복원에 필요하다.
  const headings = (chunks || [])
    .filter(chunk => chunk?.locked
      && [
        'heading',
        'heading_continuation',
        'title',
        'label',
        'heading_prefix',
        'label_prefix',
        'bullet_prefix',
        'blockquote_prefix',
        'legal_clause_prefix',
        'flow'
      ].includes(String(chunk.lockType || ''))
      && String(chunk.text || '').trim())
    .filter(chunk => String(chunk.lockType || '') !== 'bullet_prefix'
      || !/^\s*[-*+]\s*$/u.test(String(chunk.text || '')))
    .map(chunk => {
      const rawText = String(chunk.text || '').replace(/[ \t]+$/gu, '');
      return {
        text: rawText.trim(),
        replacementText: rawText,
        prefix: String(chunk.lockType || '').endsWith('_prefix')
      };
    });
  let text = normalizeNewlines(outputText);
  const sourceText = normalizeNewlines(source);
  let sourceCursor = 0;
  let outputCursor = 0;
  let restoredCount = 0;
  let missingCount = 0;
  for (const anchor of headings) {
    const heading = anchor.text;
    const replacementHeading = anchor.replacementText || heading;
    let sourceIndex = sourceText.indexOf(replacementHeading, sourceCursor);
    let sourceHeadingLength = replacementHeading.length;
    if (sourceIndex < 0) {
      sourceIndex = sourceText.indexOf(heading, sourceCursor);
      sourceHeadingLength = heading.length;
    }
    let outputIndex = text.indexOf(replacementHeading, outputCursor);
    let outputHeadingLength = replacementHeading.length;
    if (outputIndex < 0) {
      outputIndex = text.indexOf(heading, outputCursor);
      outputHeadingLength = heading.length;
    }
    if (outputIndex < 0) {
      // 모델이 `1.지원동기및진로계획`을 `1.지원동기\n및진로계획`처럼
      // 제목 내부에서 갈라도 공백을 제외한 원문 앵커가 같으면 원래 한 행으로
      // 복원한다. 같은 행 수만 찾던 예전 fallback은 이 경우를 놓쳤다.
      const equivalent = findWhitespaceEquivalentSpan(text, heading, outputCursor);
      if (!equivalent) {
        missingCount += 1;
        continue;
      }
      outputIndex = equivalent.start;
      outputHeadingLength = equivalent.end - equivalent.start;
    }
    const hasSourceBefore = sourceIndex > 0 && sourceText.slice(0, sourceIndex).trim().length > 0;
    const hasSourceAfter = sourceIndex >= 0
      && sourceText.slice(sourceIndex + sourceHeadingLength).trim().length > 0;
    let left = outputIndex;
    let right = outputIndex + outputHeadingLength;
    while (left > 0 && /\s/u.test(text[left - 1])) left -= 1;
    while (right < text.length && /\s/u.test(text[right])) right += 1;
    const sourceBefore = hasSourceBefore ? sourceLineSeparator(sourceText, sourceIndex, 'before') : '';
    const sourceAfter = hasSourceAfter
      ? (anchor.prefix
          ? sourceInlineSeparator(sourceText, sourceIndex + sourceHeadingLength, 'after')
          : sourceLineSeparator(sourceText, sourceIndex + sourceHeadingLength, 'after'))
      : '';
    const replacement = `${sourceBefore}${replacementHeading}${sourceAfter}`;
    const previous = text.slice(left, right);
    text = text.slice(0, left) + replacement + text.slice(right);
    if (previous !== replacement) restoredCount += 1;
    sourceCursor = sourceIndex >= 0 ? sourceIndex + sourceHeadingLength : sourceCursor;
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

// 의미 감사 뒤의 국소 문장 복원은 잠긴 라벨 접두부를 보존하면서도 그 앞의
// 줄 구분자를 공백으로 재조립할 수 있다. 어휘를 다시 바꾸지 않고 잠긴
// 제목·라벨·불릿·조문 접두부의 원래 행 위치만 마지막에 한 번 더 복원한다.
function restoreLockedStructureLayout({ source, outputText, chunks } = {}) {
  const heading = restoreLockedHeadingLayout(source, outputText, chunks);
  const blocks = restoreExactLockedBlocks(heading.text, chunks);
  const markdownControls = restoreStandaloneMarkdownControlLines(source, blocks.text);
  return {
    text: markdownControls.text,
    applied: heading.applied || blocks.applied || markdownControls.applied,
    headingCount: heading.headingCount,
    blockCount: blocks.blockCount,
    restoredCount: heading.restoredCount + blocks.restoredCount + markdownControls.restoredCount,
    approximateRestoredCount: Number(blocks.approximateRestoredCount || 0),
    missingCount: heading.missingCount + blocks.missingCount + markdownControls.missingCount,
    missingBlocks: blocks.missingBlocks || [],
    heading,
    blocks,
    markdownControls,
    pass: heading.missingCount === 0
      && blocks.missingCount === 0
      && markdownControls.missingCount === 0
  };
}

// 길이 기반 base chunk가 `### 5. 목적해석`의 마침표 직후처럼 구조 행
// 한가운데를 경계로 선택할 수 있다. 뒤 단계는 각 base chunk 내부에서만
// 행 역할을 찾기 때문에 이 상태를 두면 `### 5.`만 제목으로 잠기고 제목
// 본문은 편집 산문으로 흘러간다. 경계가 구조 행 안에 있으면 그 행 전체를
// 다음 청크로 옮겨 원문 행 판정이 항상 완전한 문자열을 보게 한다.
function protectStructuralLineChunkBoundaries(chunks, source) {
  const original = Array.isArray(chunks) ? chunks : [];
  if (original.length < 2) return original;
  const text = String(source || '');
  const structuralLines = layoutStructure.buildLineRecords(text)
    .filter(record => !record.blank && [
      'title', 'heading', 'label', 'table', 'flow', 'quote', 'code', 'legal_clause', 'signature'
    ].includes(record.role));
  if (!structuralLines.length) return original;
  const rows = original.map(chunk => ({ ...chunk }));
  for (let index = 0; index < rows.length - 1; index += 1) {
    const left = rows[index];
    const right = rows[index + 1];
    const line = structuralLines.find(record => (
      record.start < Number(right.start)
        && record.end > Number(left.end)
        && record.start < Number(left.end)
        && record.end > Number(right.start)
    ));
    if (!line) continue;
    left.text = text.slice(left.start, line.start);
    left.end = line.start;
    left.sep = '';
    right.start = line.start;
    right.text = text.slice(line.start, right.end);
  }
  const compact = [];
  for (const row of rows) {
    if (!String(row.text || '').length) {
      if (compact.length) compact[compact.length - 1].sep += String(row.sep || '');
      else if (rows[1]) rows[1]._lead = `${row._lead || ''}${row.sep || ''}${rows[1]._lead || ''}`;
      continue;
    }
    compact.push(row);
  }
  compact.forEach((chunk, index) => {
    chunk.index = index;
    chunk.position = compact.length === 1
      ? 'single'
      : (index === 0 ? 'intro' : (index === compact.length - 1 ? 'conclusion' : 'body'));
  });
  return baseChunk.mergeChunks(compact) === text ? compact : original;
}

const EXACT_LAYOUT_LOCK_TYPES = new Set([
  'toc_item',
  'reference_item',
  'code',
  'table',
  'flow',
  'quote',
  'signature',
  'legal_clause'
]);

function restoreExactLockedBlocks(outputText, chunks) {
  const blocks = (chunks || [])
    .filter(chunk => chunk?.locked
      && EXACT_LAYOUT_LOCK_TYPES.has(String(chunk.lockType || ''))
      && String(chunk.text || '').trim())
    .map(chunk => ({
      text: String(chunk.text || '').trim(),
      lockType: String(chunk.lockType || 'structure'),
      index: Number.isInteger(chunk.index) ? chunk.index : -1
    }));
  let text = normalizeNewlines(outputText);
  let cursor = 0;
  let restoredCount = 0;
  let approximateRestoredCount = 0;
  let missingCount = 0;
  const missingBlocks = [];
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const block = blocks[blockIndex];
    const expected = block.text;
    const equivalent = findWhitespaceEquivalentSpan(text, expected, cursor);
    const approximate = equivalent || findDamagedLockedBlockSpan(
      text,
      block,
      cursor,
      blocks[blockIndex + 1]?.text || ''
    );
    if (!approximate) {
      missingCount += 1;
      missingBlocks.push({ index: block.index, lockType: block.lockType });
      continue;
    }
    const previous = text.slice(approximate.start, approximate.end);
    text = `${text.slice(0, approximate.start)}${expected}${text.slice(approximate.end)}`;
    if (previous !== expected) restoredCount += 1;
    if (!equivalent) approximateRestoredCount += 1;
    cursor = approximate.start + expected.length;
  }
  return {
    text,
    applied: restoredCount > 0,
    blockCount: blocks.length,
    restoredCount,
    approximateRestoredCount,
    missingCount,
    missingBlocks
  };
}

// `**`처럼 한 행을 차지하는 마크다운 제어 표식은 다른 굵은 글씨 안에도
// 동일 문자열이 반복된다. 일반 substring 복원은 엉뚱한 `**제목**`을
// 찾고 성공으로 오인하므로, 앞뒤 원문 행 앵커 사이의 독립 행만 확인한 뒤
// 누락된 표식을 원래 위치에 삽입한다.
function restoreStandaloneMarkdownControlLines(source, outputText) {
  const sourceLines = normalizeNewlines(source).split('\n');
  const controls = sourceLines
    .map((line, index) => ({ line: String(line || '').trim(), index }))
    .filter(item => isStandaloneMarkdownControl(item.line));
  if (!controls.length) {
    return { text: normalizeNewlines(outputText), applied: false, restoredCount: 0, missingCount: 0 };
  }
  const outputLines = normalizeNewlines(outputText).split('\n');
  let restoredCount = 0;
  let missingCount = 0;
  for (const control of controls) {
    const beforeIndex = findNeighboringOutputAnchor(sourceLines, outputLines, control.index, -1);
    const afterIndex = findNeighboringOutputAnchor(sourceLines, outputLines, control.index, 1);
    const regionStart = beforeIndex >= 0 ? beforeIndex + 1 : 0;
    const regionEnd = afterIndex >= 0 ? afterIndex : outputLines.length;
    const alreadyPresent = outputLines
      .slice(regionStart, Math.max(regionStart, regionEnd))
      .some(line => String(line || '').trim() === control.line);
    if (alreadyPresent) continue;
    const insertionIndex = afterIndex >= 0
      ? afterIndex
      : (beforeIndex >= 0 ? beforeIndex + 1 : -1);
    if (insertionIndex < 0) {
      missingCount += 1;
      continue;
    }
    outputLines.splice(insertionIndex, 0, control.line);
    restoredCount += 1;
  }
  return {
    text: outputLines.join('\n'),
    applied: restoredCount > 0,
    restoredCount,
    missingCount
  };
}

function findNeighboringOutputAnchor(sourceLines, outputLines, sourceIndex, direction) {
  for (let index = sourceIndex + direction;
    index >= 0 && index < sourceLines.length;
    index += direction) {
    const sourceLine = String(sourceLines[index] || '').trim();
    if (!sourceLine || isStandaloneMarkdownControl(sourceLine)) continue;
    const key = lineAnchorKey(sourceLine);
    if (key.length < 3) continue;
    const outputIndex = outputLines.findIndex(line => lineAnchorKey(line) === key);
    if (outputIndex >= 0) return outputIndex;
  }
  return -1;
}

function lineAnchorKey(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/gu, '').trim();
}

function isStandaloneMarkdownControl(value) {
  return /^(?:\*{1,3}|_{2,3}|~{2}|-{3,})$/u.test(String(value || '').trim());
}

function findDamagedLockedBlockSpan(value, block, cursor = 0, nextExpected = '') {
  const text = normalizeNewlines(value);
  const expected = String(block?.text || '').trim();
  const expectedKey = bare(expected);
  const minimumKeyLength = String(block?.lockType || '') === 'table' ? 4 : 12;
  if (expectedKey.length < minimumKeyLength) return null;
  const next = nextExpected ? findWhitespaceEquivalentSpan(text, nextExpected, cursor) : null;
  const limit = next?.start ?? text.length;
  const records = layoutStructure.buildLineRecords(text);
  const expectedLineCount = Math.max(1, expected.split('\n').filter(line => line.trim()).length);
  const maxLines = Math.min(48, expectedLineCount + 2);
  const candidates = [];
  for (let startIndex = 0; startIndex < records.length; startIndex += 1) {
    const first = records[startIndex];
    if (first.blank || first.start < cursor || first.start >= limit) continue;
    for (let lineCount = 1; lineCount <= maxLines && startIndex + lineCount <= records.length; lineCount += 1) {
      const last = records[startIndex + lineCount - 1];
      if (last.end > limit) break;
      if (last.blank) continue;
      const candidate = text.slice(first.start, last.end).trim();
      const candidateKey = bare(candidate);
      if (!candidateKey || candidateKey.length > expectedKey.length * 1.35) break;
      if (candidateKey.length < Math.min(8, Math.floor(expectedKey.length * 0.35))) continue;
      const prefix = commonPrefixLength(expectedKey, candidateKey);
      const expectedPrefixCoverage = prefix / expectedKey.length;
      const candidatePrefixCoverage = prefix / candidateKey.length;
      const similarity = ngramJaccard(expectedKey, candidateKey, 4);
      const lengthRatio = candidateKey.length / expectedKey.length;
      const prefixCandidate = expectedPrefixCoverage >= 0.55 && candidatePrefixCoverage >= 0.86;
      const generalCandidate = similarity >= 0.72 && lengthRatio >= 0.55 && lengthRatio <= 1.2;
      if (!prefixCandidate && !generalCandidate) continue;
      if (!isCompatibleDamagedBlockCandidate(block.lockType, expected, candidate, first)) continue;
      const score = expectedPrefixCoverage * 0.5
        + candidatePrefixCoverage * 0.2
        + similarity * 0.3;
      candidates.push({ start: first.start, end: last.end, score, expectedPrefixCoverage, similarity });
    }
  }
  candidates.sort((left, right) => right.score - left.score || left.start - right.start);
  const best = candidates[0];
  const minimumScore = String(block?.lockType || '') === 'table' ? 0.62 : 0.64;
  if (!best || best.score < minimumScore) return null;
  const runnerUp = candidates.find(candidate => candidate.start !== best.start || candidate.end !== best.end);
  if (runnerUp && best.expectedPrefixCoverage < 0.8 && best.score - runnerUp.score < 0.08) return null;
  return { start: best.start, end: best.end, approximate: true, score: best.score };
}

function isCompatibleDamagedBlockCandidate(lockType, expected, candidate, firstRecord) {
  const type = String(lockType || '');
  if (type === 'table') {
    return layoutStructure.tableColumnCount(candidate) >= 2
      || /^\s*\|.*\|\s*$/u.test(candidate);
  }
  if (type === 'legal_clause') {
    const expectedArticle = expected.match(/^\s*(제\s*\d{1,3}\s*조(?:의\s*\d{1,3})?)/u)?.[1] || '';
    return Boolean(expectedArticle) && bare(candidate).startsWith(bare(expectedArticle));
  }
  if (type === 'toc_item') {
    return ['title', 'heading', 'list'].includes(String(firstRecord?.role || ''));
  }
  if (type === 'code') return /^\s*(?:`{3,}|~{3,})/u.test(expected) === /^\s*(?:`{3,}|~{3,})/u.test(candidate);
  return true;
}

function commonPrefixLength(left, right) {
  const maximum = Math.min(String(left || '').length, String(right || '').length);
  let index = 0;
  while (index < maximum && left[index] === right[index]) index += 1;
  return index;
}

function findWhitespaceEquivalentSpan(value, expected, cursor = 0) {
  const text = normalizeNewlines(value);
  const expectedKey = bare(expected);
  if (expectedKey.length < 2) return null;
  const compact = [];
  const starts = [];
  const ends = [];
  for (let index = 0; index < text.length;) {
    const codePoint = text.codePointAt(index);
    const char = String.fromCodePoint(codePoint);
    const next = index + char.length;
    if (!/\s/u.test(char)) {
      compact.push(char === '“' || char === '”' ? '"' : (char === '‘' || char === '’' ? "'" : char));
      starts.push(index);
      ends.push(next);
    }
    index = next;
  }
  const compactText = compact.join('');
  let compactCursor = 0;
  while (compactCursor < starts.length && starts[compactCursor] < cursor) compactCursor += 1;
  const found = compactText.indexOf(expectedKey, compactCursor);
  if (found < 0) return null;
  const last = found + expectedKey.length - 1;
  return {
    start: starts[found],
    end: ends[last]
  };
}

function restoreStructuralVisualGaps(value, { excludedBlocks = new Set() } = {}) {
  const normalized = normalizeNewlines(value);
  const records = layoutStructure.buildLineRecords(normalized);
  const nonEmpty = records.filter(record => !record.blank);
  if (nonEmpty.length < 2) {
    return { text: normalizeParagraphWhitespace(normalized), repairCount: 0 };
  }

  const lines = normalized.split('\n');
  let repairCount = 0;
  for (let index = 0; index < nonEmpty.length - 1; index += 1) {
    const left = nonEmpty[index];
    const right = nonEmpty[index + 1];
    const blankLineCount = Math.max(0, right.index - left.index - 1);
    if (isVisualGapExcluded(left, excludedBlocks) || isVisualGapExcluded(right, excludedBlocks)) continue;
    if (blankLineCount > 0 || !needsVisualParagraphGap(left, right)) continue;
    // 뒤에서부터 삽입하면 앞서 계산한 원문 행 인덱스가 흔들리지 않는다.
    lines.splice(right.index + repairCount, 0, '');
    repairCount += 1;
  }
  return {
    text: normalizeParagraphWhitespace(lines.join('\n')),
    repairCount
  };
}

function isVisualGapExcluded(record, excludedBlocks) {
  const normalized = bare(record?.raw);
  if (!normalized) return false;
  for (const block of excludedBlocks || []) {
    if (normalized === block
        || normalized.startsWith(block)
        || block.startsWith(normalized)
        || block.includes(normalized)) return true;
  }
  return false;
}

function buildVisualGapExcludedBlocks(chunks) {
  const excludedTypes = new Set([
    'toc_item',
    'reference_item',
    'table',
    'flow',
    'code',
    'quote',
    'blockquote_prefix',
    'signature',
    'legal_clause',
    'legal_clause_prefix'
  ]);
  return new Set((chunks || [])
    .filter(chunk => {
      if (!chunk?.locked) return false;
      if (excludedTypes.has(String(chunk?.lockType || ''))) return true;
      return ['heading', 'heading_continuation'].includes(String(chunk?.lockType || ''))
        && /(?:목\s*차|참고\s*(?:문헌|자료)|References)/iu.test(String(chunk?.text || ''));
    })
    .map(chunk => bare(chunk?.text))
    .filter(Boolean));
}

function needsVisualParagraphGap(left, right) {
  const leftRole = String(left?.role || '');
  const rightRole = String(right?.role || '');
  if (leftRole === 'prose' && rightRole === 'prose'
      && layoutStructure.isHardProseBoundary(left, right)) return true;
  if (['title', 'heading'].includes(leftRole) || ['title', 'heading'].includes(rightRole)) return true;

  const leftList = leftRole === 'list';
  const rightList = rightRole === 'list';
  if (leftList && rightList) return false;
  if (leftList || rightList) {
    // 번호 절은 뒤 산문을 해당 절의 설명으로 이어 붙일 수 있게 두되,
    // 새 번호 절 앞에는 실제 빈 줄을 둔다.
    const leftOrdered = isOrderedSectionRecord(left);
    const rightOrdered = isOrderedSectionRecord(right);
    if (rightOrdered) return true;
    if (leftOrdered && rightRole === 'prose') return false;
    return leftRole === 'prose' || rightRole === 'prose';
  }

  const blockRoles = new Set(['table', 'flow', 'quote', 'code', 'legal_clause', 'signature']);
  const leftBlock = blockRoles.has(leftRole);
  const rightBlock = blockRoles.has(rightRole);
  if (leftBlock && rightBlock) return false;
  return (leftRole === 'prose' && rightBlock) || (leftBlock && rightRole === 'prose');
}

function isOrderedSectionRecord(record) {
  return String(record?.role || '') === 'list'
    && /^\s*(?:\d+(?:[-.]\d+)*[.)]|[가-힣][.)]|[①-⑳])\s+\S/u.test(String(record?.text || ''));
}

function restoreParagraphLayout({ source, outputText, chunks, mode = '', requestStrength = '', documentProfile = '', profileConfidence = 0 } = {}) {
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
  const readabilityOptions = {
    mode,
    requestStrength,
    documentProfile,
    profileName
  };
  const rawOutputText = normalizeParagraphWhitespace(outputText);
  const explicitParagraphCountBefore = layoutStructure.splitExplicitParagraphs(rawOutputText).length;
  const canRepairVisualGaps = mode !== 'polish' && !creativeLayout;
  const visualGapExcludedBlocks = buildVisualGapExcludedBlocks(chunks);
  const sourceVisualLayout = canRepairVisualGaps
    ? restoreStructuralVisualGaps(source, { excludedBlocks: visualGapExcludedBlocks })
    : { text: normalizeParagraphWhitespace(source), repairCount: 0 };
  const outputVisualLayout = canRepairVisualGaps
    ? restoreStructuralVisualGaps(rawOutputText, { excludedBlocks: visualGapExcludedBlocks })
    : { text: rawOutputText, repairCount: 0 };
  const layoutSourceText = sourceVisualLayout.text;
  const layoutOutputText = outputVisualLayout.text;
  const detectedSourceParagraphs = splitParagraphs(layoutSourceText);
  const before = splitParagraphs(layoutOutputText);
  const beforeCount = before.length;
  const polishLineSeparators = mode === 'polish'
    ? restorePolishLineSeparatorPattern(layoutSourceText, layoutOutputText)
    : { applicable: false, text: layoutOutputText, applied: false, contentPreserved: true };
  if (polishLineSeparators.applicable) {
    const afterParagraphs = splitParagraphs(polishLineSeparators.text);
    const afterReadability = layoutStructure.measureParagraphReadability(afterParagraphs, readabilityOptions);
    const explicitParagraphCountAfter = layoutStructure.splitExplicitParagraphs(polishLineSeparators.text).length;
    return {
      text: polishLineSeparators.text,
      applied: polishLineSeparators.applied,
      policy: 'exact_polish_line_separators',
      sourceCount: detectedSourceParagraphs.length,
      beforeCount,
      targetCount: afterParagraphs.length,
      afterCount: afterParagraphs.length,
      roleBoundaryCount: 0,
      sourceBoundaryRepairCount: polishLineSeparators.repairedBoundaryCount,
      backwardConclusionRepairCount: 0,
      paragraphAlignmentConfidence: 1,
      proseSplitCount: 0,
      visualGapRepairCount: 0,
      explicitParagraphCountBefore,
      explicitParagraphCountAfter,
      readability: compactReadability(afterReadability),
      // 다듬기는 새 문단을 만들어 가독성을 높이는 모드가 아니다. 원문에
      // 여러 행이 있으면 과도하게 긴 행이 남더라도 원래의 단일 줄바꿈과
      // 빈 줄 경계를 우선하며, 문장 중간 오개행은 마지막 형식 보정이 있다.
      pass: polishLineSeparators.contentPreserved
    };
  }
  const formatFlags = new Set(typeof documentProfile === 'object' ? (documentProfile?.formatProfile?.flags || []) : []);
  const sourceLineLayout = layoutStructure.analyzeLineStructure(source);
  const resumeReadableUnits = profileName === 'resume_application'
    ? layoutStructure.buildLineRecords(source)
      .filter(record => !record.blank)
      .filter(record => record.role === 'prose' && layoutStructure.isSentenceComplete(record.text))
      .map(record => String(record.raw || '').trim())
      .filter(Boolean)
    : [];
  const preserveResumeUnits = profileName === 'resume_application'
    && resumeReadableUnits.length >= 3
    // 빈 줄 없이 완결 행이 연속된 붙여넣기 형식만 문항 묶음으로 본다.
    // 명시적으로 나뉜 소수의 긴 문단은 기존처럼 문단 내부 역할 전환을
    // 기준으로 읽기 좋게 세분할 수 있다.
    && Number(sourceLineLayout?.explicitParagraphCount || 0) === 1
    && resumeReadableUnits.length === Number(sourceLineLayout?.nonEmptyLineCount || 0);
  const sourceParagraphs = preserveResumeUnits ? resumeReadableUnits : detectedSourceParagraphs;
  const sourceCount = sourceParagraphs.length;
  const sourceReadability = layoutStructure.measureParagraphReadability(sourceParagraphs, readabilityOptions);
  const beforeReadability = layoutStructure.measureParagraphReadability(before, readabilityOptions);
  const readableMinimum = Math.max(sourceReadability.minimumCount, beforeReadability.minimumCount);
  if (preserveResumeUnits) {
    const anchored = buildSourceAnchoredParagraphLayout(layoutSourceText, layoutOutputText, {
      readabilityOptions,
      forceParagraphSeparators: true,
      sourceParagraphsOverride: sourceParagraphs
    });
    const afterParagraphs = splitParagraphs(anchored.text);
    const afterReadability = layoutStructure.measureParagraphReadability(afterParagraphs, readabilityOptions);
    const explicitParagraphCountAfter = layoutStructure.splitExplicitParagraphs(anchored.text).length;
    return {
      text: anchored.text,
      applied: anchored.applied || outputVisualLayout.repairCount > 0,
      policy: 'source_readable_units',
      sourceCount,
      beforeCount,
      targetCount: anchored.paragraphCount,
      afterCount: anchored.paragraphCount,
      roleBoundaryCount: 0,
      sourceBoundaryRepairCount: anchored.sourceBoundaryRepairCount,
      backwardConclusionRepairCount: anchored.backwardConclusionRepairCount,
      paragraphAlignmentConfidence: anchored.alignmentConfidence,
      proseSplitCount: anchored.proseSplitCount,
      visualGapRepairCount: Math.max(
        outputVisualLayout.repairCount,
        explicitParagraphCountAfter - explicitParagraphCountBefore - anchored.proseSplitCount
      ),
      explicitParagraphCountBefore,
      explicitParagraphCountAfter,
      readability: compactReadability(afterReadability),
      pass: anchored.contentPreserved && afterReadability.overlongCount === 0
    };
  }
  const semanticProseRoles = ['basic', 'advanced'].includes(String(requestStrength || ''))
    && mode !== 'polish'
    && !creativeLayout
    // 자기소개서는 제목 없이 여러 문항 답변을 완결 행으로 붙여 넣는 경우가
    // 많다. 이 행들을 일반 산문의 서론·근거·결론 문단으로 재배치하면 서로
    // 다른 문항이 합쳐지므로, 원문에서 감지한 읽기 단위를 그대로 유지한다.
    && !preserveResumeUnits
    && !['questionnaire', 'list_heavy', 'table', 'table_heavy', 'compressed_multicolumn', 'sectioned', 'reference_heavy', 'creative_lines']
      .some(flag => formatFlags.has(flag))
    && !(chunks || []).some(chunk => chunk?.locked && String(chunk.text || '').trim());
  const paragraphMergePlan = buildCohesiveParagraphMergePlan(sourceParagraphs, {
    enabled: process.env.PARAGRAPH_MERGE_PROSE === '1',
    semanticProseRoles,
    readabilityOptions
  });
  const sequentialEnumeratedParagraphRoles = hasSequentialEnumeratedParagraphRoles(sourceParagraphs);
  const sourceParagraphRolesAreAuthoritative = semanticProseRoles
    && paragraphMergePlan.applicable !== true
    && (sourceCount >= 3 || sequentialEnumeratedParagraphRoles)
    // 빈 줄 문단뿐 아니라 워드·입력창에서 한 줄만 내려 쓴 완결 산문도
    // layoutStructure가 판정한 원문 역할 경계로 존중한다.
    && sourceParagraphs.every(paragraph => !layoutStructure.isStructureDominatedParagraph(paragraph));
  if (sourceParagraphRolesAreAuthoritative) {
    const anchored = buildSourceAnchoredParagraphLayout(layoutSourceText, layoutOutputText, {
      readabilityOptions,
      minimumSourceCount: sequentialEnumeratedParagraphRoles ? 2 : 3
    });
    const afterReadability = layoutStructure.measureParagraphReadability(splitParagraphs(anchored.text), readabilityOptions);
    const explicitParagraphCountAfter = layoutStructure.splitExplicitParagraphs(anchored.text).length;
    return {
      text: anchored.text,
      applied: anchored.applied || outputVisualLayout.repairCount > 0,
      policy: 'source_paragraph_roles',
      sourceCount,
      beforeCount,
      targetCount: anchored.paragraphCount,
      afterCount: anchored.paragraphCount,
      roleBoundaryCount: 0,
      sourceBoundaryRepairCount: anchored.sourceBoundaryRepairCount,
      backwardConclusionRepairCount: anchored.backwardConclusionRepairCount,
      paragraphAlignmentConfidence: anchored.alignmentConfidence,
      proseSplitCount: anchored.proseSplitCount,
      visualGapRepairCount: outputVisualLayout.repairCount,
      explicitParagraphCountBefore,
      explicitParagraphCountAfter,
      readability: compactReadability(afterReadability),
      pass: anchored.contentPreserved && afterReadability.overlongCount === 0
    };
  }
  if (semanticProseRoles && paragraphMergePlan.applicable !== true) {
    const additiveTailLayout = mergeOrphanAdditiveTailParagraph(layoutOutputText, {
      sourceParagraphCount: sourceCount,
      readabilityOptions
    });
    const roleLayout = buildSemanticProseRoleLayout(additiveTailLayout.text, {
      profileName,
      readabilityOptions
    });
    if (roleLayout.applicable || additiveTailLayout.applied) {
      const roleLayoutText = roleLayout.applicable ? roleLayout.text : additiveTailLayout.text;
      const afterReadability = layoutStructure.measureParagraphReadability(splitParagraphs(roleLayoutText), readabilityOptions);
      const explicitParagraphCountAfter = layoutStructure.splitExplicitParagraphs(roleLayoutText).length;
      return {
        text: roleLayoutText,
        applied: roleLayoutText !== rawOutputText,
        policy: 'semantic_prose_roles',
        sourceCount,
        beforeCount,
        targetCount: splitParagraphs(roleLayoutText).length,
        afterCount: splitParagraphs(roleLayoutText).length,
        roleBoundaryCount: Number(roleLayout.roleBoundaryCount) || 0,
        additiveTailMergeCount: additiveTailLayout.applied ? 1 : 0,
        proseSplitCount: 0,
        visualGapRepairCount: outputVisualLayout.repairCount,
        explicitParagraphCountBefore,
        explicitParagraphCountAfter,
        readability: compactReadability(afterReadability),
        pass: bare(roleLayoutText) === bare(layoutOutputText) && afterReadability.overlongCount === 0
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
    if (paragraphMergePlan.applicable === true && beforeCount > paragraphMergePlan.targetCount) {
      targetCount = Math.max(readableMinimum, paragraphMergePlan.targetCount);
      policy = 'cohesive_prose_merge';
    } else if (beforeCount > safeMaximum) {
      targetCount = safeMaximum;
      policy = sensitiveReport ? 'bounded_sensitive_report' : 'bounded_source_paragraphs';
    } else if (beforeReadability.overlongCount > 0 && beforeReadability.targetCount > beforeCount) {
      targetCount = beforeReadability.targetCount;
      policy = 'readability_cap';
    }
  }
  if (policy === 'none' || (beforeCount === targetCount && beforeReadability.overlongCount === 0)) {
    const explicitParagraphCountAfter = layoutStructure.splitExplicitParagraphs(layoutOutputText).length;
    return {
      text: layoutOutputText,
      applied: layoutOutputText !== rawOutputText,
      policy: creativeLayout
        ? 'creative_preserve'
        : (outputVisualLayout.repairCount > 0 ? 'structural_visual_gaps' : policy),
      sourceCount,
      beforeCount,
      targetCount,
      afterCount: beforeCount,
      proseSplitCount: 0,
      visualGapRepairCount: outputVisualLayout.repairCount,
      explicitParagraphCountBefore,
      explicitParagraphCountAfter,
      readability: compactReadability(beforeReadability),
      // 창작문은 행갈이와 긴 문단 자체가 장르 구조일 수 있다. 의도적으로
      // 레이아웃 정규화를 건너뛴 결과를 “복원 실패”로 뒤집지 않는다.
      pass: creativeLayout || beforeReadability.overlongCount === 0
    };
  }

  const protectedBlocks = new Set((chunks || [])
    .filter(chunk => chunk?.locked)
    .map(chunk => bare(chunk.text))
    .filter(Boolean));
  const paragraphs = [...before];
  let proseSplitCount = 0;
  let targetConstrained = false;
  while (paragraphs.length > targetCount) {
    const candidate = policy === 'cohesive_prose_merge'
      ? findCohesiveMergeCandidate(paragraphs, protectedBlocks, readabilityOptions)
      : findMergeCandidate(paragraphs, protectedBlocks, readabilityOptions);
    if (!candidate) {
      // 원문 문단 수 상한을 맞추려고 제목·라벨 경계를 합치거나, 이미 읽기
      // 한도 안에 있는 두 문단을 다시 벽글로 만들지 않는다. 이 경우는
      // 레이아웃 실패가 아니라 구조·가독성 제약 때문에 목표 수가 조정된
      // 정상 결과다.
      targetConstrained = true;
      break;
    }
    paragraphs.splice(
      candidate.index,
      2,
      `${paragraphs[candidate.index].trim()}${candidate.separator}${paragraphs[candidate.index + 1].trim()}`.trim()
    );
  }
  while (paragraphs.length < targetCount) {
    const candidate = findSplitCandidate(paragraphs, protectedBlocks, readabilityOptions);
    if (!candidate) break;
    paragraphs.splice(candidate.index, 1, candidate.left, candidate.right);
    proseSplitCount += 1;
  }
  const text = normalizeParagraphWhitespace(paragraphs.join('\n\n'));
  const afterCount = splitParagraphs(text).length;
  const afterReadability = layoutStructure.measureParagraphReadability(splitParagraphs(text), readabilityOptions);
  const explicitParagraphCountAfter = layoutStructure.splitExplicitParagraphs(text).length;
  return {
    text,
    applied: text !== rawOutputText,
    policy,
    sourceCount,
    beforeCount,
    targetCount,
    afterCount,
    proseSplitCount,
    visualGapRepairCount: Math.max(
      outputVisualLayout.repairCount,
      explicitParagraphCountAfter - explicitParagraphCountBefore - proseSplitCount
    ),
    explicitParagraphCountBefore,
    explicitParagraphCountAfter,
    readability: compactReadability(afterReadability),
    targetConstrained,
    pass: afterReadability.overlongCount === 0
      && (afterCount === targetCount || targetConstrained)
  };
}

function mergeOrphanAdditiveTailParagraph(value, { sourceParagraphCount = 0, readabilityOptions = {} } = {}) {
  const normalized = normalizeParagraphWhitespace(value);
  const paragraphs = splitParagraphs(normalized);
  const sourceCount = Math.max(1, Number(sourceParagraphCount) || 0);
  // 의미 있는 결론 문단을 무조건 합치지 않는다. 원문보다 문단이 늘었고,
  // 세 문단 이상인 결과의 마지막에 앞 문단을 전제로 하는 짧은 부가 문장만
  // 고립된 경우를 대상으로 한다.
  if (paragraphs.length < 3 || paragraphs.length <= sourceCount) {
    return { text: normalized, applied: false };
  }
  const tail = String(paragraphs.at(-1) || '').trim();
  const previous = String(paragraphs.at(-2) || '').trim();
  const tailSentences = splitSentences(tail).map(sentence => String(sentence || '').trim()).filter(Boolean);
  if (tailSentences.length !== 1
      || bare(tail).length > 140
      || !/^(?:또한|그리고|아울러|더불어|이와\s*함께)(?=$|[\s,，])/u.test(tail)
      || layoutStructure.isStructureDominatedParagraph(tail)
      || layoutStructure.isStructureDominatedParagraph(previous)) {
    return { text: normalized, applied: false };
  }
  const merged = `${previous} ${tail}`.trim();
  if (layoutStructure.measureParagraphReadability([merged], readabilityOptions).overlongCount > 0) {
    return { text: normalized, applied: false };
  }
  const repaired = [
    ...paragraphs.slice(0, -2),
    merged
  ];
  const text = normalizeParagraphWhitespace(repaired.join('\n\n'));
  return {
    text,
    applied: text !== normalized
  };
}

function buildSemanticProseRoleLayout(value, { profileName = '', readabilityOptions = {} } = {}) {
  const normalized = normalizeParagraphWhitespace(value);
  const paragraphs = splitParagraphs(normalized);
  const sentences = splitSentences(normalized)
    .map(sentence => String(sentence || '').replace(/\s+/gu, ' ').trim())
    .filter(Boolean);
  const compactLength = bare(normalized).length;
  const minimumSemanticSentenceCount = profileName === 'resume_application' ? 6 : 7;
  const minimumSemanticLength = profileName === 'resume_application' ? 200 : 320;
  if (compactLength < minimumSemanticLength || sentences.length < minimumSemanticSentenceCount || layoutStructure.isStructureDominatedParagraph(normalized)) {
    return { applicable: false, text: normalized, paragraphCount: paragraphs.length, roleBoundaryCount: 0, contentPreserved: true };
  }

  let targetCount = paragraphs.length;

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
    if (kind === 'backward_takeaway') addCandidate(index + 1, 10, 'after_takeaway');
    else if (kind) addCandidate(index, kind === 'conclusion' ? 10 : 9, kind);
  });
  const semanticBoundaryCount = [...candidates.values()]
    .filter(candidate => candidate.kind !== 'existing' && candidate.index >= 2 && candidate.index <= sentences.length - 2)
    .sort((a, b) => a.index - b.index)
    .reduce((state, candidate) => {
      if (candidate.index - state.lastIndex < 2) return state;
      return { count: state.count + 1, lastIndex: candidate.index };
    }, { count: 0, lastIndex: -2 }).count;
  const currentReadability = layoutStructure.measureParagraphReadability(paragraphs, readabilityOptions);
  const semanticTargetCount = semanticBoundaryCount > 0
    ? Math.min(6, semanticBoundaryCount + 1)
    : paragraphs.length;
  targetCount = Math.min(
    8,
    Math.floor(sentences.length / 2),
    Math.max(
      paragraphs.length,
      Number(currentReadability.minimumCount || 0),
      semanticTargetCount
    )
  );
  const realignedExisting = realignTwoParagraphBoundary(paragraphs, sentences, profileName);
  if (realignedExisting.applied
      && targetCount <= paragraphs.length
      && currentReadability.overlongCount === 0) {
    return {
      applicable: true,
      text: realignedExisting.text,
      paragraphCount: paragraphs.length,
      roleBoundaryCount: 1,
      contentPreserved: bare(realignedExisting.text) === bare(normalized)
    };
  }
  if (targetCount < 2
      || (paragraphs.length >= targetCount && currentReadability.overlongCount === 0)) {
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
    const chosen = nearby[0]?.score >= 55 ? nearby[0] : null;
    if (!chosen) break;
    selected.push(chosen);
    previousIndex = chosen.index;
  }
  // 의미 경계가 부족한데 목표 문단 수를 맞추기 위해 정확히 같은 폭으로
  // 자르지 않는다. 읽기 한도를 넘는 문단은 뒤의 readability 경로가
  // 별도로 나누며, 여기서는 실제 담화 전환이 확인된 경계만 사용한다.
  if (!selected.length) {
    return { applicable: false, text: normalized, paragraphCount: paragraphs.length, roleBoundaryCount: 0, contentPreserved: true };
  }
  targetCount = selected.length + 1;

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
  const beforeReadability = layoutStructure.measureParagraphReadability(paragraphs, readabilityOptions);
  const afterReadability = layoutStructure.measureParagraphReadability(groups, readabilityOptions);
  const beforeDistance = Math.abs(paragraphs.length - targetCount);
  const afterDistance = Math.abs(groups.length - targetCount);
  const roleBoundaryCount = selected.filter(item => item.kind !== 'existing').length;
  const improved = afterDistance < beforeDistance
    || afterReadability.overlongCount < beforeReadability.overlongCount
    || (roleBoundaryCount > 0 && groups.length > paragraphs.length);
  const alreadyOptimal = beforeDistance === 0 && text === normalized;
  if (!contentPreserved || groups.length !== targetCount || (!improved && !alreadyOptimal)) {
    return { applicable: false, text: normalized, paragraphCount: paragraphs.length, roleBoundaryCount: 0, contentPreserved };
  }
  return {
    applicable: true,
    text,
    paragraphCount: groups.length,
    roleBoundaryCount,
    contentPreserved
  };
}

function semanticTransitionKind(value, profileName = '') {
  const sentence = String(value || '').trim();
  if (/^(?:(?:이를\s*통해|이\s*과정에서|이\s*경험(?:을\s*통해|에서)?|이\s*모습에서|그\s*과정에서|그\s*결과|여기서)|현장에서는)[^.!?。！？]{0,180}(?:배웠|알게\s*되었|깨달|확인할\s*수\s*있었|느꼈|체감했|중요하다는|필요하다는|의미한다)/u.test(sentence)) return 'backward_takeaway';
  if (/^(?:(?:이러한|이런|이와\s*같은)\s*(?:경험|과정|논의|분석|결과|역량|노력)(?:을|를)?\s*(?:통해|바탕으로)|이를\s*바탕으로|종합하면|결론적으로|결과적으로|따라서|그러므로|입사\s*후|앞으로(?:도)?)/u.test(sentence)) return 'conclusion';
  if (/^(?:반면|그러나|하지만|다만|한편|그럼에도|이에\s*반해)/u.test(sentence)) return 'contrast';
  if (/^(?:예를\s*들어|구체적으로|실제로|대표적으로|사례를\s*보면)/u.test(sentence)) return 'evidence';
  if (/^(?:(?:첫|두|세|네)\s*번째(?:\s+(?:이유|근거|요인|특징|관점|문제|장점|단점|목표|과제|단계|측면))?(?:은|는|이|가)?|(?:첫째|둘째|셋째|넷째)(?!\s*(?:문장|문단)(?:은|는))|먼저|다음으로|마지막으로|또\s*다른|이와\s*별개로)/u.test(sentence)) return 'topic_shift';
  if (/^(?:연구실|회사|기관|현장|팀|부서|조직|근무지)(?:에서는|에서)\s/u.test(sentence)) return 'context';
  if (/^(?:장비|업무|연구|프로젝트|실험)(?:를|을)\s*(?:단순히|그저|사용하는\s+데서|수행하는\s+데서)/u.test(sentence)) return 'development';
  if (profileName === 'resume_application'
      && /^(?!연구(?:를|가)\s)(?:[가-힣A-Za-z0-9·-]+\s+){0,5}(?:연구|프로젝트|과제|인턴십?|현장\s*실습)(?:에서는|에서)\s/u.test(sentence)) return 'experience';
  if (profileName === 'resume_application'
      && /^(?:지정된|별도의|새로운)\s+[^.!?。！？]{0,80}(?:MCU|IC|회로|펌웨어|모듈|장비|프로젝트)[^.!?。！？]{0,100}(?:바탕|활용|설계|작성|구성|검증|시험)/iu.test(sentence)) return 'workstream';
  if (['academic_paper', 'report_assignment', 'long_explainer'].includes(profileName)
      && /^[^,.!?。！？\n]{2,42}\s+관련\s+연구(?:는|가|에서는)(?=$|\s)/u.test(sentence)) return 'topic_shift';
  return '';
}

/**
 * 이미 여러 문단으로 정리된 일반 산문은 문단 수가 아니라 각 문단의 역할이
 * 원문 계약이다. 모델·의미 수리 단계에서 빈 줄이 이동하더라도 결과 문장은
 * 옮기지 않고, 원문 문단과 가장 잘 대응하는 문장 경계만 복원한다.
 */
function buildSourceAnchoredParagraphLayout(source, value, {
  readabilityOptions = {},
  forceParagraphSeparators = false,
  sourceParagraphsOverride = null,
  minimumSourceCount = 3
} = {}) {
  const normalized = normalizeParagraphWhitespace(value);
  const sourceParagraphs = Array.isArray(sourceParagraphsOverride) && sourceParagraphsOverride.length
    ? sourceParagraphsOverride.map(paragraph => String(paragraph || '').trim()).filter(Boolean)
    : splitParagraphs(source);
  const currentParagraphs = splitParagraphs(normalized);
  const outputSentences = splitSentences(normalized)
    .map(sentence => String(sentence || '').replace(/\s+/gu, ' ').trim())
    .filter(Boolean);
  const sourceCount = sourceParagraphs.length;
  if (sourceCount < Math.max(2, Number(minimumSourceCount) || 3)
      || outputSentences.length < sourceCount) {
    return unchangedSourceAnchoredLayout(normalized, currentParagraphs, 0);
  }

  const alignment = alignSentencesToSourceParagraphs(sourceParagraphs, outputSentences);
  if (!alignment) return unchangedSourceAnchoredLayout(normalized, currentParagraphs, 0);

  const sourceRoleGroups = [];
  let start = 0;
  for (const end of alignment.boundaries) {
    sourceRoleGroups.push(outputSentences.slice(start, end).join(' '));
    start = end;
  }
  sourceRoleGroups.push(outputSentences.slice(start).join(' '));
  const groups = sourceRoleGroups.flatMap(paragraph => splitSourceRoleForReadability(paragraph, readabilityOptions));
  const proseSplitCount = Math.max(0, groups.length - sourceRoleGroups.length);
  const proposed = normalizeParagraphWhitespace(groups.join('\n\n'));
  const contentPreserved = bare(proposed) === bare(normalized);
  if (!contentPreserved || sourceRoleGroups.length !== sourceCount) {
    return unchangedSourceAnchoredLayout(normalized, currentParagraphs, alignment.confidence);
  }

  const currentBoundaries = sentenceBoundariesForParagraphs(currentParagraphs);
  const proposedBoundaries = alignment.boundaries;
  const currentComparable = currentParagraphs.length === sourceCount
    && currentBoundaries.length === proposedBoundaries.length;
  const currentAlignment = currentComparable
    ? paragraphAlignmentScore(sourceParagraphs, currentParagraphs)
    : -1;
  const currentOverlongCount = layoutStructure.measureParagraphReadability(currentParagraphs, readabilityOptions).overlongCount;
  const proposedOverlongCount = layoutStructure.measureParagraphReadability(groups, readabilityOptions).overlongCount;
  const currentExplicitCount = layoutStructure.splitExplicitParagraphs(normalized).length;
  const shouldApply = !currentComparable
    || alignment.score > currentAlignment + 0.015
    || hasMisplacedBackwardTakeaway(outputSentences, currentBoundaries, proposedBoundaries)
    || proposedOverlongCount < currentOverlongCount
    || (forceParagraphSeparators && currentExplicitCount < groups.length);
  if (!shouldApply) {
    return {
      text: normalized,
      applied: false,
      paragraphCount: currentParagraphs.length,
      sourceBoundaryRepairCount: 0,
      backwardConclusionRepairCount: 0,
      alignmentConfidence: roundAlignment(Math.max(currentAlignment, alignment.confidence)),
      proseSplitCount,
      contentPreserved: true
    };
  }

  const sourceBoundaryRepairCount = countMovedBoundaries(currentBoundaries, proposedBoundaries);
  const backwardConclusionRepairCount = countBackwardTakeawayRepairs(
    outputSentences,
    currentBoundaries,
    proposedBoundaries
  );
  return {
    text: proposed,
    applied: proposed !== normalized,
    paragraphCount: groups.length,
    sourceBoundaryRepairCount,
    backwardConclusionRepairCount,
    alignmentConfidence: roundAlignment(alignment.confidence),
    proseSplitCount,
    contentPreserved: true
  };
}

function hasSequentialEnumeratedParagraphRoles(paragraphs) {
  const values = (paragraphs || [])
    .map(paragraph => splitSentences(String(paragraph || ''))[0] || String(paragraph || ''))
    .map(sentence => String(sentence || '').replace(/\s+/gu, ' ').trim())
    .filter(Boolean);
  if (values.length < 2) return false;
  const ordinalFamilies = [
    /(?:^|[\s,])(?:첫\s*번째|첫째)(?:\s+(?:이유|근거|요인|특징|관점|문제|장점|단점|목표|과제|단계|측면))?(?:은|는|이|가)?(?=$|[\s,])/u,
    /(?:^|[\s,])(?:두\s*번째|둘째)(?:\s+(?:이유|근거|요인|특징|관점|문제|장점|단점|목표|과제|단계|측면))?(?:은|는|이|가)?(?=$|[\s,])/u,
    /(?:^|[\s,])(?:세\s*번째|셋째)(?:\s+(?:이유|근거|요인|특징|관점|문제|장점|단점|목표|과제|단계|측면))?(?:은|는|이|가)?(?=$|[\s,])/u,
    /(?:^|[\s,])(?:네\s*번째|넷째)(?:\s+(?:이유|근거|요인|특징|관점|문제|장점|단점|목표|과제|단계|측면))?(?:은|는|이|가)?(?=$|[\s,])/u
  ];
  const comparableCount = Math.min(values.length, ordinalFamilies.length);
  if (comparableCount < 2) return false;
  for (let index = 0; index < comparableCount; index += 1) {
    if (!ordinalFamilies[index].test(values[index])) return false;
  }
  return true;
}

function alignSentencesToSourceParagraphs(sourceParagraphs, outputSentences) {
  const paragraphCount = sourceParagraphs.length;
  const sentenceCount = outputSentences.length;
  // 통상적인 지원서·보고서를 넘는 초대형 문서는 청크 경계가 이미 원문 문단을
  // 보존한다. 여기서 O(P*S²) 정렬을 반복하지 않고 현재 경계를 유지한다.
  if (paragraphCount > 30 || sentenceCount > 180) return null;
  const sourceLengths = sourceParagraphs.map(paragraph => Math.max(1, bare(paragraph).length));
  const totalSourceLength = sourceLengths.reduce((sum, length) => sum + length, 0);
  const expectedEnds = [];
  let cumulativeLength = 0;
  for (const length of sourceLengths) {
    cumulativeLength += length;
    expectedEnds.push(Math.round(sentenceCount * cumulativeLength / totalSourceLength));
  }

  const scores = Array.from({ length: paragraphCount + 1 }, () => Array(sentenceCount + 1).fill(-Infinity));
  const previous = Array.from({ length: paragraphCount + 1 }, () => Array(sentenceCount + 1).fill(-1));
  scores[0][0] = 0;
  for (let paragraphIndex = 1; paragraphIndex <= paragraphCount; paragraphIndex += 1) {
    const minimumEnd = paragraphIndex;
    const maximumEnd = sentenceCount - (paragraphCount - paragraphIndex);
    for (let end = minimumEnd; end <= maximumEnd; end += 1) {
      const minimumStart = paragraphIndex - 1;
      const maximumStart = end - 1;
      for (let candidateStart = minimumStart; candidateStart <= maximumStart; candidateStart += 1) {
        const prior = scores[paragraphIndex - 1][candidateStart];
        if (!Number.isFinite(prior)) continue;
        const segment = outputSentences.slice(candidateStart, end).join(' ');
        const segmentScore = sourceParagraphSegmentScore(
          sourceParagraphs[paragraphIndex - 1],
          segment,
          outputSentences[candidateStart],
          outputSentences[end - 1]
        );
        const expectedEnd = expectedEnds[paragraphIndex - 1];
        const positionPenalty = paragraphIndex === paragraphCount
          ? 0
          : Math.abs(end - expectedEnd) / Math.max(sentenceCount, 1) * 0.35;
        const score = prior + segmentScore - positionPenalty;
        if (score > scores[paragraphIndex][end]) {
          scores[paragraphIndex][end] = score;
          previous[paragraphIndex][end] = candidateStart;
        }
      }
    }
  }
  if (!Number.isFinite(scores[paragraphCount][sentenceCount])) return null;
  const boundaries = [];
  let end = sentenceCount;
  for (let paragraphIndex = paragraphCount; paragraphIndex > 0; paragraphIndex -= 1) {
    const start = previous[paragraphIndex][end];
    if (start < 0) return null;
    if (paragraphIndex > 1) boundaries.unshift(start);
    end = start;
  }
  const score = scores[paragraphCount][sentenceCount] / paragraphCount;
  return {
    boundaries,
    score,
    confidence: Math.max(0, Math.min(1, score))
  };
}

function sourceParagraphSegmentScore(sourceParagraph, segment, firstOutputSentence, lastOutputSentence) {
  const sourceSentences = splitSentences(sourceParagraph).filter(Boolean);
  const firstSourceSentence = sourceSentences[0] || sourceParagraph;
  const lastSourceSentence = sourceSentences[sourceSentences.length - 1] || sourceParagraph;
  const content = ngramJaccard(sourceParagraph, segment, 3);
  const first = ngramJaccard(firstSourceSentence, firstOutputSentence, 2);
  const last = ngramJaccard(lastSourceSentence, lastOutputSentence, 2);
  const sourceLength = Math.max(1, bare(sourceParagraph).length);
  const segmentLength = Math.max(1, bare(segment).length);
  const lengthFit = Math.min(sourceLength, segmentLength) / Math.max(sourceLength, segmentLength);
  return (content * 0.58) + (first * 0.2) + (last * 0.12) + (lengthFit * 0.1);
}

function paragraphAlignmentScore(sourceParagraphs, outputParagraphs) {
  if (sourceParagraphs.length !== outputParagraphs.length || !sourceParagraphs.length) return -1;
  const scores = sourceParagraphs.map((sourceParagraph, index) => {
    const outputParagraph = outputParagraphs[index];
    const outputSentences = splitSentences(outputParagraph).filter(Boolean);
    return sourceParagraphSegmentScore(
      sourceParagraph,
      outputParagraph,
      outputSentences[0] || outputParagraph,
      outputSentences[outputSentences.length - 1] || outputParagraph
    );
  });
  return scores.reduce((sum, score) => sum + score, 0) / scores.length;
}

function sentenceBoundariesForParagraphs(paragraphs) {
  const boundaries = [];
  let sentenceCount = 0;
  for (let index = 0; index < paragraphs.length - 1; index += 1) {
    sentenceCount += splitSentences(paragraphs[index]).filter(Boolean).length;
    boundaries.push(sentenceCount);
  }
  return boundaries;
}

function countMovedBoundaries(before, after) {
  const current = new Set(before);
  return after.filter(boundary => !current.has(boundary)).length;
}

function splitSourceRoleForReadability(paragraph, readabilityOptions = {}) {
  const pending = [String(paragraph || '').trim()];
  const out = [];
  while (pending.length) {
    const current = pending.shift();
    if (layoutStructure.measureParagraphReadability([current], readabilityOptions).overlongCount === 0) {
      if (current) out.push(current);
      continue;
    }
    const sentences = splitSentences(current).map(sentence => String(sentence || '').trim()).filter(Boolean);
    if (sentences.length < 2) {
      if (current) out.push(current);
      continue;
    }
    const selected = selectReadableSplitIndex(sentences, readabilityOptions.profileName || '');
    const left = sentences.slice(0, selected).join(' ').trim();
    const right = sentences.slice(selected).join(' ').trim();
    if (!left || !right) {
      out.push(current);
      continue;
    }
    pending.unshift(right);
    pending.unshift(left);
  }
  return out;
}

function hasMisplacedBackwardTakeaway(sentences, currentBoundaries, proposedBoundaries) {
  return countBackwardTakeawayRepairs(sentences, currentBoundaries, proposedBoundaries) > 0;
}

function countBackwardTakeawayRepairs(sentences, currentBoundaries, proposedBoundaries) {
  const current = new Set(currentBoundaries);
  const proposed = new Set(proposedBoundaries);
  let count = 0;
  sentences.forEach((sentence, index) => {
    if (semanticTransitionKind(sentence) !== 'backward_takeaway') return;
    if (current.has(index) && !proposed.has(index)) count += 1;
  });
  return count;
}

function unchangedSourceAnchoredLayout(text, paragraphs, alignmentConfidence) {
  return {
    text,
    applied: false,
    paragraphCount: paragraphs.length,
    sourceBoundaryRepairCount: 0,
    backwardConclusionRepairCount: 0,
    alignmentConfidence: roundAlignment(alignmentConfidence),
    proseSplitCount: 0,
    contentPreserved: true
  };
}

function roundAlignment(value) {
  return Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 1000) / 1000;
}

function sentenceKey(value) {
  return String(value || '').normalize('NFKC').replace(/[\p{P}\p{S}\s]/gu, '');
}

function splitEditablePrefixPiece(piece, options = {}) {
  const raw = String(piece?.text || '');
  const legal = raw.match(/^(\s*제\s*\d{1,3}\s*조(?:의\s*\d{1,3})?(?:\s*[（(][^）)\n]{1,80}[）)])?\s+)(\S[\s\S]*)$/u);
  // `4. 지원 동기 및 포부 [부제] 본문`처럼 번호·복합 제목·대괄호
  // 부제가 한 행에 붙은 입력은 제목 전체를 하나의 접두부로 잠근다.
  // 번호만 잠그면 모델이 `지원 동기 / 및 포부`처럼 명사구를 분절할 수 있다.
  const numberedInlineHeading = legal
    ? null
    : raw.match(/^(\s*\d{1,2}[.)]\s+[^.!?。！？\n]{2,100}?\s+\[[^\]\n]{2,140}\]\s+)(\S[\s\S]*)$/u);
  const blockquote = legal || options.editableBlockquoteWrapper !== true
    ? null
    : raw.match(/^(\s*>\s?)(\S[\s\S]*)$/u);
  // 마크다운 목록의 굵은 라벨까지 하나의 접두부로 잠근다. `* `만
  // 잠그면 모델이 `**전략:**`의 별표나 닫는 콜론을 흩뜨려 목록 기호가
  // 독립 행으로 남을 수 있다. 라벨 뒤 본문은 계속 편집 가능하다.
  const emojiLabel = legal || numberedInlineHeading || blockquote
    ? null
    : raw.match(/^(\s*(?:(?:\p{Extended_Pictographic}\uFE0F?)+)\s*[가-힣A-Za-z][가-힣A-Za-z0-9 _/·()（）-]{0,30}[:：]\s*)(\S[\s\S]*)$/u);
  const markdownLabelBullet = legal || numberedInlineHeading || blockquote || emojiLabel
    ? null
    : raw.match(/^(\s*[-*+]\s+(?:\*\*|__)[^*\n_]{1,120}(?::|：)(?:\*\*|__)\s*)(\S[\s\S]*)$/u);
  const bulletParts = legal || numberedInlineHeading || blockquote || emojiLabel || markdownLabelBullet
    ? null
    : layoutStructure.listPrefixParts(raw);
  const bullet = bulletParts ? [raw, bulletParts.prefix, bulletParts.body] : null;
  const bracketLabel = legal || numberedInlineHeading || blockquote || emojiLabel || markdownLabelBullet || bullet
    ? null
    : raw.match(/^(\s*\[(?=[^\]\n]{0,79}[가-힣A-Za-z])[^\]\n]{1,80}\]\s*)(\S[\s\S]*)$/u);
  const label = legal || numberedInlineHeading || blockquote || emojiLabel || markdownLabelBullet || bullet || bracketLabel
    ? null
    : raw.match(/^(\s*[가-힣A-Za-z][가-힣A-Za-z0-9 _/·()（）-]{0,30}[:：]\s*)(\S[\s\S]*)$/u);
  const match = legal || numberedInlineHeading || blockquote || emojiLabel || markdownLabelBullet || bullet || bracketLabel || label;
  if (!match || /^\s*(?:https?|mailto):/iu.test(raw)) return [piece];
  const prefix = match[1];
  const body = match[2];
  const start = Number(piece?.start) || 0;
  const quotedBody = !legal && isFullyQuotedSpan(body);
  return [
    {
      ...piece,
      text: prefix,
      sep: '',
      start,
      end: start + prefix.length,
      forceLockType: legal
        ? 'legal_clause_prefix'
        : (numberedInlineHeading
            ? 'heading_prefix'
            : (blockquote
                ? 'blockquote_prefix'
                : ((markdownLabelBullet || bullet) ? 'bullet_prefix' : 'label_prefix'))),
      forceSectionLabel: legal ? prefix.trim() : ''
    },
    {
      ...piece,
      text: body,
      start: start + prefix.length,
      end: Number(piece?.end) || (start + raw.length),
      forceEditable: quotedBody !== true,
      forceLockType: quotedBody ? 'quote' : undefined
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
    minimumCount: Number(value?.minimumCount) || 0,
    maxBareLimit: Number(value?.maxBareLimit) || 0,
    maxSentenceLimit: Number(value?.maxSentenceLimit) || 0
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
  // 제목 다음의 들여쓰기는 다음 목록 행의 소유다. 줄바꿈 개수만 돌려주면
  // `\n  * 하위 항목`의 두 칸이 사라져 목록 계층이 평탄화된다. 원문을 이미
  // LF로 정규화했으므로 실제 구분자와 들여쓰기를 그대로 복원한다.
  return whitespace || '\n';
}

function buildCohesiveParagraphMergePlan(paragraphs, { enabled = false, semanticProseRoles = false, readabilityOptions = {} } = {}) {
  const rows = Array.isArray(paragraphs) ? paragraphs.map(value => String(value || '').trim()).filter(Boolean) : [];
  if (!enabled || !semanticProseRoles || rows.length < 4) {
    return { applicable: false, targetCount: rows.length, mergeCount: 0 };
  }
  if (rows.some(paragraph => layoutStructure.isStructureDominatedParagraph(paragraph))) {
    return { applicable: false, targetCount: rows.length, mergeCount: 0 };
  }
  const maximumMerges = Math.max(1, Math.floor(rows.length * 0.25));
  let mergeCount = 0;
  let previousMerged = false;
  for (let index = 0; index < rows.length - 1 && mergeCount < maximumMerges; index += 1) {
    if (previousMerged) {
      previousMerged = false;
      continue;
    }
    if (!isCohesiveShortParagraphPair(rows[index], rows[index + 1], readabilityOptions)) continue;
    mergeCount += 1;
    previousMerged = true;
  }
  return {
    applicable: mergeCount > 0,
    targetCount: rows.length - mergeCount,
    mergeCount
  };
}

function findCohesiveMergeCandidate(paragraphs, protectedBlocks, readabilityOptions = {}) {
  let selected = null;
  for (let index = 0; index < paragraphs.length - 1; index += 1) {
    if (touchesProtectedBlock(paragraphs[index], protectedBlocks)
        || touchesProtectedBlock(paragraphs[index + 1], protectedBlocks)
        || !isCohesiveShortParagraphPair(paragraphs[index], paragraphs[index + 1], readabilityOptions)) continue;
    const mergedLength = bare(`${paragraphs[index]} ${paragraphs[index + 1]}`).length;
    if (!selected || mergedLength < selected.length) selected = { index, separator: ' ', length: mergedLength };
  }
  return selected;
}

function isCohesiveShortParagraphPair(leftValue, rightValue, readabilityOptions = {}) {
  const left = String(leftValue || '').trim();
  const right = String(rightValue || '').trim();
  if (!left || !right) return false;
  const leftSentences = splitSentences(left).filter(Boolean);
  const rightSentences = splitSentences(right).filter(Boolean);
  if (!leftSentences.length || !rightSentences.length
      || leftSentences.length > 2 || rightSentences.length > 2
      || bare(left).length > 220 || bare(right).length > 220) return false;
  const merged = `${left} ${right}`;
  if (layoutStructure.measureParagraphReadability([merged], readabilityOptions).overlongCount > 0) return false;
  const rightStart = rightSentences[0];
  const explicitContinuation = /^(?:또한|그리고|이어서|이와\s*함께|이를\s*통해|이\s*과정에서|그\s*결과|이러한|이런|구체적으로|특히|예를\s*들어|따라서)(?=$|[\s,])/u
    .test(rightStart);
  return explicitContinuation || paragraphTopicOverlap(leftSentences.at(-1), rightStart) >= 0.18;
}

function paragraphTopicOverlap(left, right) {
  const stop = new Set(['그리고', '또한', '하지만', '그러나', '따라서', '통해', '위해', '대한', '있는', '하는', '했다', '합니다']);
  const tokens = value => new Set((String(value || '').match(/[가-힣]{2,}|[A-Za-z]{3,}/gu) || [])
    .map(token => token.toLocaleLowerCase('ko-KR').replace(/(?:에서는|으로는|에게는|에서|으로|에게|까지|부터|하는|했다|합니다|은|는|이|가|을|를|의|에|로)$/u, ''))
    .filter(token => token.length >= 2 && !stop.has(token)));
  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  if (!leftTokens.size || !rightTokens.size) return 0;
  let shared = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) shared += 1;
  return shared / Math.max(1, Math.min(leftTokens.size, rightTokens.size));
}

function findMergeCandidate(paragraphs, protectedBlocks, readabilityOptions = {}) {
  let selected = null;
  let selectedLength = Infinity;
  for (let index = 0; index < paragraphs.length - 1; index += 1) {
    const protectedPair = touchesProtectedBlock(paragraphs[index], protectedBlocks)
      || touchesProtectedBlock(paragraphs[index + 1], protectedBlocks);
    if (protectedPair
        || layoutStructure.isStructureDominatedParagraph(paragraphs[index])
        || layoutStructure.isStructureDominatedParagraph(paragraphs[index + 1])) continue;
    const merged = `${paragraphs[index].trim()} ${paragraphs[index + 1].trim()}`;
    const mergedReadability = layoutStructure.measureParagraphReadability([merged], readabilityOptions);
    if (mergedReadability.overlongCount > 0) continue;
    const score = bare(merged).length;
    if (score < selectedLength) {
      selected = { index, separator: ' ' };
      selectedLength = score;
    }
  }
  return selected;
}

function findSplitCandidate(paragraphs, protectedBlocks, readabilityOptions = {}) {
  const ranked = paragraphs
    .map((paragraph, index) => ({ paragraph, index, length: bare(paragraph).length }))
    // 참고문헌 제목과 인용 항목이 하나의 잠금 청크로 합쳐진 뒤 읽기 문단
    // 단계에서 다시 나뉠 수 있다. 잠금 블록의 일부인 문단도 일반 산문
    // 가독성 분할 재료로 사용하지 않는다.
    .filter(item => !touchesProtectedBlock(item.paragraph, protectedBlocks))
    // 여러 목록 행·표·조문이 한 읽기 단위에 들어 있으면 문장 분리기가
    // 행 구분자를 공백으로 다시 조립할 수 있다. 구조 단위는 레이아웃
    // 가독성 목표를 채우는 재료로 사용하지 않는다.
    .filter(item => !layoutStructure.isStructureDominatedParagraph(item.paragraph))
    .sort((a, b) => b.length - a.length);
  for (const item of ranked) {
    const sentences = splitSentences(item.paragraph);
    if (sentences.length < 2) continue;
    const splitIndex = selectReadableSplitIndex(sentences, readabilityOptions.profileName || '');
    const left = sentences.slice(0, splitIndex).join(' ').trim();
    const right = sentences.slice(splitIndex).join(' ').trim();
    if (left && right) return { index: item.index, left, right };
  }
  return null;
}

function selectReadableSplitIndex(sentences, profileName = '') {
  const rows = (sentences || []).map(sentence => String(sentence || '').trim()).filter(Boolean);
  if (rows.length < 2) return 1;
  const lengths = rows.map(sentence => Math.max(1, bare(sentence).length));
  const total = lengths.reduce((sum, length) => sum + length, 0);
  const minimumSide = Math.max(24, Math.floor(total * 0.16));
  let running = 0;
  let best = null;
  for (let index = 1; index < rows.length; index += 1) {
    running += lengths[index - 1];
    const right = total - running;
    if (running < minimumSide || right < minimumSide) continue;
    const previousKind = semanticTransitionKind(rows[index - 1], profileName);
    const nextKind = semanticTransitionKind(rows[index], profileName);
    let semanticScore = 0;
    if (previousKind === 'backward_takeaway') semanticScore += 150;
    if (nextKind === 'backward_takeaway') semanticScore -= 130;
    if (['topic_shift', 'context', 'experience', 'workstream', 'contrast', 'conclusion'].includes(nextKind)) semanticScore += 125;
    else if (['evidence', 'development'].includes(nextKind)) semanticScore += 80;
    const balance = Math.min(running, right) / Math.max(1, total);
    const cohesionScore = Math.max(-28, Math.min(28, paragraphBoundaryCohesionScore(rows, index)));
    const score = semanticScore
      + cohesionScore
      + balance * 24
      - (Math.abs(running - right) / Math.max(1, total)) * 8;
    if (!best || score > best.score) best = { index, score };
  }
  if (best) return best.index;
  let fallback = 1;
  let fallbackDistance = Infinity;
  running = 0;
  for (let index = 1; index < rows.length; index += 1) {
    running += lengths[index - 1];
    const distance = Math.abs(running - total / 2);
    if (distance < fallbackDistance) {
      fallback = index;
      fallbackDistance = distance;
    }
  }
  return fallback;
}

function realignTwoParagraphBoundary(paragraphs, sentences, profileName = '') {
  if ((paragraphs || []).length !== 2 || (sentences || []).length < 6) {
    return { applied: false, text: (paragraphs || []).join('\n\n') };
  }
  const currentBoundary = splitSentences(paragraphs[0]).map(value => String(value || '').trim()).filter(Boolean).length;
  const proposedBoundary = selectReadableSplitIndex(sentences, profileName);
  if (proposedBoundary === currentBoundary
      || proposedBoundary < 2
      || proposedBoundary > sentences.length - 2) {
    return { applied: false, text: paragraphs.join('\n\n') };
  }
  const currentKind = semanticTransitionKind(sentences[currentBoundary], profileName);
  const proposedKind = semanticTransitionKind(sentences[proposedBoundary], profileName);
  const currentScore = paragraphBoundaryCohesionScore(sentences, currentBoundary)
    + (currentKind ? 35 : 0);
  const proposedScore = paragraphBoundaryCohesionScore(sentences, proposedBoundary)
    + (proposedKind ? 35 : 0);
  // 모델이 만든 기존 빈 줄도 약한 장르 신호다. 단순 균형 차이가 아니라
  // 주제 응집도나 명시적 역할 전환이 충분히 나아질 때만 경계를 옮긴다.
  if (proposedScore < currentScore + 24) {
    return { applied: false, text: paragraphs.join('\n\n') };
  }
  return {
    applied: true,
    text: normalizeParagraphWhitespace([
      sentences.slice(0, proposedBoundary).join(' '),
      sentences.slice(proposedBoundary).join(' ')
    ].join('\n\n'))
  };
}

function paragraphBoundaryCohesionScore(sentences, index) {
  const rows = (sentences || []).map(value => String(value || '').trim()).filter(Boolean);
  if (index <= 0 || index >= rows.length) return -100;
  const leftWithin = index >= 2 ? lexicalCohesion(rows[index - 2], rows[index - 1]) : 0;
  const rightWithin = index + 1 < rows.length ? lexicalCohesion(rows[index], rows[index + 1]) : 0;
  const cross = lexicalCohesion(rows[index - 1], rows[index]);
  const leftContext = rows.slice(Math.max(0, index - 2), index).join(' ');
  const rightContext = rows.slice(index, Math.min(rows.length, index + 2)).join(' ');
  const contextCross = lexicalCohesion(leftContext, rightContext);
  return (leftWithin + rightWithin) * 52 - cross * 82 - contextCross * 28;
}

function lexicalCohesion(left, right) {
  const a = new Set(cohesionTokens(left));
  const b = new Set(cohesionTokens(right));
  if (!a.size || !b.size) return 0;
  const shared = [...a].filter(token => b.has(token)).length;
  return shared / Math.max(1, Math.min(a.size, b.size));
}

function cohesionTokens(value) {
  const stop = new Set([
    '그리고', '그러나', '하지만', '따라서', '또한', '이후', '다음', '통해',
    '위해', '대한', '관련', '경우', '과정', '수행', '진행', '했습니다', '하였습니다'
  ]);
  return (String(value || '').match(/[가-힣]{2,}|[A-Za-z]{2,}|\d+(?:\.\d+)?/gu) || [])
    .map(token => token.toLowerCase().replace(
      /(?:하였습니다|했습니다|하였다|했다|에서는|으로는|에게는|이라는|으로|에서|에게|보다|처럼|하고|하며|하여|된|한|은|는|이|가|을|를|의|에|도|만|와|과|로)$/u,
      ''
    ))
    .filter(token => token.length >= 2 && !stop.has(token));
}

function touchesProtectedBlock(paragraph, protectedBlocks) {
  const normalized = bare(paragraph);
  if (!normalized) return false;
  for (const block of protectedBlocks || []) {
    if (normalized === block) return true;
    // 보호 인용이 일반 산문 문장 안에 포함된 경우에는 문단 전체를 잠그지
    // 않는다. 반대로 큰 참고문헌·표 잠금 청크가 읽기 문단 단계에서 일부로
    // 나뉜 경우에는 그 부분 문단도 다시 쪼개지 않는다.
    if (normalized.length >= 12 && String(block || '').includes(normalized)) return true;
  }
  return false;
}

function splitParagraphs(value) {
  return layoutStructure.splitReadableParagraphs(value);
}

function isFullyQuotedSpan(value) {
  const text = String(value || '').trim();
  return text.length >= 2
    && text.length <= 2400
    && /^(?:["“][^"”\n]+["”]|['‘][^'’\n]+['’]|「[^」\n]+」|『[^』\n]+』|《[^》\n]+》|〈[^〉\n]+〉)$/u.test(text);
}

function restorePolishLineSeparatorPattern(source, outputText) {
  const sourceLines = normalizeNewlines(source).split('\n');
  const outputLines = normalizeNewlines(outputText).split('\n');
  const sourceContentIndexes = sourceLines
    .map((line, index) => (String(line || '').trim() ? index : -1))
    .filter(index => index >= 0);
  const outputContent = outputLines
    .map(line => String(line || '').trim())
    .filter(Boolean);
  if (sourceContentIndexes.length < 2) {
    return {
      applicable: false,
      text: String(outputText || ''),
      applied: false,
      contentPreserved: true,
      repairedBoundaryCount: 0,
      reason: 'single_source_line'
    };
  }
  if (sourceContentIndexes.length !== outputContent.length) {
    return {
      applicable: false,
      text: String(outputText || ''),
      applied: false,
      contentPreserved: true,
      repairedBoundaryCount: 0,
      reason: 'line_count_mismatch'
    };
  }

  let text = outputContent[0];
  for (let index = 1; index < outputContent.length; index += 1) {
    const sourceGap = sourceContentIndexes[index] - sourceContentIndexes[index - 1];
    text += `${sourceGap >= 2 ? '\n\n' : '\n'}${outputContent[index]}`;
  }
  text = normalizeParagraphWhitespace(text);
  const before = normalizeParagraphWhitespace(outputText);
  return {
    applicable: true,
    text,
    applied: text !== before,
    contentPreserved: bare(text) === bare(before),
    repairedBoundaryCount: countLineSeparatorDifferences(before, text),
    reason: text !== before ? 'restored' : 'already_exact'
  };
}

function countLineSeparatorDifferences(left, right) {
  const separators = value => (normalizeNewlines(value).match(/\n+/gu) || [])
    .map(item => Math.min(2, item.length));
  const before = separators(left);
  const after = separators(right);
  const size = Math.max(before.length, after.length);
  let count = 0;
  for (let index = 0; index < size; index += 1) {
    if (before[index] !== after[index]) count += 1;
  }
  return count;
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

function buildStructureAudit({
  source,
  integritySource,
  outputText,
  chunks,
  plan,
  boundaryRepair,
  layoutRepair
} = {}) {
  const locked = (chunks || []).filter(c => c.locked && String(c.text || '').trim());
  const output = String(outputText || '');
  const original = String(integritySource || source || '');
  const lost = [];
  const outOfOrder = [];
  let orderCursor = 0;
  for (const chunk of locked) {
    const value = String(chunk.text || '').trim();
    if (!value) continue;
    const exactLayout = EXACT_LAYOUT_LOCK_TYPES.has(String(chunk.lockType || ''));
    const orderedEquivalent = exactLayout
      ? findWhitespaceEquivalentSpan(output, value, orderCursor)
      : null;
    const orderedIndex = orderedEquivalent?.start ?? output.indexOf(value, orderCursor);
    if (orderedIndex >= 0) {
      orderCursor = orderedEquivalent?.end ?? (orderedIndex + value.length);
      continue;
    }
    const anywhereEquivalent = exactLayout
      ? findWhitespaceEquivalentSpan(output, value, 0)
      : null;
    if (anywhereEquivalent || output.includes(value)) {
      outOfOrder.push({ index: chunk.index, lockType: chunk.lockType || 'structure' });
      continue;
    }
    // 참고문헌·표·인용 등 exact 블록은 전체 내용이 공백·따옴표 등가로
    // 남아 있어야 한다. 앞 80자만 같으면 긴 레코드의 꼬리 절단을 놓치므로
    // 접두사 완화는 제목·라벨 같은 비-exact 구조에만 허용한다.
    if (exactLayout) {
      lost.push({
        index: chunk.index,
        lockType: chunk.lockType || 'structure',
        text: value.slice(0, 160)
      });
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
  const structuralSignature = compareStructuralRoleSignatures(source, output);
  const originalMarkers = compareOriginalStructuralMarkers(original, output);
  const bracketedLabelLayout = compareBracketedLabelLayout(original, output);
  const lineAnchorLayout = compareLineAnchorLayout(original, output);
  const exactLinePolicy = (chunks || []).some(chunk => String(chunk?.lineBoundaryPolicy || '') === 'all');
  const exactLineStructure = exactLinePolicy
    ? auditExactLineStructure(original, output)
    : { pass: true, applicable: false };
  const introducedOrphanParticleBoundaryCount = Math.max(
    0,
    countOrphanParticleLineBoundaries(output) - countOrphanParticleLineBoundaries(original)
  );
  const protectedBlockChangedCount = lost
    .filter(item => EXACT_LAYOUT_LOCK_TYPES.has(String(item.lockType || '')))
    .length;
  return {
    version: VERSION,
    enabled: true,
    sourceChars: String(source || '').length,
    chunkCount: (chunks || []).length,
    lockedCount: locked.length,
    lockedByType: counts,
    lostLockedCount: lost.length,
    lostLocked: lost.slice(0, 20),
    protectedBlockChangedCount,
    lockedOrderChanged: outOfOrder.length > 0,
    lockedOutOfOrderCount: outOfOrder.length,
    lockedOutOfOrder: outOfOrder.slice(0, 20),
    boundaryRepair: boundaryRepair || { applied: false, count: 0, repairs: [] },
    layoutRepair: compactLayoutRepair(layoutRepair),
    unsafeBoundaryCount: boundaryWarnings.length,
    unsafeBoundaries: boundaryWarnings.slice(0, 20),
    sectionPathErrorCount: sectionPathErrors.length,
    sectionPathErrors: sectionPathErrors.slice(0, 20),
    structureSignaturePass: structuralSignature.pass,
    structuralRoleLossCount: structuralSignature.losses.length,
    structuralRoleLosses: structuralSignature.losses,
    tableColumnOwnershipPass: structuralSignature.tableColumnOwnershipPass !== false,
    tableColumnOwnershipLossCount: Number(structuralSignature.tableColumnOwnershipLossCount || 0),
    sourceStructuralSignature: structuralSignature.source,
    outputStructuralSignature: structuralSignature.output,
    originalStructurePass: originalMarkers.pass
      && lineAnchorLayout.pass
      && exactLineStructure.pass
      && introducedOrphanParticleBoundaryCount === 0,
    originalStructuralMarkerCount: originalMarkers.sourceCount,
    originalStructuralMarkerLossCount: originalMarkers.losses.length,
    originalStructuralMarkerLosses: originalMarkers.losses,
    bracketedLabelLayoutPass: bracketedLabelLayout.pass,
    bracketedLabelSourceCount: bracketedLabelLayout.sourceCount,
    bracketedLabelOutputCount: bracketedLabelLayout.outputCount,
    bracketedLabelLossCount: bracketedLabelLayout.losses.length,
    bracketedLabelBoundaryChangeCount: bracketedLabelLayout.boundaryChanges.length,
    bracketedLabelLosses: bracketedLabelLayout.losses,
    bracketedLabelBoundaryChanges: bracketedLabelLayout.boundaryChanges,
    lineAnchorLayoutPass: lineAnchorLayout.pass,
    lineAnchorSourceCount: lineAnchorLayout.sourceCount,
    lineAnchorOutputCount: lineAnchorLayout.outputCount,
    lineAnchorLossCount: lineAnchorLayout.losses.length,
    lineAnchorBoundaryChangeCount: lineAnchorLayout.boundaryChanges.length,
    lineAnchorLosses: lineAnchorLayout.losses,
    lineAnchorBoundaryChanges: lineAnchorLayout.boundaryChanges,
    exactLineStructurePass: exactLineStructure.pass,
    exactLineStructureApplicable: exactLineStructure.applicable === true,
    exactLineSourceCount: Number(exactLineStructure.sourceLineCount || 0),
    exactLineOutputCount: Number(exactLineStructure.outputLineCount || 0),
    exactNonEmptySourceCount: Number(exactLineStructure.sourceNonEmptyLineCount || 0),
    exactNonEmptyOutputCount: Number(exactLineStructure.outputNonEmptyLineCount || 0),
    introducedOrphanParticleBoundaryCount,
    pass: lost.length === 0
      && outOfOrder.length === 0
      && boundaryWarnings.length === 0
      && sectionPathErrors.length === 0
      && structuralSignature.pass
      && originalMarkers.pass
      && bracketedLabelLayout.pass
      && lineAnchorLayout.pass
      && exactLineStructure.pass
      && introducedOrphanParticleBoundaryCount === 0
      && layoutRepair?.pass !== false
  };
}

/**
 * 제목·부제·날짜·라벨은 문자열이 남는 것뿐 아니라 같은 행에 묶여 있어야
 * 구조가 보존된다. 역할 개수만 비교하면 제목을 앞 문단에 붙이거나 이모지와
 * 라벨을 서로 다른 행으로 갈라도 통과하므로 원문 행 앵커를 순서대로 대조한다.
 */
function compareLineAnchorLayout(source, output) {
  const sourceAnchors = extractLineAnchors(source);
  const outputLines = layoutStructure.buildLineRecords(output).filter(record => !record.blank);
  const losses = [];
  const boundaryChanges = [];
  let cursor = 0;
  for (const anchor of sourceAnchors) {
    let found = -1;
    for (let index = cursor; index < outputLines.length; index += 1) {
      const outputKey = anchor.standalone
        ? lineAnchorKey(outputLines[index].text)
        : lineAnchorPrefixKey(outputLines[index].text);
      if (anchor.standalone ? outputKey === anchor.key : outputKey.startsWith(anchor.key)) {
        found = index;
        break;
      }
    }
    if (found < 0) {
      const compactOutput = outputLines.map(line => lineAnchorKey(line.text)).join('');
      if (anchor.standalone && compactOutput.includes(anchor.key)) {
        boundaryChanges.push({
          kind: anchor.kind,
          sourceLineOrdinal: anchor.lineOrdinal,
          reason: 'standalone_anchor_merged_or_split'
        });
      } else {
        losses.push({
          kind: anchor.kind,
          sourceLineOrdinal: anchor.lineOrdinal,
          anchor: anchor.display.slice(0, 160)
        });
      }
      continue;
    }
    const line = outputLines[found];
    if (!anchor.standalone) {
      const outputKey = lineAnchorPrefixKey(line.text);
      if (!outputKey.startsWith(anchor.key) || outputKey.length <= anchor.key.length) {
        boundaryChanges.push({
          kind: anchor.kind,
          sourceLineOrdinal: anchor.lineOrdinal,
          outputLineOrdinal: line.index + 1,
          reason: 'inline_anchor_body_detached'
        });
      }
    }
    cursor = found + 1;
  }
  return {
    pass: losses.length === 0 && boundaryChanges.length === 0,
    sourceCount: sourceAnchors.length,
    outputCount: extractLineAnchors(output).length,
    losses: losses.slice(0, 20),
    boundaryChanges: boundaryChanges.slice(0, 20)
  };
}

function extractLineAnchors(value) {
  const anchors = [];
  for (const record of layoutStructure.buildLineRecords(value)) {
    if (record.blank) continue;
    const role = String(record.role || '');
    if (['title', 'heading', 'signature'].includes(role)) {
      anchors.push({
        kind: role,
        key: lineAnchorKey(record.text),
        display: String(record.text || ''),
        standalone: true,
        lineOrdinal: record.index + 1
      });
      continue;
    }
    if (role !== 'label_inline') continue;
    const text = String(record.text || '');
    const colonPositions = [text.indexOf(':'), text.indexOf('：')].filter(index => index >= 0);
    const colon = colonPositions.length ? Math.min(...colonPositions) : -1;
    if (colon < 0) continue;
    const prefix = text.slice(0, colon + 1);
    anchors.push({
      kind: 'label_inline',
      key: lineAnchorKey(prefix),
      display: prefix,
      standalone: false,
      lineOrdinal: record.index + 1
    });
  }
  return anchors.filter(anchor => anchor.key.length >= 2);
}

function lineAnchorKey(value) {
  return String(value || '').normalize('NFKC').replace(/[\s\u200B\uFEFF]+/gu, '');
}

function lineAnchorPrefixKey(value) {
  return lineAnchorKey(value);
}

function auditExactLineStructure(source, output) {
  const sourceRecords = layoutStructure.buildLineRecords(source);
  const outputRecords = layoutStructure.buildLineRecords(output);
  const sourceBlankPattern = sourceRecords.map(record => record.blank ? '0' : '1').join('');
  const outputBlankPattern = outputRecords.map(record => record.blank ? '0' : '1').join('');
  const sourceNonEmptyLineCount = sourceRecords.filter(record => !record.blank).length;
  const outputNonEmptyLineCount = outputRecords.filter(record => !record.blank).length;
  return {
    applicable: true,
    pass: sourceRecords.length === outputRecords.length
      && sourceNonEmptyLineCount === outputNonEmptyLineCount
      && sourceBlankPattern === outputBlankPattern,
    sourceLineCount: sourceRecords.length,
    outputLineCount: outputRecords.length,
    sourceNonEmptyLineCount,
    outputNonEmptyLineCount,
    blankPatternPass: sourceBlankPattern === outputBlankPattern
  };
}

/**
 * 자기소개서의 `[소제목]`, `[지원동기]` 표식은 문자열이 남아 있기만 해서는
 * 충분하지 않다. 서로 다른 행이 한 행으로 합쳐지면 항목 계층이 무너지므로
 * 원문 라벨의 순서와 소제목의 독립 행 계약을 함께 검사한다.
 */
function compareBracketedLabelLayout(source, output) {
  const sourceAnchors = extractBracketedLabelAnchors(source);
  const outputText = normalizeNewlines(output);
  if (!sourceAnchors.length) {
    return {
      pass: true,
      sourceCount: 0,
      outputCount: extractBracketedLabelAnchors(outputText).length,
      losses: [],
      boundaryChanges: []
    };
  }

  const losses = [];
  const boundaryChanges = [];
  const matched = [];
  let cursor = 0;
  for (const anchor of sourceAnchors) {
    const index = outputText.indexOf(anchor.anchor, cursor);
    if (index < 0) {
      losses.push({
        label: anchor.label,
        lineOrdinal: anchor.lineOrdinal,
        anchor: anchor.anchor.slice(0, 180)
      });
      continue;
    }
    const lineOrdinal = outputText.slice(0, index).split('\n').length;
    const lineStart = outputText.lastIndexOf('\n', index - 1) + 1;
    const lineEndAt = outputText.indexOf('\n', index + anchor.anchor.length);
    const lineEnd = lineEndAt < 0 ? outputText.length : lineEndAt;
    const outputLine = outputText.slice(lineStart, lineEnd).trim();
    matched.push({ ...anchor, outputLineOrdinal: lineOrdinal });
    if (anchor.standalone && outputLine !== anchor.anchor) {
      boundaryChanges.push({
        label: anchor.label,
        sourceLineOrdinal: anchor.lineOrdinal,
        outputLineOrdinal: lineOrdinal,
        reason: 'standalone_heading_merged'
      });
    }
    cursor = index + anchor.anchor.length;
  }

  for (let index = 1; index < matched.length; index += 1) {
    const previous = matched[index - 1];
    const current = matched[index];
    if (previous.lineOrdinal === current.lineOrdinal) continue;
    if (previous.outputLineOrdinal === current.outputLineOrdinal) {
      boundaryChanges.push({
        label: current.label,
        sourceLineOrdinal: current.lineOrdinal,
        outputLineOrdinal: current.outputLineOrdinal,
        reason: 'separate_labels_merged'
      });
    }
  }

  return {
    pass: losses.length === 0 && boundaryChanges.length === 0,
    sourceCount: sourceAnchors.length,
    outputCount: extractBracketedLabelAnchors(outputText).length,
    losses: losses.slice(0, 20),
    boundaryChanges: boundaryChanges.slice(0, 20)
  };
}

function extractBracketedLabelAnchors(value) {
  const anchors = [];
  normalizeNewlines(value).split('\n').forEach((line, index) => {
    const text = String(line || '').trim();
    const parts = layoutStructure.bracketLabelParts(text);
    if (!parts) return;
    const standalone = layoutStructure.isBracketHeadingLine(text);
    anchors.push({
      label: parts.label,
      anchor: standalone ? text : parts.prefix.trim(),
      standalone,
      lineOrdinal: index + 1
    });
  });
  return anchors;
}

/**
 * 전처리된 청크가 아니라 사용자가 제출한 구조 행의 번호·기호도 최종본과
 * 순서대로 대조한다. 역할 개수만 비교하면 `# 14.`가 `# 1.`과 `4.`로
 * 갈라져도 제목 수가 늘었다는 이유로 통과할 수 있다.
 */
function compareOriginalStructuralMarkers(source, output) {
  const sourceMarkers = extractOriginalStructuralMarkers(source);
  const outputMarkers = extractOriginalStructuralMarkers(output);
  const losses = [];
  let cursor = 0;
  for (const marker of sourceMarkers) {
    let found = -1;
    for (let index = cursor; index < outputMarkers.length; index += 1) {
      if (outputMarkers[index].key === marker.key) {
        found = index;
        break;
      }
    }
    if (found < 0) {
      losses.push(marker);
      continue;
    }
    cursor = found + 1;
  }
  return {
    pass: losses.length === 0,
    sourceCount: sourceMarkers.length,
    outputCount: outputMarkers.length,
    losses: losses.slice(0, 20),
    source: sourceMarkers,
    output: outputMarkers
  };
}

function extractOriginalStructuralMarkers(value) {
  const markers = [];
  const lines = normalizeNewlines(value).split('\n');
  lines.forEach((line, index) => {
    const text = String(line || '');
    let match = text.match(/^\s*(#{1,6})\s*(\d{1,3}(?:\.\d{1,3}){0,3}[.)]?)\s+/u);
    if (match) {
      markers.push(structuralMarker('markdown_number', `${match[1]} ${match[2]}`, index));
      return;
    }
    match = text.match(/^\s*(\d{1,3}(?:\.\d{1,3}){0,3}[.)])\s+/u);
    if (match) {
      markers.push(structuralMarker('number', match[1], index));
      return;
    }
    match = text.match(/^\s*([①-⑳]|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+[.)．]?|[IVX]{1,8}[.)．])\s*/u);
    if (match) {
      markers.push(structuralMarker('ordinal', match[1], index));
      return;
    }
    match = text.match(/^\s*(제\s*\d{1,3}\s*(?:장|절|항|조)(?:의\s*\d{1,3})?)/u);
    if (match) {
      markers.push(structuralMarker('legal_or_section', match[1].replace(/\s+/gu, ''), index));
      return;
    }
    match = text.match(/^\s*([-*+•▪◦·])\s+|^\s*([●○■□◆◇▶▷※])\s*|^\s*(\+)(?=[가-힣A-Za-z“"'‘「『《〈])/u);
    if (match) markers.push(structuralMarker('bullet', match[1] || match[2] || match[3], index));
  });
  return markers;
}

function structuralMarker(kind, marker, lineIndex) {
  const normalized = String(marker || '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
  return {
    kind,
    marker: normalized,
    key: `${kind}:${normalized}`,
    lineOrdinal: lineIndex + 1
  };
}

function countOrphanParticleLineBoundaries(value) {
  return (
    normalizeNewlines(value).match(
      /[가-힣]\s*\n+\s*(?:에서는|에서도|에서만|에게는|에게도|에게만|으로는|으로도|으로만|로는|로도|로만|에는|에도|에만|부터는|부터도|부터만|까지는|까지도|까지만|은|는|이|가|을|를|와|과|의|도|만|에|에서|으로|로|에게|께서|부터|까지|보다)(?=$|\s|[,.;:!?。！？])/gu
    ) || []
  ).length;
}

function compareStructuralRoleSignatures(source, output) {
  const sourceSignature = structuralRoleSignature(source);
  const outputSignature = structuralRoleSignature(output);
  const losses = [];
  for (const key of Object.keys(sourceSignature)) {
    if (key === 'tableCellSequence') continue;
    const before = Number(sourceSignature[key] || 0);
    const after = Number(outputSignature[key] || 0);
    if (after < before) losses.push({ role: key, sourceCount: before, outputCount: after });
  }
  const sourceCells = sourceSignature.tableCellSequence || [];
  const outputCells = outputSignature.tableCellSequence || [];
  const tableColumnOwnershipPass = sourceCells.length === outputCells.length
    && sourceCells.every((count, index) => count === outputCells[index]);
  if (!tableColumnOwnershipPass && sourceCells.length > 0) {
    losses.push({
      role: 'tableCellSequence',
      code: 'table_column_ownership_lost',
      sourceCount: sourceCells.length,
      outputCount: outputCells.length,
      sourceSequence: sourceCells.slice(0, 40),
      outputSequence: outputCells.slice(0, 40)
    });
  }
  return {
    pass: losses.length === 0,
    source: sourceSignature,
    output: outputSignature,
    losses,
    tableColumnOwnershipPass,
    tableColumnOwnershipLossCount: tableColumnOwnershipPass ? 0 : 1
  };
}

function structuralRoleSignature(value) {
  const report = layoutStructure.analyzeLineStructure(value);
  const roles = report.roleCounts || {};
  return {
    titleHeading: Number(roles.title || 0) + Number(roles.heading || 0),
    label: Number(roles.label || 0) + Number(roles.label_inline || 0),
    list: Number(roles.list || 0),
    table: Number(roles.table || 0),
    flow: Number(roles.flow || 0),
    quote: Number(roles.quote || 0),
    code: Number(roles.code || 0),
    legalClause: Number(roles.legal_clause || 0),
    signature: Number(roles.signature || 0),
    tableCellSequence: Array.isArray(report.tableCellSequence)
      ? report.tableCellSequence.slice(0, 80)
      : []
  };
}

function findSectionPathErrors(chunks) {
  const errors = [];
  let currentSection = '';
  const sectionMarkerTypes = new Set([
    'heading',
    'heading_continuation',
    'title',
    'legal_clause',
    'legal_clause_prefix',
    // 평가 문항은 문제·정답·해설 표제가 자체 sectionPath를 만든다.
    // 이를 일반 잠금 행으로 건너뛰면 바로 뒤의 해설 본문을 이전 절로
    // 오인해 모든 정상 평가문에 section_path_mismatch가 생긴다.
    'assessment_heading',
    'assessment_answer_heading',
    'assessment_explanation_heading',
    'questionnaire_question'
  ]);
  for (const chunk of chunks || []) {
    const lockType = String(chunk?.lockType || '');
    if (chunk?.locked && sectionMarkerTypes.has(lockType)) {
      currentSection = String(chunk.sectionPath || '').trim()
        || lastStructuralLabel(chunk.text)
        || currentSection;
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

function lastStructuralLabel(value) {
  const lines = String(value || '').split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : '';
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
    finalLockedStructure: value.finalLockedStructure ? {
      applied: value.finalLockedStructure.applied === true,
      restoredCount: Number(value.finalLockedStructure.restoredCount) || 0,
      approximateRestoredCount: Number(value.finalLockedStructure.approximateRestoredCount) || 0,
      missingCount: Number(value.finalLockedStructure.missingCount) || 0,
      pass: value.finalLockedStructure.pass !== false
    } : null,
    paragraphs: value.paragraphs ? {
      applied: value.paragraphs.applied === true,
      policy: String(value.paragraphs.policy || 'none'),
      sourceCount: Number(value.paragraphs.sourceCount) || 0,
      beforeCount: Number(value.paragraphs.beforeCount) || 0,
      targetCount: Number(value.paragraphs.targetCount) || 0,
      afterCount: Number(value.paragraphs.afterCount) || 0,
      roleBoundaryCount: Number(value.paragraphs.roleBoundaryCount) || 0,
      sourceBoundaryRepairCount: Number(value.paragraphs.sourceBoundaryRepairCount) || 0,
      backwardConclusionRepairCount: Number(value.paragraphs.backwardConclusionRepairCount) || 0,
      paragraphAlignmentConfidence: Number(value.paragraphs.paragraphAlignmentConfidence) || 0,
      proseSplitCount: Number(value.paragraphs.proseSplitCount) || 0,
      visualGapRepairCount: Number(value.paragraphs.visualGapRepairCount) || 0,
      explicitParagraphCountBefore: Number(value.paragraphs.explicitParagraphCountBefore) || 0,
      explicitParagraphCountAfter: Number(value.paragraphs.explicitParagraphCountAfter) || 0,
      readability: value.paragraphs.readability ? {
        overlongCount: Number(value.paragraphs.readability.overlongCount) || 0,
        maxBare: Number(value.paragraphs.readability.maxBare) || 0,
        maxSentences: Number(value.paragraphs.readability.maxSentences) || 0,
        minimumCount: Number(value.paragraphs.readability.minimumCount) || 0,
        maxBareLimit: Number(value.paragraphs.readability.maxBareLimit) || 0,
        maxSentenceLimit: Number(value.paragraphs.readability.maxSentenceLimit) || 0
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

function isHeadingLine(s) {
  if (layoutStructure.isKnownHeadingLine(s)) return true;
  if (/^[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]\s*[.)．]?\s*\S.{0,100}$/.test(s)) return true;
  if (/^[IVX]{1,8}[.)．]\s*\S.{0,100}$/.test(s)) return true;
  const numberedBody = String(s || '').match(/^\d{1,2}[.)]\s*([\s\S]+)$/u)?.[1] || '';
  if (/^\d{1,2}(?:\.\d{1,2}){0,3}\s*[.)]?\s+\S.{0,100}$/u.test(s)
      && s.length <= 120
      && !(numberedBody.length >= 45 && layoutStructure.isSentenceComplete(numberedBody))) return true;
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

function sourceInlineSeparator(text, boundary, direction) {
  let start = boundary;
  let end = boundary;
  if (direction === 'before') {
    while (start > 0 && /\s/u.test(text[start - 1])) start -= 1;
  } else {
    while (end < text.length && /\s/u.test(text[end])) end += 1;
  }
  const whitespace = direction === 'before' ? text.slice(start, boundary) : text.slice(boundary, end);
  const newlineCount = (whitespace.match(/\n/gu) || []).length;
  if (newlineCount >= 2) return '\n\n';
  if (newlineCount === 1) return '\n';
  return whitespace ? ' ' : '';
}

function isRepeatedTocHeadingLine(value, state) {
  const key = String(value || '')
    .normalize('NFKC')
    .trim()
    .replace(/\.{2,}\s*\d+\s*$/u, '')
    .replace(/\s+/gu, ' ')
    .toLowerCase();
  return key.length >= 2
    && key.length <= 180
    && state?.tocEntryKeys instanceof Set
    && state.tocEntryKeys.has(key);
}

function shouldKeepAssessmentLineWhole(value, currentSection = 'protected') {
  const text = String(value || '').trim();
  if (!text) return false;
  const header = assessmentHeaderKind(text);
  if (header) return true;
  return currentSection !== 'explanation';
}

function splitAssessmentExplanationPiece(piece, currentSection = 'protected') {
  const raw = String(piece?.text || '');
  // 대괄호·겹낫표형 `[해설] 본문`, `[해설]: 본문`과 일반 라벨형
  // `해설: 본문`만 분리한다. `해설 내용은 ...` 같은 일반 산문은 건드리지 않는다.
  const explicit = raw.match(/^(\s*(?:(?:\[\s*(?:해설|풀이)\s*\]|【\s*(?:해설|풀이)\s*】)\s*[:：]?|(?:해설|풀이)\s*[:：]))([ \t]*)(\S[\s\S]*)$/u);
  const inferred = ['answer_key', 'explanation'].includes(String(currentSection || ''))
    ? raw.match(/^(\s*\d{1,3}[.)])([ \t]+)(\S[\s\S]*)$/u)
    : null;
  const match = explicit || inferred;
  if (!match) return null;
  const prefix = match[1];
  const separator = match[2] || '';
  const body = match[3];
  const start = Number(piece?.start || 0);
  const prefixEnd = start + prefix.length;
  return [
    {
      text: prefix,
      sep: separator,
      start,
      end: prefixEnd
    },
    {
      text: body,
      sep: piece?.sep || '',
      start: prefixEnd + separator.length,
      end: Number(piece?.end || (prefixEnd + separator.length + body.length))
    }
  ];
}

function assessmentLineInfo(value, state) {
  if (!state?.assessment) return null;
  const text = String(value || '').trim();
  const header = assessmentHeaderKind(text);
  if (header === 'explanation') {
    state.assessmentSection = 'explanation';
    return {
      locked: true,
      lockType: 'assessment_explanation_heading',
      sectionLabel: text
    };
  }
  if (header === 'answer') {
    state.assessmentSection = 'answer';
    return {
      locked: true,
      lockType: 'assessment_answer_heading',
      sectionLabel: text
    };
  }
  if (header === 'protected') {
    state.assessmentSection = 'protected';
    return {
      locked: true,
      lockType: 'assessment_heading',
      sectionLabel: text
    };
  }
  if (state.assessmentSection === 'answer' && isAssessmentAnswerKeyLine(text)) {
    state.assessmentSection = 'answer_key';
    return {
      locked: true,
      lockType: 'assessment_answer_key',
      sectionLabel: state.currentSection
    };
  }
  if (['answer_key', 'explanation'].includes(state.assessmentSection)
      && isAssessmentExplanationOrdinal(text)) {
    state.assessmentSection = 'explanation';
    return {
      locked: true,
      lockType: 'assessment_explanation_heading',
      sectionLabel: text
    };
  }
  if (state.assessmentSection === 'answer_key' && isAssessmentExplanationProse(text)) {
    state.assessmentSection = 'explanation';
    return null;
  }
  if (state.assessmentSection !== 'explanation') {
    return {
      locked: true,
      lockType: 'assessment_content',
      sectionLabel: state.currentSection
    };
  }
  return null;
}

function assessmentHeaderKind(value) {
  const text = String(value || '').trim();
  if (/^(?:[\[【]\s*)?(?:해설|풀이)(?:\s*[\]】])?(?:\s*[:：].*)?$/u.test(text)) return 'explanation';
  if (/^(?:[\[【]\s*)?(?:듣기|읽기|말하기|쓰기|어휘|문법|수능|모의|평가|시험)?\s*(?:평가\s*)?(?:문항|문제|지문)(?:\s*[\]】])?$/u.test(text)
      ) return 'protected';
  if (/^(?:[\[【]\s*)?(?:정답|답)(?:\s*[\]】])?(?:\s*[:：].*)?$/u.test(text)) return 'answer';
  return '';
}

function isAssessmentAnswerKeyLine(value) {
  const text = String(value || '').trim();
  return /^(?:\d{1,3}[.)]\s*(?:[①-⑳]|[A-E]|[가-마])\s*)+$/u.test(text)
    || /^(?:[①-⑳]|[A-E]|[가-마])(?:\s*[,/]\s*(?:[①-⑳]|[A-E]|[가-마]))*$/u.test(text);
}

function isAssessmentExplanationOrdinal(value) {
  return /^\d{1,3}[.)]$/u.test(String(value || '').trim());
}

function isAssessmentExplanationProse(value) {
  const text = String(value || '').trim();
  return text.length >= 24 && /[.!?。！？]$/u.test(text);
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
  return layoutStructure.isExplicitTableLine(s);
}

function isStatLine(s) {
  const text = String(s || '').trim();
  if (!text || text.length > 180) return false;
  const statisticalValue = /(?:^|[^가-힣A-Za-z0-9_])(?:p|r|R²|R2|F|t|β|B|SE|M|SD)\s*[<=>]\s*-?(?:\d+(?:\.\d+)?|\.\d+)(?=$|[^가-힣A-Za-z0-9_])/iu.test(text)
    || /(?:유의확률|표준오차|회귀계수|결정계수|상관계수)\s*[:=]?\s*-?(?:\d+(?:\.\d+)?|\.\d+)/u.test(text);
  if (!statisticalValue) return false;

  // 통계값을 설명하는 산문은 숫자·사실 감사의 보호를 받으면서 편집돼야
  // 한다. 통계 출력 한 행 또는 짧은 데이터 라벨처럼 보이는 경우에만
  // 구조 잠금을 적용한다.
  const sentenceCount = splitSentences(text).filter(Boolean).length;
  if (sentenceCount >= 2) return false;
  const proseEnding = /(?:다|요|니다|했다|하였다|되었다|였다|있다|없다|않다)[.!?。！？]?$/u.test(text);
  const rowLayout = /\t/u.test(text)
    || /\S\s{2,}\S/u.test(text)
    || /^(?:[가-힣A-Za-z][가-힣A-Za-z0-9 _/·()-]{0,32})\s*[:：]\s*/u.test(text);
  const multipleStatistics = (text.match(/(?:^|[^가-힣A-Za-z0-9_])(?:p|r|R²|R2|F|t|β|B|SE|M|SD)\s*[<=>]/giu) || []).length >= 2;
  return !proseEnding && (rowLayout || multipleStatistics);
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
  restoreLockedStructureLayout,
  restoreParagraphLayout,
  compareStructuralRoleSignatures,
  compareOriginalStructuralMarkers,
  compareBracketedLabelLayout,
  compareLineAnchorLayout,
  auditExactLineStructure,
  extractOriginalStructuralMarkers,
  countOrphanParticleLineBoundaries,
  isQuestionnaireQuestionLine,
  assessmentHeaderKind,
  shouldKeepAssessmentLineWhole,
  splitAssessmentExplanationPiece,
  isAssessmentAnswerKeyLine,
  isAssessmentExplanationOrdinal,
  splitEditablePrefixPiece,
  isStandaloneQuotedTitle,
  isFullyQuotedSpan,
  restoreExactLockedBlocks
};
