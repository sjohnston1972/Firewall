# Bastion build report — branch-fw-01

- Vendor: panos
- Result: ✅ committed without errors
- Generated: 2026-06-22T08:42:21.288Z

## Zones, interfaces & addressing
- ✓ **trust → ae1** — trust zone, 10.10.10.1/24 · LACP bundle of 2 ports (ethernet1/1, ethernet1/2) · DHCP server 10.10.10.100-10.10.10.200
- ✓ **untrust → ethernet1/3** — untrust zone, 213.12.12.1/24
- ✓ **dmz → ethernet1/4** — dmz zone, 10.10.20.1/24 · DHCP server 10.10.20.100-10.10.20.200
- ✓ **guest → ethernet1/5** — guest zone, 192.168.10.1/24 · DHCP server 192.168.10.100-192.168.10.200

## NAT
- ✓ **trust-internet-snat** — source-NAT trust→untrust to egress interface address
- ✓ **dmz-internet-snat** — source-NAT dmz→untrust to egress interface address
- ✓ **guest-internet-snat** — source-NAT guest→untrust to 213.12.12.7
- ✓ **web-server-dnat** — static/dest-NAT web-server-public → 10.10.20.10:443

## Security policy & segmentation
- ✓ **Security rules** — 22 rules (13 allow, 9 deny/drop)
- ✓ **NGFW inspection on allow rules** — profile-group "bastion-ngfw" attached to every allow rule
- ✓ **deny-dmz-to-trust** — deny dmz→trust (logged)
- ✓ **deny-guest-to-trust-dmz** — deny guest→trust,dmz (logged)
- ✓ **default-deny** — deny any→any (logged)
- ✓ **deny-rfc1918-egress** — deny trust→untrust (logged)
- ✓ **geo-block-inbound** — drop untrust→trust,dmz (logged)
- ✓ **block-rogue-doh** — deny trust→untrust (logged)
- ✓ **guest-deny-to-trust** — deny guest→trust (logged)
- ✓ **dmz-deny-to-trust** — deny dmz→trust (logged)
- ✓ **mgmt-deny-untrust** — drop untrust→trust (logged)

## Routing
- ✓ **print-server** — 172.16.12.1/32 via 10.10.10.20
- ✓ **default-route** — 0.0.0.0/0 via 213.12.12.254
- ✓ **VPN-route1** — 10.220.12.0/24 via tunnel.1
- ✓ **VPN-route2** — 10.220.14.0/24 via tunnel.1

## VPN
- ⚠ (placeholder) **branch-tunnel (IPSec site-to-site)** — IKE/IPSec crypto + IKE gateway + IPSec tunnel; peer 198.51.100.1 [PLACEHOLDER]
- ⚠ (placeholder) **s2s-baseline (IPSec site-to-site)** — IKE/IPSec crypto + IKE gateway + IPSec tunnel; peer 203.0.113.50 [PLACEHOLDER]
- ⚠ (placeholder) **ra-baseline (GlobalProtect remote-access)** — GP gateway + portal, ssl-tls profile, local-database auth [self-signed cert + placeholder user]

## DHCP services
- ✓ **ae1** — pool 10.10.10.100-10.10.10.200, gateway 10.10.10.1
- ✓ **ethernet1/4** — pool 10.10.20.100-10.10.20.200, gateway 10.10.20.1
- ✓ **ethernet1/5** — pool 192.168.10.100-192.168.10.200, gateway 192.168.10.1

## NGFW & hardening
- ✓ **IPS / vulnerability protection** — predefined strict vulnerability profile
- ✓ **Anti-malware / antivirus** — predefined virus profile
- ✓ **URL filtering** — predefined url-filtering profile
- ✓ **DNS security / anti-spyware** — predefined strict anti-spyware profile
- ✓ **Sandboxing (WildFire)** — predefined wildfire-analysis profile
- → (follow-up) **TLS decryption** — not enabled — requires a forward-trust certificate
- ✓ **Zone protection** — profile "bastion-zp" attached to zones (flood ✓, packet-based attack ✓, reconnaissance ✓, anti-spoofing ✓)

## Coloured tags
- ✓ **trust** — zone tag — green; applied to every policy that uses this zone
- ✓ **untrust** — zone tag — red; applied to every policy that uses this zone
- ✓ **dmz** — zone tag — orange; applied to every policy that uses this zone
- ✓ **guest** — zone tag — yellow; applied to every policy that uses this zone
- ✓ **web-tier** — custom keyword tag (auto-coloured)
- ✓ **vpn** — zone tag — purple

## Policy packs
- ✓ **Outbound internet baseline** — Allow trust→untrust web, DNS and NTP (HTTP/HTTPS/QUIC) with logging.
- ✓ **Microsoft 365 / Teams** — Allow Exchange, SharePoint and Teams (signalling + media UDP 3478-3481).
- ✓ **Webex** — Allow Webex media + signalling per Cisco's published requirements.
- ✓ **Certificate validation (OCSP/CRL)** — Allow outbound OCSP/CRL so certificate revocation checks succeed.
- ✓ **Anti-spoofing / bogon filtering** — Enable anti-spoofing + bogon filtering and drop RFC1918 egress.
- ✓ **Geo-blocking (high-risk countries)** — Block inbound traffic from a sample set of high-risk source countries.
- ✓ **Rogue DoH control** — Block unsanctioned DNS-over-HTTPS/TLS to known public resolvers.
- ✓ **Firewall cloud-services allow** — Let the device reach its own threat/update clouds (WildFire/FortiGuard/Talos).
- ✓ **Logging / SIEM egress** — Allow syslog to a defined collector (UDP 514 / TLS 6514) with logging.
- ✓ **Site-to-site VPN baseline** — Skeleton site-to-site tunnel with strong IKEv2 crypto defaults.
- ✓ **Remote-access VPN baseline** — GlobalProtect/FortiClient/AnyConnect skeleton with strong crypto.
- ✓ **Guest / DMZ isolation** — Segment guest/DMZ so they cannot move laterally into trust.
- ✓ **Management plane lockdown** — Restrict admin to named subnets, HTTPS/SSH only, disable Telnet/HTTP.

## Placeholder values used
- VPN "branch-tunnel": placeholder peer 198.51.100.1 + placeholder PSK
- VPN "s2s-baseline": placeholder peer 203.0.113.50 + placeholder PSK
- GlobalProtect "ra-baseline": self-signed cert (bastion-gp) + local user vpnuser / BastionGP-ChangeMe1!

## Follow-up configuration needed
- VPN "branch-tunnel": set the real peer address and pre-shared key.
- VPN "s2s-baseline": set the real peer address and pre-shared key.
- GlobalProtect "ra-baseline": install a real server certificate and configure real authentication (replace the placeholder local user).
- TLS decryption: import a forward-trust certificate, then enable it.
- Management access is restricted to RFC1918 sources — narrow this to your real admin subnet(s).
