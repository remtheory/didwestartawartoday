# didwestartawartoday.com — CLAUDE.md

## What this is
A civic tech site that answers one question daily: "Did the United States start or significantly escalate a war today?" The answer and supporting headlines are updated via a Node.js script that writes to `status.json`.

## Live URL
https://didwestartawartoday.com

## Hosting & deployment
- **Platform**: Cloudflare Pages
- **Account**: remtheory@gmail.com (confirm)
- **Method**: Connected to GitHub repo `didwestartawartoday`
- **Security headers**: Handled by `_headers` file

## Tech stack
- Static HTML (`index.html`, `about.html`) + CSS (`style.css`)
- `status.json` — the data file the page reads to display today's answer
- `scripts/update-status.js` — Node.js script that updates `status.json`
- No framework, no build step
- YouTube embed in the page footer (peace activism video)
- External data sources linked (not fetched): ACLED, Airwars, The Economist

## Key files
| File | Purpose |
|---|---|
| `index.html` | Main page — reads status.json and renders the answer |
| `about.html` | Explanation of the site's methodology |
| `style.css` | All styles |
| `status.json` | Today's war status data (updated by the script) |
| `scripts/update-status.js` | Script to update status.json — run manually or via cron |
| `_headers` | Cloudflare Pages security headers |
| `robots.txt` | Crawler instructions |
| `sitemap.xml` | Sitemap for search engines |

## How status gets updated
Run `node scripts/update-status.js` locally, then commit and push `status.json` to trigger a Cloudflare Pages deploy. Consider automating this with a GitHub Action on a daily schedule.

## How to update
1. To update today's answer: run the script, commit `status.json`, push
2. To update site copy: edit `index.html` or `about.html`, push

## CSP note
The Content Security Policy in `_headers` includes `frame-src https://www.youtube.com` for the embedded YouTube video. If you remove that embed, tighten the CSP to remove that directive.

## TODO
- [ ] Automate daily `status.json` updates with a GitHub Action (cron schedule)
- [ ] Add a proper OG image for better social sharing
- [ ] Register with Google Search Console
- [ ] Consider adding a historical archive of past answers
