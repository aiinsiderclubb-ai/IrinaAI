export interface Proposal {
  id: string;
  kind: string;
  summary: string;
  project: string | null;
}

export interface Task {
  id: string;
  title: string;
  project?: string;
  status: string;
  done: boolean;
  due?: string;
  priority?: string;
  url?: string;
}

export interface CalEvent {
  id: string;
  account: 'work' | 'personal';
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  link?: string;
}

export interface Waiting {
  id: string;
  title: string;
  project?: string;
  from?: string;
  due?: string;
}

export interface Today {
  date: string;
  timezone: string;
  events: CalEvent[];
  conflicts: Array<[string, string]>;
  focus: Task[];
  upcoming: Task[];
  waiting: Waiting[];
  pending: number;
  errors: Partial<Record<'calendar' | 'tasks' | 'waiting', string>>;
}

export interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
  proposals?: Proposal[];
  voice?: boolean;
}

export interface CurrencyTotals {
  currency: string;
  expense: number;
  income: number;
  net: number;
  byCategory: Record<string, number>;
  byProject: Record<string, { expense: number; income: number }>;
  count: number;
}

export interface FinanceEntry {
  id: string;
  date: string;
  amount: number;
  currency: string;
  kind: 'expense' | 'income';
  category: string;
  scope: 'personal' | 'project';
  project?: string;
  note: string;
}

export interface SocialData {
  platform: 'instagram' | 'youtube';
  account: string;
  takenAt: string;
  totals: Record<string, number>;
  period: Record<string, number>;
  periodDays: number;
  posts: Array<{ title: string; url?: string; publishedAt?: string; metrics: Record<string, number> }>;
  unavailable: string[];
}

export interface Settings {
  timezone: string;
  morningTime: string;
  eveningTime: string;
  voiceReplies: 'mirror' | 'always' | 'never';
  workdayStart: string;
  workdayEnd: string;
  planCalendar: 'work' | 'personal';
  mirrorDetails: boolean;
  projects: string[];
  categories: { expense: string[]; income: string[] };
  currency: string;
  eventsTopics: string[];
  eventsGeo: string;
  eventsWeekday: number;
  eventsTime: string;
}

export type IntegrationState = 'on' | 'off' | 'broken' | 'setup';
export interface Status {
  integrations: Record<'notion' | 'work' | 'personal' | 'youtube' | 'instagram' | 'voice', { state: IntegrationState; connectUrl?: string; expiresAt?: string }>;
}
