FALSIFY MODE: novelty

Catalyst for digestion. Run the full digestion protocol in trainer/digest.md.

---

An audit of your own tooling found this. Over the last six weeks, every
automated subagent you dispatched to perform a bounded task returned a confident
report. You spot-checked eleven of them against the filesystem. Seven were
wrong. Not subtly wrong in a way you would have caught, and not wrong in a way
that matched their stated uncertainty, which was near zero in all eleven cases.

The pattern in the seven failures: each one had verified its own instructions
rather than the world. An agent told "count the Tier-1 cards and report the
number" checked that it had read all the card files, confirmed the count against
its own list, and reported that list's length. It never checked the number
against the registry that the repository itself uses as ground truth, because
nothing in its instructions told it that a second source existed.

Meanwhile the four correct reports had one thing in common. Each had been given
a task whose wording implied a way to be wrong, and had gone looking for it.
