import type { Listing } from '../../src/source/listing-source.js';

/** A small, deterministic listing history for tests (mirrors the shape of the provided fixtures). */
export const v1: Listing = {
  title: 'Acme CRM',
  tagline: 'Simple CRM for small teams',
  price: '$29/mo',
  description: 'Track leads and deals in one place.',
};
export const v2: Listing = { ...v1, price: '$39/mo' };
export const v3: Listing = {
  ...v2,
  tagline: 'The CRM small teams love',
  description: 'Track leads and deals in one place. Now with AI follow-up reminders.',
};
