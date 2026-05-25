# Enrichment Bench — Ollama Cloud comparison

Models tested: `deepseek-v4-flash:cloud`, `deepseek-v4-pro:cloud`, `nemotron-3-super:cloud`, `qwen3.5:cloud`

Tabs tested (5):
- **Jolene** — Dolly Parton — Jolene (ver 2)  (id `dolly-parton__jolene-ver-2`)
- **Tecumseh Valley** — Nanci Griffith — Tecumseh Valley  (id `nanci-griffith__tecumseh-valley`)
- **Let Her Go** — Passenger — Let Her Go  (id `passenger__let-her-go`)
- **Hallelujah** — Jeff Buckley — Hallelujah (ver 2)  (id `jeff-buckley__hallelujah-ver-2`)
- **Lady In Black** — Uriah Heep — Lady In Black  (id `uriah-heep__lady-in-black`)

## Per-tab results

### Jolene — Dolly Parton

| Model | parse | latency | tokens (in/out) | kp hit/total | language | themes | key_phrases (first 2) |
|---|---|---|---|---|---|---|---|
| `deepseek-v4-flash:cloud` | ✓ | 9.3s | 807/642 | 8/8 | english | love, heartbreak, jealousy | _Jolene, Jolene, Jolene, Jolene_ / _I'm begging of you, please don't take my man_ |
| `deepseek-v4-pro:cloud` | ✓ | 8.4s | 807/568 | 5/5 | english | love, jealousy, desperation | _please don't take my man_ / _flaming locks of auburn hair_ |
| `nemotron-3-super:cloud` | ✓ | 8.9s | 874/1288 | 5/5 | english | love, heartbreak, obsession | _Jolene, Jolene, Jolene, Jolene_ / _I'm begging of you, please don't take my man_ |
| `qwen3.5:cloud` | ✓ | 36.9s | 865/3263 | 5/5 | english | love, jealousy, heartbreak | _Jolene, Jolene, Jolene, Jolene_ / _please don't take my man_ |

### Tecumseh Valley — Nanci Griffith

| Model | parse | latency | tokens (in/out) | kp hit/total | language | themes | key_phrases (first 2) |
|---|---|---|---|---|---|---|---|
| `deepseek-v4-flash:cloud` | ✓ | 4.1s | 766/546 | 5/5 | english | loss, childhood, poverty | _The name she gave was Caroline_ / _Daughter of a miner_ |
| `deepseek-v4-pro:cloud` | ✓ | 12.1s | 766/821 | 3/4 | english | mining, hardship, nature | _The name she gave was Caroline_ / _Daughter of a miner_ |
| `nemotron-3-super:cloud` | ✓ | 7.4s | 823/1191 | 5/5 | english | nostalgia, longing, rural life | _The name she gave was Caroline_ / _Daughter of a miner_ |
| `qwen3.5:cloud` | ✓ | 56.8s | 806/4500 | 5/5 | english | folk, country, storytelling | _The name she gave was Caroline_ / _Daughter of a miner_ |

### Let Her Go — Passenger

| Model | parse | latency | tokens (in/out) | kp hit/total | language | themes | key_phrases (first 2) |
|---|---|---|---|---|---|---|---|
| `deepseek-v4-flash:cloud` | ✓ | 12.1s | 735/1067 | 0/3 | english | love, loss, regret | _Only know you love her when you let her go_ / _Staring at the bottom of your glass_ |
| `deepseek-v4-pro:cloud` | ✓ | 17.0s | 735/1226 | 0/0 | english | heartbreak, loss, love | — |
| `nemotron-3-super:cloud` | ✓ | 12.9s | 825/1729 | 3/3 | english | love, heartbreak, reflection | _Repeat from this point_ / _[tab][Intro]_ |
| `qwen3.5:cloud` | ✓ | 44.5s | 769/6529 | 0/0 | english | love, loss, regret | — |

### Hallelujah — Jeff Buckley

| Model | parse | latency | tokens (in/out) | kp hit/total | language | themes | key_phrases (first 2) |
|---|---|---|---|---|---|---|---|
| `deepseek-v4-flash:cloud` | ✓ | 3.4s | 843/462 | 4/4 | english | love, faith, heartbreak | _I heard there was a secret chord_ / _the baffled king composing hallelujah_ |
| `deepseek-v4-pro:cloud` | ✓ | 17.0s | 843/1134 | 3/3 | english | love, heartbreak, faith | _I heard there was a secret chord_ / _the minor fall and the major lift_ |
| `nemotron-3-super:cloud` | ✓ | 6.6s | 906/2337 | 7/7 | mixed | love, heartbreak, faith | _I heard there was a secret chord_ / _That David played and it pleased the Lord_ |
| `qwen3.5:cloud` | ✓ | 30.4s | 882/4210 | 4/4 | english | faith, love, music | _I heard there was a secret chord_ / _That David played and it pleased the Lord_ |

### Lady In Black — Uriah Heep

| Model | parse | latency | tokens (in/out) | kp hit/total | language | themes | key_phrases (first 2) |
|---|---|---|---|---|---|---|---|
| `deepseek-v4-flash:cloud` | ✓ | 4.6s | 792/635 | 5/5 | english | redemption, war, peace | _She came to me one morning_ / _Her long hair flowing in the midwinter wind_ |
| `deepseek-v4-pro:cloud` | ✓ | 20.6s | 792/1427 | 4/5 | english | loneliness, inner struggle, hope | _She came to me one morning, one lonely Sunday morning_ / _Her long hair flowing in the midwinter wind_ |
| `nemotron-3-super:cloud` | ✓ | 6.2s | 847/1845 | 4/4 | english | mystery, guidance, war | _She came to me one morning, one lonely Sunday morning_ / _Her long hair flowing in the midwinter wind_ |
| `qwen3.5:cloud` | ✓ | 50.2s | 830/5330 | 5/5 | english | war, peace, spirituality | _She came to me one morning_ / _one lonely Sunday morning_ |

## Aggregate (across all tabs)

| Model | parse rate | mean latency | mean tokens out | mean kp hit-rate |
|---|---|---|---|---|
| `deepseek-v4-flash:cloud` | 5/5 (100%) | 6.7s | 670 | 80% |
| `deepseek-v4-pro:cloud` | 5/5 (100%) | 15.0s | 1035 | 91% |
| `nemotron-3-super:cloud` | 5/5 (100%) | 8.4s | 1678 | 100% |
| `qwen3.5:cloud` | 5/5 (100%) | 43.7s | 4766 | 100% |

**Read this table as**: parse-rate is the first quality gate (must be ~100%); key_phrases hit-rate is the hallucination signal (lower = more invented quotes); latency matters most for batch enrichment of large UG imports.