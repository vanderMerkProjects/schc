# Changelog

All notable changes to this project will be documented in this file.

## [1.7.0] — 2026-05-11

### Fixed

- **`GET_PAUSE_STATE` now handled by the service worker** — pause status in the popup was always blank because the background never responded to this message type
- **"Save rules" button now works** — the click handler was defined but never wired to the button
- **"+ Add rule" button now works** — the click handler was missing entirely
- **"Remove this site" no longer re-adds the removed rule** — after splicing the rule from storage, the popup was sending an `ADD_HOST` message which caused the background to immediately re-insert the rule
- **Version string is now read from `chrome.runtime.getManifest()`** instead of being hardcoded in three separate places
- **Pattern column header now correctly reads "Pattern"** — it was incorrectly using the `uiRules` i18n key and showing "Rules"
- **Import file validation** now checks that the parsed JSON is an object with a `rules` array before sending to background

### Added

- Top-level `cacheReady` promise so event handlers (`history.onVisited`, `webNavigation.onCommitted`) await initial cache population even when the service worker is restarted by those events without triggering `onStartup`
- `chrome.runtime.onStartup` listener as an additional cache rebuild trigger
- Badge refresh for all active tabs whenever rules change in storage
- ReDoS guard: `regex:` patterns longer than 200 characters or with nested quantifiers (`+*`, `**`, etc.) are now rejected both at match time and during import, with a count of skipped patterns reported back to the popup
- Status messages in the rules panel now auto-clear after 3 seconds
- `stopPropagation` on the import/export buttons so clicking them no longer closes the Rules panel
- `aria-label` attributes on rule table checkboxes for screen reader accessibility
- New i18n keys: `uiRemoveSite`, `uiPatternHeader`, `uiPatternPlaceholder`, `uiExportFailed`, `uiImportFailed`, `uiInvalidFile`
- `lang="en"` attribute on the popup `<html>` element
- `minimum_chrome_version: "109"` in manifest
- MIT `LICENSE` file
- `README.md` with feature overview, installation guide, pattern syntax reference, and permissions table
- `.gitignore` for OS, editor, and build artifacts

### Changed

- Version bumped to **1.7.0**
- Import/export buttons use i18n keys for all status messages instead of hardcoded English strings

---

## [1.6.0] — 2025-09-09

- Initial release
