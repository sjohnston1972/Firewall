# PAN-OS feature deployment — verified config-API templates

Every template below was **validated and committed against a live PA-VM (11.2.5)**
via the config API (`type=config&action=set`) + `type=commit`. A comprehensive
profile combining **all** of them committed with `result=OK`. These are the
working XML shapes to feed Bastion's renderer when these features get IR support.

Push mechanism (the one that works — `<set><cli>` does NOT):
```
POST /api/  body: type=config&action=set&xpath=<XPATH>&element=<ELEMENT>&key=<KEY>
then        type=commit&cmd=<commit></commit>
```
`D = /config/devices/entry[@name='localhost.localdomain']`,
`V = ${D}/vsys/entry[@name='vsys1']`, `VR = ${D}/network/virtual-router/entry[@name='default']`.

| Feature | Status | Notes |
|---|---|---|
| interfaces (L3) | ✅ | `${D}/network/interface/ethernet` |
| default virtual-router | ✅ | bind every L3 iface; removes "no virtual-router" warning |
| zones | ✅ | every L3/tunnel/vlan iface needs a zone or commit warns |
| address / service objects | ✅ | |
| security rules | ✅ | `application-default` for allow; `any` service alone for deny |
| NAT (source/dest/static) | ✅ | |
| DHCP server | ✅ | `${D}/network/dhcp/interface` |
| VLAN (iface + object) | ✅ | vlan.N needs VR + zone |
| virtual-wire | ✅ | member ports must be `<virtual-wire/>` mode |
| DNS proxy | ✅ | |
| LLDP | ✅ | global `<enable>yes</enable>` at `${D}/network/lldp` (not `<enabled>`) |
| zone-protection | ✅ | profile + attach to zone |
| OSPF | ✅ | under `${VR}/protocol/ospf`, needs router-id |
| BGP | ✅ | needs router-id + local-as |
| BFD | ✅ | `${D}/network/routing-profile/bfd` |
| GRE | ✅ | tunnel.N needs IP + VR + zone; `local-address` = interface + ip |
| IPSec/IKE VPN | ✅ | ike+ipsec crypto profiles, ike gateway, ipsec tunnel, tunnel.N in VR+zone |
| QoS | ✅ | put on an interface that does **not** carry tunnels (tunnels need a tunnel QoS member profile) |
| app-override | ✅ | `<port>` is a single value, not `<member>` |
| decryption | ✅ | rule requires a `<type>` (e.g. `<ssl-forward-proxy/>`) |
| tunnel-inspect | ✅ | requires `<application><member>gre</member></application>` (not `any`) |
| DoS protection | ✅ | profile under `${V}/profiles/dos-protection` + rule |
| PBF | ✅ | `from/zone`, action `forward` egress-interface |
| GlobalProtect | ⚠️ needs prereq | requires an imported certificate + SSL/TLS service profile (+ auth profile); cannot commit with a placeholder cert |

## Templates

### Interfaces + default VR + zones
```xml
xpath: ${D}/network/interface/ethernet
<entry name="ethernet1/1"><layer3><ip><entry name="10.1.0.1/24"/></ip></layer3></entry>
<entry name="ethernet1/4"><virtual-wire/></entry>

xpath: ${D}/network/virtual-router
<entry name="default"><interface><member>ethernet1/1</member><member>tunnel.1</member></interface></entry>

xpath: ${V}/zone
<entry name="trust"><network><layer3><member>ethernet1/1</member></layer3></network></entry>
```

### DHCP server
```xml
xpath: ${D}/network/dhcp/interface
<entry name="ethernet1/3"><server><mode>enabled</mode><ip-pool><member>10.3.0.100-10.3.0.200</member></ip-pool><option><gateway>10.3.0.1</gateway><subnet-mask>255.255.255.0</subnet-mask></option></server></entry>
```

### VLAN
```xml
xpath: ${D}/network/interface/vlan/units   ->  <entry name="vlan.1"><ip><entry name="10.9.0.1/24"/></ip></entry>
xpath: ${D}/network/vlan                    ->  <entry name="vlan1"><virtual-interface><interface>vlan.1</interface></virtual-interface></entry>
(then add vlan.1 to VR + a zone)
```

### Virtual wire
```xml
xpath: ${D}/network/virtual-wire
<entry name="vw1"><interface1>ethernet1/4</interface1><interface2>ethernet1/5</interface2></entry>
```

### DNS proxy
```xml
xpath: ${D}/network/dns-proxy
<entry name="dnsproxy1"><enabled>yes</enabled><interface><member>ethernet1/1</member></interface><default><primary>1.1.1.1</primary><secondary>8.8.8.8</secondary></default></entry>
```

### LLDP
```xml
xpath: ${D}/network/lldp   ->  <enable>yes</enable>
```

### Zone protection
```xml
xpath: ${D}/network/profiles/zone-protection-profile
<entry name="zp1"><flood><tcp-syn><enable>yes</enable></tcp-syn></flood></entry>
(attach: zone ... <network><layer3>...<zone-protection-profile>zp1</zone-protection-profile></network>)
```

### OSPF / BGP / BFD
```xml
xpath: ${VR}/protocol/ospf
<enable>yes</enable><router-id>1.1.1.1</router-id><area><entry name="0.0.0.0"><type><normal/></type><interface><entry name="ethernet1/1"><enable>yes</enable></entry></interface></entry></area>

xpath: ${VR}/protocol/bgp
<enable>yes</enable><router-id>1.1.1.2</router-id><local-as>65001</local-as>

xpath: ${D}/network/routing-profile/bfd
<entry name="bfd1"><mode>active</mode></entry>
```

### GRE
```xml
xpath: ${D}/network/interface/tunnel/units  -> <entry name="tunnel.1"><ip><entry name="10.255.255.1/30"/></ip></entry>
xpath: ${D}/network/tunnel/gre
<entry name="gre1"><local-address><interface>ethernet1/2</interface><ip>10.2.0.1/24</ip></local-address><peer-address><ip>203.0.113.9</ip></peer-address><tunnel-interface>tunnel.1</tunnel-interface><ttl>64</ttl></entry>
(tunnel.1 in VR + zone)
```

### IPSec / IKE site-to-site VPN
```xml
${D}/network/ike/crypto-profiles/ike-crypto-profiles
  <entry name="ike-cp"><hash><member>sha256</member></hash><dh-group><member>group14</member></dh-group><encryption><member>aes-256-cbc</member></encryption><lifetime><hours>8</hours></lifetime></entry>
${D}/network/ike/crypto-profiles/ipsec-crypto-profiles
  <entry name="ipsec-cp"><esp><authentication><member>sha256</member></authentication><encryption><member>aes-256-cbc</member></encryption></esp><lifetime><hours>1</hours></lifetime></entry>
${D}/network/ike/gateway
  <entry name="ike-gw"><authentication><pre-shared-key><key>***</key></pre-shared-key></authentication><protocol><ikev2><ike-crypto-profile>ike-cp</ike-crypto-profile></ikev2><version>ikev2</version></protocol><local-address><interface>ethernet1/2</interface></local-address><peer-address><ip>203.0.113.50</ip></peer-address></entry>
${D}/network/tunnel/ipsec
  <entry name="ipsec-tun"><auto-key><ike-gateway><entry name="ike-gw"/></ike-gateway><ipsec-crypto-profile>ipsec-cp</ipsec-crypto-profile></auto-key><tunnel-interface>tunnel.2</tunnel-interface></entry>
(tunnel.2 in VR + zone)
```

### QoS
```xml
${D}/network/qos/profile    -> <entry name="qos1"><class-bandwidth-type><mbps><class><entry name="class1"><priority>high</priority></entry></class></mbps></class-bandwidth-type></entry>
${D}/network/qos/interface  -> <entry name="ethernet1/3"><interface-bandwidth><egress-max>1000</egress-max></interface-bandwidth><regular-traffic><default-group><qos-profile>qos1</qos-profile></default-group></regular-traffic></entry>
# NOTE: do not put QoS on an interface that carries GRE/IPSec tunnels unless you also add a tunnel QoS member profile.
```

### Policy rulebases
```xml
${V}/rulebase/pbf/rules
  <entry name="pbf1"><from><zone><member>trust</member></zone></from><source><member>any</member></source><destination><member>any</member></destination><service><member>any</member></service><application><member>any</member></application><action><forward><egress-interface>ethernet1/2</egress-interface></forward></action></entry>
${V}/rulebase/decryption/rules
  <entry name="dec1">...<type><ssl-forward-proxy/></type><action>no-decrypt</action></entry>
${V}/rulebase/application-override/rules
  <entry name="ao1">...<protocol>tcp</protocol><port>8080</port><application>web-browsing</application></entry>
${V}/rulebase/tunnel-inspect/rules
  <entry name="ti1">...<application><member>gre</member></application></entry>
${V}/profiles/dos-protection   -> <entry name="dos1"><type>aggregate</type><flood><tcp-syn><enable>yes</enable></tcp-syn></flood></entry>
${V}/rulebase/dos/rules        -> <entry name="dosrule1"><from><zone><member>untrust</member></zone></from>...<action><protect/></action><protection><aggregate><profile>dos1</profile></aggregate></protection></entry>
```

---

## Hardening + NGFW (verified committed on PA-VM 11.2; now in the live renderer)

These are emitted by `renderPanosElements` automatically for every project.

**NGFW — baked into every allow rule.** A profile-group `bastion-ngfw` is built
from the IR's NGFW toggles (defaults to a baseline when none set) using PAN
predefined profiles, and attached to each `allow` rule via `<profile-setting>`:
```
${V}/profile-group  ->  <entry name="bastion-ngfw">
  <virus><member>default</member></virus>            (antiMalware)
  <spyware><member>strict</member></spyware>         (dnsSecurity / anti-spyware)
  <vulnerability><member>strict</member></vulnerability>  (ips)
  <url-filtering><member>default</member></url-filtering>  (urlFiltering)
  <wildfire-analysis><member>default</member></wildfire-analysis>  (sandboxing)
</entry>
# each allow rule: <profile-setting><group><member>bastion-ngfw</member></group></profile-setting>
```

**Management-plane hardening** (`system.management`):
```
${D}/deviceconfig/system/service       -> <disable-telnet>yes</disable-telnet><disable-http>yes</disable-http><disable-https>no</disable-https><disable-ssh>no</disable-ssh>
${D}/deviceconfig/system/permitted-ip  -> <entry name="10.0.0.0/8"/> ...   (CAUTION: must include the mgmt source)
${D}/deviceconfig/setting/management   -> <admin-lockout><failed-attempts>5</failed-attempts><lockout-time>30</lockout-time></admin-lockout>
```

**Zone protection** (`protection`) — profile attached to zones:
```
${D}/network/profiles/zone-protection-profile -> <entry name="bastion-zp">
  <flood><tcp-syn><enable>yes</enable></tcp-syn><udp><enable>yes</enable></udp><icmp><enable>yes</enable></icmp><icmpv6><enable>yes</enable></icmpv6><other-ip><enable>yes</enable></other-ip></flood>
  <discard-overlapping-tcp-segment-mismatch>yes</discard-overlapping-tcp-segment-mismatch><discard-malformed-option>yes</discard-malformed-option>
</entry>
# zone network: <zone-protection-profile>bastion-zp</zone-protection-profile>
```
Notes: reconnaissance (`scan`) section has a finicky schema — shipped flood +
packet-based (covers floodProtection + packetBasedAttackProtection). TLS
decryption needs an imported forward-trust certificate (like GlobalProtect), so
it's not auto-rendered. App-IDs and zone references are validated against the
device on apply; invalid ones are mapped or skipped with a flag rather than
failing the commit.
