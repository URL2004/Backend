// [engine/basicblogtone.js] 기본 피하기 블로그 말투 마감 정리
// 업체/현장 후기형 글에서 과하게 문학적이거나 단정적인 표현만 좁게 낮춘다.

function form(register, hap, haeyo) {
  return register === 'haeyo' ? haeyo : hap;
}

function cleanupBasicBlogTone(text, { register = 'hap' } = {}) {
  let out = String(text || '');
  const fixes = [];
  const apply = (from, to, label) => {
    const before = out;
    out = out.replace(from, to);
    if (out !== before) fixes.push(label);
  };

  apply(/인원\s*1명이\s*투입/g, '1명이 투입', '인원 1명');
  apply(/먼지가\s*조용히\s*쌓입니다/g, form(register, '먼지가 쉽게 쌓입니다', '먼지가 쉽게 쌓여요'), '문학적 먼지 표현');
  apply(/먼지가\s*조용히\s*쌓여/g, '먼지가 쉽게 쌓여', '문학적 먼지 표현');
  apply(/청결감이\s*오래\s*버티지\s*못합니다/g, form(register, '청결감이 오래 유지되기 어렵습니다', '청결감이 오래 유지되기 어려워요'), '강한 청결감 표현');
  apply(/청결감이\s*오래\s*버티지\s*못해요/g, '청결감이 오래 유지되기 어려워요', '강한 청결감 표현');
  apply(/냄새를\s*집중적으로\s*잡아냈습니다/g, form(register, '냄새가 느껴지는 구역을 중심으로 관리했습니다', '냄새가 느껴지는 구역을 중심으로 관리했어요'), '강한 결과 단정');
  apply(/냄새를\s*집중적으로\s*잡아냈어요/g, '냄새가 느껴지는 구역을 중심으로 관리했어요', '강한 결과 단정');
  apply(/배수구\s*언저리/g, '배수구 주변', '구어적 위치 표현');
  apply(/눌어붙어\s*있던\s*먼지/g, '쌓여 있던 먼지', '먼지 동사 정리');
  apply(/눌어붙은\s*먼지/g, '쌓인 먼지', '먼지 동사 정리');
  apply(/사용\s*흔적이\s*한결\s*옅어졌습니다/g, form(register, '전반적으로 더 쾌적한 상태로 정리되었습니다', '전반적으로 더 쾌적한 상태로 정리됐어요'), '돌려 말한 결과 표현');
  apply(/사용\s*흔적이\s*한결\s*옅어졌어요/g, '전반적으로 더 쾌적한 상태로 정리됐어요', '돌려 말한 결과 표현');
  apply(/마무리\s*인상이\s*한결\s*깔끔해졌습니다/g, form(register, '전체가 한결 깔끔한 상태로 마무리되었습니다', '전체가 한결 깔끔한 상태로 마무리됐어요'), '추상적 마무리 표현');
  apply(/마무리\s*인상이\s*한결\s*깔끔해졌어요/g, '전체가 한결 깔끔한 상태로 마무리됐어요', '추상적 마무리 표현');

  return { text: out, changed: out !== String(text || ''), fixes };
}

module.exports = { cleanupBasicBlogTone };
