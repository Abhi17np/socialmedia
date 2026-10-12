# Stitch prompt pack — Social Hub UI/UX redesign

How to use this: Stitch generates one screen per prompt and carries a design system across a project. Paste **Part 1** first (it sets product, theme and component language), then paste the screen prompts in **Part 2** one at a time, in order. Part 3 holds refinement follow-ups worth sending after a screen generates. If you have screenshots of the current app, attach them to Part 1 and add: "this is the current UI — keep the information architecture, raise the visual and interaction quality."

---

## Part 1 — Project / design-system prompt (paste first)

> Design a responsive web SaaS application called **Social Hub** — a multi-tenant social media management tool for small and mid-size businesses and agencies in India. One workspace connects WhatsApp Business, Instagram, Facebook, LinkedIn, YouTube and Google Business Profile. From one place a team schedules and publishes posts, works every incoming comment, review and DM out of a single unified inbox, and sees one complete history per customer across every channel — that cross-channel single customer record is the product's signature feature, and the UI should make it feel like the point, not a detail.
>
> Users: a business owner, a marketing manager, and 1–5 agents who live in the inbox all day. Desktop-first (1440px), must hold up at 1024px and on mobile (390px) for the inbox and dashboard. Density matters more than decoration — agents triage dozens of conversations an hour.
>
> **Design language:** calm, modern, confident product UI — in the register of Linear, Height and Intercom rather than a consumer app. Light, airy neutral canvas; generous whitespace; hairline borders instead of heavy shadows; content carries the color, chrome stays quiet. Soft-rounded geometry (10–18px radii on cards, 8–10px on controls, pill shapes for status and filters). No gradients in the app shell, no drop shadows on flat elements, no skeuomorphism. Never use a colored sidebar or colored page headers.
>
> **Color:**
> - Primary / brand: indigo-violet `#5B5FEF` (hover `#4C50E0`), used sparingly — primary buttons, active nav, focus rings, links.
> - Canvas `#F7F7FB`, surfaces `#FFFFFF`, sunken fills `#F3F3F9`, borders `#E7E7F1`.
> - Text: `#16161F` primary, `#5D5D72` secondary, `#9C9CB0` muted.
> - Semantic: success `#16A34A`, warning `#D97706`, danger `#DC2626`, teal accent `#0D9488`.
> - Channel identity colors, used only on small badges, chips and per-channel bars — never as large background fills: WhatsApp `#25D366`, Instagram `#E1306C`, Facebook `#1877F2`, LinkedIn `#0A66C2`, YouTube `#FF0000`, Google Business `#4285F4`.
> - Also produce a **dark theme** of the same system (near-black `#0E0E14` canvas, `#17171F` surfaces, same indigo primary lightened for contrast).
>
> **Type:** Inter. Page title 24/700, section title 16/600, body 14/400, meta and labels 12–13/500, numeric KPI values 28–32/700 with tabular figures. Sentence case everywhere, including buttons. Uppercase only for 11px micro-labels.
>
> **Shell:** fixed 248px left sidebar on a white surface with a hairline right border — small indigo square logo mark plus "Social Hub" wordmark at top, a "Social" section label, then nav items with 18px line icons: Dashboard, Compose, Posts, Inbox, Analytics, Connect accounts, Team, Billing. The active item is indigo text on an 8%-indigo tinted rounded row. Inbox shows a numeric unread badge. Pinned at the bottom: a workspace card with avatar initial, user email, and workspace name plus plan badge, opening a menu with workspace switch, theme toggle and log out. Main area: a sticky top bar holding the page title, a global search field ("Search contacts, posts and conversations"), a notification bell, and the page's primary action; content max-width 1280px with 32px padding.
>
> **Components to define once and reuse:** stat/KPI tile (icon chip, label, big value, delta), content card, filter bar (segmented tabs + select pills + search), status pill, channel badge (round, channel-colored, white glyph), avatar with channel badge overlay, assignee avatar picker, data table, list row, right-side slide-over drawer, modal, inline banner (info/success/warning/danger), empty state (line illustration + one-line explanation + single primary action), loading skeletons, and a toast. Every destructive action gets a confirm dialog.
>
> Show empty, loading and error states as part of the design, not as an afterthought — this app is frequently opened before any account is connected.

---

## Part 2 — Screen prompts (paste one at a time)

### 1. Log in

> Split-screen auth page. Left half: an indigo `#5B5FEF` to `#4338CA` diagonal gradient panel with subtle large-radius light blooms, the Social Hub mark top left, a headline "Every channel, one inbox. One customer, one history.", a one-line subhead, and four checkmark feature lines (Unified inbox across every channel · Schedule once, publish everywhere · One customer record per person · WhatsApp Business built in), with a small copyright line pinned bottom. Right half: white panel, left-aligned form, max 360px — "Welcome back" title, "Log in to your workspace" subhead, email and password fields with 16px leading line icons inside the input, a "Forgot password?" link, a full-width indigo primary button, and "No account yet? Create a workspace" below. Include the error state: a soft red inline banner with an alert icon above the form. On mobile the brand panel collapses to a short header strip.

### 2. Create workspace (sign up)

> Same split-screen as log in, left panel headline "Set up your workspace in under a minute." Right panel form: workspace name, work email, password with an inline strength meter and an "at least 8 characters" helper, a terms checkbox, and a full-width primary "Create workspace" button. Below the button, a thin 3-step progress hint: Create workspace → Connect a channel → Publish your first post.

### 3. Dashboard

> The 30-second glance. Page header "Dashboard" with a subtitle, a brand filter select, a date-range segmented control (7 / 30 / 90 days) and a refresh icon button. Then a row of six KPI tiles with small channel-tinted icon chips: Connected accounts, Total followers (with a "+124 this window" delta), Posts published, Total reach, Total engagement, Open conversations (with a red "needs a reply" delta). Below, a two-thirds / one-third split: left, a "Reach and engagement" area chart over the selected range with a clean legend and hover tooltip; right, a "Channels" card listing each connected account as a row with channel badge, account name, follower count and a thin channel-colored horizontal bar. Below that, two equal cards side by side: **Needs attention** — up to five open conversations as rows with avatar plus channel badge, author name, truncated message, a priority dot, relative timestamp and a hover "Reply" action, with "Open inbox →" in the card header; and **Upcoming posts** — up to five scheduled posts as rows with the channel chips they publish to, the scheduled time, truncated content and a hover "Edit" action, header link "Open posts →". Also design the first-run state of this page: one centered empty-state card, "No channels connected yet", one line of explanation, and a primary "Connect a channel" button.

### 4. Compose

> A three-column publishing workspace, page header "Compose".
>
> **Left column (editor, widest):** at the top a horizontal row of selectable account chips — each a round channel-colored avatar with the channel glyph, the account name under it, and an indigo check badge on the corner when selected. Below, a two-option segmented toggle: "Manual" and "AI assist" (sparkle icon). In AI assist mode an indigo-tinted panel appears with a brief textarea ("What do you want to post about?"), a tone input, and a "Generate draft" button — the generated text drops into the main editor for the human to edit. Then the main content textarea with a formatting/emoji/hashtag toolbar, and a live per-channel character counter row (e.g. "LinkedIn 412/3000 · Instagram 412/2200") that turns amber when a selected channel's limit is exceeded, with an inline warning line explaining that channel's constraint. Below, a dashed-border drag-and-drop media zone ("Click to upload, or drag and drop · images or videos up to 50MB"), uploaded media as a row of square thumbnails with a remove button, an upload progress overlay and a failed state, plus a subtle link "…or paste an already-hosted media URL".
>
> **Middle column:** a sticky "Publishing options" card — brand field, two radio options "Publish now" and "Schedule for a specific date" (the second revealing a date-time picker and a timezone note), an optional "best time to post" suggestion row, a line reading "Posting to Acme Instagram, Acme LinkedIn", and a full-width primary submit button that reads "Publish now" or "Schedule post".
>
> **Right column:** a sticky "Post preview" card with small channel icon tabs and a pixel-faithful mock of the post as it will appear on the selected channel — Instagram (square media, icon row, truncated caption), LinkedIn and Facebook (avatar, name, timestamp, body with "…more", reaction bar), YouTube (16:9 thumbnail with play overlay, title, channel line), Google Business (photo, business name, "Local post", body, "Learn more" button). Include the empty preview state: "Select an account above to see how your post will look." At 1024px the preview moves below the editor as a full-width panel.

### 5. Posts

> Page header "Posts" with a subtitle, a refresh button and a primary "New post" button. Below, two segmented sub-tabs with counts — "Scheduled (12)" and "Published (148)" — then a filter bar: channel filter as a row of round channel icon toggles (with an "All" option), a search field ("Search post content"), a brand select, and a view switcher with **List** and **Calendar** options.
>
> **List view:** posts grouped under collapsible date headers (calendar icon, "Monday, 14 October 2026", "3 posts") each holding post cards — a row of small channel chips, the post text (two lines max), a 56px media thumbnail on the left when present, the scheduled time and brand as meta, a status pill on the right (Pending / Publishing / Published / Failed), and hover actions Edit, Duplicate and Cancel. A failed post shows an expandable per-channel error box listing each channel and its failure reason with a "Retry" link.
>
> **Calendar view:** a month grid where each day cell shows up to three compact post pills (channel badge, time, truncated text, colored by status) and a "+2 more" overflow, with drag-to-reschedule implied by a grab cursor and a drop-target highlight, plus a week view toggle.
>
> Include the empty state: "Nothing scheduled — write your first post" with a primary action.

### 6. Inbox (the screen agents live in — design this one hardest)

> Replace a flat row list with a three-pane triage workspace built for keyboard speed.
>
> **Left pane (280px):** saved views with counts — All, Unassigned, Assigned to me, Mentions, Messages, High priority, Under review, Closed — then a "Channels" group listing each channel with a badge and unread count.
>
> **Middle pane (380px):** the conversation list. A sticky filter header with a search field and compact select pills (Type, Priority, Status, Assignee). Each row: a 36px avatar with initials on a deterministic tint and a small channel-colored badge overlaid on its corner, the author name, a two-line message preview, relative time, a priority dot, an assignee micro-avatar, and an unread indicator; the selected row is indigo-tinted with a left indigo rail. Rows expose quick actions on hover (assign, close, snooze), and the list supports multi-select with a bulk action bar (assign, set status, set priority, close).
>
> **Right pane (flexible):** the conversation itself — a header with the contact's name, channel badge, the original channel permalink ("View on Instagram"), three compact pill selects for Priority, Status and Assignee, and a prominent secondary button "View full history" (this opens the cross-channel timeline drawer). Under it, the conversation as chat bubbles: inbound left-aligned on a light sunken fill, outbound right-aligned on indigo tint, each with a timestamp and channel label, and a day divider between dates; mentions and reviews render as a single quoted card with the original post context and a star rating where it applies. At the bottom, a sticky reply composer: a "Manual / AI suggest" segmented toggle, a canned-response picker ("Insert a canned response…") with a manage link, an "AI suggest" button with a sparkle icon and a "Thinking…" loading state, the textarea, attachment and emoji buttons, a note that WhatsApp replies outside the 24-hour window need a template, and a primary "Send reply" with a "Send and close" split option. Show an internal-note tab beside Reply.
>
> Include the empty state for the right pane ("Select a conversation"), the zero-inbox state ("You're all caught up"), and the never-synced state ("Nothing here yet — connected accounts sync every 10 minutes"). On mobile this collapses to a single list that pushes to the conversation view.

### 7. Contact history drawer (signature feature)

> A right-side slide-over drawer, 480px wide, over a dimmed backdrop — the cross-channel history of one person. Header: large avatar, display name, phone and email, the channel badges of every channel they have been seen on, and a close button. Under it a compact facts strip: first seen, last seen, total conversations, assigned owner, and editable tags. Then a vertical timeline with a left rail: each entry is a channel-colored dot badge (at-sign glyph for a mention, speech bubble for a message), a channel name, an exact timestamp, and the message text, with outbound messages prefixed "You:" and visually distinguished; entries from different channels sit in one chronological stream so the unification reads instantly. Group entries under month dividers, add a channel filter chip row at the top of the timeline, and include an empty state. Pin a footer with "Open conversation" and "Merge contact" actions.

### 8. Analytics

> Page header "Analytics" with the subtitle "Channel overview for the past 30 days", a brand select, a date-range segmented control and an "Export CSV" button. A row of four KPI tiles (Total followers, Posts published, Total reach, Total engagement), each with an icon chip, a big tabular-figure value, a small trend sparkline and a percentage delta. Then a full-width card "Engagement over time" — a multi-series line chart, one line per channel in that channel's color, with a legend that toggles series and a hover tooltip. Beside or below it, a card "Engagement by channel" as a horizontal bar chart, bars in channel colors, value labels at the bar end, sorted descending. Then a "Channels" section as a responsive grid of channel cards: channel badge, account name, channel name, a follower count with delta, and a four-metric row (Followers, Reach, Engagement, Posts) where any metric a channel cannot report shows a muted em dash with the tooltip "Not reported by this platform yet" — never a fabricated zero. A card expands to reveal a "Recent posts" table: post text (two lines), date, a permalink link, and likes / comments / shares columns with icons. Add a small inline note explaining the em-dash convention, and a best-time-to-post heatmap card (days × hours) as the last panel.

### 9. Connect accounts

> Page header "Connect accounts" with the subtitle "Connect real channel accounts to publish, monitor and reply from one place", a brand field, and a refresh button. Then a responsive grid of one card per channel — WhatsApp Business, Instagram, Facebook, LinkedIn, YouTube, Google Business Profile — each showing a large channel badge, the channel name, a one-line description of what connecting enables, and a status pill ("2 connected" in green or "Not connected" in grey). A connected card lists each linked account as a row with its avatar, account name, brand, a health indicator ("Token valid" / "Reconnect needed" in amber), last-synced time, and a "Disconnect" button. The footer action reads "Connect Instagram" or "Connect another Instagram account", with a connecting spinner state; the WhatsApp card carries a second button "Connect via embedded signup" with a help tooltip. Include a success banner, an error banner, and a "Reconnect needed" card variant that visibly stands out. Also design the disconnect confirm dialog: title, the warning that scheduled posts targeting this account will fail, Cancel, and a danger-styled Disconnect.

### 10. Team

> Page header "Team" with the subtitle "Everyone with access to this workspace, and what they can do", and a primary "Invite teammate" button. A members table: avatar plus name and email in one cell, a role select rendered as a pill (Viewer, Member, Admin, Owner), last active, joined date, and a row overflow menu with "Change role" and a danger "Remove". Above the table, a seat-usage line ("4 of 10 seats used") with a thin progress bar. Design the invite as a modal — email, role select, and a short per-role permission explainer that updates with the selection (Viewer: read only · Member: compose and reply · Admin: manage channels and team · Owner: billing) — with a primary "Send invite". Include a pending-invite row variant with a "Resend" link.

### 11. Billing and usage

> Page header "Billing & usage". A current-plan card: plan name pill, price, "Next invoice 1 November 2026", a "Manage payment method" link and a "Change plan" button. Beside it a usage card listing four metered meters, each a label, a used-of-limit figure and a thin progress bar that turns amber past 80% and red at 100%: Connected accounts, Posts this month, WhatsApp messages this month, AI assist drafts this month. Then a three-column plan comparison — Free, Starter, Pro — each with a price in Indian rupees, a feature checklist, the current plan marked, and an "Upgrade" primary button on the others (Pro marked "Recommended"). Below, an invoice history table: date, amount, status pill, and a download icon. Include a near-limit warning banner at the top of the page.

### 12. System states and internal console

> On one canvas, design the shared states as reusable blocks: a full-width amber "Can't reach the Social Hub server" connectivity banner with an icon, the server address in mono type and a "Retry" button; a rate-limited toast; a 403 "You don't have access to this" page for a viewer who opened an admin URL; a 404 page; loading skeletons for a KPI row, a list and a table; a success toast; and a danger confirm dialog. Then, separately, an internal operator console in the same design system but visually distinct (a slate-grey top bar instead of the indigo app shell, labelled "Social Hub · Internal"): a tenants table with columns Workspace, Plan, Status, Seats, Accounts, Posts this month, WhatsApp this month, Created, plus a search field, plan and status filters, and a row overflow menu (View, Suspend, Impersonate).

### 13. Mobile

> Design mobile (390px) versions of the three screens an owner actually opens on a phone: **Dashboard** (stacked KPI tiles two per row, one chart, the needs-attention list), **Inbox** (full-width conversation list pushing to a chat view with a sticky reply bar and an AI-suggest button), and **Compose** (channel chips, editor, a collapsible preview, and a sticky bottom publish bar). Use a bottom tab bar: Dashboard, Compose, Inbox, Analytics, More.

---

## Part 3 — Refinement follow-ups (use after a screen generates)

Send these as follow-up messages on the screen you want to adjust:

- "Reduce the vertical padding and tighten the row height — this list is for all-day triage, make it denser without losing legibility."
- "The channel colors are too dominant. Keep them only on the small round badges and the per-channel bars; everything else neutral."
- "Add the dark theme variant of this screen using the palette from the project brief."
- "Show this screen's empty state, loading skeleton and error state as three additional frames."
- "Add keyboard shortcut hints: `j`/`k` to move between conversations, `r` to reply, `e` to close, `/` to search — show them in a shortcuts popover."
- "Make the primary action unmistakable — one indigo button per screen, everything else secondary or ghost."
- "Show this at 1024px and say which panels collapse."

---

## What this redesign deliberately changes

Carried over unchanged: the eight-item sidebar and role-gated nav (viewer / member / admin / owner), every page's data and endpoints, the per-channel post previews, the Manual↔AI-assist pattern where AI only drafts into the same field a human edits and sends, and the em-dash convention for metrics a channel cannot report.

Asked of Stitch as genuine UX upgrades over the current build:

1. **Inbox becomes a three-pane conversation workspace** instead of a grid of rows with three dropdowns each — real threaded bubbles, bulk actions, keyboard triage.
2. **Contact history is promoted** from a text link inside a row to a first-class drawer with facts, tags and month grouping — it is the differentiating feature.
3. **Posts gains a calendar view** with drag-to-reschedule alongside the list.
4. **Dashboard and Analytics gain time-series** (reach/engagement over the range, deltas, sparklines, best-time heatmap) rather than only point-in-time totals.
5. **A shell top bar** with global search, notifications and the page's primary action; workspace, theme and log out move into a proper account menu.
6. **A dark theme**, plus defined empty / loading / error / offline states.
7. **Channel health surfaced** on Connect accounts (token valid, reconnect needed, last synced) instead of only connected/not connected.
8. **An onboarding spine**: connect a channel → publish a first post, visible from signup and from the first-run dashboard.

---

## Part 4 — Reply when the output looks AI-generated

Send this when Stitch returns the generic look: every element in its own rounded white card, colored icon chips next to numbers, a purple gradient panel, uniform padding everywhere. Paste it on the screen you want fixed, then re-send it on each subsequent screen so the correction sticks.

> Redo this screen. It currently reads as generic AI-generated UI and I need it to look like a product a design team shipped. The specific things making it look machine-made, all of which I want gone:
>
> - Every single element wrapped in its own rounded white card with a border and a shadow — card inside card inside card.
> - A colored rounded-square icon chip beside every number and every section title.
> - Equal-width columns of equal-height cards in a tidy grid.
> - A purple gradient panel.
> - The same 16px padding and the same 12px radius on everything, so nothing is more important than anything else.
>
> Rebuild it with these rules instead:
>
> **1. One surface per region, not one per element.** A region is a flat area of the page separated by whitespace and a single hairline rule — not a floating card. The page background and the content share one color; a raised white surface appears only where something genuinely floats above the page (a drawer, a modal, a dropdown, a sticky bar). No card inside a card, ever.
>
> **2. Hierarchy comes from type and space, not from containers.** Create it with scale contrast (a 30px number against an 11px label), weight (400 body against 600 headings — never both 700 and 800), and vertical rhythm on an 8px grid. If two things need separating, use 32px of space or a 1px `#E7E7F1` rule, not a border-radius.
>
> **3. Radii down, shadows nearly gone.** 6px on inputs and buttons, 8px on the few real surfaces, full pill only on status and filter chips. One shadow in the whole system, for floating layers only: `0 16px 40px rgba(22,22,31,0.12)`. Flat things cast no shadow.
>
> **4. Numbers are set, not boxed.** Lay the KPI row out as four or six figures on one flat strip divided by vertical hairlines: an 11px uppercase letter-spaced muted label above, a 30px/600 tabular-figure value below, and a small `+12.4%` delta in green or red beside it. No icon chips, no tinted circles, no card borders around each one.
>
> **5. Break the grid.** Asymmetric columns — a 1.6fr main column against a 1fr rail, not 1fr/1fr/1fr. Let one element span full width. Let the rail be shorter than the main column. Vary the density between regions so the eye has somewhere to rest.
>
> **6. One accent, under 5% of the pixels.** Indigo `#5B5FEF` on the single primary button, the active nav row, focus rings and links — nowhere else. Everything else is the neutral ramp. Channel colors appear only as 16px round badges and as the fill of per-channel bars. No tinted section backgrounds, no colored card headers, no gradients anywhere in the app.
>
> **7. Use icons sparingly and consistently.** 16px line icons at 1.5px stroke, only where they carry meaning — nav, buttons with a verb, channel badges, status. No decorative icons beside headings.
>
> **8. Tabular data gets a table.** Rows at 44px with a hover tint and no vertical rules; a 36px header row in 12px uppercase muted type; numeric columns right-aligned with tabular figures. Do not render a table as a stack of cards.
>
> **9. Real content, at realistic volume.** Indian business and personal names, real-looking handles and amounts in rupees, messages of varying length including one that must truncate, timestamps spanning several days, one failed item, one metric showing an em dash. No "Lorem ipsum", no "Acme Inc.", no row where every value is the same width.
>
> **10. Density.** This is a tool people use for six hours a day. 44px list rows, 32px page padding, 16–24px between related elements, 32–48px between regions. Tighten it until it reads as professional software rather than a marketing page.
>
> Keep the information architecture, the content and the features exactly as they are — I am changing how it looks and feels, not what it does.

For the auth screens specifically, add:

> Drop the gradient. Make the left panel a single flat near-black `#16161F` field with the wordmark small in the top-left corner, the headline set large and tight (36px/600, -0.02em tracking) in the optical centre, and the feature lines as plain 14px text in 70%-opacity white separated by generous space — no checkmark icons, no bullets, no card around them.

And for the Inbox, add:

> This is a triage queue, not a feed of cards. Make every conversation a flat 64px row on the page surface with no border, no radius and no shadow — separated from the next row by one hairline — with the selected row carrying a 2px indigo left rail and a 4%-indigo tint. The three panes are divided by single vertical hairlines, not by gaps between floating panels.
