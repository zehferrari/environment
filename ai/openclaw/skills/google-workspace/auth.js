const fs = require('fs');
const path = require('path');
const http = require('http');
const { URL } = require('url');
const { google } = require('googleapis');

const SECRETS_DIR = path.join(__dirname, 'secrets');
const CLIENT_PATH = path.join(SECRETS_DIR, 'oauth-client.json');
const TOKEN_PATH = path.join(SECRETS_DIR, 'token.json');

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/photoslibrary.readonly',
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
  fs.mkdirSync(SECRETS_DIR, { recursive: true });
  if (!fs.existsSync(CLIENT_PATH)) {
    console.error(`Missing ${CLIENT_PATH}. Copy your OAuth client JSON there.`);
    process.exit(1);
  }

  if (fs.existsSync(TOKEN_PATH)) {
    console.log('Token already exists at secrets/token.json');
    process.exit(0);
  }

  const { client_id, client_secret, redirect_uri } = loadClient();
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uri);

  const redirect = new URL(redirect_uri);
  const host = redirect.hostname || 'localhost';
  const port = Number(redirect.port || (redirect.protocol === 'https:' ? 443 : 80));
  const pathname = redirect.pathname || '/';

  const server = http.createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url, redirect_uri);
      if (reqUrl.pathname !== pathname) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const code = reqUrl.searchParams.get('code');
      const err = reqUrl.searchParams.get('error');
      if (err) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end(`OAuth error: ${err}`);
        return;
      }
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Missing code');
        return;
      }

      const { tokens } = await oAuth2Client.getToken(code);
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Authorization complete. You can close this tab.');
      console.log(`Saved token to ${TOKEN_PATH}`);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Auth failed. Check console.');
      console.error(e);
    } finally {
      setTimeout(() => server.close(), 250);
    }
  });

  server.listen(port, host, () => {
    const authUrl = oAuth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      prompt: 'consent',
    });

    console.log(`Listening on ${redirect_uri} for OAuth callback...`);
    console.log('\nAuthorize this app by visiting this url:\n');
    console.log(authUrl);
  });
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
