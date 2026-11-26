import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_CONFIG, parseConfig } from '../src/config.js';
import { createMessages, ENGLISH } from '../src/messages.js';

describe('configuration from the address (ENV-005)', () => {
  it('defaults to the studio scene from its own seed, on the DOM backend, restoring what was saved', () => {
    expect(parseConfig('')).toEqual(DEFAULT_CONFIG);
    expect(DEFAULT_CONFIG).toEqual({ preset: 'studio', seed: 1, backend: 'dom', restore: true });
  });

  it('loads the scene an address names, and restores the saved workspace otherwise (UX-016)', () => {
    expect(parseConfig('?backend=geometry').restore).toBe(true);
    expect(parseConfig('?preset=seam').restore).toBe(false);
    expect(parseConfig('?seed=3').restore).toBe(false);
  });

  it('reads the preset, the seed and the backend', () => {
    expect(parseConfig('?preset=seam&seed=7&backend=geometry')).toEqual({
      preset: 'seam',
      seed: 7,
      backend: 'geometry',
      restore: false,
    });
    expect(parseConfig('?preset=dense')).toEqual({
      preset: 'dense',
      seed: 1,
      backend: 'dom',
      restore: false,
    });
    expect(parseConfig('?seed=4294967295').seed).toBe(4294967295);
  });

  it('names the setting at fault', () => {
    const fieldOf = (search: string) => {
      try {
        parseConfig(search);
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        return (error as ConfigError).field;
      }
      throw new Error(`"${search}" was accepted`);
    };
    expect(fieldOf('?preset=busy')).toBe('preset');
    expect(fieldOf('?seed=-1')).toBe('seed');
    expect(fieldOf('?seed=1.5')).toBe('seed');
    expect(fieldOf('?seed=4294967296')).toBe('seed');
    expect(fieldOf('?seed=')).toBe('seed');
    expect(fieldOf('?backend=webgl')).toBe('backend');
    expect(fieldOf('?zoom=2')).toBe('zoom');
    expect(fieldOf('?seed=1&seed=2')).toBe('seed');
  });
});

describe('messages (UX-015)', () => {
  it('formats a message by its ID, with numbers in the locale', () => {
    const en = createMessages('en');
    expect(en.format('scene.summary', { preset: 'Dense', seed: 12345, windows: 250 })).toBe(
      'Dense scene, seed 12,345: 250 windows',
    );
    const de = createMessages('de');
    expect(de.format('scene.summary', { preset: 'Dense', seed: 12345, windows: 250 })).toBe(
      'Dense scene, seed 12.345: 250 windows',
    );
  });

  it('takes a translation pack in place of English, message by message', () => {
    const fr = createMessages('fr', { 'empty.title': 'Aucune fenêtre' });
    expect(fr.format('empty.title')).toBe('Aucune fenêtre');
    expect(fr.format('mode.panorama')).toBe(ENGLISH['mode.panorama']);
  });

  it('refuses a pack naming an unknown message, and a message missing a parameter', () => {
    expect(() => createMessages('fr', { 'no.such': 'x' } as never)).toThrow(
      'the translation pack names an unknown message "no.such"',
    );
    expect(() => createMessages().format('scene.summary', { preset: 'Dense' })).toThrow(
      'message "scene.summary" needs the parameter "seed"',
    );
  });
});
