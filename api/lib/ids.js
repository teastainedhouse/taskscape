import { randomUUID } from 'node:crypto';

/** @returns {string} a new record id */
export function newId() {
  return randomUUID();
}
