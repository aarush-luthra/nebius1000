# Dead Thinkers Dialogue — Visual Redesign Plan

## What we're building

Three interlocked upgrades to the app's visual language:

1. **10 portrait illustrations** — bespoke SVG headshots for each thinker
2. **Full-card portraits** on the character select grid
3. **Dining table Room View** — the debate chamber reimagined as an intimate dinner
4. **Interactive text** — every finished response is clickable for follow-ups

---

## 1. Portrait Illustrations

**Style:** Editorial line-art — black, cream, and one accent colour per thinker. No gradients. Bold silhouettes. Recognisable from 80px down.

**Format:** SVG, `viewBox="0 0 280 340"`, stored in `frontend/portraits/`.

**Roster:**

| File | Thinker | Key visual markers |
|------|---------|-------------------|
| `modi.svg` | Narendra Modi | White-grey beard, dark cropped hair, rectangular glasses, Nehru jacket |
| `einstein.svg` | Albert Einstein | Wild white hair halo, thick mustache, rumpled lapels |
| `musk.svg` | Elon Musk | Short dark widow's-peak hair, clean jaw, dark turtleneck |
| `kalam.svg` | APJ Abdul Kalam | Flowing white side-hair, high kurta collar, warm expression |
| `cleopatra.svg` | Cleopatra | Striped nemes headdress, kohl eyes, gold collar necklace |
| `michelle.svg` | Michelle Obama | Natural shoulder-length hair, pearl earrings, elegant neckline |
| `tesla.svg` | Nikola Tesla | Slicked center-parted hair, thin mustache, high cravat collar |
| `trump.svg` | Donald Trump | Swept golden hair, long red tie, suit lapels |
| `buffett.svg` | Warren Buffett | Thin white hair, round glasses, bow tie |
| `curie.svg` | Marie Curie | Dark bun, high Victorian collar, lab jacket |

Each `thinker.image` field in `thinkers.py` now points to `/static/portraits/<id>.svg`.

---

## 2. Full-Card Portraits (Character Select Grid)

**Before:** 56px circle avatar with initials, then name/domain below.

**After:** Portrait illustration fills the full card width at 3:4 ratio. Number and selection badge overlay the top-left corner. Name / domain / era remain below in a text block.

CSS change: `.thinker-card` has no top padding. `.card-portrait-full` is a new element — `width: 100%; aspect-ratio: 3/4; overflow: hidden`. The old `.card-portrait` circle is removed.

Selection state: same 2px terracotta top border, plus a subtle terracotta tint overlay on the portrait.

---

## 3. Dining Table Room View

**Before:** A row of small circular avatars in a bar strip above the message feed.

**After:** A rendered dining scene — an oval wooden table in the centre, selected thinkers seated around it as portrait medallions. Below the table, the message feed continues unchanged.

### Layout (dynamic by selection count)

**2 thinkers**
```
  [Portrait]            [Portrait]
     Name    ──TABLE──    Name
```

**3 thinkers**
```
   [Portrait]      [Portrait]
      Name    TABLE   Name
              ──────
            [Portrait]
               Name
```

### Implementation
- `.room-table-scene` replaces `.room-seats` — a fixed-height flex container with relative positioning
- `.dining-table` is a CSS oval with a wood-grain background, decorative centre marker
- `.table-seat` elements are absolutely positioned around the oval, coordinated from JS
- Seat positions are computed from a `SEAT_POSITIONS[count][index]` lookup table
- When a thinker is `speaking`, their medallion gets a terracotta border glow

### Seat positions (px offset from table centre)
```js
const SEAT_POSITIONS = {
  2: [{ x: -180, y: 0 }, { x: 180, y: 0 }],
  3: [{ x: -175, y: -30 }, { x: 175, y: -30 }, { x: 0, y: 85 }],
};
```

---

## 4. Interactive Text

Every completed response in the Room View becomes clickable:

- Words in `.msg-text` are wrapped in `<span class="word-token">` elements after streaming ends
- Hovering highlights the span in a faint terracotta underline
- Clicking a word/phrase sets that thinker as the direct target and pre-fills the input with `"Following up on what you said about [word]…"`
- A small `[↩ Reply]` button also appears in `.msg-meta` after streaming completes

---

## Files changed

```
frontend/
  portraits/          ← NEW: 10 SVG files
  style.css           ← card-portrait-full, dining table, interactive word tokens
  app.js              ← renderSelectGrid(), buildDebateUI(), archivePanelResponse()
  index.html          ← room-table-scene structure

backend/
  thinkers.py         ← image field added per thinker; model exposed in list
```
