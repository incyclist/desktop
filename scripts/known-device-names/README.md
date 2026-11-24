# Known device names

The WebBLE block list (`webble-devices.json` in the app directory) is **permanent**. A hand-maintained list of name
parts of real trainers and sensors (`kickr`, `tacx`, `vanrysel`, `hrm*`, ...) protects them from one thing only:
**not responding**.

- a device whose name contains a listed part is **never put on the failed list because it did not respond** (busy,
  out of reach, not ready yet): no block list entry, no name cooldown, no name verdict (a name written off because of
  hundreds of speaker/TV addresses never applies to it);
- a device that **connects and reports that it is not a fitness device** ("unsupported") is blocked anyway, and that
  block is kept;
- when the list changes, blocks that already exist are cleaned up **once**, see "Version" below.

## Where the list lives: incyclist-services

The list is owned by `incyclist-services` (`src/devices/known-names/known-device-names.ts`, see the README there) and
delivered with the UI bundle, so changing it needs **no desktop release**:

1. web-ui (`bindings/devices/ble.js`) creates the WebBLE binding and, if the desktop announces the capability
   `webble-known-names`, calls `binding.setKnownDeviceNames(getKnownDeviceNames())`;
2. the renderer binding (`ipc-binding.js`) hands it to the main process (IPC `webble-known-names`);
3. `WebBleFeature.setKnownDeviceNames()` stores it (`known-device-names.js`) and has the block list cleaned against
   it (`WebBleDeviceCache.applyKnownNames()`).

This happens at app start, **before the first scan**. The desktop has no copy of the list: until a list was pushed
nothing is protected (nothing scans before that). A bundle without the push (older than this feature) protects
nothing either: it is replaced by the hot update. A shell without the capability ignores the list.

The matching (`nameParts`, `matchesPart`, `isKnownDeviceName` in `known-device-names.js`) runs in the main process and
has its own copy in services (`matching.ts`). Both are covered by the same test cases: **keep them in line**.

## Matching

The advertised name is split into lower case parts; serial numbers and MAC fragments are dropped
(`VANRYSEL-HT-c4d1` -> `vanrysel`, `AssiomaPRO12774R` -> `assiomapro`). A part matches an entry if it is equal to it. An
entry ending with `*` is a **family** and matches every part that starts with it: `hrm*` matches `hrm`, `hrm200`,
`hrm600` and `hrmpro`; `bkool*` matches `bkoolsmartpro`, `bkoolsmartgo`, ...

## Version

The list has a `version`, increased by hand with every change. The block list stores the version it was last cleaned
against (`knownNamesVersion`). When a list with a **higher** version is set (also for a file without a version, i.e.
from an older release), every entry of the block list that the list matches is removed once, whatever the reason
(unsupported, did not respond, failure counts): those devices are probed again. In the worst case they are blocked
again by their next probes (a known name that does not respond is no longer blocked at all; one that reports
"unsupported" is). Devices we connected to ("good") are never removed. A new installation has nothing to clean. A list
with a lower version than the one already set is refused, and a block list that was cleaned against a higher version
is left alone. If you forget to increase the version, the blocks that exist already stay until the next change.

## Getting suggestions

```bash
ES_URL=http://<elasticsearch>:9200 node scripts/known-device-names/suggest.js [--list <file>] [--days 90] [--max-parts 30] [--top 60]
```

It reads the list of services (`../services/src/devices/known-names/known-device-names.ts` next to this repository, or
`--list` / `KNOWN_NAMES_FILE`) and the **BLE devices that connected fine** (`start result: success` on interface `ble`)
from Elasticsearch. Devices that failed or were found to be unsupported are not looked at. Only model names are read,
users are only counted. It never changes a file. It prints:

1. how much of the users the list covers now, and with all suggestions;
2. the parts that occur for most users, each with its status: `listed`, `suggest` (worth adding), `covered` (the
   devices with it are covered by other parts, e.g. `core` in "KICKR CORE");
3. the suggestions with example names. Entries are picked greedily: the one covering the most users that no listed
   entry covers goes first. When several parts share a prefix (`hrm`, `hrm200`, `hrmpro`; `bkoolsmartpro`,
   `bkoolsmartgo`) a family `prefix*` is suggested together with its members: a prefix that is no part itself needs 5 or
   more characters, so that nothing like `smar*` comes up. Check that a family is not too broad;
4. the listed parts that no device of the period contains.

Generic words (`bike`, `watch`, `smart`, `sensor`) and non-fitness devices (a notebook, a phone) can show up in the
suggestions: skip them, the list is yours.

## A new trainer is blocked although it is a trainer

Add a part of its name to the list in services and **increase the version**: the next UI bundle removes its block (and
the blocks of all devices that the list matches) at the app's start. For a single machine without a release, delete
the entry in `webble-devices.json`, or the whole file (the app directory, app closed).
