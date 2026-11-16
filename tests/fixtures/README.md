# Test fixtures

## Real logs (committed)

| File | What | Source |
|---|---|---|
| `ublox.nmea` | 29 min of NMEA from a u-blox F9K, multi-constellation, multi-band (2020) | [google/gps-measurement-tools](https://github.com/google/gps-measurement-tools), `NmeaUtils/example/MTV.Local1.ublox-F9K.20200206-181434.nmea`, Apache-2.0 |
| `epoch10.txt` | GnssLogger log from a Pixel (Raw, Fix, Status), 10 epochs, with clock drift and AGC | google/gps-measurement-tools, Apache-2.0 |
| `pr2016.txt` | GnssLogger Raw log from 2016 (no satellite positions, no drift field) | google/gps-measurement-tools, Apache-2.0 |
| `gpstest_synth.txt` | Two-epoch GPSTest-format log written by hand for this project | this project |

These files are used unchanged, as test input only. The Apache-2.0 license of the source repository applies to them.

## Generated logs (not committed)

`node tests/fixtures/generate.mjs` builds everything else into `tests/.generated/`, which git ignores. The generator is deterministic (seeded random numbers), so every run produces the same files.

- **Attacks** (`attack/`), each built from a real log:
  - Spoofing: uniform C/N₀, teleport, frozen replay, single-transmitter common C/N₀.
  - GNSS vs. network position mismatch.
  - Jamming: AGC rise, and a C/N₀ dip across every satellite.
  - Receiver-clock attacks: clock pull, time shift, clock steps.
- **Hostile inputs:** a ReDoS line, out-of-range coordinates, prototype-pollution keys, a million-signal epoch, 200k providers, a 3 MB line.
- **Cellular logs:**
  - Tower Collector format: steady signal, and a "tunnel" drop that coincides with the GNSS dip.
  - G-NetTrack format.
  - Hostile CSV.

`npm test` and `npm run test:e2e` run the generator first.
