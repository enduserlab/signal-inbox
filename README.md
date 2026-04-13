# Signal Inbox

An Obsidian plugin that watches an inbox folder for incoming messages, auto-classifies them using Claude, and files them into your knowledge base.

Designed as the first piece of a self-hosted AI second brain. Works standalone or with the **[signal-bridge](https://github.com/enduserlab/signal-bridge)** companion service for automatic Signal message capture.

## How it works

1. **Messages land in your inbox folder** as markdown files — dropped by the signal-bridge daemon, the Obsidian Web Clipper, Hovernotes, or anything else that writes markdown.

2. **The plugin detects new files** via polling (configurable interval, default 10s).

3. **URLs are fetched** (optional) — if a message contains links, the plugin fetches page titles, descriptions, and content previews to give Claude richer context.

4. **Claude analyzes each message** deeply:
   - **Category**: article, question, task, update, reference, idea, conversation
   - **Summary**: one-sentence description
   - **Tags**: 1–5 relevant tags
   - **Priority**: high / medium / low / none
   - **People**: names mentioned or involved
   - **Dates**: deadlines and dates extracted
   - **Actions**: suggested next steps for actionable items
   - **Confidence**: 0–1 score

5. **Messages get enriched** with all metadata in their YAML frontmatter.

6. **Optionally auto-filed** into category-specific folders, or moved to an archive for manual triage.

## Setup

### Prerequisites

- Obsidian 1.5.0+
- An Anthropic API key ([console.anthropic.com](https://console.anthropic.com))

### Install

1. Copy the `signal-inbox` folder into your vault's `.obsidian/plugins/` directory
2. Run `npm install && npm run build` inside the plugin folder
3. Enable "Signal Inbox" in Obsidian Settings → Community Plugins
4. Go to Signal Inbox settings and enter your Claude API key
5. (Optional) Adjust inbox path, category folders, and behavior toggles

### Folder structure

```
your-vault/
├── _inbox/
│   ├── signal/          ← inbox folder (messages land here)
│   ├── attachments/     ← media from Signal messages
│   └── processed/       ← archive (after classification)
├── inbox/
│   ├── questions/       ← classified questions
│   ├── tasks/           ← classified tasks
│   ├── updates/         ← classified updates
│   ├── ideas/           ← classified ideas
│   ├── conversations/   ← classified conversations
│   └── unclassified/    ← fallback
└── wiki/
    ├── sources/         ← classified articles
    └── references/      ← classified reference material
```

All paths are configurable in settings.

## Enriched frontmatter

After classification, files look like this:

```yaml
---
sender: "Carol"
source: "+15555551234"
timestamp: 1712964000000
date: "2026-04-12T20:00:00.000Z"
type: "signal-message"
signal-inbox-category: "task"
signal-inbox-summary: "Review auth service PR before Thursday"
signal-inbox-tags:
  - "code-review"
  - "auth"
  - "deadline"
signal-inbox-confidence: 0.95
signal-inbox-priority: "high"
signal-inbox-people:
  - "Carol"
  - "Dave"
signal-inbox-dates:
  - "2026-04-16"
signal-inbox-actions:
  - "Review the auth service PR"
  - "Check JWT to session token migration"
  - "Merge before Thursday freeze"
signal-inbox-received: "2026-04-12T20:00:00.000Z"
signal-inbox-classified: "2026-04-12T20:00:05.000Z"
---
```

## Commands

- **Signal Inbox: Process now** — Manually trigger inbox processing
- **Signal Inbox: Open inbox folder** — Navigate to the inbox folder

## Settings

| Setting | Description | Default |
|---------|-------------|---------|
| API Key | Anthropic API key | — |
| Model | Claude model for classification | Claude Sonnet 4 |
| Inbox folder | Watch folder for incoming messages | `_inbox/signal` |
| Archive folder | Where processed messages go | `_inbox/processed` |
| Auto-classify | Send new messages to Claude automatically | On |
| Fetch link content | Fetch page titles/descriptions for URLs | On |
| Auto-file | Move to category folders automatically | Off |
| Poll interval | How often to check for new files | 10s |
| Category folders | Destination for each category | Configurable |
| Custom prompt | Override the classification prompt | — |

## Signal Bridge (companion service)

The [signal-bridge](https://github.com/enduserlab/signal-bridge) is a separate Node.js service that receives Signal messages via signal-cli and writes them into your vault's inbox folder. It also supports bidirectional commands — text `/help` to yourself on Signal to interact with your knowledge base.

## Development

```bash
cd signal-inbox
npm install
npm run dev    # watch mode — rebuilds on save
```

Symlink the plugin folder into your test vault's `.obsidian/plugins/` directory. Reload Obsidian (Ctrl+R / Cmd+R) after rebuilds.

## License

MIT
