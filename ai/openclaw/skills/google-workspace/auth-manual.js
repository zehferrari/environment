const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { google } = require('googleapis');

const SECRETS_DIR = path.join(__dirname, 'secrets');
const CLIENT_PATH = path.join(SECRETS_DIR, 'oauth-client.json');
const TOKEN_PATH = path.join(SECRETS_DIR, 'token.json');

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/photoslibrary',
  'https://www.googleapis.com/auth/photoslibrary.appendonly',
  'https://www.googleapis.com/auth/pubsub'
];

function loadClient() {
  const raw = fs.readFileSync(CLIENT_PATH, 'utf8');
  const json = JSON.parse(raw);
  const c = json.installed || json.web;
  if (!c) throw new Error('oauth-client.json must have "installed" or "web" section');
  const redirectUris = c.redirect_uris || [];
  const redirectUri = redirectUris[0];
  if (!redirectUri) throw new Error('No redirect_uris in oauth-client.json');
  return { client_id: c.client_id, client_secret: c.client_secret, redirect_uri: redirectUri };
}

async function main() {
  if (!fs.existsSync(SECRETS_DIR)) fs.mkdirSync(SECRETS_DIR, { recursive: true });
  if (!fs.existsSync(CLIENT_PATH)) {
    console.error(`Missing ${CLIENT_PATH}. Copy your OAuth client JSON there.`);
    process.exit(1);
  }

  const { client_id, client_secret, redirect_uri } = loadClient();
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uri);

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });

  console.log('\n1) Open this URL in your browser and complete consent:\n');
  console.log(authUrl);
  console.log('\n2) After consent you will be redirected to the redirect URI (it may fail to load).');
  console.log('   Copy the full URL from your browser address bar. It will contain ?code=...');
  console.log('   Paste either the CODE value, or the whole redirected URL below.\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const input = await new Promise(resolve => rl.question('Code or redirect URL: ', ans => resolve(ans.trim())));
  rl.close();

  let code = input;
  if (input.startsWith('http://') || input.startsWith('https://')) {
    const u = new URL(input);
    code = u.searchParams.get('code') || '';
  }

  if (!code) {
    throw new Error('No code found in input. Paste the code=... value (or full URL).');
  }

  const { tokens } = await oAuth2Client.getToken(code);
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
  console.log(`\nSaved token to ${TOKEN_PATH}`);
}

main().catch(err => {
  console.error(err?.response?.data || err);
  process.exit(1);
});
