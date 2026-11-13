import ngrok from '@ngrok/ngrok';
import dns from 'node:dns';

// 部分移动网络到 ngrok 的 IPv6 路由不稳定，健康检查优先走 IPv4，避免误判后重启隧道。
dns.setDefaultResultOrder('ipv4first');

const token = process.env.NGROK_AUTHTOKEN || '';
const domain = (process.env.NGROK_DOMAIN || '').trim();
const addr = process.env.GAME_ADDR || 'http://127.0.0.1:4173';

if (!token) {
  console.error('NGROK_AUTHTOKEN missing');
  process.exit(2);
}

const opts = { addr, authtoken: token };
if (domain) opts.domain = domain;
if (process.env.NGROK_OAUTH) opts.oauth = process.env.NGROK_OAUTH;

let publicUrl = '';
try {
  const listener = await ngrok.forward(opts);
  publicUrl = listener.url();
  console.log('NGROK_URL=' + publicUrl);
  console.log('NGROK_READY=' + new Date().toISOString());
} catch (e) {
  console.error('NGROK_ERROR=' + (e && e.message ? e.message : e));
  process.exit(1);
}

// 看门狗：ngrok 进程有时仍然存活，但公网端点已断开（ERR_NGROK_3200）。
// 连续两次健康检查失败就主动退出，让 supervisor 重新建立固定域名隧道。
let healthFails = 0;
const watchdog = setInterval(async () => {
  try {
    const res = await fetch(publicUrl + '/health', {
      headers: { 'ngrok-skip-browser-warning': 'true' },
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      healthFails = 0;
      return;
    }
    healthFails += 1;
    console.error('NGROK_HEALTH_BAD=' + res.status + ' fails=' + healthFails);
  } catch (e) {
    healthFails += 1;
    console.error('NGROK_HEALTH_ERR=' + (e && e.message ? e.message : e) + ' fails=' + healthFails);
  }
  if (healthFails >= 2) {
    console.error('NGROK_WATCHDOG_RESTART');
    process.exit(1);
  }
}, 30000);
