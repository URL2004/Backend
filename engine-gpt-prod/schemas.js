'use strict';

const HUMANIZE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    outputText: {
      type: 'string',
      description: 'Final rewritten body only. Do not include explanations, labels, or code fences.'
    },
    editIntensity: {
      type: 'string',
      enum: ['light', 'medium', 'strong'],
      description: 'How much ordinary prose was edited while preserving protected terms and facts.'
    },
    protectedTerms: {
      type: 'array',
      items: { type: 'string' },
      description: 'Protected source terms that were preserved verbatim.'
    },
    riskFlags: {
      type: 'array',
      items: { type: 'string' },
      description: 'Short internal risk flags such as structure_loss, speaker_drift, protected_term_risk, or factual_risk.'
    },
    changedSentenceRatio: {
      type: 'number',
      description: 'Estimated 0-1 ratio of sentences whose wording, order, or connection changed meaning-preservingly.'
    },
    factualRiskNotes: {
      type: 'array',
      items: { type: 'string' },
      description: 'Brief notes about numbers, names, references, or claims that required preservation care.'
    },
    warnings: {
      type: 'array',
      items: { type: 'string' },
      description: 'Non-fatal warnings from the rewrite attempt.'
    }
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
