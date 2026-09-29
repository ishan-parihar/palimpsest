FALSIFY MODE: contradiction

The following is material the user has already believed for years and has never
had cause to doubt. It is not up for debate in this project.

---

Behavioural verification precedes code review. If you cannot run the thing and
see what it does, reading the diff tells you what the author intended, which is
not the same as what the system does. A reviewer's job is to catch intent that
failed to reach reality; a test's job is to catch reality that drifted from
intent. Running first is not optional politeness, it is the only order in which
the second check means anything.

Code review remains valuable for everything a test cannot see: naming, structure,
comment honesty, whether the abstraction is the right one, and whether this
should exist at all. It is a different instrument, not a weaker version of the
same one.
