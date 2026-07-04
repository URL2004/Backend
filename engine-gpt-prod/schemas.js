'use strict';

const HUMANIZE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    outputText: { type: 'string' },
    editIntensity: { type: 'string', enum: ['light', 'medium', 'strong'] },
    protectedTerms: { type: 'array', items: { type: 'string' } },
    riskFlags: { type: 'array', items: { type: 'string' } },
    changedSentenceRatio: { type: 'number' },
    factualRiskNotes: { type: 'array', items: { type: 'string' } },
    warnings: { type: 'array', items: { type: 'string' } }
  },
  required: ['outputText', 'editIntensity', 'protectedTerms', 'riskFlags', 'changedSentenceRatio', 'factualRiskNotes', 'warnings']
};

const DETECT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    probability: { type: 'number' },
    summary: { type: 'string' },
    detail: { type: 'string' },
    signals: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] }
  },
  required: ['probability', 'summary', 'detail', 'signals', 'confidence']
};

const REWRITE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    rewritten: { type: 'string' }
  },
  required: ['rewritten']
};

const EVIDENCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          url: { type: 'string' },
          publisher: { type: 'string' },
          reason: { type: 'string' }
        },
        required: ['title', 'url', 'publisher', 'reason']
      }
    },
    warnings: { type: 'array', items: { type: 'string' } }
  },
  required: ['candidates', 'warnings']
};

module.exports = {
  HUMANIZE_SCHEMA,
  DETECT_SCHEMA,
  REWRITE_SCHEMA,
  EVIDENCE_SCHEMA
};
