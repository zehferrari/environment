const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const SECRETS_DIR = path.join(__dirname, 'secrets');
const CLIENT_PATH = path.join(SECRETS_DIR, 'oauth-client.json');
const TOKEN_PATH = path.join(SECRETS_DIR, 'token.json');

// The code you provided
const CODE = '4/0AfrIepDgPsh9PtS2TX9ur8msY4XDtK4sgLkWOY8cU46YNhCbKaQqahAIGuQucmy3QVQj6Q';

function loadClient() {
  const raw = fs.readFileSync(CLIENT_PATH, 'utf8');
  const json = JSON.parse(raw);
  const c = json.installed || json.web;
  return { client_id: c.client_id, client_secret: c.client_secret, redirect_uri: c.redirect_uris[0] };
}

async function main() {
  const { client_id, client_secret, redirect_uri } = loadClient();
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uri);

  console.log('Exchanging code for token...');
  const { tokens } = await oAuth2Client.getToken(CODE);
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
  console.log(`Saved token to ${TOKEN_PATH}`);
}

main().catch(console.error);
