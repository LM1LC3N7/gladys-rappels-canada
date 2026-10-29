// -----------------------------------------------------------------------------
// Integration configuration: defaults (they mirror the `default` values of the
// manifest `config_schema`, see test/manifest.test.js) and normalization, so
// the rest of the code never deals with strings, blanks or `undefined`.
// -----------------------------------------------------------------------------

// Languages of the texts: the open data comes in English and in French, and the
// language chosen picks the file read (one file, never both).
export const LANGUAGES = ['en', 'fr'];

// The groups the integration follows. `key` is the stable English word the
// manifest, the scene triggers and the docs use; `organizations` are the
// values of the `Organization` column of the open data, in both files (as
// published on 29/10/2026). An organization added later is filed under
// `other`.
export const CATEGORIES = [
  { key: 'food', organizations: ['CFIA', 'ACIA'] },
  {
    key: 'consumer',
    organizations: ['Consumer product safety', 'Sécurité des produits de consommation'],
  },
  { key: 'vehicles', organizations: ['TC'] },
  {
    key: 'health',
    organizations: [
      'Drugs and health products',
      'Médicaments et produits de santé',
      'Marketed health products',
      'Produits de santé commercialisés',
      'Communications and Public Affairs Branch',
      'Direction générale des communications et des affaires publiques',
      'Controlled substances and cannabis',
      'Substances contrôlées et du cannabis',
      'HC',
      'SC',
    ],
  },
  { key: 'medical_devices', organizations: ['Medical devices', 'Instruments médicaux'] },
  { key: 'other', organizations: [] },
];
export const CATEGORY_KEYS = CATEGORIES.map((category) => category.key);

// Medical devices are left out by default: a quarter of the file, nearly all
// hospital and laboratory equipment.
export const DEFAULT_CATEGORIES = ['food', 'consumer', 'vehicles', 'health', 'other'];

const BY_ORGANIZATION = new Map(
  CATEGORIES.flatMap((category) => category.organizations.map((name) => [name, category.key])),
);

/** The stable key of an `Organization` value. */
export function categoryKey(organization) {
  return BY_ORGANIZATION.get(String(organization ?? '').trim()) ?? 'other';
}

// Hours between two checks of the file. Health Canada regenerates it once a
// day (around 02:15 UTC); a check whose file did not change costs a 304 and
// no byte of data.
export const REFRESH_INTERVALS = ['3', '6', '12', '24'];

// Bound of the free-text list: a scene that follows 200 brands would be
// better served by a category.
export const MAX_KEYWORDS = 30;
export const MAX_KEYWORD_LENGTH = 60;

export const DEFAULT_CONFIG = {
  categories: DEFAULT_CATEGORIES,
  keywords: '',
  refresh_interval: '6',
  language: 'fr',
};

/** Lower case, without accents nor punctuation: "Crème-Glacée" → "creme glacee". */
export function fold(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Brands or words, separated by commas, semicolons or new lines. */
export function parseKeywords(text) {
  const keywords = [];
  for (const part of String(text ?? '').split(/[,;\n]+/)) {
    const keyword = fold(part).slice(0, MAX_KEYWORD_LENGTH).trim();
    if (keyword !== '' && !keywords.includes(keyword)) {
      keywords.push(keyword);
    }
  }
  return keywords.slice(0, MAX_KEYWORDS);
}

function categories(value) {
  // A multi_select is stored as an array; an unset field keeps the default.
  if (!Array.isArray(value)) {
    return [...DEFAULT_CATEGORIES];
  }
  return CATEGORY_KEYS.filter((key) => value.includes(key));
}

/**
 * @param {Record<string, unknown>} raw the configuration returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const refresh = String(source.refresh_interval ?? '');
  return {
    categories: categories(source.categories),
    keywords: parseKeywords(source.keywords),
    refreshHours: Number(
      REFRESH_INTERVALS.includes(refresh) ? refresh : DEFAULT_CONFIG.refresh_interval,
    ),
    language: LANGUAGES.includes(source.language) ? source.language : DEFAULT_CONFIG.language,
  };
}
