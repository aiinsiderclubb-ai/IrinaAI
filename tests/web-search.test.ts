import { describe, expect, it } from 'vitest';
import { Agent } from '../src/agent/agent.js';
import { cleanUrl } from '../src/integrations/openai.js';
import { makeEnv, say, toolCall } from './helpers/services.js';

describe('web search', () => {
  it('the agent can search the web and gets the answer with its sources', async () => {
    const env = await makeEnv();
    env.llm.searchAnswer = 'Курс НБУ на 23.10: 41,5 грн за долар.';
    env.llm.searchSources = [{ title: 'НБУ', url: 'https://bank.gov.ua/ua/markets/exchangerates' }];
    env.llm.script.push(toolCall('web_search', { query: 'курс долара НБУ сьогодні' }), (m) => {
      const result = String(m.at(-1)!.content);
      expect(result).toContain('41,5 грн');
      expect(result).toContain('https://bank.gov.ua/ua/markets/exchangerates');
      return say('Курс НБУ сьогодні 41,5 грн. Джерело: https://bank.gov.ua/ua/markets/exchangerates');
    });
    const r = await new Agent(env.s).handle(42, 'який курс долара?');
    expect(r.text).toContain('41,5');
    expect(r.proposals).toHaveLength(0);
    // the search model is told today's date so "today" questions resolve correctly
    expect(env.llm.searchPrompts[0]).toContain('2026-10-23');
    expect(env.llm.searchPrompts[0]).toContain('курс долара НБУ сьогодні');
  });

  it('a failed search is reported to the model instead of crashing the turn', async () => {
    const env = await makeEnv();
    env.llm.webSearch = async () => {
      throw new Error('timeout');
    };
    env.llm.script.push(toolCall('web_search', { query: 'новини' }), (m) => {
      expect(String(m.at(-1)!.content)).toContain('недоступний');
      return say('Пошук зараз не працює.');
    });
    expect((await new Agent(env.s).handle(42, 'що в новинах?')).text).toContain('не працює');
  });

  it('the system prompt points the model at web_search for fresh facts', async () => {
    const env = await makeEnv();
    env.llm.script.push(say('ок'));
    await new Agent(env.s).handle(42, 'привіт');
    expect(env.llm.calls[0]!.messages[0]!.content as string).toContain('web_search');
  });

  it('cited links lose the utm tag OpenAI adds', () => {
    expect(cleanUrl('https://bank.gov.ua/rates?utm_source=openai')).toBe('https://bank.gov.ua/rates');
    expect(cleanUrl('https://x.ua/a?id=5&utm_source=openai')).toBe('https://x.ua/a?id=5');
  });
});
