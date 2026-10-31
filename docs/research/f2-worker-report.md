# F2 worker report: materials and reactions

(Written as the work lands.)

## Commits
- Oil (id 15): `liquid_move` now takes the displaceable-set from the `Liquid` (`ok` fn); Water may displace Oil, so water sinks through oil. Oil ignites at 1-in-2 per fire neighbour per tick (wood 1-in-12, plants 1-in-4). Tests `oil_floats_on_water` (red with `water_ok` not including OIL) and `oil_burns_fast_and_spreads_fire` (red with OIL not in `is_flammable`).
