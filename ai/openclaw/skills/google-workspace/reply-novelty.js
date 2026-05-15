function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
}

function noveltyScore(prev, next) {
  const a = normalize(prev);
  const b = normalize(next);
  if (!a && !b) return 0;
  if (!a) return 1;
  if (a === b) return 0;

  // Simple heuristic: proportion of new words not in prev.
  const aw = new Set(a.split(' '));
  const bw = b.split(' ');
  const newWords = bw.filter(w => w && !aw.has(w));
  const score = newWords.length / Math.max(1, bw.length);
  return score;
}

function isMeaningfullyNew(prev, next, threshold = 0.12) {
  return noveltyScore(prev, next) >= threshold;
}

module.exports = { normalize, noveltyScore, isMeaningfullyNew };
