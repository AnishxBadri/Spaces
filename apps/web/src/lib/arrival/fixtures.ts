/**
 * Raw RFC 822 fixtures for the arrival lane (SPA-56), shared by the pure
 * forward table (`forwarded.test.ts`) and the poll tests, which deliver them
 * to the fake IMAP server. Line endings are `\n` here; the fake server turns
 * them into `\r\n` on delivery, and mailparser reads either.
 */

export const MAILBOX = 'deals@fund.example'

/** A plain message, BCC'd to the mailbox: its headers are the conversation. */
export function bcc(opts: {
  messageId: string
  from: string
  to: string
  cc?: string
  subject: string
  date?: string
  inReplyTo?: string
  references?: string
  extra?: string
  body?: string
}): string {
  return [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    ...(opts.cc === undefined ? [] : [`Cc: ${opts.cc}`]),
    `Subject: ${opts.subject}`,
    `Date: ${opts.date ?? 'Mon, 21 Sep 2026 10:04:00 +0000'}`,
    ...(opts.messageId === '' ? [] : [`Message-ID: <${opts.messageId}>`]),
    ...(opts.inReplyTo === undefined
      ? []
      : [`In-Reply-To: <${opts.inReplyTo}>`]),
    ...(opts.references === undefined
      ? []
      : [`References: ${opts.references}`]),
    ...(opts.extra === undefined ? [] : [opts.extra]),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    opts.body ?? 'Hi — sharing where we are.',
    '',
  ].join('\n')
}

/** Gmail: the dashed marker, a zoneless `at` date, no Message-ID in the block. */
export function gmailForward(wrapperId = 'fwd-gmail-1@mail.gmail.com'): string {
  return `From: Anish Badri <anish@fund.example>
To: ${MAILBOX}
Subject: Fwd: Seed round
Date: Tue, 22 Sep 2026 09:00:00 +0000
Message-ID: <${wrapperId}>
MIME-Version: 1.0
Content-Type: text/plain; charset="UTF-8"

Worth a look.

---------- Forwarded message ---------
From: Jane Founder <jane@acme.io>
Date: Mon, Sep 21, 2026 at 10:04 AM
Subject: Seed round
To: Anish Badri <anish@fund.example>
Cc: Raj Mehta <raj@acme.io>


Hi Anish, the deck is attached. We are raising $3M.
`
}

/** Outlook: the underscore rule, `Sent:` for the date, `;`-separated Cc. */
export const OUTLOOK_FORWARD = `From: Anish Badri <anish@fund.example>
To: ${MAILBOX}
Subject: FW: Series A update
Date: Tue, 22 Sep 2026 11:00:00 +0000
Message-ID: <fwd-outlook-1@fund.example>
MIME-Version: 1.0
Content-Type: text/plain; charset="UTF-8"

FYI

________________________________
From: Priya Rao <priya@beta.dev>
Sent: Monday, September 21, 2026 3:15 PM
To: Anish Badri <anish@fund.example>
Cc: Sam Lee <sam@beta.dev>; Lee Wong <lee@gamma.vc>
Subject: Series A update

Numbers inside.
`

/**
 * Apple Mail: `Begin forwarded message:`, a zoned date, and — as a forward of
 * a reply does — the original's own Message-Id, In-Reply-To and References.
 */
export const APPLE_FORWARD = `From: Anish Badri <anish@fund.example>
Subject: Fwd: Intro
Message-Id: <fwd-apple-1@fund.example>
Date: Tue, 22 Sep 2026 12:00:00 +0100
To: ${MAILBOX}
MIME-Version: 1.0
Content-Type: text/plain; charset=us-ascii

Begin forwarded message:

From: Omar Haddad <omar@delta.ai>
Subject: Re: Intro
Date: 21 September 2026 at 18:30:00 BST
To: Anish Badri <anish@fund.example>
Message-Id: <CAB123@delta.ai>
In-Reply-To: <root-777@delta.ai>
References: <root-777@delta.ai> <mid-778@delta.ai>

Following up on our call.
`
