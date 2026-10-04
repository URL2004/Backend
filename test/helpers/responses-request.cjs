'use strict';
// Existing engine fixtures inspect logical prompts. Preserve that view for
// both legacy instructions/input strings and Responses developer/user items.
// Wire-format/cache tests deliberately inspect the unmodified request body.
module.exports = serialized => {
  const body = JSON.parse(serialized);
  if (!Array.isArray(body.input)) return body;
  const text = content => typeof content === 'string' ? content
    : (content || []).filter(part => part.type === 'input_text').map(part => part.text).join('');
  return { ...body, rawInput: body.input,
    instructions: [body.instructions || '', ...body.input.filter(item => item.role === 'developer')
      .map(item => text(item.content))].filter(Boolean).join('\n'),
    input: body.input.filter(item => item.role === 'user').map(item => text(item.content)).join('\n') };
};
