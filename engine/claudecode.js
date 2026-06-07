// [engine/claudecode.js] LLM_BACKEND=claudecode 백엔드
// ────────────────────────────────────────────────────────────────
// API 키 없이 로컬에서 엔진을 돌려보기 위한 dev 전용 LLM 백엔드.
// 내 Claude Code 구독(Sonnet)을 헤드리스(`claude -p`)로 호출한다.
//
// ★ system+user를 한 프롬프트로 합쳐 stdin으로 전달하는 이유:
//   휴머나이저 시스템 프롬프트가 길어서(thesis는 ~60줄) CLI 인자로 넘기면
//   Windows 명령행 길이/따옴표 문제가 난다. stdin은 길이 제한이 없다.
//
// ⚠️ 한계(테스트용임을 전제): claude -p는 Claude Code 에이전트라 자체 시스템
//    프롬프트가 살짝 섞인다 → API Sonnet과 바이트 단위로 동일하진 않다(품질은 근접).
//    최종 acceptance만 LLM_BACKEND=api로 한 번 더 확인할 것.

const { spawn } = require('child_process');

// claude CLI를 헤드리스로 실행하고 stdout(재작성 결과)을 받는다.
function runClaudeCode(promptText, { model = 'claude-sonnet-4-6', signal, timeoutMs = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    // Windows의 claude는 claude.ps1/claude.cmd → shell:true로 PATH 해석.
    const child = spawn('claude', ['-p', '--model', model], {
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`claudecode timeout ${timeoutMs}ms`));
    }, timeoutMs);

    const onAbort = () => { clearTimeout(timer); child.kill(); reject(new Error('aborted')); };
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { err += d.toString(); });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(`claude exited ${code}: ${err.trim().slice(0, 500)}`));
    });

    child.stdin.write(promptText);
    child.stdin.end();
  });
}

// callClaude와 동일한 응답 모양({type, content:[tool_use], usage, stop_reason})으로 래핑.
// 엔진은 어차피 verifyCheckFields로 모든 수치를 서버 재측정하므로, 모델에서 필요한 건 outputText뿐.
async function callViaClaudeCode({ userText, systemText, tool, model, signal }) {
  const combined = [
    systemText ? systemText.trim() : '',
    '',
    userText,
    '',
    '---',
    '위 규칙에 따라 재작성한 글 "본문만" 출력하세요. 설명·머리말·라벨·따옴표·코드블록 없이 결과 텍스트만 출력합니다.'
  ].join('\n');

  // 헤드리스 flakiness 방어: 빈/짧은 응답 또는 "Execution error" 사텐넬이면 최대 3회 재시도.
  const isBad = (s) => !s || s.replace(/\s+/g, '').length < 30 || /^execution error/i.test(s.trim());
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let text = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(1500); // transient "Execution error" 완화용 짧은 백오프
    try {
      text = await runClaudeCode(combined, { model, signal });
    } catch (e) {
      if (signal?.aborted) throw e;
      text = '';
    }
    if (!isBad(text)) break;
  }
  if (isBad(text)) {
    // 끝내 실패 → throw. 호출 측(runHumanize)이 1차 결과로 폴백하거나 에러 처리.
    throw new Error('claudecode: 유효한 응답 실패 (Execution error/빈 응답 반복)');
  }
  const toolName = (tool && tool.name) ? tool.name : 'return_humanized_result';

  return {
    type: 'message',
    content: [{ type: 'tool_use', id: 'claudecode', name: toolName, input: { outputText: text } }],
    usage: { input_tokens: 0, output_tokens: 0, _backend: 'claudecode' },
    stop_reason: 'tool_use'
  };
}

module.exports = { runClaudeCode, callViaClaudeCode };
