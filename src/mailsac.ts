// A small Mailsac REST client. Every request identifies itself as the official MCP server
// (Mailsac-Client: mcp), which Mailsac counts in aggregate, never alongside message content.
import { randomBytes } from 'node:crypto';

export const VERSION = '0.1.0';

export type MessageSummary = {
    _id: string;
    inbox: string;
    subject: string | null;
    from: Array<{ address: string; name?: string }>;
    received: string;
    links?: string[] | null;
    attachments?: string[] | null;
    size?: number;
};

export type Domain = { _id: string; domain?: string };

export class MailsacError extends Error {
    constructor(message: string, readonly status: number) {
        super(message);
    }
}

export class Mailsac {
    readonly baseUrl: string;
    constructor(
        private readonly apiKey: string,
        baseUrl = 'https://mailsac.com/api',
        private readonly fetchImpl: typeof fetch = fetch,
    ) {
        this.baseUrl = baseUrl.replace(/\/+$/, '');
    }

    private async request(path: string, init: RequestInit = {}): Promise<Response> {
        const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
            ...init,
            headers: {
                'Mailsac-Key': this.apiKey,
                'Mailsac-Client': 'mcp',
                'User-Agent': `mailsac-mcp/${VERSION} (+https://github.com/mailsac/mailsac-mcp)`,
                Accept: 'application/json',
                ...(init.headers || {}),
            },
        });
        if (!res.ok) {
            let detail = '';
            try {
                const body = await res.json();
                detail = body?.message || '';
            } catch {
                /* not JSON */
            }
            throw new MailsacError(explain(res.status, detail), res.status);
        }
        return res;
    }

    async listMessages(address: string): Promise<MessageSummary[]> {
        const res = await this.request(`/addresses/${encodeURIComponent(address)}/messages`);
        return (await res.json()) as MessageSummary[];
    }

    async readText(address: string, messageId: string, format: 'text' | 'html' | 'raw' = 'text'): Promise<string> {
        const route = { text: 'text', html: 'body', raw: 'raw' }[format];
        const res = await this.request(`/${route}/${encodeURIComponent(address)}/${encodeURIComponent(messageId)}`, {
            headers: { Accept: 'text/plain, text/html, */*' },
        });
        return res.text();
    }

    async readHeaders(address: string, messageId: string): Promise<unknown> {
        const res = await this.request(
            `/addresses/${encodeURIComponent(address)}/messages/${encodeURIComponent(messageId)}/headers`,
        );
        return res.json();
    }

    async deleteMessage(address: string, messageId: string): Promise<void> {
        await this.request(`/addresses/${encodeURIComponent(address)}/messages/${encodeURIComponent(messageId)}`, {
            method: 'DELETE',
        });
    }

    async deleteAllMessages(address: string): Promise<void> {
        await this.request(`/addresses/${encodeURIComponent(address)}/messages`, { method: 'DELETE' });
    }

    async listDomains(): Promise<Domain[]> {
        const res = await this.request('/domains');
        return (await res.json()) as Domain[];
    }
}

function explain(status: number, detail: string): string {
    const suffix = detail ? ` Mailsac said: ${detail}` : '';
    if ((status === 401 || status === 403) && detail) return `Not allowed (HTTP ${status}): ${detail}`;
    if (status === 401 || status === 403) {
        return `Mailsac rejected the API key (HTTP ${status}). Check MAILSAC_API_KEY; create a key at https://mailsac.com/api-keys.`;
    }
    if (status === 404) return `Not found (HTTP 404). The address or message may not exist, or the message was already deleted.${suffix}`;
    if (status === 429) {
        return `Mailsac is limiting requests (HTTP 429): the account may have used its monthly operations, or is sending requests too fast. See https://mailsac.com/pricing.${suffix}`;
    }
    return `Mailsac API error (HTTP ${status}).${suffix}`;
}

/** A unique, lower-case address such as signup-mf3k2a1b-9c41d2@mailsac.com. */
export function uniqueAddress(domain: string, prefix = 'test'): string {
    const clean = prefix.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 30) || 'test';
    return `${clean}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}@${domain.toLowerCase()}`;
}
