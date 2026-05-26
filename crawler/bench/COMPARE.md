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
| `deepseek-v4-flash:cloud` | ✓ | 10.5s | 1762/1428 | 5/5 | english | love, heartbreak, jealousy | _I'm begging of you, please don't take my man_ / _Please don't take him just because you can_ |
| `deepseek-v4-pro:cloud` | ✓ | 48.9s | 1762/2939 | 5/5 | english | love, jealousy, pleading | _I'm begging of you, please don't take my man_ / _Your beauty is beyond compare_ |
| `nemotron-3-super:cloud` | ✓ | 14.5s | 1906/1837 | 5/5 | english | love, heartbreak, jealousy | _Jolene, Jolene, Jolene, Jolene_ / _I'm begging of you, please don't take my man_ |
| `qwen3.5:cloud` | ✓ | 102.0s | 1875/7289 | 4/4 | english | love, jealousy, heartbreak | _Jolene, Jolene, Jolene, Jolene_ / _please don't take my man_ |

### Tecumseh Valley — Nanci Griffith

| Model | parse | latency | tokens (in/out) | kp hit/total | language | themes | key_phrases (first 2) |
|---|---|---|---|---|---|---|---|
| `deepseek-v4-flash:cloud` | ✓ | 37.9s | 1229/4253 | 5/5 | english | tragedy, poverty, prostitution | _The name she gave was Caroline_ / _Fare thee well, Tecumseh Valley_ |
| `deepseek-v4-pro:cloud` | ✓ | 47.7s | 1229/3774 | 5/5 | english | poverty, hardship, loss of innocence | _The name she gave was Caroline_ / _Daughter of a miner_ |
| `nemotron-3-super:cloud` | ✓ | 70.1s | 1292/7565 | 4/4 | english | hardship, poverty, loss | _The name she gave was Caroline_ / _She saved enough to get back home_ |
| `qwen3.5:cloud` | ✓ | 130.0s | 1263/10405 | 5/5 | english | tragedy, prostitution, mining | _The name she gave was Caroline_ / _Daughter of a miner_ |

### Let Her Go — Passenger

| Model | parse | latency | tokens (in/out) | kp hit/total | language | themes | key_phrases (first 2) |
|---|---|---|---|---|---|---|---|
| `deepseek-v4-flash:cloud` | ✓ | 108.4s | 2645/8268 | 5/5 | english | love, heartbreak, loss | _Only need the light when it's burning low_ / _Only miss the sun when it starts to snow_ |
| `deepseek-v4-pro:cloud` | ✓ | 116.1s | 2645/6048 | 5/5 | english | love, loss, regret | _Only know you love her when you let her go_ / _Only miss the sun when it starts to snow_ |
| `nemotron-3-super:cloud` | ✓ | 93.6s | 2903/9731 | 5/5 | english | love, heartbreak, loss | _Only know you love her when you let her go_ / _Only miss the sun when it starts to snow_ |
| `qwen3.5:cloud` | ✓ | 262.6s | 2773/10493 | 5/5 | english | love, heartbreak, loss | _Only know you love her when you let her go_ / _Only miss the sun when it starts to snow_ |

### Hallelujah — Jeff Buckley

| Model | parse | latency | tokens (in/out) | kp hit/total | language | themes | key_phrases (first 2) |
|---|---|---|---|---|---|---|---|
| `deepseek-v4-flash:cloud` | ✓ | 8.9s | 2551/1713 | 3/3 | english | love, heartbreak, faith | _the baffled king composing hallelujah_ / _love is not a victory march_ |
| `deepseek-v4-pro:cloud` | ✓ | 22.4s | 2551/1252 | 3/5 | english | love, faith, heartbreak | _the fourth, the fifth, the minor fall and the major lift_ / _the baffled king composing hallelujah_ |
| `nemotron-3-super:cloud` | ✓ | 17.8s | 2768/2743 | 5/5 | english | love, heartbreak, faith | _I heard there was a secret chord_ / _That David played and it pleased the Lord_ |
| `qwen3.5:cloud` | ✓ | 187.5s | 2649/7059 | 5/5 | english | love, faith, heartbreak | _I heard there was a secret chord_ / _The baffled king composing hallelujah_ |

### Lady In Black — Uriah Heep

| Model | parse | latency | tokens (in/out) | kp hit/total | language | themes | key_phrases (first 2) |
|---|---|---|---|---|---|---|---|
| `deepseek-v4-flash:cloud` | ✓ | 8.2s | 2436/854 | 4/4 | english | war, peace, faith | _She came to me one morning_ / _Have faith and trust in peace_ |
| `deepseek-v4-pro:cloud` | ✓ | 14.8s | 2436/1019 | 4/4 | english | mysticism, guidance, peace | _She came to me one morning, one lonely Sunday morning_ / _Her long hair flowing in the midwinter wind_ |
| `nemotron-3-super:cloud` | ✓ | 42.1s | 2600/4606 | 5/5 | english | war, peace, mother | _She came to me one morning, one lonely Sunday morning_ / _Her long hair flowing in the midwinter wind_ |
| `qwen3.5:cloud` | ✓ | 62.9s | 2485/5792 | 5/5 | english | war, peace, guidance | _She came to me one morning_ / _Her long hair flowing in the midwinter wind_ |

## Aggregate (across all tabs)

| Model | parse rate | mean latency | mean tokens out | mean kp hit-rate |
|---|---|---|---|---|
| `deepseek-v4-flash:cloud` | 5/5 (100%) | 34.8s | 3303 | 100% |
| `deepseek-v4-pro:cloud` | 5/5 (100%) | 50.0s | 3006 | 92% |
| `nemotron-3-super:cloud` | 5/5 (100%) | 47.6s | 5296 | 100% |
| `qwen3.5:cloud` | 5/5 (100%) | 149.0s | 8208 | 100% |

**Read this table as**: parse-rate is the first quality gate (must be ~100%); key_phrases hit-rate is the hallucination signal (lower = more invented quotes); latency matters most for batch enrichment of large UG imports.