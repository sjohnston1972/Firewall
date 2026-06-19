# CLAUDE.md — Firewall Onboarding Assistant ("Bastion")

> Working name: **Bastion**. A guided, mostly-deterministic web app that brings a
> firewall from a near-blank state up to a best-practice baseline via vendor APIs.
> AI is used in exactly one place: normalising messy source configs into a clean
> structured format. Everything else is deterministic templating.

---

## 1. Project overview

Bastion is a single-tenant web application that an engineer uses to onboard and
baseline a firewall. The engineer connects to a target device, the app reads its
current layout (read-only), the engineer designs the desired state through a GUI,
optionally imports existing NAT/ACL/VPN config (AI normalises these), and Bastion
then either **pushes the config live** or **produces a config bundle for manual
review** — the engineer chooses per run.

- **Domain:** `bastion.clydeford.net`
- **Access:** Cloudflare Access policy — allow **only** `stevie.johnston@gmail.com`.
- **Hosting:** Cloudflare Workers (API + static frontend), R2 (file storage),
  D1 (relational data), Durable Objects (per-session state + relay coordination).

### Primary goal
Reduce a multi-hour, error-prone manual firewall build to a guided, repeatable,
auditable workflow that applies best practice **from the outset**.

### Non-goals (v1)
- Not a day-to-day policy management console (it onboards, it doesn't replace
  Panorama / FortiManager / FMC for ongoing ops).
- Not a packet-level traffic analyser.
- Not multi-tenant or multi-user — single user, single owner.

---

## 2. Core principles (these are hard rules)

1. **Determinism boundary.** AI is invoked in *one* place only: converting an
   uploaded/pasted source config (NAT, ACL, VPN) into the app's internal
   structured format (the "IR" — see §6). AI **never** calls a firewall, **never**
   chooses the final committed config, and **never** runs in the apply path. The
   AI's output is always validated against a schema and shown to the human as a
   reviewable before/after diff.
2. **Read before write.** Every session begins with a read-only discovery and a
   full backup of the running config to R2. No write happens until the engineer
   has seen a complete diff and explicitly confirmed.
3. **Two apply modes, chosen per run.**
   - *Live*: build a candidate config and commit it via the vendor API.
   - *Staged*: render the config and produce a downloadable bundle the engineer
     pushes manually.
4. **Everything is audited.** Every connect, read, plan, apply, and rollback is
   written to an immutable audit log.
5. **Credentials are never persisted by default.** They live in the session's
   Durable Object memory only. (Optional encrypted-at-rest storage behind a
   user-supplied passphrase is a later opt-in.)
6. **Idempotent.** Re-running a plan that already matches the device produces no
   change.

---

## 3. Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Compute / API | Cloudflare Workers | Single Worker serves both API routes and the SPA static assets |
| Stateful coordination | Durable Objects | One DO instance per onboarding session |
| Relational store | Cloudflare D1 (SQLite) | Projects, plans, imports, audit log |
| Object store | Cloudflare R2 | Raw configs, backups, generated bundles, reports |
| Frontend | React + Vite + Tailwind | Built to static assets, served by the Worker |
| AI | Anthropic API (`claude-sonnet-4-6` default, `claude-opus-4-8` for hard conversions) | Only used by the config normaliser (§13) |
| Auth | Cloudflare Access | Email-gated to one identity |

> **Teaching note (not a coder):** A *Worker* is a small program that runs in
> Cloudflare's network and is stateless — it spins up to handle a request and
> forgets everything afterwards. A *Durable Object* is the opposite: a single,
> long-lived, stateful object with its own tiny storage that can also hold open
> connections (like a live link to an on-site agent). That's why Bastion uses a
> Durable Object to "be" each onboarding session.

---

## 4. Architecture

### 4.1 The build pipeline (the spine of the app)

```
[1] Connect & Discover  → read-only, backup running config to R2
[2] Design              → map zones/interfaces, set DNS/NTP, pick policy packs
[3] Import (optional)   → paste/upload NAT/ACL/VPN → AI normalises to IR → human reviews diff
[4] Plan                → deterministic engine merges design + imports + packs into one IR build plan
[5] Validate            → driver dry-run / candidate validation
[6] Apply               → LIVE (commit) or STAGED (download bundle) — user picks
[7] Verify              → read device back, confirm what actually landed
```

### 4.2 Transport layer (how the Worker reaches the firewall)

A Worker can't dial a private management IP directly, so reachability is a
pluggable **transport**. Three are supported (the engineer picks per target):

| Transport | When to use | How it works |
|---|---|---|
| **Direct** | Mgmt IP is internet-reachable | Worker calls the vendor API directly over HTTPS |
| **Cloudflare Tunnel** | A `cloudflared` tunnel already exposes the mgmt endpoint | Worker calls a tunnel hostname routed back to the device |
| **Relay agent** | Firewall is deep in a private network with no tunnel | A small on-site agent dials *outbound* to the session's Durable Object over WSS; the Worker sends API calls through that link. No inbound holes needed. |

> **Teaching note:** the relay agent pattern is the clean one for customer sites.
> The agent makes an *outbound* connection home (which firewalls allow by
> default), so you never ask the customer to open an inbound port. The Durable
> Object holds that WebSocket open and shuttles commands across it.

**Meraki exception:** Meraki MX is cloud-managed. There is no local mgmt IP and
no transport choice — the driver always talks to the Meraki Dashboard API using
an API key + org ID + network ID. The UI must hide IP/transport fields and show
Meraki-specific fields instead.

### 4.3 Vendor drivers

Every platform implements the same driver contract so the rest of the app stays
vendor-neutral:

```ts
interface FirewallDriver {
  testConnection(creds): Promise<ConnInfo>;        // auth check, version, model, license
  discover(): Promise<DeviceInventory>;            // read-only: interfaces, zones, routes, objects
  validate(plan: BuildPlan): Promise<Validation>;  // dry-run / candidate validation
  render(plan: BuildPlan): Promise<RenderedConfig>;// deterministic vendor-native config
  applyLive(plan: BuildPlan): Promise<ApplyResult>;// candidate + commit
  readback(): Promise<DeviceInventory>;            // post-apply verification
}
```

| Platform | API used | Live-apply model |
|---|---|---|
| Palo Alto (PAN-OS) | XML API / REST API | Candidate config → `commit` |
| Fortinet (FortiOS) | REST API (cmdb) | Direct object writes, transaction where available |
| Cisco FTD | FMC REST API (managed) or FDM REST (standalone) | Staged deploy → push |
| Cisco ASA | ASA REST API; SSH/CLI fallback | Write to running-config, copy to startup |
| Meraki MX | Dashboard API (cloud) | Direct API writes (no commit step) |

> When the app writes the actual drivers, confirm current API versions/auth
> methods per vendor before coding each one — these APIs change between releases.

### 4.4 The Intermediate Representation (IR)

The IR is a single vendor-neutral JSON description of the **desired firewall
state**: interfaces, zones, DNS/NTP, NAT rules, security/ACL rules, VPNs, NGFW
profiles, zone protection. Everything funnels through it:

- The GUI builds IR.
- The AI normaliser emits IR fragments (for imports only).
- Each driver's `render()` turns IR into vendor-native config, deterministically.

This is what makes the app "deterministic except where AI is invoked" — the AI
only ever produces IR (which a human reviews), and the IR→device path has zero AI
in it.

---

## 5. Feature specification

### 5.1 Vendor toggle
Top-level selector: Palo Alto · Fortinet · Cisco FTD · Cisco ASA · Meraki MX.
Selecting a vendor swaps the active driver and adjusts the UI (e.g. Meraki shows
API-key fields, not IP/creds).

### 5.2 Connect to target
Engineer enters target details (IP + credentials, or for Meraki an API key +
org/network). App runs `testConnection`, shows model/version/licensing.

### 5.3 Discovery (read-only scan)
Pull and display: physical/logical interfaces, existing zones, routing table,
existing objects, HA status. Persist a snapshot to R2 and D1. Take a full
running-config backup to R2 (rollback safety net).

### 5.4 Zone / interface design
Engineer chooses how many zones to create and maps them to discovered interfaces
(drag-to-map UI). Supports trust/untrust/DMZ patterns and custom zones.

### 5.5 DNS / NTP
Engineer specifies DNS servers and NTP servers; deterministic templates apply
them per vendor.

### 5.6 Imports — NAT, ACL, VPN (the only AI step)
Engineer pastes or uploads source config in **various formats** (raw vendor CLI,
another vendor's syntax, CSV, spreadsheet export, free text). The AI normaliser
converts it into IR fragments. The engineer is shown a **before/after diff** and
must accept it before it joins the plan. See §13 for the normaliser spec.

### 5.7 Boilerplate policy packs
Toggleable, deterministic, best-practice rule packs (full catalogue in §7).

### 5.8 Next-gen features
Apply IPS/IDS, anti-malware/sandboxing, URL filtering, DNS security, and
(optional) TLS decryption profiles — as deterministic best-practice profiles per
vendor.

### 5.9 Zone protection / hardening
Apply flood protection, reconnaissance protection, packet-based attack
protection, and management-plane hardening (restrict mgmt sources, disable
insecure protocols, no default creds).

### 5.10 Plan → Validate → Apply → Verify
Show the full diff, run driver validation, then apply live or export a staged
bundle, then read the device back and confirm.

---

## 6. (reserved — IR schema lives alongside the code as `schema/ir.ts`)

The IR schema is large; define it as a versioned JSON Schema + TypeScript types in
the repo. Top-level keys: `interfaces`, `zones`, `system` (dns/ntp/mgmt),
`nat`, `security` (acl/rules), `vpn`, `ngfw`, `protection`, `meta`.

---

## 7. Suggested policy-pack catalogue

Boilerplate packs the engineer can toggle on. Packs that depend on live vendor
endpoint lists (O365, Webex) should pull the current published lists at build
time rather than hard-coding IPs.

**Connectivity / productivity**
- **Outbound internet baseline** — HTTP/HTTPS/QUIC, DNS, NTP, with logging.
- **Microsoft 365 / Teams** — built from Microsoft's published O365 IP/URL
  endpoints API (Exchange, SharePoint, Teams signalling + media UDP 3478–3481).
- **Webex** — from Cisco's published Webex network requirements (media + signalling).
- **Zoom** *(suggested addition)*
- **Google Workspace / Meet** *(suggested addition)*
- **Software & OS updates** *(suggested addition)* — Windows Update, Apple, common vendor update servers.
- **Certificate validation** *(suggested addition)* — OCSP/CRL access.

**Security baseline**
- **Anti-spoofing / bogon / RFC1918 egress filtering**
- **Geo-blocking** — block high-risk source countries inbound.
- **Rogue DoH control** — block unsanctioned DNS-over-HTTPS.
- **Firewall cloud-services allow** — let the device reach its own threat/update
  clouds (PAN WildFire, FortiGuard, Cisco Talos/Threat Defense cloud).
- **Logging / SIEM egress** — syslog to a collector.
- **Internal services** — DNS, DHCP relay, NTP, AAA/RADIUS, SNMP to defined hosts.

**Access**
- **Remote-access VPN baseline** — GlobalProtect / FortiClient / AnyConnect skeleton.
- **Site-to-site VPN baseline** — strong crypto defaults, named tunnels.
- **Guest / DMZ isolation** — segment with no lateral access to trust.

**Management hardening**
- **Mgmt plane lockdown** — restrict admin access to named source subnets,
  HTTPS/SSH only, disable Telnet/HTTP, admin lockout thresholds, MFA where supported.

---

## 8. Data model

### D1 tables
- `projects` — onboarding sessions (id, name, vendor, status, created_at).
- `targets` — vendor, platform, transport type, connection metadata, last discovery snapshot ref.
- `plans` — versioned IR build plans (project_id, version, ir_json, created_at).
- `imports` — raw source text (ref to R2) + AI-normalised IR + provenance + accepted flag.
- `policy_packs` — catalogue of available packs + which are enabled per project.
- `apply_runs` — mode (live/staged), result, readback ref, started/finished timestamps.
- `audit_log` — append-only: actor, action, target, before/after refs, timestamp.

### R2 buckets / prefixes
- `backups/` — pre-change running-config snapshots.
- `imports/` — raw uploaded source configs.
- `bundles/` — generated staged config bundles for download.
- `readbacks/` — post-apply device reads.
- `reports/` — generated build reports (PDF).

### Durable Object (one per session)
- Holds: live wizard state, credentials in memory, the WSS link to a relay agent
  (if used), and a lock so a single session can't double-apply.

---

## 9. Worker API surface (sketch)

```
POST /api/session                      create onboarding session (→ DO)
POST /api/session/:id/connect          test connection / auth
POST /api/session/:id/discover         read-only inventory + backup
POST /api/session/:id/design           save zones/interfaces/dns/ntp
POST /api/session/:id/import           submit source config → AI normalise → IR diff
POST /api/session/:id/import/:i/accept accept a normalised import
POST /api/session/:id/packs            toggle policy packs
POST /api/session/:id/plan             build/refresh the IR plan + diff
POST /api/session/:id/validate         driver dry-run
POST /api/session/:id/apply            { mode: "live" | "staged" }
GET  /api/session/:id/bundle           download staged bundle
POST /api/session/:id/verify           read device back
POST /api/session/:id/rollback         re-apply pre-change backup
GET  /api/session/:id/report           generate build report
WS   /api/relay/:token                 inbound WSS from on-site relay agent
```

---

## 10. GUI / UX spec ("beautiful GUI")

A clean, dark, technical wizard. Steps along the top, big diff/preview panels,
explicit confirmation before any write.

- **Vendor toggle** — segmented control, top of screen.
- **Connect** — IP/creds (or Meraki API fields), transport selector, live status.
- **Discovery** — interface map (visual), routing/zone summary, "backup taken" badge.
- **Design** — drag zones onto interfaces; DNS/NTP inputs.
- **Imports** — paste/upload box; "Normalise with AI" button; side-by-side
  before/after diff with accept/reject.
- **Policy packs** — toggle cards with one-line descriptions of what each adds.
- **NGFW & protection** — toggle cards for IPS/malware/URL/zone-protection.
- **Plan preview** — full human-readable diff of everything about to change.
- **Apply** — mode selector (Live / Staged), big confirmation requiring a typed
  acknowledgement for live pushes.
- **Verify** — green/red readback comparison.

> Read `/mnt/skills/public/frontend-design/SKILL.md` before building the
> frontend for visual-design conventions.

---

## 11. The AI normaliser (the only AI component) — §13

**Job:** take messy source config (any format) and emit a validated IR fragment
for NAT / ACL / VPN. Nothing else.

**Hard constraints:**
- Output **must** validate against the IR JSON Schema; reject + retry if not.
- Output is always shown to the human as a before/after diff and must be accepted.
- The normaliser has no network access to firewalls and is absent from the apply path.
- Flag anything ambiguous (e.g. an `any/any` rule, an unrecognised service) for
  human attention rather than guessing silently.

**Model:** `claude-sonnet-4-6` default; escalate to `claude-opus-4-8` for large or
cross-vendor conversions. Use structured-output prompting (system prompt demands
JSON-only, no prose), then parse and schema-validate.

---

## 12. Security & access

- Cloudflare Access: allow only `stevie.johnston@gmail.com`.
- Credentials in DO memory only by default; never logged.
- VPN PSKs / shared secrets never stored in plaintext.
- Every live apply: full diff shown + typed confirmation + audit entry.
- Automatic running-config backup before any change; one-click rollback.
- Relay agent authenticates with a short-lived token; WSS only.

---

## 13. Additional features worth adding

- **Config backup + rollback** (already core, but expose clearly).
- **What-if diff** before every apply (already core).
- **Compliance score** — check the built config against CIS / vendor hardening
  benchmarks, show a score + findings.
- **Templates** — save a finished design as a reusable template for the next site.
- **HA awareness** — detect an HA pair and apply to / sync both members.
- **Export to IaC** — generate Terraform (PAN/Forti providers) or Ansible from the
  IR, so the same build is repeatable outside Bastion.
- **Build report (PDF)** — document exactly what was configured, for handover.
- **Post-build connectivity test** — confirm DNS resolves, NTP syncs, internet
  reachable, from the device's perspective.
- **Plan versioning + diff between versions.**

---

## 14. Build phases (suggested milestones)

**Phase 0 — Skeleton**
Worker + static SPA, Cloudflare Access, D1/R2/DO bindings, session DO, audit log.

**Phase 1 — One vendor, read-only**
Palo Alto driver: connect, discover, backup. No writes. Prove the transport
layer (start with Direct + Cloudflare Tunnel).

**Phase 2 — Deterministic build (PAN)**
IR schema, design UI (zones/interfaces/DNS/NTP), a couple of policy packs, plan
diff, validate, **staged** apply (download bundle). Still no live push.

**Phase 3 — Live apply + verify (PAN)**
Candidate+commit, readback, rollback. Typed confirmation gate.

**Phase 4 — AI normaliser**
Imports for NAT/ACL with schema validation + review diff. Then VPN import.

**Phase 5 — More vendors**
Fortinet, then Cisco FTD, ASA, and Meraki (Meraki UI exception).

**Phase 6 — Relay agent**
On-site agent dialling the DO over WSS for private-network targets.

**Phase 7 — Extras**
Compliance score, IaC export, HA, templates, PDF report.

---

## 15. Conventions

- TypeScript throughout. Strict mode.
- Drivers live in `src/drivers/<vendor>/` and implement `FirewallDriver`.
- Transports live in `src/transport/` (`direct`, `tunnel`, `relay`).
- IR schema is the single source of truth in `schema/ir.ts` + `schema/ir.json`.
- Never let AI output reach a driver without passing schema validation + human accept.
- Every write path goes through the audit log.
- Wrangler config (`wrangler.toml`) declares all D1/R2/DO bindings.