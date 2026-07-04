'use strict';

// GPT-native analyze compatibility layer.
// 기존 routes/analyze.js가 기대하던 호출 계층을 OpenAI Responses API 기반으로 별도 제공한다.

module.exports = require('../engine-gpt-prod/compat');
