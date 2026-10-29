// -----------------------------------------------------------------------------
// Dashboard widget (manifest `widgets`, Gladys 5.1+): `recalls`.
//
// A heading with the number of recalls of the last 7 days, then the latest
// ones as a `card-list` (8 rows at most, the core's cap), newest first, the
// badge giving the category (red for a Class 1 / Type I recall, the most
// serious). Tapping a row opens the core's detail panel: issue, class, what
// to do, and the link to the official sheet. The footer gives the source and
// the time of the last reading, and a button opens recalls-rappels.canada.ca.
// Budget: 2 texts, 1 card-list, 1 button.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { CATEGORY_NAMES, COLORS, clip, formatDate, formatSourceDay } from './messages.js';
import { WIDGET_KEY } from './monitor.js';
import { SITE_URL } from './source.js';

export const MAX_ITEMS = 8;
export const TTL_SECONDS = 600;

export const TEXT = {
  waiting: { en: 'Waiting for Health Canada…', fr: 'En attente de Santé Canada…' },
  none: { en: 'No recall in 7 days', fr: 'Aucun rappel sur 7 jours' },
  one: { en: '1 recall in 7 days', fr: '1 rappel sur 7 jours' },
  many: { en: ' recalls in 7 days', fr: ' rappels sur 7 jours' },
  source: { en: 'Source: Health Canada', fr: 'Source : Santé Canada' },
  stale: { en: 'file not updated', fr: 'fichier non mis à jour' },
  sheet: { en: 'Recall sheet', fr: 'Fiche de rappel' },
  issue: { en: 'Issue', fr: 'Problème' },
  recallClass: { en: 'Class', fr: 'Classe' },
  todo: { en: 'What to do', fr: 'Que faire' },
  updated: { en: 'Last updated', fr: 'Mis à jour' },
  site: { en: 'Recalls and safety alerts', fr: 'Rappels et avis de sécurité' },
};

const t = (text, language) => text[language] ?? text.en;

function heading(count, language) {
  if (count === 0) {
    return t(TEXT.none, language);
  }
  return count === 1 ? t(TEXT.one, language) : `${count}${t(TEXT.many, language)}`;
}

/** Class 1 (food) and Type I (health products): the most serious recalls. */
export const isSerious = (recall) => /^(Class 1|Classe 1|Type I)$/.test(recall.recallClass);

/** One row of the list, and its detail panel. */
export function itemOf(recall, language) {
  const colon = language === 'fr' ? ' : ' : ': ';
  const field = (label, value) => (value ? `${t(label, language)}${colon}${value}` : null);
  return {
    title: clip(recall.title, 60),
    subtitle: clip(
      [formatSourceDay(recall.updated, language), recall.subcategory].filter(Boolean).join(' · '),
      60,
    ),
    badge: {
      text: CATEGORY_NAMES[language][recall.category],
      color: isSerious(recall) ? WIDGET_COLORS.DANGER : COLORS.recall,
    },
    description: clip(
      [
        field(TEXT.issue, recall.issue),
        field(TEXT.recallClass, recall.recallClass),
        field(TEXT.todo, recall.todo),
        field(TEXT.updated, formatSourceDay(recall.updated, language)),
      ]
        .filter(Boolean)
        .join('\n'),
      2000,
    ),
    links: [{ url: recall.url, label: t(TEXT.sheet, language) }],
  };
}

export const WIDGETS = {
  [WIDGET_KEY]: {
    async get(monitor, { language = 'en' } = {}) {
      const lang = language === 'fr' ? 'fr' : 'en';
      const { recalls, ok, readAt, stale } = monitor.snapshot();
      const source = t(TEXT.source, lang);
      const components = [
        {
          type: 'text',
          variant: 'heading',
          text: ok ? heading(recalls.length, lang) : t(TEXT.waiting, lang),
        },
      ];
      const rows = recalls.slice(0, MAX_ITEMS).map((recall) => itemOf(recall, lang));
      if (rows.length > 0) {
        components.push({ type: 'card-list', display: 'list', items: rows });
      }
      const caption = [source];
      if (readAt !== null) {
        caption.push(formatDate(readAt, lang));
      }
      if (stale) {
        caption.push(t(TEXT.stale, lang));
      }
      components.push(
        { type: 'text', variant: 'caption', text: caption.join(' · ') },
        {
          type: 'button',
          label: t(TEXT.site, lang),
          icon: 'external-link',
          link: { url: SITE_URL[lang] },
        },
      );
      return { ttl_seconds: TTL_SECONDS, components };
    },
  },
};
