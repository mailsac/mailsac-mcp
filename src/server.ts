import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { extractCodes, extractLinks, pickActionLink } from './extract.js';
import { Mailsac, MailsacError, MessageSummary, uniqueAddress, VERSION } from './mailsac.js';

export type Options = {
    client: Mailsac;
    defaultDomain: string;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
};

const MAX_TEXT = 12_000;
const PUBLIC_DOMAIN = 'mailsac.com';

const text = (value: unknown) => ({
    content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});
const failure = (err: unknown) => ({
    isError: true,
    content: [{ type: 'text' as const, text: err instanceof MailsacError ? err.message : `Error: ${(err as Error)?.message || err}` }],
});
const truncate = (value: string) =>
    value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}\n…[truncated ${value.length - MAX_TEXT} characters]` : value;

function summarize(message: MessageSummary) {
    return {
        messageId: message._id,
        subject: message.subject,
        from: message.from?.[0]?.address || null,
        received: message.received,
        attachments: message.attachments?.length || 0,
    };
}

function matches(message: MessageSummary, subjectContains?: string, fromContains?: string, receivedAfter?: number) {
    if (subjectContains && !(message.subject || '').toLowerCase().includes(subjectContains.toLowerCase())) return false;
    if (fromContains && !(message.from || []).some((f) => f.address?.toLowerCase().includes(fromContains.toLowerCase()))) {
        return false;
    }
    if (receivedAfter && new Date(message.received).getTime() < receivedAfter) return false;
    return true;
}

async function withContent(client: Mailsac, message: MessageSummary) {
    const body = await client.readText(message.inbox, message._id, 'text');
    const links = extractLinks(body, message.links || []);
    return {
        ...summarize(message),
        address: message.inbox,
        actionLink: pickActionLink(links),
        codes: extractCodes(body),
        links,
        text: truncate(body),
    };
}

export function createServer({ client, defaultDomain, sleep, now }: Options): McpServer {
    const wait = sleep || ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    const clock = now || Date.now;
    const server = new McpServer(
        { name: 'mailsac', version: VERSION },
        {
            instructions:
                'Mailsac test inboxes for checking the email an application sends. Typical flow: create_test_address, ' +
                'use the address in the app (sign up, reset a password, request a code), wait_for_email, then follow ' +
                'actionLink or enter one of codes, and delete_emails when done. Addresses on mailsac.com are public: ' +
                'anyone who guesses the address can read it, so only use made-up data there, or use a private domain ' +
                '(see list_domains). Every API call, including each poll while waiting, uses Mailsac operations.',
        },
    );

    server.registerTool(
        'create_test_address',
        {
            title: 'Create a test email address',
            description:
                'Return a new, unique address that can receive email immediately, with nothing to set up. ' +
                'Use one address per test so tests never read each other\'s mail. Makes no API call.',
            inputSchema: {
                prefix: z.string().max(30).optional().describe('Readable start of the address, e.g. "signup"'),
                domain: z
                    .string()
                    .optional()
                    .describe(`Domain to use. Defaults to ${defaultDomain}. Use a private domain for real or sensitive data.`),
            },
        },
        async ({ prefix, domain }) => {
            const chosen = (domain || defaultDomain).toLowerCase();
            const address = uniqueAddress(chosen, prefix);
            return text({
                address,
                public: chosen === PUBLIC_DOMAIN,
                ...(chosen === PUBLIC_DOMAIN
                    ? {
                          webInbox: `https://mailsac.com/inbox/${address}`,
                          note: 'Public inbox: anyone who knows the address can read it. Use made-up data only.',
                      }
                    : {}),
            });
        },
    );

    server.registerTool(
        'wait_for_email',
        {
            title: 'Wait for an email',
            description:
                'Poll an address until a matching email arrives, then return its subject, sender, text, links, the ' +
                'most likely confirm/reset/login link (actionLink) and candidate one-time codes. Each poll uses one ' +
                'Mailsac operation.',
            inputSchema: {
                address: z.string().email().describe('Address to watch'),
                subjectContains: z.string().optional().describe('Only match emails whose subject contains this text'),
                fromContains: z.string().optional().describe('Only match emails whose sender contains this text'),
                receivedAfter: z
                    .string()
                    .optional()
                    .describe('ISO timestamp; ignore emails received before it (useful when an address is reused)'),
                timeoutSeconds: z.number().int().min(5).max(300).default(60).describe('Give up after this long'),
                pollIntervalSeconds: z.number().int().min(2).max(30).default(3),
            },
        },
        async ({ address, subjectContains, fromContains, receivedAfter, timeoutSeconds, pollIntervalSeconds }) => {
            try {
                const after = receivedAfter ? Date.parse(receivedAfter) : undefined;
                if (receivedAfter && Number.isNaN(after)) throw new Error('receivedAfter must be an ISO date-time');
                const deadline = clock() + timeoutSeconds * 1000;
                let polls = 0;
                for (;;) {
                    polls++;
                    const messages = await client.listMessages(address);
                    const found = messages
                        .filter((m) => matches(m, subjectContains, fromContains, after))
                        .sort((a, b) => Date.parse(b.received) - Date.parse(a.received))[0];
                    if (found) return text({ ...(await withContent(client, found)), polls });
                    if (clock() + pollIntervalSeconds * 1000 > deadline) break;
                    await wait(pollIntervalSeconds * 1000);
                }
                return {
                    isError: true,
                    content: [
                        {
                            type: 'text' as const,
                            text:
                                `No matching email reached ${address} within ${timeoutSeconds} seconds (${polls} checks). ` +
                                'Check that the app sent to exactly this address, that its mail provider is configured, ' +
                                'and try a longer timeout for real delivery.',
                        },
                    ],
                };
            } catch (err) {
                return failure(err);
            }
        },
    );

    server.registerTool(
        'list_emails',
        {
            title: 'List emails at an address',
            description: 'List the emails currently stored for an address, newest first (no bodies). One operation.',
            inputSchema: { address: z.string().email() },
        },
        async ({ address }) => {
            try {
                const messages = await client.listMessages(address);
                return text(
                    messages
                        .sort((a, b) => Date.parse(b.received) - Date.parse(a.received))
                        .map(summarize),
                );
            } catch (err) {
                return failure(err);
            }
        },
    );

    server.registerTool(
        'read_email',
        {
            title: 'Read an email',
            description:
                'Read one email. format "text" (default) also returns links, actionLink and codes; "html" returns the ' +
                'HTML body; "raw" the full MIME source; "headers" the parsed headers.',
            inputSchema: {
                address: z.string().email(),
                messageId: z.string().min(1),
                format: z.enum(['text', 'html', 'raw', 'headers']).default('text'),
            },
        },
        async ({ address, messageId, format }) => {
            try {
                if (format === 'headers') return text(await client.readHeaders(address, messageId));
                const body = await client.readText(address, messageId, format);
                if (format !== 'text') return text(truncate(body));
                const links = extractLinks(body);
                return text({ messageId, actionLink: pickActionLink(links), codes: extractCodes(body), links, text: truncate(body) });
            } catch (err) {
                return failure(err);
            }
        },
    );

    server.registerTool(
        'delete_emails',
        {
            title: 'Delete emails',
            description: 'Delete one email (messageId) or every email at an address (omit messageId). Clean up after a test.',
            inputSchema: { address: z.string().email(), messageId: z.string().optional() },
            annotations: { destructiveHint: true },
        },
        async ({ address, messageId }) => {
            try {
                if (messageId) {
                    await client.deleteMessage(address, messageId);
                    return text({ deleted: 1, address });
                }
                try {
                    await client.deleteAllMessages(address);
                    return text({ deleted: 'all', address });
                } catch (err) {
                    // Deleting a whole inbox needs ownership (e.g. a public address); delete message by message instead.
                    if (!(err instanceof MailsacError) || (err.status !== 401 && err.status !== 403)) throw err;
                    const messages = await client.listMessages(address);
                    for (const message of messages) await client.deleteMessage(address, message._id);
                    return text({ deleted: messages.length, address });
                }
            } catch (err) {
                return failure(err);
            }
        },
    );

    server.registerTool(
        'list_domains',
        {
            title: 'List private domains',
            description:
                'List the private domains on this Mailsac account. Mail to a private domain is visible only to the ' +
                'account; pass one as `domain` to create_test_address.',
            inputSchema: {},
        },
        async () => {
            try {
                const domains = await client.listDomains();
                return text({
                    defaultDomain,
                    privateDomains: domains.map((d) => d._id || d.domain),
                    ...(domains.length
                        ? {}
                        : { note: 'No private domains. Add one, or a free yourteam.msdc.co subdomain, at https://mailsac.com/domains' }),
                });
            } catch (err) {
                return failure(err);
            }
        },
    );

    return server;
}
