import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../dist/server.js';
import { Mailsac, VERSION } from '../dist/mailsac.js';
import { extractCodes, extractLinks, pickActionLink } from '../dist/extract.js';

const ADDRESS = 'signup-abc@mailsac.com';
const MESSAGE = {
    _id: 'm1',
    inbox: ADDRESS,
    subject: 'Confirm your account',
    from: [{ address: 'no-reply@example.com' }],
    received: '2026-09-29T20:00:00.000Z',
    links: ['https://example.com/verify?token=abc'],
    attachments: null,
};
const TEXT = 'Welcome!\nYour verification code is 482913.\nConfirm: https://example.com/verify?token=abc\n' +
    'Unsubscribe: https://example.com/unsubscribe\n© 2026 Example';

function fakeApi({ messagesAfterPolls = 0 } = {}) {
    const calls = [];
    let lists = 0;
    const fetchImpl = async (url, init) => {
        calls.push({ url, method: init?.method || 'GET', headers: init?.headers });
        const path = new URL(url).pathname;
        const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
        if (path === `/api/addresses/${encodeURIComponent(ADDRESS)}/messages` && (init?.method || 'GET') === 'GET') {
            lists++;
            return json(lists > messagesAfterPolls ? [MESSAGE] : []);
        }
        if (path === `/api/text/${encodeURIComponent(ADDRESS)}/m1`) return new Response(TEXT, { status: 200 });
        if (path === `/api/addresses/${encodeURIComponent('public@mailsac.com')}/messages` && init?.method === 'DELETE') {
            return json({ message: 'Cannot delete messages for inbox that is not owned by this account' }, 401);
        }
        if (path === `/api/addresses/${encodeURIComponent('public@mailsac.com')}/messages`) return json([{ ...MESSAGE, inbox: 'public@mailsac.com', _id: 'p1' }, { ...MESSAGE, inbox: 'public@mailsac.com', _id: 'p2' }]);
        if (path.startsWith('/api/addresses/') && init?.method === 'DELETE') return json({ ok: true });
        if (path === '/api/domains') return json([{ _id: 'test.example.com' }]);
        if (path === `/api/addresses/${encodeURIComponent('bad@mailsac.com')}/messages`) return json({ message: 'nope' }, 401);
        return json({ message: 'not found' }, 404);
    };
    return { calls, fetchImpl };
}

async function connect(api, now) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    let time = 0;
    const server = createServer({
        client: new Mailsac('test-key', 'https://mailsac.test/api', api.fetchImpl),
        defaultDomain: 'mailsac.com',
        sleep: async (ms) => { time += ms; },
        now: now || (() => time),
    });
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientTransport);
    return client;
}
const parse = (result) => JSON.parse(result.content[0].text);

test('lists the testing tools', async () => {
    const client = await connect(fakeApi());
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(),
        ['create_test_address', 'delete_emails', 'list_domains', 'list_emails', 'read_email', 'wait_for_email']);
});

test('creates unique public addresses without calling the API', async () => {
    const api = fakeApi();
    const client = await connect(api);
    const a = parse(await client.callTool({ name: 'create_test_address', arguments: { prefix: 'Sign Up!' } }));
    const b = parse(await client.callTool({ name: 'create_test_address', arguments: { prefix: 'Sign Up!' } }));
    assert.match(a.address, /^sign-up-[a-z0-9]+-[a-f0-9]{6}@mailsac\.com$/);
    assert.notEqual(a.address, b.address);
    assert.equal(a.public, true);
    assert.equal(api.calls.length, 0);
    const priv = parse(await client.callTool({ name: 'create_test_address', arguments: { domain: 'Test.Example.com' } }));
    assert.match(priv.address, /@test\.example\.com$/);
    assert.equal(priv.public, false);
});

test('waits for an email and returns the action link and code', async () => {
    const api = fakeApi({ messagesAfterPolls: 2 });
    const client = await connect(api);
    const result = parse(await client.callTool({ name: 'wait_for_email', arguments: { address: ADDRESS, subjectContains: 'confirm' } }));
    assert.equal(result.polls, 3);
    assert.equal(result.actionLink, 'https://example.com/verify?token=abc');
    assert.equal(result.codes[0], '482913');
    assert.ok(!result.codes.includes('2026'));
    assert.equal(result.subject, 'Confirm your account');
});

test('identifies itself on every request', async () => {
    const api = fakeApi();
    const client = await connect(api);
    await client.callTool({ name: 'wait_for_email', arguments: { address: ADDRESS } });
    assert.ok(api.calls.length >= 2);
    for (const call of api.calls) {
        assert.equal(call.headers['Mailsac-Client'], 'mcp');
        assert.equal(call.headers['Mailsac-Key'], 'test-key');
        assert.equal(call.headers['User-Agent'], `mailsac-mcp/${VERSION} (+https://github.com/mailsac/mailsac-mcp)`);
    }
});

test('times out with a helpful message', async () => {
    const api = fakeApi({ messagesAfterPolls: 1000 });
    const client = await connect(api);
    const result = await client.callTool({ name: 'wait_for_email', arguments: { address: ADDRESS, timeoutSeconds: 10, pollIntervalSeconds: 3 } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /No matching email reached/);
});

test('filters out older mail with receivedAfter', async () => {
    const api = fakeApi({ messagesAfterPolls: 0 });
    const client = await connect(api);
    const result = await client.callTool({ name: 'wait_for_email', arguments: { address: ADDRESS, receivedAfter: '2026-09-29T21:00:00Z', timeoutSeconds: 5, pollIntervalSeconds: 2 } });
    assert.equal(result.isError, true);
});

test('explains an API key problem', async () => {
    const client = await connect(fakeApi());
    const result = await client.callTool({ name: 'list_emails', arguments: { address: 'bad@mailsac.com' } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /HTTP 401/);
});

test('deletes one or all emails and lists private domains', async () => {
    const api = fakeApi();
    const client = await connect(api);
    assert.equal(parse(await client.callTool({ name: 'delete_emails', arguments: { address: ADDRESS, messageId: 'm1' } })).deleted, 1);
    assert.equal(parse(await client.callTool({ name: 'delete_emails', arguments: { address: ADDRESS } })).deleted, 'all');
    assert.deepEqual(api.calls.filter((c) => c.method === 'DELETE').map((c) => new URL(c.url).pathname), [
        `/api/addresses/${encodeURIComponent(ADDRESS)}/messages/m1`,
        `/api/addresses/${encodeURIComponent(ADDRESS)}/messages`,
    ]);
    assert.deepEqual(parse(await client.callTool({ name: 'list_domains', arguments: {} })).privateDomains, ['test.example.com']);
});

test('deletes a public inbox message by message', async () => {
    const api = fakeApi();
    const client = await connect(api);
    assert.equal(parse(await client.callTool({ name: 'delete_emails', arguments: { address: 'public@mailsac.com' } })).deleted, 2);
    const noKeyBlame = await client.callTool({ name: 'list_emails', arguments: { address: 'bad@mailsac.com' } });
    assert.match(noKeyBlame.content[0].text, /Not allowed \(HTTP 401\): nope/);
});

test('extracts links and codes from typical emails', () => {
    assert.deepEqual(extractCodes('Your one-time code: 004512.\nOrder #123456 shipped'), ['004512']);
    assert.deepEqual(extractCodes('Total $1234.50 on 12.10.2026'), []);
    assert.deepEqual(extractCodes('Use code ABC-123 to sign in'), ['ABC-123']);
    assert.deepEqual(extractCodes('Call 555-1234 or visit in 2026'), []);
    const links = extractLinks('Reset: https://app.test/reset?t=1. Privacy https://app.test/privacy');
    assert.deepEqual(links, ['https://app.test/reset?t=1', 'https://app.test/privacy']);
    assert.equal(pickActionLink(links), 'https://app.test/reset?t=1');
    assert.equal(pickActionLink(['https://app.test/about']), null);
});
