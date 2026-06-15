// Discord 슬래시 커맨드 등록(1회성).
// 실행: node scripts/register-discord-commands.mjs
// 필요한 env(.env): DISCORD_APP_ID, DISCORD_BOT_TOKEN, (선택) DISCORD_GUILD_ID
//   - DISCORD_GUILD_ID 가 있으면 그 서버에 즉시 등록(테스트에 권장).
//   - 없으면 글로벌 등록(전파에 최대 1시간).
import 'dotenv/config';

const APP_ID = (process.env.DISCORD_APP_ID || '').trim();
const TOKEN = (process.env.DISCORD_BOT_TOKEN || '').trim();
const GUILD = (process.env.DISCORD_GUILD_ID || '').trim();

if (!APP_ID || !TOKEN) {
  console.error('DISCORD_APP_ID, DISCORD_BOT_TOKEN 을 .env 에 먼저 설정하세요.');
  process.exit(1);
}

const commands = [
  {
    name: '매출',
    description: '기간별 매출을 조회합니다 (본인에게만 표시)',
    options: [
      {
        type: 3, // STRING
        name: '기간',
        description: '조회 기간 (기본: 오늘)',
        required: false,
        choices: [
          { name: '오늘', value: 'today' },
          { name: '어제', value: 'yesterday' },
          { name: '이번주', value: 'week' },
          { name: '이번달', value: 'month' },
          { name: '오픈이후', value: 'all' }
        ]
      }
    ]
  }
];

const url = GUILD
  ? `https://discord.com/api/v10/applications/${APP_ID}/guilds/${GUILD}/commands`
  : `https://discord.com/api/v10/applications/${APP_ID}/commands`;

const res = await fetch(url, {
  method: 'PUT', // PUT = 전체 덮어쓰기(중복 등록 방지)
  headers: { Authorization: `Bot ${TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(commands)
});

const text = await res.text();
if (!res.ok) {
  console.error(`등록 실패 (${res.status}):`, text);
  process.exit(1);
}
console.log(`등록 완료 (${GUILD ? 'guild:' + GUILD : 'global'}):`, text);
