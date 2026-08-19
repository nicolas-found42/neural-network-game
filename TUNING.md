# TUNING.md — autonomous-retuning changelog

Append-only log of every parameter change made autonomously during the Phase 2
tuning loop. Fitness magnitudes and NEAT rates were frozen through Phase 1;
entries below start from there. Operator evidence: `node dev/evolve.mjs --seed S
--gens 40` gate lines (and the browser console, same format).

Entry format:

    date | gen | param old->new | trigger evidence (gate/console) | observed effect
