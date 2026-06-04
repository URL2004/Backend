// [인증] 카카오톡 OAuth 로그인 처리

const express = require('express');
const router = express.Router();

router.post('/kakao-login', async (req, res) => {
  try {
    const { accessToken } = req.body;
    if (!accessToken) return res.json({ error: '토큰이 없습니다.' });

    const userRes = await fetch('https://kapi.kakao.com/v2/user/me', {
      headers: { 'Authorization': 'Bearer ' + accessToken }
    });
    const userData = await userRes.json();

    if (!userData.id) return res.json({ error: '카카오 사용자 정보를 가져올 수 없습니다.' });

    const kakaoId = String(userData.id);
    const nickname = userData.kakao_account?.profile?.nickname || '카카오유저';
    const email = userData.kakao_account?.email || (kakaoId + '@kakao.com');
    const photo = userData.kakao_account?.profile?.profile_image_url || '';

    res.json({ ok: true, kakaoId, nickname, email, photo });
  } catch(err) {
    res.json({ error: err.message });
  }
});

module.exports = router;
