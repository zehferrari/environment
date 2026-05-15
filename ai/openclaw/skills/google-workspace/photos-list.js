const fetch = require('node-fetch');
const { getAuth } = require('./lib');

async function main() {
  const auth = getAuth();

  // Ensure we have a fresh access token
  const { token } = await auth.getAccessToken();
  if (!token) throw new Error('No access token available. Re-run node auth.js');

  const res = await fetch('https://photoslibrary.googleapis.com/v1/mediaItems?pageSize=10', {
    headers: { Authorization: `Bearer ${token}` },
  });

  const data = await res.json();
  if (!res.ok) {
    console.error(JSON.stringify(data, null, 2));
    process.exit(1);
  }

  const items = (data.mediaItems || []).map(m => ({
    id: m.id,
    filename: m.filename,
    mimeType: m.mimeType,
    creationTime: m.mediaMetadata?.creationTime,
    productUrl: m.productUrl,
  }));

  console.log(JSON.stringify(items, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
