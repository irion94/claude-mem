/**
 * Session wall-clock age guard must be configurable (baton fork).
 *
 * Upstream hardcodes MAX_SESSION_WALL_CLOCK_MS = 4h (#1590), which silently
 * drops every observation of a legitimate long-lived interactive session.
 * The limit now resolves from CLAUDE_MEM_SESSION_MAX_AGE_HOURS in settings:
 * a finite number of hours, 0 (or negative) disables the guard entirely,
 * anything unparsable falls back to the upstream 4h default.
 */
import { describe, test, expect } from 'bun:test';
import { resolveSessionMaxAgeMs } from '../src/services/worker/http/routes/SessionRoutes.js';
import { SettingsDefaultsManager } from '../src/shared/SettingsDefaultsManager.js';

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

describe('resolveSessionMaxAgeMs', () => {
  test('default settings resolve to the upstream 4h limit', () => {
    expect(resolveSessionMaxAgeMs({ CLAUDE_MEM_SESSION_MAX_AGE_HOURS: '4' }))
      .toBe(FOUR_HOURS_MS);
  });

  test('a custom hour value scales the limit', () => {
    expect(resolveSessionMaxAgeMs({ CLAUDE_MEM_SESSION_MAX_AGE_HOURS: '48' }))
      .toBe(48 * 60 * 60 * 1000);
  });

  test('fractional hours are honored', () => {
    expect(resolveSessionMaxAgeMs({ CLAUDE_MEM_SESSION_MAX_AGE_HOURS: '0.5' }))
      .toBe(30 * 60 * 1000);
  });

  test('zero disables the guard (returns 0)', () => {
    expect(resolveSessionMaxAgeMs({ CLAUDE_MEM_SESSION_MAX_AGE_HOURS: '0' }))
      .toBe(0);
  });

  test('a negative value also disables the guard', () => {
    expect(resolveSessionMaxAgeMs({ CLAUDE_MEM_SESSION_MAX_AGE_HOURS: '-1' }))
      .toBe(0);
  });

  test('garbage falls back to the 4h default', () => {
    expect(resolveSessionMaxAgeMs({ CLAUDE_MEM_SESSION_MAX_AGE_HOURS: 'lots' }))
      .toBe(FOUR_HOURS_MS);
  });

  test('a missing key falls back to the 4h default', () => {
    expect(resolveSessionMaxAgeMs({})).toBe(FOUR_HOURS_MS);
  });
});

describe('SettingsDefaultsManager', () => {
  test('ships CLAUDE_MEM_SESSION_MAX_AGE_HOURS with the upstream default of 4', () => {
    expect(SettingsDefaultsManager.getAllDefaults().CLAUDE_MEM_SESSION_MAX_AGE_HOURS)
      .toBe('4');
  });
});
