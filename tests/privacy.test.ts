import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import { makeEnv } from './helpers/services.js';

describe('privacy policy page', () => {
  it('is public HTML (Google OAuth verification links to it)', async () => {
    const env = await makeEnv();
    const res = await buildServer(env.s, {} as never).inject({ method: 'GET', url: '/privacy' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Limited Use');
  });
});
