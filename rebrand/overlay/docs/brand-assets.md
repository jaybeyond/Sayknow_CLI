# Brand assets

Sayknow-CLI's mascot is an **octopus** 🐙. The source artwork is
[`assets/brand/mascot.png`](../assets/brand/mascot.png) (512×512, transparent);
all product images are derived from it.

| Asset | Purpose |
| --- | --- |
| [`assets/brand/mascot.png`](../assets/brand/mascot.png) | Source mascot (transparent, 512×512). Edit/replace this to rebrand. |
| [`assets/hero.png`](../assets/hero.png) | Wide README/docs hero — mascot + `sayknow` wordmark on a deep-navy field. |
| [`assets/character.png`](../assets/character.png) | Standalone mascot (square). |
| [`python/roboskc/assets/icon.png`](../python/roboskc/assets/icon.png) | App/service icon (square, transparent). |
| [`python/roboskc/assets/icon.jpg`](../python/roboskc/assets/icon.jpg) | Same, flattened on a navy background for JPEG. |
| [`assets/tool-image-fixture.webp`](../assets/tool-image-fixture.webp) | Minimal WebP fixture for terminal image rendering tests. Not a product brand asset. |

## Regenerating

Derived images are composited from `assets/brand/mascot.png` with ImageMagick:

```sh
SRC=assets/brand/mascot.png
magick "$SRC" -resize 800x800 assets/character.png
cp "$SRC" python/roboskc/assets/icon.png
magick "$SRC" -background '#06182b' -flatten -resize 512x512 python/roboskc/assets/icon.jpg
magick -size 1200x630 gradient:'#0c2a47'-'#020812' \
  \( "$SRC" -resize 300x300 \) -gravity North -geometry +0+72 -composite \
  -gravity North -font "/System/Library/Fonts/Supplemental/Arial Bold.ttf" \
  -fill '#eef7ff' -pointsize 104 -annotate +0+392 'sayknow' \
  -fill '#ff8a4c' -pointsize 27 -annotate +0+520 'Coding should feel like thinking.' \
  assets/hero.png
```

> Note: the mascot is warm/orange while the bundled TUI theme is `blue-octopus`
> (blue). They coexist intentionally; if you want the terminal palette to match
> the mascot, switch the default theme to `red-octopus` or add a warm theme.
