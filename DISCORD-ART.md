# Discord Presence+ art assets

Used by **Settings > Extras > Discord Presence+** (Class Icon and Map Picture).
Upload the pictures in the Discord Developer Portal under your application:
**Rich Presence > Art Assets > Add Image(s)**.

- The **key** (the name you give the picture) must match exactly. Keys cannot be renamed after saving.
- Pictures: png or jpg, 1024x1024 recommended (512x512 minimum), square.
- Keys are the name in lowercase, with every group of other characters changed to one `_`.
  Class `Run N Gun` becomes `class_run_n_gun`, map `Lostworld` becomes `map_lostworld`.
- **Class icon and Map picture are on by default now** (Settings > Extras > Discord Presence+). Configs made before 1.2.1.0 were switched on once.
- The logo key `krh_logo` is the default big picture and is always used when a map has no picture.
- A key without an uploaded picture should simply show no image (the client does not check this).
- Discord caches assets: after uploading, wait a few minutes and restart Discord.

## Class icons (`class_<name>`)

| Class | Key |
|---|---|
| Agent | `class_agent` |
| Bowman | `class_bowman` |
| Commando | `class_commando` |
| Deagler | `class_deagler` |
| Detective | `class_detective` |
| Hunter | `class_hunter` |
| Infiltrator | `class_infiltrator` |
| Marksman | `class_marksman` |
| Rocketeer | `class_rocketeer` |
| Run N Gun | `class_run_n_gun` |
| Runner | `class_runner` |
| Spray N Pray | `class_spray_n_pray` |
| Survivor | `class_survivor` |
| Triggerman | `class_triggerman` |
| Trooper | `class_trooper` |
| Vince | `class_vince` |

These 16 are the ones prepared in `assets/discord-art/`. A class that is not listed works the same way: the client builds
the key from the class name the game reports, so upload it as `class_<name>`.

## Map pictures (`map_<name>`)

| Map | Key |
|---|---|
| Burg | `map_burg` |
| Littletown | `map_littletown` |
| Sandstorm | `map_sandstorm` |
| Subzero | `map_subzero` |
| Undergrowth | `map_undergrowth` |
| Shipment | `map_shipment` |
| Freight | `map_freight` |
| Lostworld | `map_lostworld` |
| Citadel | `map_citadel` |
| Oasis | `map_oasis` |
| Kanji | `map_kanji` |
| Industry | `map_industry` |
| Lumber | `map_lumber` |
| Evacuation | `map_evacuation` |
| Site | `map_site` |
| SkyTemple | `map_skytemple` |
| Lagoon | `map_lagoon` |
| Bureau | `map_bureau` |
| Tortuga | `map_tortuga` |
| Tropicano | `map_tropicano` |
| Krunk_Plaza | `map_krunk_plaza` |
| Arena | `map_arena` |
| Habitat | `map_habitat` |
| Atomic | `map_atomic` |
| Old_Burg | `map_old_burg` |
| Throwback | `map_throwback` |
| Stockade | `map_stockade` |
| Facility | `map_facility` |
| Clockwork | `map_clockwork` |
| Laboratory | `map_laboratory` |
| Shipyard | `map_shipyard` |
| Soul Sanctum | `map_soul_sanctum` |
| Bazaar | `map_bazaar` |
| Erupt | `map_erupt` |
| HQ | `map_hq` |
| Khepri | `map_khepri` |
| Lush | `map_lush` |
| Vivo | `map_vivo` |
| Slide Moonlight | `map_slide_moonlight` |
| Eterno Simulator | `map_eterno_simulator` |
| Stalk Factory | `map_stalk_factory` |
| Eterno Jump | `map_eterno_jump` |
| Frontier | `map_frontier` |
| Bastion | `map_bastion` |
| Piazza | `map_piazza` |
| Barnyard | `map_barnyard` |

### Ready-made pictures

The folder `assets/discord-art/` has everything prepared: 46 maps, 16 classes and `krh_logo`, all named with the
right keys and sized 1024x1024. Upload them all at once (Add Image(s) accepts many files). The folder is only
for you: it is not packaged into the installer. The maps were made from the small
200x80 originals, placed in the middle of a blurred copy of themselves so they fit the square, so they are a bit
soft. The class icons are the 8x8 pixel faces scaled up without blur.

### Getting the map pictures yourself

The pictures are not part of the repo (the client loads them from `assets.krunker.io`). A script downloads all
official ones and names them correctly:

```
node scripts/make-discord-map-art.mjs
```

It creates a `discord-map-art` folder with `map_burg.png`, `map_sandstorm.png` and so on. Upload every file there
(Developer Portal > Rich Presence > Art Assets > Add Image(s)); the file name without `.png` becomes the key.
Discord wants square pictures. For automatic 1024x1024 cropping run `npm i --no-save sharp` first.
`DRY=1 node scripts/make-discord-map-art.mjs` only lists what would be downloaded.
This needs internet access and was not run against the real server, so check that the files come out right.

Custom maps use the same rule (their name in lowercase with `_`), for example `map_my_cool_map`.

## Join button

No picture is needed. Turn on **Join Button** and friends see a Join button on your profile while you are in a match.
While the Join button is shown, your custom link buttons are hidden (Discord does not show both).
