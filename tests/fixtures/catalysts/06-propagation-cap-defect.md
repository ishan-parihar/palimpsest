A test asserted that two-hop propagation from a tier-1 seed reaches strictly more
cards than one hop, and it failed: expected greater than 200, received 200.

The assertion was wrong, not the code. The cap parameter was set to 200, and the
lattice is dense enough that one seed saturates it within two hops. The test was
measuring its own ceiling and calling it a result.
