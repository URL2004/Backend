// [tools/_test-register-normalize.js] 말투 정규화 검증(무LLM): 실측 혼입 출력(존댓말+한다체)을
//   원문 말투(존댓말=hap)로 통일했을 때 혼입이 줄고 문장이 자연스러운지 확인.
const { normalizeRegister } = require('../engine/registernormalize');
const sg = require('../engine/surfaceguard');

// 사용자 실측 출력(존댓말 성찰문이 한다체로 군데군데 추락한 부분 발췌)
const mixed = `이 강의를 듣기 전까지 저는 막연한 외로움 때문에 연애를 하고 싶다고 자주 생각했습니다. 문제는 상대방이 아니었다. 그때의 저는 제 자신을 잘 알지 못했습니다.
저는 제 내면의 문제를 제대로 인식하지 못했습니다. 근본적인 오류였다. 스스로를 먼저 사랑하지 못하면서도 타인을 사랑할 수 있다고 여겼기 때문입니다.
혼자 있을 때는 별다른 문제가 없다고 여기던 부분들도 타인과의 관계에서는 영향을 미칠 수 있다는 점을 인식하게 되었습니다. 관계가 달라진다. 더 건강한 관계를 위해 노력하게 되었습니다.
감정을 이해하고 조절하는 능력에 따라 행동도 달라진다는 점을 알게 되었습니다. 그게 핵심이다. 제 감정에 솔직해져야 한다고 생각했습니다.
저는 원래 자아가 조금 더 성숙해진 뒤에 사랑을 하고 싶다고 생각했다. 지금은 여자친구와 교제한 지 12일째다. 따라서 내가 생각하는 성공적인 데이트란 서로 양보하는 것이다. 이성적인 대화를 통해 풀어나가야 한다고 생각한다. 스킨십에 있어서도 서로의 결정권을 존중하며 관계를 만들어 가야 한다. 감정적인 문제가 생겼을 때가 중요하다.`;

const before = sg.measureRegisterMix(mixed);
const { text, changed } = normalizeRegister(mixed, 'hap');
const after = sg.measureRegisterMix(text);

console.log('=== 변환 전 ===');
console.log(`dominant=${before.dominant} offRatio=${before.offRatio} (한다체 혼입 문장 ${before.offCount}개)`);
console.log('=== 변환 후 ===');
console.log(`dominant=${after.dominant} offRatio=${after.offRatio} (혼입 ${after.offCount}개) · 치환 ${changed}건`);
console.log('\n=== 결과 본문 ===\n' + text);

// 성공 기준: 원문 말투(존댓말)로 dominant가 잡히고, 혼입이 절반 이하로 줄었는지(완벽 0은 copula 등으로 불가).
const ok = after.dominant === 'hap' && after.offRatio <= before.offRatio * 0.7;
console.log(ok ? '\n── 통과(존댓말로 통일·혼입 대폭 감소) ──' : '\n── 실패 ──');
process.exit(ok ? 0 : 1);
