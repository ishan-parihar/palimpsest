# Digestion protocol

Loaded when the user brings **catalyst**: a document, a thread, a transcript, a
paper, a failure, a decision they are sitting with. Not when they ask a question
about a framework — that is a different move (routing, see root `SKILL.md`).

The aim is not to summarise the catalyst. It is to find where it collides with
what the user already holds, because that collision is the only thing that
grows the topology.

## Procedure

### 1. Bind the catalyst

State in one line what kind of thing this is and what it actually asserts. Name
the claim underneath the content. A catalyst without a claim cannot be digested.

If the catalyst is ambiguous, do not ask. Take the strongest reading available
and mark which reading you took: `reading: <the reading>`. Getting it wrong is
informative.

### 2. Map the full contact surface

Width here is the point. Find **every** atlas node the catalyst actually
touches — across all 10 clusters, not one family. A catalyst that seems to be
about pricing usually also touches incentives, time, and network topology.

Emit as `[TOUCH]` with a node per line and the move that node makes relevant.

Do not cap this at three. The cap applies to the final claim, not to the map.

### 3. Trace the lattice

The 32 primitives are the connective tissue. For each adjacent pair in the
contact surface, name the primitive that links them. This is the propagation
step and it is where the exponential lives: N connected nodes process a catalyst
in ways a flat list cannot.

Emit as `[PROPAGATE]` with `node A --primitive--> node B` lines. If you cannot
name a primitive, the two nodes are not actually connected. Say so.

### 4. Find the contradictions

This is the load-bearing step and the one most likely to be faked. Ask: **what
does this catalyst break in what the user already holds?**

A catalyst that contradicts nothing has either been misread or does not matter.

Emit each as `[CONTRADICTION]` with: the held belief, the part that breaks it,
and the evidence that does the breaking.

If you find none, emit `none` — and name the weakest thing the catalyst does
disturb. "Nothing here moves anything" is a legitimate and useful finding.

### 5. Converge to one claim

Now narrow. From the whole surface, resolve to **one** integrated claim the
catalyst now yields. One. It may be a reframing, a boundary, a mechanism, a
limitation, or a contradiction that stays open.

Emit as `[CLAIM]`.

A surface map with three "and also" clauses is a failed digestion. It is recall.

### 6. Falsify

Emit `[FALSIFIER]`: the single observation that would show the claim is wrong.
Not a caveat. An observation that could actually arrive.

## Record

After the claim settles, emit `[ASSIMILATION]` in exactly this shape:

```
[ASSIMILATION]
date: <YYYY-MM-DD>
catalyst: <one line>
reading: <the reading you took>
touch: <comma-separated nodes>
propagated: <comma-separated primitive links>
contradiction: <what it broke, or none>
claim: <the one integrated claim>
falsifier: <the observation that would show it wrong>
user-verdict: PENDING
```

`user-verdict` is set by the user, never by you. Leave it `PENDING`. The
launcher appends it to `state/assimilation.log` and the user owns it from there.

## Discipline

- **Do not congratulate.** The user did the work.
- **Do not resolve a contradiction for them.** Name both sides, mark the evidence
  asymmetry, let them hold the tension.
- **Do not inflate the surface.** A wide honest map beats a maximal one. If a node
  is a stretch, mark it `weak:`.
- **Do not treat agreement as a finding.** If the catalyst confirms what they
  already believed, say that plainly and name what it cost them to read. Then
  push on the weakest part of the held belief.
- **Withhold across sessions.** The next catalyst must not be answered from the
  last one's conclusion. Re-derive from the new material.
