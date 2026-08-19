# TUNING.md — autonomous-retuning changelog

Append-only log of every parameter change made autonomously during the Phase 2
tuning loop. Fitness magnitudes and NEAT rates were frozen through Phase 1;
entries below start from there. Operator evidence: `node dev/evolve.mjs --seed S
--gens 40` gate lines (and the browser console, same format).

Entry format:

    date | gen | param old->new | trigger evidence (gate/console) | observed effect

## Sessions

2026-08-19 | seeds 11, 23, 42 · 40 gens headless each | no param changes (gate never tripped) | gate max 3/15 on all seeds; best AT 118-126s, pts 5940-6940, wave 2 by gen 29-40; seed 23 browser run continued to gen 211 unprompted: gate 6/15 max, best fitness 14771.6 (gen 192) | exit criteria met, no retune applied

Bar confirmation (in-page probe, champions evaluated on 12 never-seen layouts,
vs a gen-1 random brain): median alive-time 31.6-60s vs 16.4s random (dodging);
median rock points 800-2400 vs 660, seed-42 gen-15 peak 5940 pts with a wave-1
clear (aiming). Per-shot alignment selectivity at gen ~20 is weak (fire-error
~80-100°); clearing comes from sustained survive-and-shoot volume. Noted:
seed-23 gen-192 champion generalizes worse to fresh layouts (med pts 1300) than
mid-run champions — late-run overfitting to training layouts is visible.

Exit seeds recorded: 11, 23, 42. Exported champion: `champions/42-g29-2026-08-19.json`
(fitness 9010.9, best-through-gen-40 of seed 42; fresh-layout medAT 60s,
medPts 2200, maxWave 1).
