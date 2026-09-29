# Bench catalysts

Five real defects found while building this harness, kept as a regression set for
`palimpsest bench tests/fixtures/catalysts`.

They are real rather than synthetic on purpose: each one is a case where a
plausible-looking thing was wrong, and a trainer that digests them properly
should find the actual shape of the error rather than restating it.

The full phase-1 run uses ten catalysts — these five plus extracts from your own
repos (`mysterium` vision and first-principles docs, `mindstrata` and
`holosim-infinite` READMEs, and the atlas `_build/plan.md` audit log). Those are
not copied in here: they already live in their source repos, and duplicating them
would let the copies drift from the originals.
