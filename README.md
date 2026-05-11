# Selective History Cleaner

A Chrome extension (Manifest V3) that automatically removes specified websites from your browser history — and optionally clears their cookies and site data — the moment you visit them.

## Features

- **Automatic removal** — history entries are deleted as soon as you navigate to a matched site
- **Cookie & site-data clearing** — optionally wipe cookies and/or localStorage, IndexedDB, cache, and service workers per rule
- **Flexible rule patterns** — match by hostname, wildcard, exact URL, or regular expression
- **Pause controls** — temporarily suspend cleaning globally or per-site (10 min / 1 hour)
- **Import / export** — back up and restore rules as JSON; importing always merges without overwriting
- **Context menu** — right-click any page or link to instantly add a site to your rules
- **Live badge** — toolbar icon shows `•` on matched sites and `⏸` when paused

## Installation

This extension is not published to the Chrome Web Store. Install it in developer mode:

1. Download or clone this repository.
2. Open Chrome and navigate to `chrome://extensions`.
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select the repository folder.

The extension requires Chrome 109 or later.

## Usage

Click the extension icon to open the popup:

| Control | Action |
|---|---|
| **Add this site** | Adds the current hostname to your rules |
| **Remove this site** | Removes the current hostname from your rules |
| 🍪 **Cookies** | Toggle cookie clearing for the current site |
| 💾 **Site data** | Toggle localStorage / IndexedDB / cache clearing for the current site |
| **⏸ 10m** | Pause cleaning for this site for 10 minutes |
| **⏸ 🌐 10m / 1h** | Pause cleaning globally for 10 minutes or 1 hour |

Open the **Rules** panel to add, edit, or remove patterns directly, then click **Save rules**. Use 📥 / 📤 to import or export your rules as a JSON file.

## Pattern Syntax

| Type | Example | Matches |
|---|---|---|
| Hostname | `example.com` | `example.com` and all its subdomains |
| Subdomain wildcard | `*.ads.example.com` | Any subdomain of `ads.example.com` |
| Full URL wildcard | `https://example.com/path/*` | URLs matching the pattern |
| Regex | `regex:example\.(com\|org)` | Any URL matching the regular expression |

- **Hostname** patterns are the simplest and most common. `example.com` matches `example.com`, `www.example.com`, `sub.example.com`, etc.
- **Wildcard** patterns use `*` as a glob. `*` in the host part matches any single label; `*` elsewhere matches any sequence of characters.
- **Regex** patterns must start with `regex:` and are tested against the full URL. For safety, patterns longer than 200 characters or with nested quantifiers are rejected.

## Permissions

| Permission | Why it's needed |
|---|---|
| `history` | Delete visited URLs from history |
| `browsingData` | Clear cookies and site data |
| `storage` | Persist rules and pause state |
| `tabs` | Read the active tab URL to show popup status |
| `contextMenus` | Right-click "Add this site" menu |
| `webNavigation` | Catch navigations that `history.onVisited` may miss |

## Privacy

All rules and settings are stored locally via `chrome.storage.sync` (synced across your Chrome profile) and `chrome.storage.local`. No data is ever sent to any external server.

## Contributing

Bug reports and pull requests are welcome. Please open an issue first for significant changes.

## License

[MIT](LICENSE) © Andries van der Merk
