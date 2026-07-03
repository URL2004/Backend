'use strict';

const engine = require('./index');

async function genreTransferV2(rawText, { evidence = '', userNotes = '', lang = 'ko', lengthMode = 'keep', signal, config } = {}) {
  const out = await engine.run({
    text: rawText,
    mode: 'assignment',
    lang,
    evidence,
    userNotes,
    signal,
    config,
    styleProfile: lengthMode === 'compact' ? 'gpt_genretransfer_compact' : 'gpt_genretransfer_keep'
  });
  const result = out.result || {};
  return {
    text: result.outputText || '',
    result,
    floorReport: out.floorReport,
    novelty: result.floorNovelty || null,
    lostFacts: result.lostFacts || null,
    judge: result.judgeReport || null,
    lenRatio: result.floorLength?.ratio || null,
    skeleton: 'gpt_prod_chunked',
    gptEngine: out.gptEngine || result.humanizeMeta || null
  };
}

async function genreTransfer(rawText, opts = {}) {
  return await genreTransferV2(rawText, opts);
}

module.exports = {
  genreTransfer,
  genreTransferV2
};
