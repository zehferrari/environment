const { exec } = require('child_process');
const path = require('path');

const TELEGRAM_TOKEN = '8450756475:AAFyfmW4yEQasW2sJ3nrR0Z9zW70T7p0RjQ';
const TELEGRAM_CHAT_ID = '212787671'; // Your Chat ID
const RACHAEL_EMAIL = 'contact@rachaelsmith.net.au';

function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const payload = JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: text, parse_mode: 'Markdown' });
  const cmd = `curl -s -H "Content-Type: application/json" -d '${payload.replace(/'/g, "'\\''")}' ${url}`;
  
  exec(cmd, (error, stdout, stderr) => {
    if (error) console.error(`[Notifier] Telegram error: ${error.message}`);
  });
}

function sendEmail(to, subject, body) {
  const scriptPath = path.join(__dirname, 'gmail-send.js');
  const safeTo = to.replace(/"/g, '\\"');
  const safeSubject = subject.replace(/"/g, '\\"');
  const safeBody = body.replace(/"/g, '\\"');
  
  exec(`node "${scriptPath}" "${safeTo}" "${safeSubject}" "${safeBody}"`, (error, stdout, stderr) => {
    if (error) console.error(`[Notifier] Email error: ${error.message}`);
    else console.log(`[Notifier] Email sent to ${to}`);
  });
}

module.exports = { sendTelegram, sendEmail, RACHAEL_EMAIL };
