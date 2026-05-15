const fetch = require('node-fetch');
const { getAuth } = require('./lib');

function usage() {
  console.error('Usage: node photos-create-album.js "Album title"');
  process.exit(1);
}

async function main() {
  const title = process.argv.slice(2).join(' ').trim();
  if (!title) usage();

  const auth = getAuth();
  const { token } = await auth.getAccessToken();
  if (!token) throw new Error('No access token. Re-run auth.');

  const res = await fetch('https://photoslibrary.googleapis.com/v1/albums', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ album: { title } })
  });

  const data = await res.json();
  if (!res.ok) {
    console.error(JSON.stringify(data, null, 2));
    process.exit(1);
  }

  console.log(JSON.stringify({ id: data.id, title: data.title, productUrl: data.productUrl }, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
