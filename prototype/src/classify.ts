import type { Class } from './domain.ts';

/**
 * Class lookup, keyed on normalised source label — the table wins over sign for
 * any known label (a contradicting sign is a Data issue, never a
 * reclassification). Four classes per the Canonical vocabulary decision.
 */
const TABLE: Record<string, Class> = {
  // Income
  salary: 'Income',
  'tereza rent': 'Income',
  // Asset sales
  'sold shares': 'Asset sales',
  // Investments
  investments: 'Investments',
  'mamka btc': 'Investments',
  'albert btc': 'Investments',
  // Spend
  'rent etc.': 'Spend',
  tax: 'Spend',
  'fun, not essential groceries, health, barber': 'Spend',
  'fun, not essential groceries': 'Spend',
  vacation: 'Spend',
  'health + barber': 'Spend',
  'kuba + fit': 'Spend',
  'dining out': 'Spend',
  'groceries etc.': 'Spend',
  'car, bike, etc.': 'Spend',
  kid: 'Spend',
  mobile: 'Spend',
  albert: 'Spend',
};

/** The sign a known label's `amount actual` is expected to carry. */
const EXPECTED_SIGN: Record<Class, 1 | -1> = {
  Income: 1,
  'Spend': -1,
  Investments: -1,
  'Asset sales': 1,
};

/** `starting amount` is an Opening balance annotation, not a cashflow. */
export const OPENING_LABEL = 'starting amount';

export function normaliseLabel(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function isKnownLabel(categoryId: string): boolean {
  return categoryId in TABLE;
}

/** Table first; unknown labels fall back to the sign of `amount actual`. */
export function classify(categoryId: string, actual: number | null): Class {
  const known = TABLE[categoryId];
  if (known) return known;
  return (actual ?? 0) >= 0 ? 'Income' : 'Spend';
}

/** True when a known label's amount contradicts its expected direction. */
export function isSignAnomaly(categoryId: string, actual: number | null): boolean {
  const known = TABLE[categoryId];
  if (!known || actual === null || actual === 0) return false;
  return Math.sign(actual) !== EXPECTED_SIGN[known];
}

/** Everyday balance covers these two; the investing toggle adds the rest. */
export const EVERYDAY_CLASSES: Class[] = ['Income', 'Spend'];
export const INVESTING_CLASSES: Class[] = ['Investments', 'Asset sales'];
