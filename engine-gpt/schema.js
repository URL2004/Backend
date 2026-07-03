'use strict';

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    outputText: {
      type: 'string',
      description: 'The finished rewritten body text only.'
    },
    editIntensity: {
      type: 'string',
      enum: ['light', 'medium', 'strong'],
      description: 'How much the wording changed while preserving the source.'
    },
    protectedTerms: {
      type: 'array',
      items: { type: 'string' },
      description: 'Facts, numbers, names, citations, URLs, and terms preserved exactly.'
    },
    warnings: {
      type: 'array',
      items: { type: 'string' },
      description: 'Potential preservation risks. Empty array if none.'
    }
  },
  required: ['outputText', 'editIntensity', 'protectedTerms', 'warnings']
};

module.exports = { OUTPUT_SCHEMA };
