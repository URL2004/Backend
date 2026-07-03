'use strict';

// GPT 전용 analyze compatibility layer.
// 기존 routes/analyze.js의 callClaude/extractClaudeResult/runHumanizeChunked/runDetect 계층을
// Claude 코드와 섞지 않고 OpenAI Responses API 기반으로 별도 제공한다.

module.exports = require('../engine-gpt-prod/compat');
