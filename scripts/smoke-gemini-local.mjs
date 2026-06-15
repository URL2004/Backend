const base = process.env.LOCAL_API_BASE || 'http://127.0.0.1:3100';
const runTransform = process.argv.includes('--transform');

async function req(path, options = {}) {
  const res = await fetch(base + path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`${path} ${res.status}: ${JSON.stringify(data).slice(0, 500)}`);
  return data;
}

const sample = '대학생에게 생성형 AI는 편리한 도구이지만, 과제를 대신 완성하는 방식으로 쓰이면 학습 과정이 약해질 수 있다. 그래서 학생은 AI가 만든 문장을 그대로 제출하기보다 자신의 경험과 수업 내용을 기준으로 다시 검토해야 한다.';

console.log('[smoke] healthz');
console.log(await req('/healthz'));

console.log('[smoke] detect-report');
const det = await req('/detect-report', { method: 'POST', body: JSON.stringify({ text: sample }) });
console.log({ ok: det.ok, probability: det.result?.probability, source: det.result?.source });

console.log('[smoke] analyze polish');
const polish = await req('/analyze', {
  method: 'POST',
  body: JSON.stringify({ mode: 'humanize', humanizeMode: 'assignment', engine: 'floorV2', text: sample })
});
console.log({ ok: polish.ok, len: polish.result?.outputText?.length, status: polish.result?.floorReport?.status });

if (runTransform) {
  console.log('[smoke] transform formal');
  const created = await req('/transform', {
    method: 'POST',
    body: JSON.stringify({ mode: 'formal', text: sample.repeat(8), wantEvidence: false })
  });
  console.log({ jobId: created.jobId, status: created.status });
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const st = await req(`/transform/${created.jobId}`);
    console.log({ poll: i + 1, status: st.status, stage: st.stage });
    if (['done', 'blocked', 'error', 'cancelled'].includes(st.status)) break;
  }
}

console.log('[smoke] done');
