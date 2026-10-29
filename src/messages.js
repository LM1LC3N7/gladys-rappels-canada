// -----------------------------------------------------------------------------
// Texts sent from the container (feature values, connection status, action and
// scene messages, scene variables), in English and French. The recall sheets
// come from Health Canada in the language of the configuration: their titles,
// issues and advice are shown as published.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { LANGUAGES } from './config.js';

// Short enough for a widget badge (16 characters).
export const CATEGORY_NAMES = {
  en: {
    food: 'Food',
    consumer: 'Consumer product',
    vehicles: 'Vehicle',
    health: 'Health product',
    medical_devices: 'Medical device',
    other: 'Other',
  },
  fr: {
    food: 'Aliment',
    consumer: 'Consommation',
    vehicles: 'Véhicule',
    health: 'Produit de santé',
    medical_devices: 'Instr. médical',
    other: 'Autre',
  },
};

export const COLORS = { recall: WIDGET_COLORS.WARNING };

export const PHRASES = {
  en: {
    none: 'No recall in the last 7 days',
    recalls: ({ count }) =>
      count === 1 ? '1 recall or alert in 7 days' : `${count} recalls or alerts in 7 days`,
    noRecall: 'No recall or alert in your selection over the last 7 days.',
    list: ({ head, items }) => `${head}: ${items.join('; ')}.`,
    more: ({ count }) => `and ${count} more`,
    summary: ({ title, issue }) =>
      issue ? `Recall in Canada: ${title}. Issue: ${issue}.` : `Recall in Canada: ${title}.`,
  },
  fr: {
    none: 'Aucun rappel ces 7 derniers jours',
    recalls: ({ count }) =>
      count === 1 ? '1 rappel ou avis sur 7 jours' : `${count} rappels ou avis sur 7 jours`,
    noRecall: 'Aucun rappel ni avis dans votre sélection ces 7 derniers jours.',
    list: ({ head, items }) => `${head} : ${items.join(' ; ')}.`,
    more: ({ count }) => `et ${count} de plus`,
    summary: ({ title, issue }) =>
      issue ? `Rappel au Canada : ${title}. Problème : ${issue}.` : `Rappel au Canada : ${title}.`,
  },
};

// Connection status and action messages.
export const STATUS = {
  en: {
    initFailed: 'Cannot read the configuration from Gladys: trying again.',
    sourceDown: ({ error }) =>
      `The open data of Health Canada cannot be read (${error}): the recalls are not updated.`,
    paused: ({ time }) => `Health Canada asked to wait: next try at ${time}.`,
    stale: ({ day }) =>
      `The file of Health Canada has not changed since ${day}: the counters are not published again until it does.`,
    noCategory: 'No category selected: nothing is followed.',
    dataUnreadable:
      'The memory of the integration (/data) cannot be read: the recalls already seen are not known, nothing fires until a new file.',
    dataUnwritable:
      'The memory of the integration (/data) cannot be written: after a restart, the recalls already seen are forgotten.',
    truncated: 'The file holds more sheets than the integration reads: the last ones are ignored.',
    waiting: 'Waiting for the first reading of the file of Health Canada.',
    notYet: 'The file of Health Canada has not been read yet.',
    old: ({ time }) =>
      `The recalls are not up to date: the file of Health Canada was last read on ${time}.`,
    staleShort: ({ day }) =>
      `The recalls are not up to date: the file of Health Canada has not changed since ${day}.`,
    summary: ({ text, time }) => `${text} File read at ${time}.`,
  },
  fr: {
    initFailed: 'Impossible de lire la configuration depuis Gladys : nouvel essai en cours.',
    sourceDown: ({ error }) =>
      `Les données ouvertes de Santé Canada sont illisibles (${error}) : les rappels ne sont pas mis à jour.`,
    paused: ({ time }) => `Santé Canada demande d'attendre : prochain essai à ${time}.`,
    stale: ({ day }) =>
      `Le fichier de Santé Canada n'a pas changé depuis le ${day} : les compteurs ne sont plus publiés jusqu'à sa mise à jour.`,
    noCategory: 'Aucune catégorie choisie : rien n’est suivi.',
    dataUnreadable:
      'La mémoire de l’intégration (/data) est illisible : les rappels déjà vus sont inconnus, rien n’est déclenché avant un nouveau fichier.',
    dataUnwritable:
      'La mémoire de l’intégration (/data) ne peut pas être écrite : après un redémarrage, les rappels déjà vus sont oubliés.',
    truncated:
      'Le fichier contient plus de fiches que l’intégration n’en lit : les dernières sont ignorées.',
    waiting: 'En attente de la première lecture du fichier de Santé Canada.',
    notYet: 'Le fichier de Santé Canada n’a pas encore été lu.',
    old: ({ time }) =>
      `Les rappels ne sont pas à jour : le fichier de Santé Canada a été lu pour la dernière fois le ${time}.`,
    staleShort: ({ day }) =>
      `Les rappels ne sont pas à jour : le fichier de Santé Canada n’a pas changé depuis le ${day}.`,
    summary: ({ text, time }) => `${text} Fichier lu à ${time}.`,
  },
};

// What went wrong with the file, said for people (never a raw code).
export const ERRORS = {
  en: {
    network: 'the connection failed',
    dns: 'the server name cannot be found (DNS)',
    refused: 'the connection was refused',
    closed: 'the connection was cut by the server',
    timeout: 'no answer in time',
    stalled: 'the download stopped halfway',
    tooLong: 'the download took too long',
    redirect: 'the server redirects elsewhere',
    http: ({ status }) => `the server answered with an error (HTTP ${status})`,
    size: 'the file is far larger than expected',
    format: 'the file is not in the expected format',
    noCopy: 'the server says "not modified" for a copy no longer kept',
    stopped: 'the integration stopped',
  },
  fr: {
    network: 'la connexion a échoué',
    dns: 'le nom du serveur est introuvable (DNS)',
    refused: 'la connexion a été refusée',
    closed: 'la connexion a été coupée par le serveur',
    timeout: 'pas de réponse à temps',
    stalled: 'le téléchargement s’est arrêté en route',
    tooLong: 'le téléchargement a pris trop de temps',
    redirect: 'le serveur redirige ailleurs',
    http: ({ status }) => `le serveur a répondu par une erreur (HTTP ${status})`,
    size: 'le fichier est bien plus gros que prévu',
    format: 'le fichier n’a pas le format attendu',
    noCopy: 'le serveur répond « non modifié » pour une copie qui n’est plus gardée',
    stopped: 'l’intégration s’est arrêtée',
  },
};

/** An error `{ kind, status }` in one language. */
export function describeError(error, language) {
  const entry = ERRORS[language][error.kind] ?? ERRORS[language].network;
  return typeof entry === 'function' ? entry(error) : entry;
}

/** One entry of a message table, in every language: `{ en, fr }`. */
export function render(table, key, params = {}) {
  return Object.fromEntries(
    LANGUAGES.map((language) => {
      const entry = table[language][key];
      return [language, typeof entry === 'function' ? entry(params) : entry];
    }),
  );
}

/** One entry in every language, with parameters computed per language. */
export function renderEach(table, key, paramsOf) {
  return Object.fromEntries(
    LANGUAGES.map((language) => [language, table[language][key](paramsOf(language))]),
  );
}

/** Several multi-language texts joined, language by language. */
export function join(...messages) {
  return Object.fromEntries(
    LANGUAGES.map((language) => [
      language,
      messages
        .filter(Boolean)
        .map((message) => message[language])
        .join(' '),
    ]),
  );
}

const locale = (language) => (language === 'en' ? 'en-CA' : 'fr-CA');

/** A source day "2026-10-28" written for people: "Oct. 28" / "28 oct.". */
export function formatSourceDay(day, language) {
  if (!day) {
    return '';
  }
  const [y, m, d] = day.split('-').map(Number);
  return new Intl.DateTimeFormat(locale(language), {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** A date and a time in the user's time zone (TZ, set by the Gladys supervisor). */
export function formatDate(time, language) {
  return new Intl.DateTimeFormat(locale(language), {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(time));
}

/** A time of day, e.g. "18:35". */
export function formatTime(time, language) {
  return new Intl.DateTimeFormat(locale(language), {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(time));
}

/** The calendar day of a time in the user's time zone, "2026-10-20". */
export function localDay(time) {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(time));
}

/** The day `days` calendar days before `day` ("2026-10-20", 7 → "2026-10-13"). */
export function dayBefore(day, days) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - days)).toISOString().slice(0, 10);
}

export const clip = (text, max) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/** The value of the "Latest recall" feature: "Oct. 28 · Buck Wild brand …". */
export function describe(recall, language) {
  const day = formatSourceDay(recall.updated, language);
  return clip(day ? `${day} · ${recall.title}` : recall.title, 200);
}

// Recalls named in one sentence: a scene that reads it aloud stays short.
export const SENTENCE_RECALLS = 5;

/** The recalls of the last 7 days as one sentence, newest first. */
export function sentence(recalls, language) {
  const p = PHRASES[language];
  if (recalls.length === 0) {
    return p.noRecall;
  }
  const items = recalls.slice(0, SENTENCE_RECALLS).map((recall) => clip(recall.title, 120));
  const rest = recalls.length - SENTENCE_RECALLS;
  if (rest > 0) {
    items.push(p.more({ count: rest }));
  }
  return p.list({ head: p.recalls({ count: recalls.length }), items });
}
