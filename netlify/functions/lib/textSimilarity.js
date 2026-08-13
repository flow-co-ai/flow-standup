// Faithful JS port of generate.py's shared fuzzy-text-match mechanism
// (_text_similarity / _norm_dedup_text / SIMILARITY_DUP_THRESHOLD /
// COMPLETION_CORROBORATED_SIMILARITY_THRESHOLD, generate.py ~line 1524) --
// ported rather than reinvented so a "possible duplicate" verdict here means
// the exact same thing it means in the completion-dedup/alias-gap/prospect-
// bucketing paths that already rely on this. Keep both in sync by hand;
// there is no shared runtime between the Python job and these Netlify
// functions.
//
// sequenceMatcherRatio is a port of Python's stdlib
// difflib.SequenceMatcher(None, a, b, autojunk=True).ratio() -- specifically
// the isjunk=None call shape used everywhere in generate.py, which means
// the "junk" bucket is always empty and only the plain (non-junk) match-
// extension logic in find_longest_match ever runs. autojunk (the popular-
// element purge) is still implemented since it only activates once the
// shorter string is 200+ chars, which real updateBody text can reach.

function normDedupText(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
}

function sequenceMatcherRatio(a, b) {
  const la = a.length;
  const lb = b.length;

  // __chain_b: b2j maps each char in b to the list of indices it occurs at.
  const b2j = new Map();
  for (let i = 0; i < lb; i++) {
    const c = b[i];
    if (!b2j.has(c)) b2j.set(c, []);
    b2j.get(c).push(i);
  }
  // autojunk: purge characters that appear "too often" in b, same threshold
  // Python uses (only once len(b) >= 200).
  if (lb >= 200) {
    const ntest = Math.floor(lb / 100) + 1;
    for (const [c, idxs] of Array.from(b2j.entries())) {
      if (idxs.length > ntest) b2j.delete(c);
    }
  }

  function findLongestMatch(alo, ahi, blo, bhi) {
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;
    let j2len = new Map();
    for (let i = alo; i < ahi; i++) {
      const newj2len = new Map();
      const idxs = b2j.get(a[i]);
      if (idxs) {
        for (const j of idxs) {
          if (j < blo) continue;
          if (j >= bhi) break;
          const k = (j2len.get(j - 1) || 0) + 1;
          newj2len.set(j, k);
          if (k > bestsize) {
            besti = i - k + 1;
            bestj = j - k + 1;
            bestsize = k;
          }
        }
      }
      j2len = newj2len;
    }
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
      besti--; bestj--; bestsize++;
    }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize]) {
      bestsize++;
    }
    return [besti, bestj, bestsize];
  }

  function getMatchingBlocks() {
    const queue = [[0, la, 0, lb]];
    const matchingBlocks = [];
    while (queue.length) {
      const [alo, ahi, blo, bhi] = queue.pop();
      const [i, j, k] = findLongestMatch(alo, ahi, blo, bhi);
      if (k) {
        matchingBlocks.push([i, j, k]);
        if (alo < i && blo < j) queue.push([alo, i, blo, j]);
        if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
      }
    }
    matchingBlocks.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
    let i1 = 0, j1 = 0, k1 = 0;
    const nonAdjacent = [];
    for (const [i2, j2, k2] of matchingBlocks) {
      if (i1 + k1 === i2 && j1 + k1 === j2) {
        k1 += k2;
      } else {
        if (k1) nonAdjacent.push([i1, j1, k1]);
        i1 = i2; j1 = j2; k1 = k2;
      }
    }
    if (k1) nonAdjacent.push([i1, j1, k1]);
    return nonAdjacent;
  }

  const matches = getMatchingBlocks().reduce((sum, [, , k]) => sum + k, 0);
  const length = la + lb;
  return length ? (2.0 * matches) / length : 1.0;
}

const SIMILARITY_DUP_THRESHOLD = 0.6;

// Corroboration (an independent signal beyond text alone that two mentions
// describe the same real-world thing) lets a real match hiding behind heavy
// rewording clear a lower floor instead of the plain 0.6 -- generate.py's
// own corroboration is {source, sourceDate, who} all matching; callers here
// use whatever's the analogous "extra evidence" for their comparison (see
// lib/monday.js's findLikelyDuplicate for how it's applied to a live-Monday
// dedup check).
const COMPLETION_CORROBORATED_SIMILARITY_THRESHOLD = 0.45;

// 0.0-1.0. Full containment (either direction) of a non-trivial-length
// string (8+ chars) is treated as a perfect match before falling back to
// plain SequenceMatcher ratio -- see generate.py's _text_similarity for why
// (a short name fully contained in a longer title otherwise scores lower
// than its length gap alone deserves).
function textSimilarity(a, b) {
  const na = normDedupText(a);
  const nb = normDedupText(b);
  if (!na || !nb) return 0.0;
  const [shorter, longer] = na.length <= nb.length ? [na, nb] : [nb, na];
  if (shorter.length >= 8 && longer.includes(shorter)) return 1.0;
  return sequenceMatcherRatio(na, nb);
}

module.exports = { textSimilarity, SIMILARITY_DUP_THRESHOLD, COMPLETION_CORROBORATED_SIMILARITY_THRESHOLD };
