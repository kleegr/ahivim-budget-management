# UX information architecture

The everyday product has one role-specific Home and three primary work sections: **People & Budgets**, **Activity**, and **Money & Reports**. Settings and advanced administration remain secondary. The global command bar remains available to power users.

The first slice groups the existing application routes under this simpler shell. It does not delete pages, change their URLs, replace business logic, or remove role gates.

## Complete current route map

| Destination | Everyday entry | Existing routes retained | Navigation treatment |
| --- | --- | --- | --- |
| Home | `/home` | `/home`, `/dashboard`, `/portal` | `/home` remains the role-aware entry. Owners/managers reach the operational dashboard; external viewers reach their authorized portal. |
| People & Budgets | `/individuals` | `/individuals`, `/individuals/[id]`, `/employees`, `/employees/[id]`, `/agencies`, `/agencies/[id]` | Individuals are the default working table. Employees and agencies are secondary destinations and contextual profile links inside the same hub. |
| Activity | `/transactions` | `/transactions`, `/schedule`, `/portal/schedule`, `/reconciliation`, `/reconciliation/groups`, `/review`, `/imports`, `/imports/[id]`, `/imports/[id]/corrections`, `/sync`, `/matches`, `/exceptions`, `/aliases` | Transactions and Schedule are everyday destinations. Matching, imports, sync, exceptions, aliases, and reconciliation sit under **Review & Sync** or remain command-bar destinations. |
| Money & Reports | `/masser` | `/masser`, `/masser/individuals/[id]`, `/settlements`, `/calculations`, `/reports`, `/reports/[report]`, `/reports/agency-financials`, `/classes` | Masser is the action-focused money entry. Detailed settlements, Financial Setup, reports, Agency Financials, and class billing remain available beneath the hub. |
| Secondary settings/admin | `/settings` | `/settings`, `/settings/role-preview`, `/settings/agencies`, `/documents`, `/documents/pdf-editor`, `/signin` | Users, access, role previews, programs, agencies/roles, document administration, PDF editing, and authentication do not compete with daily work in primary navigation. |
| Compatibility redirects | — | `/`, `/people`, `/projections`, `/collections` | Preserve `/` → `/home`, `/people` → `/individuals`, `/projections` → `/calculations`, and `/collections` → `/masser`. The collections redirect continues to carry its query string. |

All 40 current page routes are accounted for above.

## Navigation model

- Primary internal navigation: **Home**, **People & Budgets**, **Activity**, **Money & Reports**.
- Secondary navigation: a collapsed **Settings/Admin** area containing only destinations the signed-in user may access.
- External accounts: **My portal** plus only the one or two authorized work areas relevant to that role.
- One nested everyday level at most; advanced screens stay reachable through contextual links and the command bar.
- Labels describe business questions and actions, while server-side authorization remains authoritative.

## Deep-link contract

- Keep entity links such as `/individuals/[id]`, `/employees/[id]`, `/agencies/[id]`, and `/masser/individuals/[id]` stable.
- Keep operational drilldowns such as `/imports/[id]`, `/imports/[id]/corrections`, `/reconciliation/groups`, `/reports/[report]`, and `/documents/pdf-editor` stable.
- Preserve supported query parameters for selected periods, filters, focused people, checks, transactions, settlement sources, documents, and review rows.
- A future consolidation may hide a route from navigation, but it must preserve the route or add a compatible redirect before removal. Exact-source links from totals and exceptions must continue to open the records that produced them.
- Route grouping is a discovery change only: existing APIs, data calculations, audit history, permissions, saved links, and browser bookmarks remain compatible.
