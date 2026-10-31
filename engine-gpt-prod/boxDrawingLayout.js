'use strict';
function isBoxDrawingRow(value) {
  const row=String(value ?? '').trim();
  return /^│[^\r\n]*│$/u.test(row)
    || /^(?=[^\r\n]*─{3})[┌┐└┘┬┴┼├┤─ \t]+$/u.test(row);
}
function blocks(text) {
  const rows=[...text.matchAll(/[^\n]+/gu)],out=[];
  for(let i=0;i<rows.length;i++){
    if(!/^\s*┌/u.test(rows[i][0])||!isBoxDrawingRow(rows[i][0]))continue;
    let end=i;
    while(end+1<rows.length&&isBoxDrawingRow(rows[end+1][0])
      &&rows[end+1].index===rows[end].index+rows[end][0].length+1)end++;
    if(end-i>=2&&/^\s*└/u.test(rows[end][0])){
      const start=rows[i].index,stop=rows[end].index+rows[end][0].length;
      out.push({start,end:stop,text:text.slice(start,stop)});
    }
    i=end;
  }
  return out;
}
function restoreBoxDrawingLayout(source,candidate) {
  const src=String(source ?? ''),out=String(candidate ?? ''),a=blocks(src),b=blocks(out);
  const bare=s=>s.replace(/\s/gu,''),keyed=xs=>{
    const map=new Map();for(const x of xs){const key=bare(x.text);map.set(key,[...(map.get(key)||[]),x]);}return map;
  };
  const originals=keyed(a),results=keyed(b),edits=[];
  for(const [key,items]of originals){const targets=results.get(key);
    if(items.length===1&&targets?.length===1&&items[0].text!==targets[0].text)
      edits.push({...targets[0],text:items[0].text});
  }
  let text=out;for(const e of edits.sort((a,b)=>b.start-a.start))text=text.slice(0,e.start)+e.text+text.slice(e.end);
  return {text,restoredCount:edits.length};
}
module.exports={isBoxDrawingRow,restoreBoxDrawingLayout};
