# Command Ledger design system

This is the single source of truth for how Command Ledger looks. The public
website and the signed-in application share one brand, one set of tokens and
one component language; they differ only in density.

The runtime source of the tokens is the `:root` block at the top of the `CSS`
string in `src/App.jsx`. Inline styles use the `C` object in the same file,
whose every value is a `var(--token)`. No component hardcodes a colour. If a
value here and the code ever disagree, the code is wrong and this file is
right; fix the code.

There was no earlier written design system in this repository. The previous
interface mixed a navy blue-black, a warm cream and a blue-grey that matched
neither each other nor the brand mark. All of it was replaced in November 2026.

## 1. The brand mark

- **Master file:** `assets/Logo.png`, 1254 x 1254. It is the final brand
  asset. Do not redraw, recolour, crop, trace or generate alternatives.
- **Web copies:** `public/brand/` and the favicons in `public/` are the same
  image scaled down with Lanczos resampling and nothing else. Same
  composition, same square proportions. `public/brand/command-ledger-logo.png`
  is a byte-identical copy of the master.

  | File | Size | Used for |
  |---|---|---|
  | `public/favicon.ico` | 16, 32, 48 | Browser tab (legacy) |
  | `public/favicon-32.png`, `favicon-48.png` | 32, 48 | Browser tab |
  | `public/apple-touch-icon.png` | 180 | iOS home screen |
  | `public/brand/icon-192.png` | 192 | Marks up to 96 px |
  | `public/brand/icon-512.png` | 512 | Marks 97 to 256 px |
  | `public/brand/logo-640.png` | 640 | Marks above 256 px |
  | `public/brand/command-ledger-logo.png` | 1254 | Open Graph image |

- **Component:** `BrandMark` picks the smallest copy that stays sharp.
  `BrandLockup` sets the mark beside the name "Command Ledger" in display caps,
  because the wordmark inside the logo is not legible below about 200 px.
- **Framing:** the logo carries its own lighting, a soft glow behind the
  monogram. At 44 px and above that glow reads as a faint square, so those
  instances use `framed`, a hairline plate that makes the square deliberate.
  Below that size the field is invisible and the mark is shown unframed.
  `mix-blend-mode: lighten` blends the logo's darker vignette into its
  surface. The mark itself is never altered.

## 2. Colour

Every neutral is sampled from the brand mark: its near-black field and its
brushed-silver ramp, which leans very slightly cool. The three financial
colours are the only chroma in the system and carry meaning, never decoration.

| Token | Value | Source and use |
|---|---|---|
| `--bg` | `#0D0D0F` | The logo's field. Page background. |
| `--panel` | `#151517` | Logo shadow. Cards, sidebar, panels. |
| `--panel-2` | `#1C1C1F` | Inputs, nested surfaces, featured card. |
| `--panel-3` | `#232327` | Hover, active pill. |
| `--line` | `#2A2A2E` | Default borders and dividers. |
| `--line-strong` | `#3F3F41` | Logo dark metal. Emphasised borders, rules. |
| `--text` | `#EDEDEE` | Primary text. |
| `--text-2` | `#AAAAAC` | Logo silver. Secondary text. |
| `--text-3` | `#8C8C8D` | Logo mid silver. Muted text, labels. |
| `--platinum` | `#DEDEDE` | Logo highlight. Primary buttons, active marks, focus ring. |
| `--platinum-hi` | `#F4F4F5` | Primary button hover. |
| `--silver` | `#AAAAAC` | Informational state. |
| `--pewter` | `#626264` | Second chart series, numerals, decorative rules. |
| `--metal` | gradient | Brushed silver, as on the monogram. See section 6. |
| `--positive` | `#28A879` | A meaningful positive financial outcome. |
| `--warning` | `#D4A34F` | Caution or uncertainty. |
| `--danger` | `#E05252` | A genuine financial warning or security problem. |

Rules:

1. Most of the interface is neutral surfaces and light text. Hierarchy comes
   from borders and spacing, not from giving each component its own colour.
2. Platinum is a highlight, never a large background.
3. Red appears only when the evidence warrants attention. Green only for a
   meaningful positive outcome. Amber for caution.
4. Status is never colour alone. Every coloured state carries a text label
   (`SeverityTag`, alert severities, the AI risk chip).
5. No blue, no gold, no neon, no glassmorphism, no decorative glows.
6. Tinted backgrounds use `color-mix(in srgb, var(--x) 9 to 14%, transparent)`.
7. Contrast: `--text-3`, the weakest text token, is 5.1:1 on `--panel-2`,
   above WCAG AA for normal text. Do not introduce a dimmer text colour.
8. The brief's suggested bronze accent (#B69B70) and blue-tinted surfaces
   were not adopted: the founder ruled that colours must match the logo,
   which has neither.

## 3. Typography

Three roles, set in `--f-display`, `--f-ui` and `--f-num`:

- **Cormorant Garamond (display):** editorial headlines, page titles,
  directives, large financial figures. Never body paragraphs.
- **Syne (interface):** navigation, buttons, labels, body copy, descriptions.
- **JetBrains Mono (numbers):** transaction tables, dates, references,
  aligned amounts, tags.

Comparable figures use `font-variant-numeric: lining-nums tabular-nums`.

| Role | Size |
|---|---|
| Site hero headline | `clamp(46px, 5.4vw, 76px)` |
| Site section heading | `clamp(34px, 3.6vw, 48px)` |
| App page title | `clamp(30px, 2.6vw, 38px)` |
| Card heading | 22 px (site), 12 px uppercase label (app panel title) |
| Body | 16 to 18 px (site), 14.5 to 15.5 px (app) |
| Labels | 12 to 13.5 px; never smaller than 11.5 px (mono tags) |
| Lead KPI figure | 56 px |
| KPI figure | 34 px |

Never shrink type to make something fit. When six KPI tiles cannot hold their
figures at full size (below 1,320 px), they wrap to two rows of three.

## 4. Space and layout

- Site content width 1200 px with a 32 px gutter (20 px on phones).
- Site sections are separated by a hairline and `clamp(72px, 9vw, 128px)` of
  vertical space.
- App: 60 px header, 240 px sidebar, panels on a 16 px gap grid. Rows are
  `row-21`, `row-12`, `row-2`, `row-3`, all `minmax(0, ...)` so content can
  never force horizontal overflow.
- Breakpoints: 1320 (KPI wrap), 1100 (site hero stacks, header compacts),
  960 (app sidebar becomes a drawer, rows stack), 720 (phone: search behind a
  button), 520 (small phone).

## 5. Components

- **Buttons:** `btn-primary` (platinum, the one main action), `btn-outline`
  (secondary), `btn-ghost` (tertiary). Sentence case, Syne 600.
- **Panel:** `--panel` surface, `--line` border, 4 px radius, uppercase 12 px
  title. The app's basic container.
- **KPI tile:** label (13 px), figure (34 px, 56 px for the lead), one line of
  context, then `ConfidenceLine` when the figure is not high confidence. The
  lead tile is chosen by severity and carries a 2 px severity bar.
- **Directive strip:** the week's call, with a 3 px severity edge. `compact`
  hides the reasoning, for the site preview only.
- **Revenue and costs (`BChart`):** platinum bars for revenue, pewter for
  costs, one shared scale, period totals, labelled as actual history. Loans,
  owner money and own-account transfers are neither, so they are not drawn.
  A month in progress is drawn at 45% opacity with an asterisk and a
  "To date" legend. Forecasts are never mixed into it.
- **Counts as (`tx-kind`, `KindEditor`):** every transaction row says what it
  counts as, in words, with "set by you" when a rule applies, and a Change
  link that opens an editor row beneath it (`kind-edit`): a select, the
  effect in one line, and a choice between this transaction and every one
  described like it.
- **Cash balance (`CashBalancePanel`, `cash-form`):** the balance runway uses,
  where it came from and its date, and a form to enter the total. An
  overdraft is shown in the danger colour and named in words.
- **AI brief:** a memo with a fixed label column; the recommended action in
  display type; risk chip plus a confidence meter of the real score.
- **Tables:** mono numerals, right-aligned amounts, sticky uppercase headers.
- **Site sections** use the `mk-` prefix so they can never collide with app
  classes. Every class in `CSS` is global: check before naming a new one.

## 6. The signature

One distinctive decision, taken from the logo itself: the **ledger rule**, the
logo's "FINANCIAL SYSTEMS" device of a tracked caption between two hairlines.
It heads every site section (`.ledger-rule`). The only other borrowing from
the mark is its brushed silver (`.metal-text`), used once, on the hero phrase
"can afford.", and on the 2 px rule over the featured price. Do not spread
either further.

## 7. Motion

Motion only where it explains or confirms: the hero preview rises in once,
popovers fade, the accordion marker rotates, the drawer slides. No scroll
animations, no animated counters, no moving backgrounds.
`prefers-reduced-motion` disables all of it.

## 8. Copy

- No em dashes or en dashes in any user-facing text, and no dashes used as
  decorative separators. Use full stops, colons and commas. A hyphen in a
  compound word ("one-time") is fine. `---` is not a dash: it is the required
  marker for a metric without enough data.
- Write for founders, not engineers. Short, confident, specific.
- Never claim what the product does not do (it does not connect to banks).
- Every sample figure on the site is computed from `EXAMPLE_CSV` by the real
  engine and labelled as sample data. Never type a figure in.
