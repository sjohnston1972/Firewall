# Sample deployment profile — "Branch office baseline"

A realistic walk-through to test the Bastion wizard end-to-end against the lab
PA-VM (now wiped clean). Everything here is within what the wizard renders and
commits today: interfaces, default virtual-router, zones, DNS/NTP, address/service
objects, NAT, and security rules.

## 0. Connect
- **Vendor:** Palo Alto
- **Transport:** **Relay agent** — the device (`192.168.1.128`) is on a private
  LAN, so the Worker/Cloud-proxy can't reach it. Run the agent on a host on that
  subnet:
  ```
  node relay-agent.mjs --url wss://bastion.clydeford.net/api/relay/<session-id> --device https://192.168.1.128
  ```
- **Host:** `192.168.1.128`  **User:** `admin`  **Password:** `Extr748a`
- Test connection → should show **PA-VM / 11.2.5**.

## 1. Discovery
Expect 24 physical `ethernet1/x` ports (link down, unzoned), no config — clean slate.

## 2. Design
- **Hostname:** `branch-fw-01`
- **DNS:** `1.1.1.1`, `8.8.8.8`   **NTP:** `pool.ntp.org`
- **Zones → interfaces:**
  | Zone | Type | Interface |
  |---|---|---|
  | `trust` | trust | ethernet1/1 |
  | `untrust` | untrust | ethernet1/2 |
  | `dmz` | dmz | ethernet1/3 |

## 3. Import (the AI step) — paste this as **Free text**, then "Normalise with AI"
```
Branch office firewall. Zones: trust (LAN), untrust (internet/WAN), dmz.

Outbound:
- trust users browse the internet (HTTP, HTTPS, DNS) out via untrust,
  source-NAT to the WAN interface address.
- dmz hosts may reach the internet for updates (HTTP, HTTPS) via untrust, source-NAT to WAN.

Inbound:
- Publish the DMZ web server 10.10.20.10 to the internet on 203.0.113.10 port 443
  (static destination NAT). Allow HTTPS from any to the web server.

Segmentation:
- dmz must NOT be able to reach trust (deny dmz -> trust).
- explicit default deny at the end of the rulebase, with logging.

Objects:
- web-server = 10.10.20.10
- web-server-public = 203.0.113.10
- trust-net = 10.10.10.0/24
- dmz-net = 10.10.20.0/24
```
Review the before/after diff — you should get address/service objects, a source
NAT, a static DNAT, the inbound HTTPS allow, the dmz→trust deny, and a default
deny. **Accept** it. (Expect a couple of advisory warnings — the SNAT "translated
to WAN interface IP" assumption, and the any/any default-deny flagged per policy.)

## 4. Policy packs
Toggle on:
- **Outbound internet baseline** (trust→untrust web/dns/ntp + logging)
- **Mgmt plane lockdown**

(Optional: Geo-blocking, Anti-spoofing/bogon.)

## 5. NGFW & hardening
Leave the defaults (IPS, anti-malware, URL filtering on) — these ride along in the
plan.

## 6. Plan
Review the change set — interfaces (eth1/1–1/3), default VR, the 3 zones, DNS/NTP,
the imported objects/NAT/rules, plus the pack rules. No "no virtual-router" warning
(the default VR is added automatically).

## 7. Apply — try all three modes
1. **Staged** → download the PAN-OS `set` bundle and eyeball it.
2. **Push** → writes the candidate config via API; then open the firewall GUI and
   you'll see it pending — commit it yourself.
3. **Push & Commit** → type the ack phrase (`branch-fw-01`) and commit via the API.
   Watch the result panel for the commit job id + "Committed".

## 8. Verify
Read the device back — zones/interfaces should show present/green.

---
*Tip: to reset between runs, the device can be wiped to this clean baseline again
(delete the config subtrees + restore an empty `<ethernet/>` + commit).*
