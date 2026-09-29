#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Mailsac, VERSION } from './mailsac.js';
import { createServer } from './server.js';

const apiKey = process.env.MAILSAC_API_KEY;
if (process.argv.includes('--version')) {
    console.log(VERSION);
    process.exit(0);
}
if (!apiKey) {
    console.error('Set MAILSAC_API_KEY to a Mailsac API key (free at https://mailsac.com/register, then https://mailsac.com/api-keys).');
    process.exit(1);
}

const server = createServer({
    client: new Mailsac(apiKey, process.env.MAILSAC_API_URL || 'https://mailsac.com/api'),
    defaultDomain: (process.env.MAILSAC_DOMAIN || 'mailsac.com').toLowerCase(),
});
await server.connect(new StdioServerTransport());
