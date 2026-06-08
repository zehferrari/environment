const { PubSub } = require('@google-cloud/pubsub');

function usage() {
  console.error('Usage: node create-gmail-subs.js projects/<project>/topics/<topic> <subscription> [subscription...]');
  console.error('Example: node create-gmail-subs.js projects/asdrubal-projects/topics/gmail-inbox-watch gmail-inbox-watch-asdrubal-sub gmail-inbox-watch-barekbaal-sub');
}

function parseTopic(topicName) {
  const match = topicName.match(/^projects\/([^/]+)\/topics\/([^/]+)$/);
  if (!match) {
    throw new Error('topic must be a full resource name: projects/<project>/topics/<topic>');
  }
  return { projectId: match[1], topicId: match[2] };
}

function subscriptionId(name) {
  const match = name.match(/^projects\/[^/]+\/subscriptions\/([^/]+)$/);
  return match ? match[1] : name;
}

async function main() {
  const [topicName, ...subscriptionNames] = process.argv.slice(2);
  if (!topicName || subscriptionNames.length === 0) {
    usage();
    process.exit(2);
  }

  const { projectId, topicId } = parseTopic(topicName);
  const pubsub = new PubSub({ projectId });
  const topic = pubsub.topic(topicId);
  const [topicExists] = await topic.exists();
  if (!topicExists) {
    throw new Error(`topic does not exist: ${topicName}`);
  }

  for (const name of subscriptionNames) {
    const id = subscriptionId(name);
    const sub = pubsub.subscription(id);
    const [exists] = await sub.exists();
    if (exists) {
      console.log(`exists ${id}`);
      continue;
    }
    await topic.createSubscription(id);
    console.log(`created ${id}`);
  }
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
