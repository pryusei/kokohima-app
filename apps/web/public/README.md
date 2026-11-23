# public/

`icon-192.png`・`icon-512.png`・`icon-maskable-512.png`・`apple-touch-icon.png` は `icon.svg`（黄色 `#fcd34d` の角丸に白い円）と同じ絵から作って、コミットしている（docs/specs/T-25-installable-pwa.md「画像」）。ビルドでは作らない。

作り方（ImageMagick）：

```bash
convert -size 512x512 xc:none -fill "#fcd34d" -draw "roundrectangle 0,0 511,511 96,96" -fill white -draw "circle 256,256 376,256" icon-512.png
convert icon-512.png -resize 192x192 icon-192.png
convert -size 512x512 xc:"#fcd34d" -fill white -draw "circle 256,256 376,256" -alpha off -depth 8 PNG24:icon-maskable-512.png   # 角丸なし・全面・透過なし
convert icon-maskable-512.png -resize 180x180 -alpha off -depth 8 PNG24:apple-touch-icon.png               # 透過させない
```
