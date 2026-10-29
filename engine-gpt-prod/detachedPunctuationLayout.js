'use strict';

// PDF copies can emit punctuation as separate physical rows inside words.
// Collapse only whitespace in strongly witnessed damaged prose. Retain every
// character; never guess where displaced punctuation originally belonged.
function repairDetachedPunctuationLayout(value) {
  const source=String(value||''),changes=[];
  const text=source.split(/(\n[ \t]*\n+)/u).map((block,i)=>{
    if(i%2||block.length<200||block.length>30000||/[\t|`~]/u.test(block))return block;
    const lines=block.split('\n').map(s=>s.trim()).filter(Boolean);
    const punct=lines.filter(s=>/^[.,;:'"，。‘’“”]{1,2}$/u.test(s));
    const body=lines.filter(s=>!punct.includes(s));
    if(punct.length<4||body.length<4
        ||body.some((s,j)=>(s.length<15 && !(/^[가-힣 ]{2,13}(?:다|요)[.]$/u.test(s)
          ||j===body.length-1&&/^[가-힣 ]{3,14}[.]?$/u.test(s)))
          ||/^(?:\d+[.)]|[-*•#]|[ⅠⅡⅢⅣⅤ]|[\[【])/u.test(s))
        ||body.filter(s=>s.length>=30&&/[가-힣]{10}/u.test(s.replace(/\s/gu,''))).length<body.length*.65
        ||(block.match(/(?:다|요)[.\s]/gu)||[]).length<3)return block;
    changes.push({code:'source_detached_punctuation_review',lineOrdinal:1,action:'notice',
      message:'복사한 글에서 문장부호가 본문과 떨어진 흔적이 있어요. 줄은 연결했지만 문장부호 위치와 원문 내용을 확인해 주세요.'});
    return lines.join(' ');
  }).join('');
  return {text,changes};
}
module.exports={repairDetachedPunctuationLayout};
