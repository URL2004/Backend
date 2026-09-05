'use strict';

const HUMANIZE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    outputText: {
      type: 'string',
      description: 'Final rewritten body only. Do not include explanations, labels, or code fences.'
    }
  },
  required: ['outputText']
};

const DETECT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    probability: { type: 'number' },
    signals: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          category: {
            type: 'string',
            enum: [
              'sentence_uniformity', 'ending_repetition', 'formulaic_transition',
              'generic_abstraction', 'insufficient_grounding', 'overstructured_progression',
              'voice_instability', 'unsupported_assertion', 'lexical_template',
              'other_observed_style'
            ]
          },
          strength: { type: 'string', enum: ['weak', 'moderate', 'strong'] },
          evidenceSentences: { type: 'array', items: { type: 'integer' } },
          scope: { type: 'string', enum: ['isolated', 'recurring', 'pervasive'] }
        },
        required: ['category', 'strength', 'scope', 'evidenceSentences']
      }
    },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] }
  },
  required: ['probability', 'signals', 'confidence']
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
