# Cloverdale Paint Dashboard

Interactive social media dashboard for Cloverdale Paint covering Instagram, Facebook, LinkedIn and YouTube.

Live: https://tjsuduku.github.io/cloverdale-paint-dashboard/

- Growth scale, top content and a deep dive for each platform
- **Competitive landscape** comparing Cloverdale with Benjamin Moore, Sherwin-Williams, Behr and Dulux, shown two ways:
  - share of engagement: who got the most attention
  - engagement per follower: who got the strongest response for their size
- Best posts, standout posts, posting rhythm, and which topics are working
- Zoomable audience geography map
- Report builder with weekly, bi-weekly, monthly or custom reports as PDF
- Built-in assistant that answers questions from the data

Works on desktop and phone.

## How the competitor data stays fresh

`collector/collect.mjs` runs every morning through GitHub Actions (`.github/workflows/collect.yml`). It reads public numbers from the official Instagram and YouTube APIs and saves them to `data/landscape.json`, which the dashboard loads. Keys are stored as repository secrets and never appear in the code or the page.

- Brands and handles: `collector/config.json`
- Shared maths (used by the dashboard and the weekly email): `collector/landscape-math.mjs`
- Optional Monday summary email: `collector/weekly-email.mjs`

To run it by hand, open **Actions → Collect competitor data → Run workflow**.
