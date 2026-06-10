export const CLIENT_MESSAGE_ID_PREFIX = "clientmsg_";

const CLIENT_MESSAGE_ID_REGEX = /^clientmsg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function generateClientMessageId() {
  return `${CLIENT_MESSAGE_ID_PREFIX}${crypto.randomUUID()}`;
}

export function isValidClientMessageId(value: string) {
  return CLIENT_MESSAGE_ID_REGEX.test(value);
}
