/**
 * Emergency World Cup 2026 cross-venue arbitrage:
 * FIFA team name normalisation alias map.
 *
 * Kalshi and Polymarket both list FIFA World Cup winner/tournament markets,
 * but they use different naming conventions for teams. This map collapses
 * every known alias into a single canonical 3-letter code.
 *
 * The canonical code chosen is a consistent 3-letter token that matches the
 * most common abbreviation used in the data – e.g. "bra" for Brazil, "arg"
 * for Argentina, "usa" for United States – NOT the formal ISO alpha-3
 * (which would be "USA" uppercase, and differs in some edge cases).
 *
 * @emergency This map is scoped to the 2026 FIFA World Cup. When the generic
 * topic normalisation pipeline can produce stable team keys across venues,
 * this module can be deleted.
 */

/** Canonical team code → list of alias strings (all must be lowercase). */
const ALIAS_TABLE: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["arg", ["argentina", "argentine"]],
  ["aus", ["australia", "australian", "socceroos"]],
  ["bel", ["belgium", "belgian", "red devils"]],
  ["bra", ["brazil", "brasileiro", "brazilian", "canarinho", "selecao", "seleção"]],
  ["cam", ["cameroon", "cameroun", "cameroonian", "indomitable lions"]],
  ["can", ["canada", "canadian"]],
  ["crc", ["costa rica", "costa rican"]],
  ["cro", ["croatia", "croatian", "vatreni"]],
  ["den", ["denmark", "danish"]],
  ["ecu", ["ecuador", "ecuadorian"]],
  ["eng", ["england", "english", "three lions"]],
  ["esp", ["spain", "spanish", "espana", "la roja"]],
  ["fra", ["france", "french", "les bleus"]],
  ["ger", ["germany", "german", "deutschland", "die mannschaft"]],
  ["gha", ["ghana", "ghanaian", "black stars"]],
  ["irn", ["iran", "iranian", "team melli"]],
  ["ita", ["italy", "italian", "azzurri"]],
  ["jpn", ["japan", "japanese", "samurai blue"]],
  ["kor", ["south korea", "korea", "korean", "taeguk warriors"]],
  ["mar", ["morocco", "moroccan", "atlas lions"]],
  ["mex", ["mexico", "mexican", "el tri"]],
  ["ned", ["netherlands", "dutch", "oranje"]],
  ["nga", ["nigeria", "nigerian", "super eagles"]],
  ["nor", ["norway", "norwegian"]],
  ["por", ["portugal", "portuguese"]],
  ["pol", ["poland", "polish"]],
  ["qat", ["qatar", "qatari"]],
  ["ksa", ["saudi arabia", "saudi", "saudi arabian"]],
  ["sen", ["senegal", "senegalese", "teranga lions"]],
  ["srb", ["serbia", "serbian"]],
  ["sui", ["switzerland", "swiss", "nati"]],
  ["swe", ["sweden", "swedish"]],
  ["tun", ["tunisia", "tunisian", "eagles of carthage"]],
  ["uru", ["uruguay", "uruguayan", "celeste"]],
  ["usa", ["united states", "us", "usmnt", "american", "yanks"]],
  ["wal", ["wales", "welsh"]],

  // Additional 2026 qualified teams
  ["chi", ["chile", "chilean", "la roja"]],
  ["col", ["colombia", "colombian", "cafeteros"]],
  ["alg", ["algeria", "algerian", "les verts"]],
  ["civ", ["ivory coast", "cote divoire", "cote d'ivoire", "côte d'ivoire", "elephants"]],
  ["gre", ["greece", "greek"]],
  ["par", ["paraguay", "paraguayan", "albirroja"]],
  ["per", ["peru", "peruvian", "la blanquirroja"]],
  ["bol", ["bolivia", "bolivian", "verde"]],
  ["ven", ["venezuela", "venezuelan", "la vinotinto"]],
  ["tur", ["turkey", "turkish", "turkiye"]],
  ["ukr", ["ukraine", "ukrainian"]],
  ["aut", ["austria", "austrian"]],
  ["cze", ["czechia", "czech republic", "czech"]],
  ["rou", ["romania", "romanian"]],
  ["hun", ["hungary", "hungarian", "magyarok"]],
  ["rsa", ["south africa", "south african", "bafana bafana"]],
  ["cpv", ["cape verde", "cape verdean", "cabo verde"]],
  ["cod", ["congo", "congo dr", "dr congo", "congo drc", "drc"]],
  ["bih", ["bosnia", "bosnia and herzegovina", "bosnian"]],
  ["cuw", ["curaçao", "curacao"]],
  ["egy", ["egypt", "egyptian"]],
  ["hti", ["haiti", "haitian"]],
  ["irq", ["iraq", "iraqi"]],
  ["jor", ["jordan", "jordanian"]],
  ["nzl", ["new zealand", "new zealander", "all whites"]],
  ["pan", ["panama", "panamanian"]],
  ["sco", ["scotland", "scottish"]],
  ["uzb", ["uzbekistan", "uzbek"]],
  ["prk", ["north korea", "north korean"]],
];

/** Pre-built map: alias (lowercased, trimmed) → canonical team code. */
const LOOKUP = new Map<string, string>();
/** Aliases 3+ chars for substring matching (avoids checking short aliases like "us" on every call). */
const SUBSTRING_ALIASES: Array<[string, string]> = [];

for (const [canonical, aliases] of ALIAS_TABLE) {
  // Map the canonical code to itself as a fallback.
  LOOKUP.set(canonical, canonical);
  for (const alias of aliases) {
    const normalized = alias.trim().toLowerCase();
    LOOKUP.set(normalized, canonical);
    if (normalized.length >= 3) {
      SUBSTRING_ALIASES.push([normalized, canonical]);
    }
  }
}

/**
 * Resolve a raw team name to the canonical 3-letter World Cup team code.
 * Returns `undefined` if the team is not in the alias map.
 *
 * The input must already be lowercased by the caller.
 */
export function resolveWorldCupTeam(lowercasedName: string): string | undefined {
  const cleaned = lowercasedName.trim().toLowerCase();
  if (!cleaned) return undefined;

  // Exact match is the fast path.
  const exact = LOOKUP.get(cleaned);
  if (exact !== undefined) return exact;

  // Check if any known alias is a substring of the input (handles "team brazil", "the brazilian squad").
  for (const [alias, canonical] of SUBSTRING_ALIASES) {
    if (cleaned.includes(alias)) {
      return canonical;
    }
  }

  return undefined;
}

/** All known canonical team codes. */
export const WORLDCUP_TEAM_CODES: ReadonlySet<string> = new Set(ALIAS_TABLE.map(([c]) => c));

/** Total qualified teams count (for tests). */
export const WORLDCUP_TEAM_COUNT = ALIAS_TABLE.length;
