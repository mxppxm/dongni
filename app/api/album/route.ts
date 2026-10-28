import fs from "node:fs";
import { listPhotos, OUTFITS, today, wardrobeFile } from "@/lib/wardrobe";

export const dynamic = "force-dynamic";

export async function GET() {
  const t = await today();
  return Response.json({
    today: { outfit: t.outfit.key, weather: t.weather, season: t.season },
    outfits: OUTFITS.map((o) => ({
      key: o.key,
      name: o.name,
      when: o.when,
      url: wardrobeFile(`${o.key}.jpg`) ? `/api/wardrobe/${o.key}.jpg` : null,
    })),
    photos: listPhotos()
      .filter((p) => wardrobeFile(p.file) && fs.existsSync(wardrobeFile(p.file)!))
      .map((p) => ({ date: p.date, outfit: p.outfit, weather: p.weather, caption: p.caption, url: `/api/wardrobe/${p.file}` })),
  });
}
