# Known device names

`src/features/webble/known-device-names.json` is a **hand-maintained** list of name parts of trainers and sensors
(`kickr`, `tacx`, `vanrysel`, `hrm`, ...). The WebBLE blacklist (`webble-devices.json` in the app directory) is
**permanent**. The list protects real devices from one thing only: **not responding**.

- a device whose name contains a listed part is **never put on the failed list because it did not respond** (busy,
  out of reach, not ready yet): no blacklist entry, no name cooldown, no name verdict (a name written off because of
  hundreds of speaker/TV addresses never applies to it);
- an **older blacklisting** that was caused by failed connects is ignored for such a device, so a trainer that was
  banned by mistake is probed again;
- a device that **connects and reports that it is not a fitness device** ("unsupported") is blacklisted anyway, and
  that blacklisting is kept.

Matching (`known-device-names.js`): the advertised name is split into lower case parts; serial numbers and MAC
fragments are dropped (`VANRYSEL-HT-c4d1` -> `vanrysel`, `AssiomaPRO12774R` -> `assiomapro`). A part matches an entry
if it is equal to it. An entry ending with `*` is a **family** and matches every part that starts with it:
`hrm*` matches `hrm`, `hrm200`, `hrm600` and `hrmpro`; `assioma*` matches `assiomapro`; `bkool*` matches
`bkoolsmartpro`, `bkoolsmartpro2`, `bkoolsmartgo`, ... Use a family for product lines instead of listing every model.

## The file

A sorted JSON array of lower case parts (3 or more characters, a family needs 3 before the `*`). Change it by hand,
in a pull request. A test fails if an entry is already matched by a family of the list. The script below only
**suggests**, it never writes the file.

## Getting suggestions

```bash
ES_URL=http://<elasticsearch>:9200 node scripts/known-device-names/suggest.js [--days 90] [--max-parts 30] [--top 60]
```

It reads the **BLE devices that connected fine** (`start result: success` on interface `ble`: the device connected and
delivered data). Devices that failed or were found to be unsupported are not looked at. Only model names are read,
users are only counted. It prints:

1. how much of the users the list covers now, and with all suggestions;
2. the parts that occur for most users, each with its status: `listed` (in the list), `suggest` (worth adding),
   `covered` (the devices with it are covered by other parts, e.g. `core` in "KICKR CORE");
3. the suggestions with example names: entries are picked greedily, the one covering the most users that no listed
   entry covers goes first. When several parts share a prefix (`hrm`, `hrm200`, `hrmpro`; `bkoolsmartpro`,
   `bkoolsmartgo`) a family `prefix*` is suggested together with its members: a prefix that is no part itself needs 5 or
   more characters, so that nothing like `smar*` comes up. Check that a family is not too broad;
4. the listed parts that no device of the period contains.

Generic words (`bike`, `watch`, `smart`, `sensor`) and non-fitness devices (a notebook, a phone) can show up in the
suggestions: skip them, the list is yours.

## A new trainer is banned although it is a trainer

If it reported "unsupported", adding a part of its name to the list is not enough: delete its entry in
`webble-devices.json`, or the whole file (the app directory, app closed). A device on the list that only did not
respond needs nothing: it is released by the next release that contains it.
