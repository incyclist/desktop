# Known device names

`src/features/webble/known-device-names.json` lists name parts of trainers and sensors our users ride with
(`kickr`, `tacx`, `vanrysel`, `hrm`, ...). The WebBLE blacklist (`webble-devices.json` in the app directory) is
**permanent**, and this list is what protects real devices from it:

- a device whose name contains a listed part is **never added to the blacklist** and never covered by the name
  cooldown or the persisted name verdict (hundreds of speaker/TV addresses under one name);
- an **older blacklisting** of such a device is ignored, so a trainer that was banned by mistake (e.g. it was busy
  or its GATT table was incomplete when probed) is released by the next release that carries an updated list.

Matching (`known-device-names.js`): the advertised name is split into lower case parts; serial numbers and MAC
fragments are dropped (`VANRYSEL-HT-c4d1` -> `vanrysel`, `AssiomaPRO12774R` -> `assiomapro`). A part matches an entry
if it is equal to it; entries of 5 or more characters also match the start of a part (`assioma`, `bkool`).

## The file

| Key | Meaning |
|---|---|
| `manual` | written by hand, never touched by the generator |
| `exclude` | parts that must never be on the list (too generic: `bike`, `sensor`, `google`, ...). Applies to `manual` and `generated` |
| `generated` | written by `update.js` |
| `meta` | when and with which settings the generated part was made |

## Updating the generated part

```bash
ES_URL=http://<elasticsearch>:9200 node scripts/known-device-names/update.js --dry-run   # shows what would change
ES_URL=http://<elasticsearch>:9200 node scripts/known-device-names/update.js             # writes the file
```

Options: `--days 90` (look-back), `--min-users 3`, `--max-noise-ratio 0.3`.

It reads the BLE devices users **started** (`start bike request`, `start sensor request`) and the devices the app
connected to and found to be of another kind (`device confirmed unsupported`). Only model names are read, users are
only counted. Parts are picked greedily: the part that covers the most users not yet covered goes first (`kickr`), so
`core` in "KICKR CORE" never gets on the list, and a part is only eligible if it is rare among confirmed-unsupported
names (generic words such as `pro`, `galaxy`, `watch` also occur in earbuds, watches and TVs).

Review the diff before committing: add parts that came out too generic to `exclude`, add new brands that are not
in the data yet to `manual`. Run it every month or two, and before a release.

## A new trainer is banned although it is a trainer

Add a part of its name to `manual` (this is also how a device unknown to the data is protected) and release.
For a single machine, delete the entry (or the whole file `webble-devices.json`) in the app directory.
