# Growth Hub

KIPP Team & Family's workspace for growth planning. Static pages backed by Supabase, styled with IBM Carbon.

| Page | Purpose |
|---|---|
| `index.html` | Home: workstream launcher and search |
| `readiness.html` | Growth Readiness: Dashboard, Openings, Milestones |
| `enabling.html` | Enabling Work: Dashboard, Milestones |

`app.js` and `styles.css` serve both boards. `version.js` holds the release number; change it with every publish. `data.json` and `enabling-seed.json` hold starting data.

Run locally:

```bash
python3 -m http.server 4602
```

Reference: [DESIGN-RULES.md](DESIGN-RULES.md), [AUTH-SETUP.md](AUTH-SETUP.md), [INTEGRATIONS-SETUP.md](INTEGRATIONS-SETUP.md), [UX-AUDIT-2026-11-09.md](UX-AUDIT-2026-11-09.md).
