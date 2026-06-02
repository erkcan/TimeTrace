# TimeTrace

A personal Chrome extension for tracking time spent on websites. Designed for local use — no data leaves your browser.

## Features

### Tracking
- Tracks time per domain (e.g. `youtube.com`) while the tab is active and focused
- Pauses when the system is idle (no mouse/keyboard for 60 seconds)
- Pauses when the tab has been silent and inactive beyond a configurable inactivity timeout (default: 5 minutes)
- Continues tracking when the tab is playing audio, regardless of interaction — for passive watching/listening
- Correctly handles system idle during video playback: the idle gap is credited immediately when the system becomes active again
- Retroactively credits time when the service worker was suspended during audio playback (on audio stop, tab switch, or window focus loss)
- Records visit counts per domain, incremented on navigation and on the first tab switch to a domain each day
- Captures favicons for display

### Data model
- Stores time at three granularities: **daily**, **weekly** (Mon–Sun), and **all-time**
- Each domain entry holds: URL, favicon, total time, visit counter, and a per-day breakdown

### Popup
- Quick view of the currently tracked domain and today's total time
- Top sites for today ranked by time
- Daily usage for the active site shown even when no limit is set
- Set or edit a daily time limit for the active site directly from the popup

### Dashboard
- Three views: **Today**, **This week**, **All time**
- Summary cards: total time, sites visited, top site; All time view shows the date tracking began
- **Today**: bar chart of daily activity for the last 7 rolling days
- **This week**: rolling 8-week bar chart showing weekly totals; current incomplete week shown at half opacity
- Donut chart of time distribution across top 9 sites + Others
- Full domain table with time, percentage, bar, favicon, and daily limit indicator
- **Search box** in the table header — filters domains by name as you type, persists across tab switches
- **Hover tooltips** on table rows showing: first/last visited, total visits, active days, avg time per active day, avg time per visit, longest day, current streak, longest streak
- **Hover tooltips** on chart bars showing exact values after 300ms
- Inline limit editor: set a daily limit and snooze period per domain
- **Merge subdomains** option: groups subdomains under their root domain (e.g. `sub.example.com` → `example.com`) using a heuristic TLD detector. Limit badge reflects combined state: green (within limits), yellow (any subdomain over its limit), red (combined time over combined limit)

### Daily limits & notifications
- Set a daily time limit (in minutes) per domain
- Native OS notification when the limit is exceeded
- Snooze button on the notification; re-notifies after the snooze period
- Limit status shown in the dashboard table and in the popup

### Import / Export
- The JSON format is compatible with the **Web Activity Time Tracker** extension available on the Chrome Web Store, an extension used by tens of thousands. But unlike that extension, which started inserting ads onto webpages, TimeTrace runs locally and without any invasive measures.
- Export tracked data as JSON (scoped to the active period: today, this week, or all time)
- Import JSON with two modes: **Merge** (adds on top of existing data) or **Replace** (clears first)
- Export format: `[{ url, favicon, summaryTime, counter, days: [{ date, summary, counter }] }]`

### Settings
- Configurable inactivity timeout (minutes)
- Merge subdomains toggle
- Debug mode: live log panel in the dashboard with a three-position slider (Off / Normal / Verbose) for filtering displayed events. All events are always recorded to the buffer regardless of filter level.

## Known issues / ToDo

- **Silent video**: muted or silent videos are not tracked beyond the inactivity timeout, as there is no API to detect video playback without audio.
- **`www.` stripping**: all domains have `www.` stripped. `www.example.com` and `example.com` are treated as the same site.
- **Week aggregation keys**: legacy `week:` storage keys may be stale after the v1.1.5 timezone fix. The dashboard now derives weekly data from per-day entries directly, so display is correct, but the legacy keys are not cleaned up.

## Data storage

All data is stored in `chrome.storage.local`, keyed to the extension ID. It is never transmitted anywhere. Removing the extension permanently deletes all data — export before uninstalling.

## How to install

Installing in Chrome:

1. Download from Code -> Download zip.
2. Unzip it in a folder that will be the home to your extension.
3. Go to `chrome://extensions` in your browser.
4. Enable **Developer mode** (toggle, top-right).
5. Click **"Load unpacked"** and select the folder containing the unzipped contents.

The clock icon will appear in your toolbar — _you're live!_
