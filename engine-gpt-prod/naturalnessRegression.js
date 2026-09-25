'use strict';

const { splitSentenceSpans } = require('../engine/koreanText');
const { syntaxSpans } = require('../engine/textSyntax');
const { sentenceSimilarity } = require('./sentenceAlignment');
const layout = require('./layoutStructure');

const FORMAL = new Set(['resume_application', 'academic_paper', 'report_assignment', 'long_explainer']);
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

// Source-relative review, not a ban on nominal clauses or on changing word order.
// Never use sentence length or edit percentage as proof of bad writing.
function auditNaturalnessRegression(source, output, profile = 'unknown') {
  const sources = proseSpans(source), outputs = proseSpans(output);
  const findings = sourceFrameRegressions(source, output);
  const sourceWords = /\p{Script=Han}/u.test(output)
    ? [...new Set(sources.flatMap(s=>s.text.match(/[가-힣]{3,24}/gu)||[]))] : [];
  for (const target of outputs) {
    // A newly introduced possessive must not replace the subject of
    // "도움이 되다". Require the original subject AND following local clause;
    // do not blanket-replace valid nominal phrases such as "교육의 도움 정도".
    for (const m of target.text.matchAll(/(?<![가-힣])([가-힣]{2,24})의(\s+도움이\s+될)\s+/gu)) {
      if (sources.some(s => s.text.includes(m[0]))) continue;
      const localTail = target.text.slice(m.index + m[0].length)
        .replace(/^것이라고\s+(?:본|답한|응답한|판단한)\s+/u, '것이라는 ');
      const tail = localTail.match(/^\S+\s+\S+/u)?.[0];
      if (!tail || tail.length < 6) continue;
      // A quoted prediction can be expressed as "것이라는 응답" or
      // "것이라고 본 응답". Their shared noun, not an exact surface string,
      // anchors the clause. Other complement nouns still do not match.
      const tailPattern = escape(tail).replace(/^것이라는 /u,
        '(?:것이라는|것이라고\\s+(?:본|답한|응답한|판단한))\\s+');
      const frame = new RegExp(`(?<![가-힣])${escape(m[1])}([이가])\\s+도움이\\s+될\\s+${tailPattern}`, 'u');
      const particles = new Set(sources.map(s => frame.exec(s.text)?.[1]).filter(Boolean));
      if (particles.size !== 1) continue;
      const code = 'introduced_help_subject_particle';
      const start = target.start + m.index + m[1].length;
      findings.push({code, ordinal:target.ordinal, repair:{start, end:start+1,
        replacement:[...particles][0], ordinal:target.ordinal, code}});
    }
    // A coordinated purpose must not become a completed first action plus
    // an unrelated purpose. Only restore a unique source nominal frame with
    // the same two actions and exact following proposition; no synonym guess.
    for (const m of target.text.matchAll(/(?<![가-힣])([가-힣]{2,24})(?:을|를)\s+([가-힣]{2,12})하고\s+([가-힣]{2,20}(?:\s+[가-힣]{2,20}){0,3})(을|를)\s+위해/gu)) {
      if (sources.some(s => s.text === target.text)) continue;
      const tail = target.text.slice(m.index + m[0].length).replace(/\s+/gu, '');
      if (tail.length < 8) continue;
      const frame = new RegExp(`(?<![가-힣])${escape(m[1])}\\s+${escape(m[2])}\\s*(?:및|과|와)\\s+${escape(m[3])}${m[4]}\\s+위해`, 'gu');
      const matches = sources.flatMap(s => [...s.text.matchAll(frame)].filter(found =>
        s.text.slice(found.index + found[0].length).replace(/\s+/gu, '') === tail
        && sentenceSimilarity(s.text, target.text) >= .65));
      if (matches.length !== 1) continue;
      const code = 'introduced_parallel_purpose_mismatch';
      findings.push({code, ordinal:target.ordinal, repair:{
        start:target.start+m.index, end:target.start+m.index+m[0].length,
        replacement:matches[0][0], ordinal:target.ordinal, code
      }});
    }
    // A role/description (X로서) is not a reason (X이므로). Restore only
    // the connector when one source sentence has the same noun and exact
    // following proposition, with a comparable preceding description.
    // Changed predicates, ambiguous sources, quotes and code are not guessed.
    for (const m of target.text.matchAll(/([가-힣]{2,24})(이므로|이기에|이기\s*때문에)\s+/gu)) {
      if (sources.some(span => span.text === target.text)) continue;
      const tail = target.text.slice(m.index + m[0].length).replace(/\s+/gu, '');
      if (tail.length < 12) continue;
      const role = new RegExp(`${escape(m[1])}(으로서|로서)\\s+`, 'gu');
      const matches = sources.flatMap(span => [...span.text.matchAll(role)]
        .filter(s => span.text.slice(s.index+s[0].length).replace(/\s+/gu, '') === tail
          && sentenceSimilarity(span.text,target.text) >= .65)
        .map(s => ({ span, connector:s[1] })));
      if (matches.length !== 1) continue;
      const code='introduced_role_causality';
      const start=target.start+m.index+m[1].length;
      findings.push({code,ordinal:target.ordinal,repair:{start,end:start+m[2].length,
        replacement:matches[0].connector,ordinal:target.ordinal,code}});
    }
    const frame = /^(나타날|발생할|기대할|얻을)\s+수\s+있는\s+(?:증상|변화|현상|결과|효과)(?:으로는|로는|은|는)\s+/u.exec(target.text);
    if (frame && new RegExp(`${frame[1]}\\s+수\\s+있(?:다|습니다)[.!?]?\\s*$`, 'u').test(target.text)) {
      const body = target.text.slice(frame[0].length);
      const sourceText = String(source), offset = sourceText.indexOf(body);
      // PDF paste can omit the space after the previous full stop. Require
      // the exact, uniquely located source sentence, even if coarse source
      // segmentation grouped it with that preceding sentence.
      const exactSource = offset >= 0 && sourceText.lastIndexOf(body) === offset
        && (offset === 0 || /[.!?。！？\s]/u.test(sourceText[offset-1]))
        && !syntaxSpans(sourceText).some(p => p.start < offset+body.length && p.end > offset);
      if (exactSource && !sourceText.includes(target.text)) {
        const code = 'introduced_predicate_echo_frame';
        findings.push({code, ordinal:target.ordinal, repair:{start:target.start,
          end:target.start+frame[0].length, replacement:'', ordinal:target.ordinal, code}});
      }
    }
    for(const word of target.text.matchAll(/[\p{Script=Han}가-힣]{3,24}/gu)) {
      const hanCount = (word[0].match(/\p{Script=Han}/gu)||[]).length;
      // Preserve native Chinese/Japanese and existing mixed notation. Only
      // a locally source-grounded substitution inside an otherwise Korean
      // word can be repaired; unrelated Han text elsewhere is not an exemption.
      if(!hanCount || hanCount > 3 || word[0].length-hanCount < 2
          || !sourceWords.length || String(source).includes(word[0])) continue;
      const pattern=new RegExp('^'+word[0].replace(/\p{Script=Han}/gu,'[가-힣]')+'$','u');
      const next=target.text.slice(word.index+word[0].length).match(/^\s+([가-힣]{2})/u)?.[1];
      if(!next)continue;
      const matches=sourceWords.filter(w=>pattern.test(w) && sources.some(s=>new RegExp(`(?<![가-힣])${w}\\s+${next}`,'u').test(s.text)));
      if(matches.length!==1)continue;
      const code='introduced_mixed_script_word';
      findings.push({code,ordinal:target.ordinal,repair:{start:target.start+word.index,end:target.start+word.index+word[0].length,replacement:matches[0],ordinal:target.ordinal,code}});
    }
    const nominal = [...target.text.matchAll(/(?<![가-힣])([가-힣]{2,24})는\s+일(?:을\s+이어가|부터\s+(?:탄탄히\s+)?시작하)/gu)];
    const condition = /려면\s*,?\s*[^.!?。！？]{5,180}고\s*싶(?:습니다|다|어요)/u.test(target.text)
      && !/(?:해야|필요|조건|전제|알리|묻|물어|알아보|설명|다고|라는)/u.test(target.text);
    const displaced = FORMAL.has(profile) && /^[^,\n]{8,100}도,\s*[^,\n]{5,100}고려해\s/u.test(target.text);
    const evidenceFrame = /^(?:(?:따라서|이에)\s+)?((?:이번|본|해당)\s+(?:탐구|연구|분석|조사|실험))에서는\s+([가-힣A-Za-z0-9]+(?:\s+[가-힣A-Za-z0-9]+){0,2})(?:은|는)\s/u.exec(target.text);
    const reflection = /(점|사실)은\s+(생각|관점|인식)을\s+(?:바꾸었다|바꿨다|바꾸었습니다|바꿨습니다)[.!?]?$/u.exec(target.text);
    if (!nominal.length && !condition && !displaced && !evidenceFrame && !reflection) continue;
    if (reflection) {
      // One source sentence can become two output sentences. Whole-sentence
      // similarity can rank a generic earlier sentence above the true source.
      // Require a unique, exact proposition tail AND the original experience
      // predicate instead of lowering the global alignment threshold.
      const tail = target.text.slice(0, reflection.index).trim().split(/\s+/u).slice(-4).join(' ');
      const compact = value => value.replace(/\s+/gu, '');
      const evidencePattern = /(점|사실)을\s+알게\s*되면서\s+(생각|관점|인식)이\s+(?:달라졌다|바뀌었다|달라졌습니다|바뀌었습니다)[.!?]?$/u;
      const matches = sources.map(span => ({span, evidence: evidencePattern.exec(span.text)}))
        .filter(({span,evidence}) => evidence && compact(tail).length >= 10
          && evidence[1] === reflection[1] && evidence[2] === reflection[2]
          && compact(span.text.slice(0, evidence.index)).endsWith(compact(tail)));
      if (matches.length === 1) {
        const code = 'introduced_reflection_agency_shift';
        findings.push({code, ordinal:target.ordinal, repair:{
          start:target.start+reflection.index, end:target.end,
          replacement:matches[0].evidence[0], ordinal:target.ordinal, code
        }});
      }
    }
    const ranked = sources.map(span => ({ span, score: sentenceSimilarity(span.text, target.text) }))
      .sort((a,b) => b.score-a.score);
    const best = ranked[0];
    if (!best || best.score < .5 || (ranked[1] && best.score-ranked[1].score < .1)) continue;
    const original = best.span.text;
    if (original === target.text) continue;
    // Restore the source's evidential frame, not arbitrary repeated 은/는.
    // Contrast topics and a setting already present in SOURCE are valid.
    if (evidenceFrame && /(?:결론\s*내|결론을\s*내|판단하|판단했|확인하|확인했)/u.test(target.text)
        && !/(?:반면|한편|각각|대조)/u.test(target.text)) {
      const sourceFrame = new RegExp(`${escape(evidenceFrame[1])}(?:을|를)\\s+통해(?=\\s)`, 'u').exec(original);
      const sourceTopic = new RegExp(`${escape(evidenceFrame[2])}(?:은|는)(?=\\s)`, 'u').test(original);
      if (sourceFrame && sourceTopic) {
        const start = target.start + target.text.indexOf(evidenceFrame[1]);
        const code = 'introduced_evidential_topic_frame';
        findings.push({ code, ordinal: target.ordinal, repair: {
          start, end: start + evidenceFrame[1].length + '에서는'.length,
          replacement: sourceFrame[0], ordinal: target.ordinal, code
        }});
      }
    }
    for (const match of nominal) {
      const stem = escape(match[1]);
      // Same action, same tense/modality. Continuing a real existing activity,
      // starting a new stage, contrasting occupations, etc. is not inflation.
      if (/(?:이어가|계속|지속|시작|하던|해\s*온|직업|생업)/u.test(original)) continue;
      const ending = target.text.slice(match.index + match[0].length).match(/^(고\s*싶(?:습니다|다|어요)|겠습니다)/u)?.[1];
      if (!ending) continue;
      const direct = new RegExp(`(?<![가-힣])${stem}${escape(ending)}`, 'u').exec(original);
      if (!direct) continue;
      findings.push({ code:'introduced_action_nominalization', ordinal:target.ordinal,
        // '부터 시작하다' changes particle scope too: only repair it when the
        // same multi-word object and direct predicate occur verbatim in SOURCE.
        repair: /일을\s+이어가/u.test(match[0]) ? {
          start:target.start+match.index, end:target.start+match.index+match[0].length,
          replacement:match[1], ordinal:target.ordinal, code:'introduced_action_nominalization'
        } : groundedStartRepair(original, target, match, ending) });
    }
    if (condition && !/려면/u.test(original)) {
      findings.push({code:'introduced_condition_wish_mismatch',ordinal:target.ordinal});
    }
    if (displaced) {
      const modifier = target.text.match(/도,\s*([^,\n]{5,100}고려해)\s/u)?.[1];
      if (modifier && original.startsWith(modifier)
          && !/(?:특히|반면|다만|무엇보다|만큼은)/u.test(original)) {
        findings.push({code:'introduced_modifier_dislocation',ordinal:target.ordinal});
      }
    }
  }
  return findings;
}

// Preserve source-backed local frames, including label bodies and the prose
// outside a quotation. A source example list is not redundant just because
// its class name survives. Never infer missing members of a partial list.
function sourceFrameRegressions(source, output) {
  const before=String(source || ''),after=String(output || ''),findings=[];
  const ss=splitSentenceSpans(before),os=splitSentenceSpans(after);
  const protectedBefore=syntaxSpans(before),protectedAfter=syntaxSpans(after);
  const blocked=(spans,start,end)=>spans.some(p=>['quote','code'].includes(p.spanType)&&p.start<end&&p.end>start);
  const lists=/(?<![가-힣A-Za-z0-9])((?:[가-힣A-Za-z][가-힣A-Za-z0-9/-]{1,23},\s*){2,}[가-힣A-Za-z][가-힣A-Za-z0-9/-]{1,23})\s+등\s+((?:각|여러|해당)\s+[가-힣]{2,16}?)(?=별|의|에|을|를|은|는|이|가|\s|[.,]|$)/gu;
  for(const m of before.matchAll(lists)) {
    if(blocked(protectedBefore,m.index,m.index+m[0].length))continue;
    const anchor=m[2],items=m[1].split(',').map(x=>x.trim());
    const locations=[...after.matchAll(new RegExp(escape(anchor),'gu'))];
    if(before.split(anchor).length!==2 || locations.length!==1)continue;
    const start=locations[0].index;
    if(blocked(protectedAfter,start,start+anchor.length))continue;
    const s=ss.find(x=>x.start<=m.index&&x.end>=m.index+m[0].length);
    const ordinal=os.findIndex(x=>x.start<=start&&x.end>=start+anchor.length),o=os[ordinal];
    if(!s||!o||items.some(item=>new RegExp(`(?<![가-힣A-Za-z0-9])${escape(item)}(?=$|[^가-힣A-Za-z0-9]|(?:에서|은|는|이|가|을|를|의|에|와|과|도)(?=$|[^가-힣A-Za-z0-9]))`,'u').test(after)))continue;
    const sourceBody=s.text.replace(m[0],anchor);
    if(sentenceSimilarity(sourceBody,o.text)<.6)continue;
    const code='introduced_named_example_loss';
    findings.push({code,ordinal:ordinal+1,repair:{start,end:start,
      replacement:m[0].slice(0,m[0].length-anchor.length),ordinal:ordinal+1,code}});
  }
  // A uniquely shared quoted category plus the same conditional boundary
  // anchors the claim. Restore only its source clause; never rewrite quotes
  // or turn "not limited" into "limited". Broader scope changes need judging.
  for(const [i,o] of os.entries()) {
    const tail=/에\s+있었다면\s*,/u.exec(o.text);
    if(!tail || !/중심/u.test(o.text.slice(0,tail.index)))continue;
    const oq=syntaxSpans(o.text).filter(p=>p.spanType==='quote'&&p.end<=tail.index);
    if(oq.length!==1||o.text.slice(oq[0].end,tail.index).trim())continue;
    const literal=o.text.slice(oq[0].start,oq[0].end);
    const matches=ss.map(s=>({s,m:/에\s+국한되었다면\s*,/u.exec(s.text)}))
      .filter(({s,m})=>m&&s.text.slice(0,m.index).endsWith(literal)
        && !s.text.slice(0,m.index).includes('\n')&&sentenceSimilarity(s.text,o.text)>=.6);
    if(matches.length!==1||blocked(protectedAfter,o.start,o.start+oq[0].start))continue;
    const {s,m}=matches[0];
    if(blocked(protectedBefore,s.start,s.start+s.text.indexOf(literal)))continue;
    const code='introduced_restriction_frame_weakening';
    findings.push({code,ordinal:i+1,repair:{start:o.start,end:o.start+tail.index+tail[0].length,
      replacement:s.text.slice(0,m.index+m[0].length),ordinal:i+1,code}});
  }
  return findings;
}

function groundedStartRepair(original, target, match, ending) {
  const prefix = target.text.slice(0, match.index);
  const anchor = prefix.match(/([가-힣]{2,20}\s+[가-힣]{2,20})(을|를)\s+$/u);
  if (!anchor) return null;
  const pattern = new RegExp(`(?<![가-힣])${escape(anchor[1])}(?:부터|을|를)\\s*(?:탄탄히\\s+)?${escape(match[1])}(?=${escape(ending)})`, 'gu');
  const evidence = [...original.matchAll(pattern)];
  if (evidence.length !== 1) return null;
  return {start:target.start+anchor.index, end:target.start+match.index+match[0].length,
    replacement:evidence[0][0],ordinal:target.ordinal,code:'introduced_action_nominalization'};
}

function proseSpans(value) {
  const text = String(value || ''), protectedSpans = syntaxSpans(text);
  return splitSentenceSpans(text).map((span,index)=>({...span,ordinal:index+1})).filter(span =>
    span.text.length <= 800 && !protectedSpans.some(p=>p.start<span.end && p.end>span.start)
    && layout.buildLineRecords(span.text).every(row=>row.blank || row.role==='prose'));
}

module.exports = { auditNaturalnessRegression };
