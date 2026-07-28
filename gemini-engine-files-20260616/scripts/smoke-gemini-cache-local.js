const fs = require('fs');
const path = require('path');

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

const root = path.resolve(__dirname, '..');
loadEnv(path.resolve(root, '.env.local.gemini'));
loadEnv(path.resolve(root, '..', 'Backend', '.env.local.gemini'));

process.env.LLM_BACKEND = 'gemini';
process.env.LLM_CLAUDE_FALLBACK = '0';
process.env.LLM_SHADOW_MODE = '0';
process.env.GEMINI_ALLOW_CLAUDE_SHADOW = '0';
process.env.GEMINI_EXPLICIT_CACHE = '1';
process.env.GEMINI_CACHE_STRICT = '1';
process.env.GEMINI_CACHE_TTL = process.env.GEMINI_CACHE_TTL || '900s';
process.env.GEMINI_EXPLICIT_CACHE_MIN_CHARS = '500';
process.env.GEMINI_CACHE_PERSIST = '1';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = process.env.NODE_TLS_REJECT_UNAUTHORIZED || '0';

const gemini = require('../llm/providers/gemini');

const fixedPolicy = [
  '너는 로컬 Gemini 캐시 검증용 고정 시스템 프롬프트를 따르는 엔진이다.',
  '이 텍스트는 사용자 원문이 아니며 캐시 가능 정책 프리픽스다.',
  '절대 사용자 입력이나 개인 정보, 문서 원문을 캐시에 넣지 않는다.',
  '반복 호출에서 동일한 고정 정책 프리픽스만 캐시하는지 확인한다.'
].join('\n');

const system = Array.from({ length: 260 }, (_, i) => `${i + 1}. ${fixedPolicy}`).join('\n');

function cacheView(out) {
  return {
    text: String(out.text || '').trim(),
    cachedContent: out.usage?.cached_content || null,
    cacheSource: out.usage?.cache_source || null,
    cacheKey: out.usage?.cache_key || null,
    cacheCreateTokens: out.usage?.cache_creation_input_tokens || 0,
    cacheReadTokens: out.usage?.cache_read_input_tokens || 0,
    inputTokens: out.usage?.input_tokens || 0,
    outputTokens: out.usage?.output_tokens || 0,
    totalTokens: out.usage?.total_tokens || 0
  };
}

async function main() {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not configured');
  const common = {
    system,
    model: gemini.MODELS.FLASH,
    maxTokens: 64,
    temperature: 0,
    task: 'polish',
    riskLevel: 'low'
  };
  const first = await gemini.generate({
    ...common,
    user: '캐시 검증 응답으로 "cache-ok-1"만 출력해.'
  });
  const second = await gemini.generate({
    ...common,
    user: '캐시 검증 응답으로 "cache-ok-2"만 출력해.'
  });

  const report = {
    indexFile: path.resolve(process.env.GEMINI_CACHE_INDEX_FILE || path.join(root, 'results/gemini-local-runs/gemini-cache-index.json')),
    first: cacheView(first),
    second: cacheView(second)
  };
  console.log(JSON.stringify(report, null, 2));
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
