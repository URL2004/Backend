'use strict';

// Formula freezing protects the glyphs, not the prose that explains which
// coefficient and integrand belong to an even/odd signal. Keep this audit
// source-attested: it never "corrects" an unsupported claim in the source.
const PARAGRAPH_BOUNDARY = /\n\s*\n/u;
const RULES = {
  even: {
    coefficient: /b[_ₙ]?n|b_n/iu,
    integrand: /\bsin(?:e)?\b|사인/iu,
    wrongProof: /기함수와\s*(?:cos(?:ine)?|코사인)\s*(?:함수)?의?\s*곱/iu,
    rightProof: /우함수와\s*기함수를\s*곱[^.!?\n]*기함수|우함수[^.!?\n]*\bsin(?:e)?\b[^.!?\n]*곱[^.!?\n]*기함수/iu
  },
  odd: {
    coefficient: /a[_ₙ]?n|a_n/iu,
    integrand: /\bcos(?:ine)?\b|코사인/iu,
    wrongProof: /우함수와\s*(?:sin(?:e)?|사인)\s*(?:함수)?의?\s*곱/iu,
    rightProof: /기함수와\s*(?:cos(?:ine)?|코사인)\s*(?:함수)?의?\s*곱[^.!?\n]*기함수/iu
  }
};

function paragraphs(text) {
  return String(text || '').split(PARAGRAPH_BOUNDARY).filter(Boolean);
}

function focus(paragraph) {
  const first = String(paragraph || '').split(/[.!?]\s/u, 1)[0];
  const match = first.match(/우함수|기함수/gu);
  if (!match?.length) return '';
  return match[0] === '우함수' ? 'even' : 'odd';
}

function sentences(paragraph) {
  // This extractor only selects complete Korean explanatory sentences. It
  // avoids rewriting formulas, code, or an incomplete trailing fragment.
  return String(paragraph || '').match(/[^.!?\n]+[.!?]/gu) || [];
}

function findProof(paragraph, pattern) {
  return sentences(paragraph).find(sentence => pattern.test(sentence) && !/반면|반대로|대조하면/u.test(sentence))?.trim() || '';
}

function attestedProof(paragraph, pattern, type) {
  const sentence = findProof(paragraph, pattern);
  const match = pattern.exec(sentence);
  if (!match) return '';
  // A formula may precede the proof in the same sentence. Restore the proof
  // clause only, so a frozen formula is never moved or duplicated.
  const clause = type === 'even'
    ? sentence.search(/우함수와\s*기함수를\s*곱/iu)
    : sentence.search(/기함수와\s*(?:cos(?:ine)?|코사인)\s*(?:함수)?의?\s*곱/iu);
  return sentence.slice(clause >= 0 ? clause : match.index).trim();
}

function relationParagraph(paragraph, type) {
  const rule = RULES[type];
  return focus(paragraph) === type
    && rule.coefficient.test(paragraph)
    && rule.integrand.test(paragraph);
}

function auditTechnicalRelations(source, outputText) {
  if (!/우함수|기함수/u.test(source) || !/우함수|기함수/u.test(outputText)) {
    return { applicable: false, pass: true, issues: [] };
  }
  const sourceParagraphs = paragraphs(source);
  const outputParagraphs = paragraphs(outputText);
  const issues = [];
  for (const type of Object.keys(RULES)) {
    const rule = RULES[type];
    const attested = sourceParagraphs.filter(paragraph =>
      relationParagraph(paragraph, type) && findProof(paragraph, rule.rightProof));
    if (attested.length !== 1) continue;
    const targets = outputParagraphs.filter(paragraph => relationParagraph(paragraph, type));
    if (targets.length !== 1) continue;
    const wrongSentence = findProof(targets[0], rule.wrongProof);
    if (!wrongSentence) continue;
    // An explicit contrasting explanation may mention both parities. Do not
    // infer its intent from one matching phrase.
    if (findProof(targets[0], rule.rightProof)) continue;
    issues.push({ type, paragraph: targets[0], wrongSentence,
      sourceSentence: attestedProof(attested[0], rule.rightProof, type) });
  }
  return { applicable: true, pass: issues.length === 0, issues };
}

function restoreAttestedRelations(source, outputText) {
  const audit = auditTechnicalRelations(source, outputText);
  let text = String(outputText || '');
  let restoredCount = 0;
  for (const issue of audit.issues) {
    if (!issue.sourceSentence || !issue.wrongSentence) continue;
    if (/[0-9π∫Σ]/u.test(issue.sourceSentence)) continue;
    if (text.split(issue.paragraph).length !== 2) continue;
    const repairedParagraph = issue.paragraph.replace(issue.wrongSentence, issue.sourceSentence);
    if (repairedParagraph === issue.paragraph) continue;
    text = text.replace(issue.paragraph, repairedParagraph);
    restoredCount += 1;
  }
  return { text, applied: restoredCount > 0, restoredCount,
    before: audit, after: auditTechnicalRelations(source, text) };
}

module.exports = { auditTechnicalRelations, restoreAttestedRelations };
