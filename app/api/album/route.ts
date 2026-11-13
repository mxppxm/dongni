import fs from "node:fs";
import { db } from "@/lib/db";
import { diaryOf } from "@/lib/diary";
import { captionOf, fillCaptions } from "@/lib/captions";
import { listPhotos, outfits, today, wardrobeFile } from "@/lib/wardrobe";
import { outfitSeasons } from "@/lib/wardrobeoutfits";

export const dynamic = "force-dynamic";

export async function GET() {
  const t = await today();
  return Response.json({
    today: { outfit: t.outfit.key, weather: t.weather, season: t.season },
    outfits: outfits().map((o) => ({
      key: o.key,
      name: o.name,
      when: o.when,
      seasons: outfitSeasons(o),
      url: outfitUrl(o.key),
    })),
    photos: [...dailyPhotos(), ...drawnPhotos()].sort((a, b) => b.created_at - a.created_at || b.id - a.id),
  });
}

/** 定妆照重拍后文件名不变，URL 带上修改时间，浏览器才不会一直拿旧缓存 */
function outfitUrl(key: string) {
  const f = wardrobeFile(`${key}.jpg`);
  if (!f) return null;
  try {
    return `/api/wardrobe/${key}.jpg?v=${Math.floor(fs.statSync(f).mtimeMs)}`;
  } catch {
    return `/api/wardrobe/${key}.jpg`;
  }
}

/** 每天拍的那张 */
function dailyPhotos() {
  return listPhotos()
      .filter((p) => wardrobeFile(p.file) && fs.existsSync(wardrobeFile(p.file)!))
      .map((p) => ({
        id: p.id,
        date: p.date,
        outfit: p.outfit,
        weather: p.weather,
        caption: p.caption,
        diary: diaryOf(p.date),
        created_at: p.created_at,
        url: `/api/wardrobe/${p.file}`,
        kind: "daily",
      }));
}

/** 她平时画的所有图：配上她发图时说的那句话 */
function drawnPhotos() {
  void fillCaptions(); // 还没配文的在后台补上
  const rows = db().prepare("SELECT id, prompt, created_at FROM images WHERE kind = 'gen' ORDER BY id").all() as {
    id: number;
    prompt: string | null;
    created_at: number;
  }[];
  return rows.map((r) => {
    return {
      id: 1_000_000 + r.id,
      date: new Date(r.created_at).toLocaleDateString("sv-SE"),
      outfit: "",
      weather: "",
      caption: captionOf(r.id),
      diary: null as string | null,
      created_at: r.created_at,
      url: `/api/image/${r.id}`,
      kind: "drawn",
    };
  });
}
