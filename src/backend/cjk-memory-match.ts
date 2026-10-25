// Memory search for Chinese, Japanese and Korean text.
//
// The memory search indexes use the unicode61 tokenizer, which keeps a run of CJK characters with no
// space as one token: "使用者住在台北" is one word, so a search for "台北" finds nothing. The indexes stay
// as they are; a query with CJK text also scores each memory of the owner by the overlapping character
// pairs (bigrams) of that text. An owner holds at most a few hundred memories, so the scan is small.

const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;

/**
 * Characters that join or end a phrase more than they carry meaning. A pair with one of them, such as
 * "的飲" or "我推", matches nearly any text, so it does not count.
 */
const FUNCTION_CHARACTERS = new Set(
  "的了是我你他她它們在和與及也都就嗎呢吧啊把被這那個有要會很還再又或而之以於對給讓請幫想說個一不沒の".split(""),
);

/** The most pairs one query scores by. A long message keeps its first pairs. */
export const CJK_BIGRAM_LIMIT = 48;

/** The distinct character pairs of the CJK text in a query, in order. Empty for a query with no CJK. */
export function cjkBigrams(query: string): string[] {
  const pairs = new Set<string>();
  for (const [run] of query.matchAll(CJK_RUN)) {
    const characters = [...run];
    for (let index = 0; index + 1 < characters.length; index += 1) {
      const first = characters[index] ?? "";
      const second = characters[index + 1] ?? "";
      if (FUNCTION_CHARACTERS.has(first) || FUNCTION_CHARACTERS.has(second)) continue;
      pairs.add(first + second);
      if (pairs.size >= CJK_BIGRAM_LIMIT) return [...pairs];
    }
  }
  return [...pairs];
}

/** How many of the pairs the text holds. */
export function cjkMatchScore(text: string, bigrams: readonly string[]) {
  return bigrams.filter((pair) => text.includes(pair)).length;
}
