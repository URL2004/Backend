'use strict';

// 눈에 보이지 않는 서식 문자를 제출 원문에서 걷어낸다.
//
// 2026-10-11 운영 글에서 U+034F(COMBINING GRAPHEME JOINER)가 한글 음절 사이와 숫자 안에
// 81개 끼어 있었다. 엔진은 이 문자를 지우지 않았고, 숫자 안에 낀 경우("19<U+034F>68")
// 모델이 숫자를 깨끗하게 쓰는 순간 숫자 보존 검사가 "숫자가 바뀌었다"고 보아 고친 문장을
// 거부했다. 그 결과 그 문장이 원문 그대로(붙은 문장 포함) 남았다.
//
// 지우는 것은 "양옆이 평범한 글자일 때"뿐이다. 이모지 결합(ZWJ, 변형 선택자, 키캡, 국기 태그),
// 아랍·인도계 문자의 연결 제어, 결합 부호 앞뒤처럼 이 문자들이 실제로 쓰이는 자리는 그대로 둔다.
// 폭이 있는 채움 문자(U+3164 등)와 옛한글 채움 자모(U+115F, U+1160)는 대상이 아니다.

const INVISIBLE = String.raw`­͏؜᠎​-‏‪-‮⁠-⁤⁦-⁯︀-️﻿\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}`;
const INVISIBLE_RUN_RE = new RegExp(`[${INVISIBLE}]+`, 'gu');
const INVISIBLE_TEST_RE = new RegExp(`[${INVISIBLE}]`, 'u');
// 한글·라틴·한자·가나·숫자·문장부호·공백. 결합 부호와 그 밖의 문자 체계는 넣지 않는다.
const PLAIN_RE = /^[\p{Script=Hangul}\p{Script=Latin}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Nd}\p{P}\s]$/u;
const PICTOGRAPHIC_RE = /^\p{Extended_Pictographic}$/u;

function plainNeighbor(char) {
  return char === '' || (PLAIN_RE.test(char) && !PICTOGRAPHIC_RE.test(char));
}

function lastCodePoint(text) {
  if (!text) return '';
  const code = text.codePointAt(text.length - 1);
  // 뒤쪽이 보조 평면 문자의 끝(낮은 서러게이트)이면 두 단위를 함께 읽는다.
  if (code >= 0xDC00 && code <= 0xDFFF && text.length >= 2) return String.fromCodePoint(text.codePointAt(text.length - 2));
  return String.fromCodePoint(code);
}

function firstCodePoint(text) {
  return text ? String.fromCodePoint(text.codePointAt(0)) : '';
}

function stripInvisibleCharacters(value) {
  const source = String(value ?? '');
  if (!INVISIBLE_TEST_RE.test(source)) return { text: source, removedCount: 0, codePoints: {} };
  const codePoints = {};
  let removedCount = 0;
  let out = '';
  let cursor = 0;
  for (const match of source.matchAll(INVISIBLE_RUN_RE)) {
    const run = match[0];
    const start = match.index;
    out += source.slice(cursor, start);
    cursor = start + run.length;
    // 왼쪽 이웃은 이미 정리된 결과의 끝, 오른쪽 이웃은 이 연속 구간 바로 뒤의 보이는 문자다.
    const previous = lastCodePoint(out);
    const next = firstCodePoint(source.slice(cursor));
    if (plainNeighbor(previous) && plainNeighbor(next)) {
      for (const char of run) {
        const key = `U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
        codePoints[key] = (codePoints[key] || 0) + 1;
        removedCount += 1;
      }
    } else {
      out += run;
    }
  }
  out += source.slice(cursor);
  return { text: out, removedCount, codePoints };
}

module.exports = { stripInvisibleCharacters };
