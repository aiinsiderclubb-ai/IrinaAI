/** Public privacy policy: Google requires one before the OAuth app can leave "Testing". */
export const PRIVACY_HTML = `<!doctype html>
<html lang="uk">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Irina Assistant — Privacy Policy</title>
<body style="font-family:system-ui,sans-serif;max-width:42rem;margin:3rem auto;padding:0 1rem;line-height:1.55;color:#222">
<h1>Irina Assistant — Privacy Policy</h1>
<p><i>Last updated: 9 November 2026</i></p>

<p>Irina Assistant is a private personal assistant used by a single owner through Telegram and a web cabinet.
It is not offered to the public. This page explains what data it accesses and how it is handled.</p>

<h2>Data we access</h2>
<ul>
  <li><b>Google Calendar</b> (only the calendars the owner connects): event titles, times, places and descriptions,
    to show the schedule, warn about conflicts and — after the owner confirms each action — create, move or delete events.</li>
  <li><b>YouTube</b> (read-only): channel and video statistics for the owner's reports.</li>
  <li>Messages the owner sends to the assistant, and data from other services the owner connects (Notion, Instagram).</li>
</ul>

<h2>How data is used</h2>
<p>Data is used only to provide the assistant's features to the owner. It is not sold, not used for advertising and not shared
with third parties, except service providers that process requests on the owner's behalf: OpenAI (understanding and answering
requests) and ElevenLabs (voice replies). Every change to the owner's calendar requires the owner's explicit confirmation.</p>

<p>The use of information received from Google APIs adheres to the
<a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>,
including the Limited Use requirements.</p>

<h2>Storage and security</h2>
<p>Access tokens are stored encrypted. Data is kept on the assistant's server only as long as needed for its features
(conversation history is kept up to 30 days). Access can be revoked at any time at
<a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>.</p>

<h2>Deletion and contact</h2>
<p>To delete your data or ask a question, write to <a href="mailto:aiinsider52@gmail.com">aiinsider52@gmail.com</a>.</p>
</body>
</html>`;
