import type { Llm } from '../integrations/openai.js';

export interface ImportGuess {
  project?: string;
  title: string;
  source: 'ChatGPT' | 'Dot' | 'Інше';
}

/** Which project does a forwarded ChatGPT/Dot answer or file belong to? Unknown -> the owner picks. */
export async function classifyImport(llm: Llm, projects: string[], text: string, hint?: string): Promise<ImportGuess> {
  const fallback: ImportGuess = { title: (hint ?? text).split('\n')[0]!.slice(0, 80) || 'Матеріал', source: 'Інше' };
  if (!projects.length) return fallback;
  try {
    const res = await llm.chat({
      json: true,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            'Ти розкладаєш матеріали за проєктами. Відповідай JSON: {"project": <назва зі списку або null, якщо не впевнений>, "title": <короткий заголовок до 80 символів>, "source": "ChatGPT"|"Dot"|"Інше"}. ' +
            `Проєкти: ${JSON.stringify(projects)}. Не вигадуй нових проєктів.`,
        },
        { role: 'user', content: `${hint ? `Файл/підпис: ${hint}\n` : ''}${text.slice(0, 6000)}` },
      ],
    });
    const parsed = JSON.parse(res.content ?? '{}') as Partial<ImportGuess> & { project?: string | null };
    const project = projects.find((p) => p.toLowerCase() === String(parsed.project ?? '').toLowerCase());
    const source = (['ChatGPT', 'Dot', 'Інше'] as const).find((s) => s === parsed.source) ?? 'Інше';
    return { project, title: (parsed.title || fallback.title).slice(0, 80), source };
  } catch {
    return fallback;
  }
}
