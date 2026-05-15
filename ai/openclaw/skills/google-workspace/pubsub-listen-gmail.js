const fs = require('fs');
const path = require('path');
const { PubSub } = require('@google-cloud/pubsub');

// This script listens to a Pub/Sub *subscription* (pull) and writes the most recent
// Gmail push payload to stdout, while also saving it to disk for debugging.
//
// Gmail push payload: { emailAddress, historyId }
//
// Usage:
//   GOOGLE_APPLICATION_CREDENTIALS=secrets/gcp-sa.json \
//   node pubsub-listen-gmail.js gmail-inbox-watch-sub

async function main() {
  const subName = process.argv[2];
  if (!subName) {
    console.error('Usage: node pubsub-listen-gmail.js <subscriptionName>');
    process.exit(1);
  }

  const pubsub = new PubSub();
  const subscription = pubsub.subscription(subName);

  const outPath = path.join(__dirname, 'last-push.json');

  const handler = message => {
    try {
      const dataStr = message.data ? message.data.toString('utf8') : '{}';
      let data;
      try { data = JSON.parse(dataStr); } catch { data = { raw: dataStr }; }

      const payload = {
        receivedAt: new Date().toISOString(),
        id: message.id,
        publishTime: message.publishTime?.toISOString?.() || String(message.publishTime || ''),
        attributes: message.attributes || {},
        data,
      };

      fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
      console.log(JSON.stringify(payload, null, 2));
      message.ack();
    } catch (e) {
      console.error(e);
      // If something goes wrong, nack to retry.
      message.nack();
    }
  };

  subscription.on('message', handler);
  subscription.on('error', err => {
    console.error('Subscription error:', err);
    process.exit(1);
  });

  console.error(`Listening for Pub/Sub messages on subscription: ${subName}`);
  // keep process alive
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
