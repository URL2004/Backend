'use strict';
const intro='안내 방식에 따른 참여자의 반응을 같은 조건에서 비교하였다.';
const left='일반적으로 기존 안내 방식에서는 이용자의 대기 시간이 상대적으로 길었으며, ';
const tail='새로운 안내 방식에서는 참여자의 이동 동선이 줄어드는 결과가 나타났다.';
const rewritten='기존 안내 방식의 이용자 대기 시간은 상대적으로 길었다.';
const conclusion='따라서 안내 방식에 따라 대기 시간과 이동 동선이 다르게 나타남을 확인하였다.';
module.exports={intro,left,tail,rewritten,conclusion,source:[intro,left+tail,conclusion].join(' '),output:[intro,rewritten,conclusion].join(' ')};
