const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { getAuth } = require('./lib');

function usage() {
  console.error('Usage: node photos-upload.js /path/to/file.jpg [albumId]');
  process.exit(1);
}

async function uploadBytes(token, filePath) {
  const bytes = fs.readFileSync(filePath);
  const filename = path.basename(filePath);

  const res = await fetch('https://photoslibrary.googleapis.com/v1/uploads', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-type': 'application/octet-stream',
      'X-Goog-Upload-Protocol': 'raw',
      'X-Goog-Upload-File-Name': filename
    },
    body: bytes
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Upload failed ${res.status}: ${text}`);
  }
  return text; // uploadToken
}

async function batchCreate(token, uploadToken, filename, albumId) {
  const body = {
    newMediaItems: [
      {
        description: filename,
        simpleMediaItem: { uploadToken }
      }
    ]
  };
  if (albumId) body.albumId = albumId;

  const res = await fetch('https://photoslibrary.googleapis.com/v1/mediaItems:batchCreate', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const data = await res.json();
  if (!res.ok) {
    console.error(JSON.stringify(data, null, 2));
    process.exit(1);
  }

  const item = data.newMediaItemResults?.[0];
  console.log(JSON.stringify({
    status: item?.status,
    mediaItem: item?.mediaItem && {
      id: item.mediaItem.id,
      filename: item.mediaItem.filename,
      mimeType: item.mediaItem.mimeType,
      productUrl: item.mediaItem.productUrl
    }
  }, null, 2));
}

async function main() {
  const filePath = process.argv[2];
  const albumId = process.argv[3];
  if (!filePath) usage();

  const auth = getAuth();
  const { token } = await auth.getAccessToken();
  if (!token) throw new Error('No access token. Re-run auth.');

  const filename = path.basename(filePath);
  const uploadToken = await uploadBytes(token, filePath);
  await batchCreate(token, uploadToken, filename, albumId);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
