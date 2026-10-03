# Mailsac MCP server

The official [Model Context Protocol](https://modelcontextprotocol.io) server for [Mailsac](https://mailsac.com).
It gives AI coding agents (Claude Code, Cursor, VS Code, Claude Desktop and other MCP clients) disposable
test inboxes, so an agent can check the email your application sends: sign-up confirmations,
password resets, magic links and one-time codes.

A typical conversation:

> Sign up for a new account on http://localhost:3000 and confirm it by email.

The agent creates a unique address with Mailsac, fills in your sign-up form, waits for the confirmation
email, follows the link, and tells you what it found. The same tools help it write and debug end-to-end
tests for those flows.

Read the [setup guide](https://docs.mailsac.com/en/latest/services/mcp_server/mcp_server.html) in the Mailsac
docs or the [announcement](https://blog.mailsac.com/mailsac-mcp-server/) on the Mailsac blog.

## Tools

| Tool | What it does | Mailsac operations |
|---|---|---|
| `create_test_address` | A new unique address, e.g. `signup-mf3k2a1b-9c41d2@mailsac.com`. Nothing to create first. | none |
| `wait_for_email` | Waits until a matching email arrives (optionally by subject, sender or time), then returns the subject, text, links, the most likely confirm/reset/login link (`actionLink`) and candidate one-time codes. | 1 per check, plus 1 to read |
| `list_emails` | Emails stored at an address, newest first. | 1 |
| `read_email` | One email as text (with links and codes), HTML, raw MIME or headers. | 1 |
| `delete_emails` | Delete one email, or all emails at an address. | 1 per call or message |
| `list_domains` | Your account's private domains, to use with `create_test_address`. | 1 |

## Set up

You need a Mailsac API key. The free plan works: [create an account](https://mailsac.com/register), then
[create a key](https://mailsac.com/api-keys).

**Claude Code**

```bash
claude mcp add mailsac -e MAILSAC_API_KEY=your-key -- npx -y @mailsac/mcp
```

**Cursor** (`.cursor/mcp.json`), **Claude Desktop** (`claude_desktop_config.json`) and other clients that use the
same format:

```json
{
  "mcpServers": {
    "mailsac": {
      "command": "npx",
      "args": ["-y", "@mailsac/mcp"],
      "env": { "MAILSAC_API_KEY": "your-key" }
    }
  }
}
```

**VS Code** (`.vscode/mcp.json`):

```json
{
  "servers": {
    "mailsac": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@mailsac/mcp"],
      "env": { "MAILSAC_API_KEY": "your-key" }
    }
  }
}
```

### Settings

| Variable | Default | Purpose |
|---|---|---|
| `MAILSAC_API_KEY` | (required) | Your Mailsac API key |
| `MAILSAC_DOMAIN` | `mailsac.com` | Domain for new test addresses. Set it to your private domain. |
| `MAILSAC_API_URL` | `https://mailsac.com/api` | API base URL |

## Public inboxes and private domains

Addresses at `@mailsac.com` are public: anyone who guesses an address can read its mail. They are ideal for
made-up test data and need no setup. For anything real, such as a staging environment that sends real
customer names, use a private domain: your own subdomain (for example `test.example.com`) or a zero-setup
`yourteam.msdc.co` subdomain from the [domains page](https://mailsac.com/domains). Set `MAILSAC_DOMAIN` and every
new address uses it.

## Operations and limits

Each API call uses one [Mailsac operation](https://mailsac.com/pricing). `wait_for_email` checks every 3 seconds
by default, so a message that arrives within a few seconds costs about 2 to 5 operations. The free plan
includes 1,500 operations a month; paid plans start at 25,000.

## How Mailsac knows this is the MCP server

Requests from this server carry `Mailsac-Client: mcp` and a `mailsac-mcp/<version>` user agent. Mailsac
counts these in aggregate to see how many people use Mailsac through AI agents. Email content is never part of that
count.

## Develop

```bash
npm install
npm test          # builds, then runs the tests with a fake Mailsac API
MAILSAC_API_KEY=your-key node dist/index.js   # runs the server over stdio
```

## License

MIT
