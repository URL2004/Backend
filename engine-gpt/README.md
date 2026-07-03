# engine-gpt

GPT/OpenAI Responses API 전용 휴머나이징 엔진입니다.

## 원칙

- 기존 `Backend/engine` Claude 운영엔진은 수정하지 않고 롤백용으로 유지한다.
- 이 폴더 안의 LLM 호출, 프롬프트, JSON schema, reasoning, prompt caching 설정은 GPT 성향에 맞춰 별도 관리한다.
- 결정론 가드(`floor`, `contract`, `chunk`, `spacing`, `dedupe`, `register normalize`)는 운영 검증 자산이므로 공유한다.
- Claude `tool_use`, `cache_control`, Anthropic streaming event, `claude-sonnet/haiku` 모델명은 사용하지 않는다.

## 진입점

- `index.js`: 관리자 테스트 엔진 실행
- `llm.js`: OpenAI Responses API 호출, usage/cached token 정규화
- `prompt.js`: GPT 전용 프롬프트. 과한 칼럼화, 과매끈화, 문체 혼합을 억제한다.
- `schema.js`: OpenAI strict structured output schema

## 환경변수

- `OPENAI_API_KEY`
- `OPENAI_MODEL_MAIN` 기본 `gpt-5.4`
- `OPENAI_MODEL_FAST` 기본 `gpt-5.4-mini`
- `OPENAI_REASONING_MAIN` 기본 `low`
- `OPENAI_REASONING_HUMANIZE` 기본 `low`
- `OPENAI_TEXT_VERBOSITY` 기본 `medium`
- `OPENAI_PROMPT_CACHE_KEY_PREFIX` 기본 `gp-humanize-gpt`
- `OPENAI_PROMPT_CACHE_RETENTION` 선택
