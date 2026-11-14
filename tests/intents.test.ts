import { describe, expect, it } from 'vitest';
import { detectIntent } from '../src/intents.js';
import { loadConfig } from '../src/schemas.js';

describe('intent routing', () => {
  it.each([
    ['Hello there', 'greeting'],
    ['hola buenas', 'greeting'],
    ['What are your hours?', 'hours'],
    ['¿A qué hora abren?', 'hours'],
    ['where are you located', 'location'],
    ['cuál es la dirección', 'location'],
    ['thanks a lot', 'thanks'],
    ['I want to talk to a person', 'human'],
    ['quiero hablar con un asesor', 'human'],
    ['hi, can I speak to an agent about your hours', 'human'],
    ['my order arrived broken', 'unknown'],
    ['', 'unknown'],
    ['this is a hit', 'unknown'],
    ['personal question', 'unknown']
  ])('%j -> %s', (text, intent) => {
    expect(detectIntent(text)).toBe(intent);
  });
});

describe('configuration', () => {
  const base = { WHATSAPP_APP_SECRET: 's3cret', WHATSAPP_VERIFY_TOKEN: 'v', WHATSAPP_PHONE_NUMBER_ID: '1' };

  it('applies defaults and coerces the port', () => {
    expect(loadConfig({ ...base, PORT: '8080' })).toMatchObject({ OUTBOUND_MODE: 'mock', PORT: 8080, GRAPH_API_VERSION: 'v27.0' });
  });

  it('refuses to start without an app secret (no insecure default)', () => {
    expect(() => loadConfig({ ...base, WHATSAPP_APP_SECRET: '' })).toThrow(/WHATSAPP_APP_SECRET/);
    expect(() => loadConfig({})).toThrow(/Invalid configuration/);
  });

  it('refuses the .env.example placeholders', () => {
    expect(() => loadConfig({ ...base, WHATSAPP_APP_SECRET: 'replace-with-your-app-secret' })).toThrow(/placeholders/);
  });

  it('requires an access token only in cloud mode', () => {
    expect(() => loadConfig({ ...base, OUTBOUND_MODE: 'cloud' })).toThrow(/WHATSAPP_ACCESS_TOKEN is required/);
    expect(loadConfig({ ...base, OUTBOUND_MODE: 'cloud', WHATSAPP_ACCESS_TOKEN: 't' }).OUTBOUND_MODE).toBe('cloud');
  });
});
