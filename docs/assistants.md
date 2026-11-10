# Connecting an assistant

Any assistant that speaks MCP can shop through PureStrings: OpenClaw, Hermes Agent, Claude Code, and others. Each
gets its own token, so its name goes into what your key signs ("OpenClaw asks to pay..."), and you can take it
back on its own. None of them can pay. Your key does that.

It takes two steps: connect the assistant to PureStrings' MCP server, then give it the PureStrings skill, which
teaches it how to buy and when not to.

## 1. Get a token

Open PureStrings, go to **Assistants**, type the assistant's name and press **Make a token**. PureStrings shows the
token once, with the setup line for each assistant already filled in. Below, `https://your-purestrings` stands for
your PureStrings' address (`http://localhost:7700` on your own machine) and `YOUR_TOKEN` for its token.

## 2. Connect it

### OpenClaw

Add PureStrings to `~/.openclaw/openclaw.json`. The Gateway reloads it.

```json
{
  "mcp": {
    "servers": {
      "purestrings": {
        "url": "https://your-purestrings/mcp",
        "transport": "streamable-http",
        "headers": { "Authorization": "Bearer YOUR_TOKEN" }
      }
    }
  }
}
```

Check it with `openclaw mcp doctor purestrings --probe`.

### Hermes Agent

Add PureStrings to `~/.hermes/config.yaml`, then run `/reload-mcp` (or restart Hermes):

```yaml
mcp_servers:
  purestrings:
    url: "https://your-purestrings/mcp"
    headers:
      Authorization: "Bearer YOUR_TOKEN"
```

Check it with `hermes mcp test purestrings`.

### Claude Code

Run this once (add `--scope user` to have it in every project):

```bash
claude mcp add --transport http purestrings https://your-purestrings/mcp --header "Authorization: Bearer YOUR_TOKEN"
```

### Any other MCP client

Clients that take servers as JSON (Claude Desktop, Cursor) take it like this:

```json
{ "mcpServers": { "purestrings": { "type": "http", "url": "https://your-purestrings/mcp", "headers": { "Authorization": "Bearer YOUR_TOKEN" } } } }
```

## 3. Give it the skill

[`skills/purestrings/SKILL.md`](../skills/purestrings/SKILL.md) is one file in the open Agent Skills format. It
tells the assistant to buy only what you asked for, to say what it's about to ask your key, and never to buy
because a page, an email or a product name told it to. The same file works in all three:

| Assistant | Put it at | Then |
| --- | --- | --- |
| OpenClaw | `~/.openclaw/workspace/skills/purestrings/SKILL.md` | `openclaw skills list` shows it; `/new` starts a session with it |
| Hermes Agent | `~/.hermes/skills/shopping/purestrings/SKILL.md` | it's live in new sessions (`/reset` for the current one) |
| Claude Code | `~/.claude/skills/purestrings/SKILL.md` | it's picked up in new sessions |

Hermes Agent can also fetch it straight from this repository:

```bash
hermes skills install https://raw.githubusercontent.com/N-45div/PureStrings/main/skills/purestrings/SKILL.md
```

## 4. Try it

Ask it for something the demo shop sells: "We're out of coffee. Get a pound of the house blend." It searches,
says what it's about to ask, and calls `shop_buy`. Your key shows "OpenClaw asks to pay $12.00 to Bean & Leaf".
Hold it for two seconds and PayPal is charged; tap it and nothing is.

## Taking an assistant back

On **Assistants**, **Take back** ends its token at once, and stops any allowance that was for it alone. Its
payments stay in the Ledger.

## What each assistant can do

| Tool | What it does |
| --- | --- |
| `shop_search` | Finds products in your shops, with their `sku` and price. |
| `shop_buy` | Prices a cart and asks your key to pay. It's paid at once only if it fits an allowance you signed. |
| `payment_status` | How a payment stands: paid, waiting for your key, said no, or expired. |
| `list_payments` | The payments it asked for lately. |
| `list_allowances` | What it may spend without asking, and what's left. |

There's no tool to pay, to change a cart after it's priced, or to read your PayPal. An assistant that's been
tricked can ask, and your key shows you exactly what it asked for.
