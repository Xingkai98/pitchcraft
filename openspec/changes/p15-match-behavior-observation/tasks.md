## Slice 1 — formal observation model

- [ ] Define `ControlFactKind`, `ControlFactBasis`, `BehaviorControlState`, `ObservedTime`.
- [ ] Define `PossessionEpisode`, `RestartSequence`, `DiagnosticMatch` and recorder ownership rules.
- [ ] Add opt-in simulation API without changing `simulate()`.

## Slice 2 — engine integration

- [ ] Record kickoff/restart and first confirmed control.
- [ ] Record pass/interception/lost/tackle/pickup transitions at state commit points.
- [ ] Record shot finalize outcomes: goal, saved caught, rebound, off target and out.
- [ ] Record foul, out, half-time, full-time and whistle interruption paths.

## Slice 3 — verification

- [ ] Add fixtures for successful pass, interception, contested loss, loose pickup, shot outcomes, foul and restarts.
- [ ] Assert episode/contest/restart closure and no overlapping active objects.
- [ ] Assert recorder on/off leaves formal events, output bytes and RNG unchanged.
- [ ] Run Rust tests, prototype tests, OpenSpec validation and `./verify.sh`.

## Slice 4 — follow-up

- [ ] Implement #15B `PhaseAnnotator` only after #15A facts are stable.
- [ ] Do not attach set-piece delivery to a possession episode before confirmed open-play control.
