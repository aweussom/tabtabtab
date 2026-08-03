---
name: never-whois-domain-search
description: "NEVER run a WHOIS lookup (or any external domain-availability search) on a domain Tommy is considering. Front-running risk — the searched name can get snapped up. Only check availability inside the registrar console, logged in, card ready."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 34184579-7cd2-477b-b7a4-f4f76345762b
---

Never run a WHOIS query — or any external/CLI domain-availability lookup — on a domain name Tommy is considering registering. Do not offer to, either.

**Why:** domain front-running. A WHOIS (or some registrar search boxes) can leak the searched name to actors who then register it before the user can, so the user loses the name they wanted. Tommy treats this as a hard rule: the only safe place to check availability is inside the DNS-seller's own console, logged in, with the credit card ready to register on the spot.

**How to apply:** when a domain name comes up (brainstorming product names, picking a host, etc.), suggest names freely — but never verify availability via WHOIS, `whois`, `dig` against a registry, web availability-checkers, or WebFetch to a "is this domain free" service. If the user wants to know whether a name is free, point them to do it themselves in their registrar console. Tommy already owns `nollama.no` and registers his own domains, so he knows the drill — just hand him the candidate names and let him check + buy in one motion.
