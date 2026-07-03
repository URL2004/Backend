// This adapter is intentionally generic. Replace callYourModel with your own provider call.
// The V5 engine does not pass user instructions. It only passes an admin-built system prompt and source text as data.

async function callYourModel({ system, user, temperature, maxOutputTokens }) {
  throw new Error('Implement your model provider call here. Return the raw text response.');
}

function createLlmAdapter() {
  return {
    async complete({ system, user, temperature, maxOutputTokens }) {
      return await callYourModel({ system, user, temperature, maxOutputTokens });
    }
  };
}

module.exports = { createLlmAdapter };
